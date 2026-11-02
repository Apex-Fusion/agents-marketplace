// Delegations off the ledger (Part 2 Sections 5.1, 5.2 and 5.4). The token service issues a token
// for a delegation only after it checks the whole chain with the use checks of Section 5.2:
// - the delegation and every ancestor are authentic: an unspent output at the delegation address
//   that holds exactly one token of the delegation policy, named by the delegation identifier;
// - each delegator agent and the delegate have effective status Active (the view without options);
// - active_key(delegate, delegate_key, delegation) holds: the delegate lists an Ed25519 key with the
//   delegation purpose whose key hash is delegate_key; the request proves possession of that key;
// - the actions and resources are covered (Section 5.1);
// - the token's time range is inside the period of every delegation in the chain.
// The gateway also checks the links of the chain (delegator = parent's delegate, depth, remaining,
// narrower patterns and periods), which the contract checked when it created them.
// Confirmations (Part 1 Section 7.2, applied to delegations): a delegation counts only when its
// mint has 30 confirmations; an Undelegate or any spend of the output counts at once.

import { hexToBytes } from "../codec/plutus-data.js";
import type { ChainSource, ChainTip, LedgerTx } from "../chain/types.js";
import { isAuthentic, ledgerOrder, tokenQuantity } from "../resolve/history.js";
import { PURPOSE } from "../resolve/document.js";
import type { CurrentRecord } from "../resolve/resolver.js";
import { CONFIRMATION_DEPTH, type Registry } from "../resolve/settings.js";
import { decodeDelegationDatum, type DelegationDatum } from "./delegation-datum.js";
import { principalKeyIdOf, type M4Settings, type RecordSource } from "./context.js";

/** RFC 9396 authorization details type of a delegation token (a collision-resistant URI, RFC 9396 Section 2.1). */
export const DELEGATION_DETAILS_TYPE = "https://id.vector.apexfusion.org/ns/delegation";
/** Part 2 Section 5.2: depth 1..4. */
export const MAX_DELEGATION_DEPTH = 4;

// ── Section 5.1 patterns ──

const SEG = "[a-z0-9-]+";
const INTERNAL = new RegExp(`^${SEG}(?:\\.${SEG})*$`);
const PREFIX = new RegExp(`^${SEG}(?:\\.${SEG})*\\.\\*$`);
const EXTERNAL = /^(?:oauth:|mcp:|https:\/\/)[\x21-\x7e]+$/;
const SCRIPT = /^script:[0-9a-f]{56}$/;

export const isActionPattern = (p: string): boolean => p === "*" || INTERNAL.test(p) || PREFIX.test(p) || EXTERNAL.test(p);
export const isResourcePattern = (p: string): boolean => p === "*" || SCRIPT.test(p) || EXTERNAL.test(p);

/** A pattern covers a value: `*`, the value itself, or `x.*` when the value starts with `x.`. External and script patterns match only exactly. */
export function covers(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === value) return true;
  return PREFIX.test(pattern) && value.startsWith(pattern.slice(0, -1));
}

/** A parent pattern covers a child pattern. A child `x.*` is covered only by `*` or by a parent `y.*` with x = y or x starting with `y.`. */
export function patternCovers(parent: string, child: string): boolean {
  if (child === "*") return parent === "*";
  if (PREFIX.test(child)) {
    if (parent === "*") return true;
    if (!PREFIX.test(parent)) return false;
    const x = child.slice(0, -2);
    const y = parent.slice(0, -2);
    return x === y || x.startsWith(`${y}.`);
  }
  return covers(parent, child);
}

/** The child list is narrower than the parent list: a parent pattern covers each child pattern. */
export const narrower = (parents: readonly string[], children: readonly string[]): boolean => children.every((c) => parents.some((p) => patternCovers(p, c)));

// ── Delegation records ──

export interface DelegationRecord {
  readonly id: string;
  readonly datum: DelegationDatum;
  /** The patterns as text. */
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly txHash: string;
  readonly outputIndex: number;
}

export type DelegationLookup = { readonly ok: true; readonly record: DelegationRecord } | { readonly ok: false; readonly reason: string };

const ID = /^[0-9a-f]{64}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function patterns(hexItems: readonly string[], valid: (p: string) => boolean): string[] | null {
  const out: string[] = [];
  for (const hex of hexItems) {
    let text: string;
    try {
      text = UTF8.decode(Buffer.from(hex, "hex"));
    } catch {
      return null;
    }
    if (!valid(text)) return null;
    out.push(text);
  }
  return out;
}

/** Reads delegation records through the chain source. */
export class DelegationSource {
  constructor(
    private readonly chain: ChainSource,
    readonly registry: Registry,
  ) {}

  /** The current tip; delegation reads are relative to it. */
  tip(): Promise<ChainTip> {
    return this.chain.tip();
  }

  /** The live, authentic, confirmed delegation with this identifier, or why there is none. A failed read throws. */
  async read(id: string, tip: ChainTip): Promise<DelegationLookup> {
    if (!ID.test(id)) return { ok: false, reason: "a delegation identifier is 64 lowercase hex characters" };
    const { policyId } = this.registry;
    const hashes = await this.chain.assetTxHashes(policyId, id);
    if (hashes.length === 0) return { ok: false, reason: `delegation ${id} does not exist` };
    const txs = await this.chain.transactions(hashes);
    if (txs.length !== new Set(hashes).size) throw new Error("the ledger source did not return every transaction of a delegation token");
    const seen = txs.filter((t) => t.blockHeight <= tip.blockHeight).sort(ledgerOrder);
    const minted = (t: LedgerTx): bigint => tokenQuantity(t.mint, policyId, id);
    if (seen.some((t) => minted(t) < 0n)) return { ok: false, reason: `delegation ${id} was undelegated` };
    const mints = seen.filter((t) => minted(t) > 0n);
    if (mints.length !== 1) return { ok: false, reason: mints.length === 0 ? `delegation ${id} does not exist` : `delegation ${id} is not authentic` };
    const mint = mints[0]!;
    const output = mint.outputs.find((o) => tokenQuantity(o.assets, policyId, id) > 0n);
    if (!output || !isAuthentic(output, this.registry, id)) return { ok: false, reason: `delegation ${id} is not authentic` };
    const spent = seen.some((t) => t.inputs.some((i) => i.txHash === mint.txHash && i.outputIndex === output.outputIndex));
    if (spent) return { ok: false, reason: `delegation ${id} is spent` };
    if (tip.blockHeight - mint.blockHeight < CONFIRMATION_DEPTH) return { ok: false, reason: `delegation ${id} has fewer than ${CONFIRMATION_DEPTH} confirmations` };
    if (output.inlineDatum === null) return { ok: false, reason: `delegation ${id} has no inline datum` };
    let datum: DelegationDatum;
    try {
      datum = decodeDelegationDatum(hexToBytes(output.inlineDatum));
    } catch {
      return { ok: false, reason: `delegation ${id} has an invalid datum` };
    }
    const actions = patterns(datum.actions, isActionPattern);
    const resources = patterns(datum.resources, isResourcePattern);
    if (actions === null || resources === null || actions.length === 0) return { ok: false, reason: `delegation ${id} has invalid patterns` };
    return { ok: true, record: { id, datum, actions, resources, txHash: mint.txHash, outputIndex: output.outputIndex } };
  }
}

// ── Chain checks ──

export interface CheckedChain {
  /** The leaf delegation first, then each parent up to the root. */
  readonly chain: readonly DelegationRecord[];
  /** The delegate's current record. */
  readonly delegate: CurrentRecord;
  /** The earliest `not_after` of the chain (POSIX ms): a token must expire by then. */
  readonly notAfter: number;
}

export type ChainCheck = { readonly ok: true; readonly value: CheckedChain } | { readonly ok: false; readonly reason: string };

export interface ChainRequest {
  readonly leafId: string;
  /** Start of the token's time range (POSIX ms). Its end is at most `notAfter` of the result. */
  readonly atMs: number;
  /** The agent that must be the leaf's delegate. */
  readonly delegate: string;
  /** Requested actions and resources (patterns); every delegation of the chain must cover them. */
  readonly actions?: readonly string[];
  readonly resources?: readonly string[];
  /**
   * The key hash that the request proved possession of, which must be the leaf's delegate_key; null
   * when the request proved no Ed25519 key. Undefined: no proof is checked (a later re-check).
   */
  readonly provenKeyHash?: string | null;
}

const agentActive = async (records: RecordSource, vectorId: string): Promise<{ ok: true; record: CurrentRecord } | { ok: false; reason: string }> => {
  const lookup = await records.currentRecord(vectorId);
  if (!lookup.found) return { ok: false, reason: `agent ${vectorId} is not registered` };
  if (lookup.record.effective.status !== "active") return { ok: false, reason: `agent ${vectorId} has effective status ${lookup.record.effective.status}, not active` };
  return { ok: true, record: lookup.record };
};

/**
 * Part 2 Section 5.2, use by a dependent contract, done off the ledger for the whole chain of
 * `leafId`. A failed ledger read throws.
 */
export async function checkDelegationChain(source: DelegationSource, records: RecordSource, request: ChainRequest): Promise<ChainCheck> {
  const tip = await source.tip();
  const chain: DelegationRecord[] = [];
  let id: string | null = request.leafId;
  while (id !== null) {
    if (chain.length === MAX_DELEGATION_DEPTH) return { ok: false, reason: "the delegation chain is deeper than 4" };
    if (chain.some((d) => d.id === id)) return { ok: false, reason: "the delegation chain names one of its own delegations" };
    const lookup = await source.read(id, tip);
    if (!lookup.ok) return { ok: false, reason: lookup.reason };
    chain.push(lookup.record);
    id = lookup.record.datum.parent;
  }
  if (chain[0]!.datum.delegate !== request.delegate) return { ok: false, reason: "the subject is not the delegate of the delegation" };

  // Links: chain[i + 1] is the parent of chain[i].
  const root = chain[chain.length - 1]!;
  if (root.datum.depth !== 1) return { ok: false, reason: "the root delegation does not have depth 1" };
  for (let i = 0; i + 1 < chain.length; i++) {
    const child = chain[i]!.datum;
    const parent = chain[i + 1]!;
    const delegator = child.delegator;
    if (delegator.type !== "Agent" || delegator.id !== parent.datum.delegate) return { ok: false, reason: `delegation ${chain[i]!.id} is not made by the delegate of its parent` };
    if (child.depth !== parent.datum.depth + 1) return { ok: false, reason: `delegation ${chain[i]!.id} has the wrong depth` };
    if (parent.datum.remaining < 1 || child.remaining > parent.datum.remaining - 1) return { ok: false, reason: `delegation ${chain[i]!.id} exceeds the hops that its parent allows` };
    if (!narrower(parent.actions, chain[i]!.actions) || !narrower(parent.resources, chain[i]!.resources)) {
      return { ok: false, reason: `delegation ${chain[i]!.id} is not narrower than its parent` };
    }
    if (child.notBefore < parent.datum.notBefore || child.notAfter > parent.datum.notAfter) return { ok: false, reason: `delegation ${chain[i]!.id} is outside the period of its parent` };
    const limit = parent.datum.value;
    if (limit !== null && (child.value === null || child.value.perTx > limit.perTx || child.value.total > limit.total || child.value.periodMs < limit.periodMs)) {
      return { ok: false, reason: `delegation ${chain[i]!.id} exceeds the value limit of its parent` };
    }
  }
  if (chain.some((d) => d.datum.depth + d.datum.remaining > MAX_DELEGATION_DEPTH)) return { ok: false, reason: "a delegation allows more hops than depth 4" };

  // Use checks.
  for (const d of chain) {
    if (request.atMs < d.datum.notBefore || request.atMs >= d.datum.notAfter) return { ok: false, reason: `the time is outside the period of delegation ${d.id}` };
    if (request.actions && !narrower(d.actions, request.actions)) return { ok: false, reason: `delegation ${d.id} does not cover the requested actions` };
    if (request.resources && !narrower(d.resources, request.resources)) return { ok: false, reason: `delegation ${d.id} does not cover the requested resources` };
  }
  for (const d of chain) {
    if (d.datum.delegator.type !== "Agent") continue;
    const status = await agentActive(records, d.datum.delegator.id);
    if (!status.ok) return { ok: false, reason: `delegator ${status.reason}` };
  }
  const leaf = chain[0]!;
  const delegate = await agentActive(records, leaf.datum.delegate);
  if (!delegate.ok) return { ok: false, reason: `delegate ${delegate.reason}` };
  const view = delegate.record.view;
  const listed = view.kind === "identity" && view.keys.some((k) => k.keyType === "Ed25519" && k.keyHash === leaf.datum.delegateKey && k.purposes & PURPOSE.delegation);
  if (!listed) return { ok: false, reason: "the delegate_key is not a listed Ed25519 key of the delegate with the delegation purpose" };
  if (request.provenKeyHash !== undefined && request.provenKeyHash !== leaf.datum.delegateKey) {
    return { ok: false, reason: "the DPoP proof key is not the delegate_key of the delegation" };
  }
  const notAfter = Math.min(...chain.map((d) => d.datum.notAfter));
  return { ok: true, value: { chain, delegate: delegate.record, notAfter } };
}

/** The `sub` and `act` claims of a delegation token. */
export interface DelegationClaims {
  readonly sub: string;
  readonly act: Record<string, unknown>;
}

/**
 * Part 2 Section 5.4, which follows RFC 8693 Section 4.1 (https://www.rfc-editor.org/rfc/rfc8693#section-4.1):
 * - `sub` is the root delegator, the principal: `did:vector:<id>` for an agent, or
 *   `<base>/principals/key/<key hash>` for a PrincipalKey;
 * - `act` is the chain of actors: the leaf's delegate (the current actor) is the outermost
 *   `act.sub`, and the delegate of each earlier delegation is a nested `act`, so the root's
 *   delegate (the least recent actor) is the most deeply nested.
 * `chain` is the leaf first, then each parent up to the root, as `checkDelegationChain` returns it.
 */
export function delegationClaims(chain: readonly DelegationRecord[], settings: M4Settings): DelegationClaims {
  const principal = chain[chain.length - 1]!.datum.delegator;
  const sub = principal.type === "Agent" ? `did:vector:${principal.id}` : principalKeyIdOf(settings, principal.hash);
  let act: Record<string, unknown> | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const actor = { sub: `did:vector:${chain[i]!.datum.delegate}` };
    act = act === null ? actor : { ...actor, act };
  }
  return { sub, act: act! };
}

/** RFC 9396 authorization details of a delegation token (Part 2 Section 5.4). */
export function delegationDetails(leaf: DelegationRecord, actions: readonly string[], resources: readonly string[]): Record<string, unknown> {
  return {
    type: DELEGATION_DETAILS_TYPE,
    identifier: leaf.id,
    actions: [...actions],
    locations: [...resources],
    ...(leaf.datum.purpose === null ? {} : { purpose: leaf.datum.purpose }),
  };
}
