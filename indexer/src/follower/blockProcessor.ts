/**
 * indexer/src/follower/blockProcessor.ts — processes a single block.
 *
 * processBlock(block, knownUtxos, addresses) inspects each transaction,
 * decodes datums at the watched script addresses and emits typed
 * MarketplaceEvent objects. It also reports the watched outputs that the
 * block creates and the identity records that it changes.
 *
 * Watched addresses. Each advert and escrow address has one datum layout:
 * the legacy advert and escrow addresses use the legacy layouts, the new
 * advert and escrow addresses the identity layouts (Part 2 §6.1–6.2). A datum
 * with the other layout at an address is not an advert or escrow of that
 * contract: it is logged and gives no event. The two contracts of a kind are
 * separate families: a spend of a legacy escrow never continues into a new
 * escrow output, and a transaction may retire a legacy advert and post a new
 * one.
 *
 * Detection rules (per family):
 *   PostAdvert    — advert output, no advert of the family spent
 *   UpdateAdvert  — advert output, an advert of the family spent
 *   RetireAdvert  — advert spent, no valid advert output of the family
 *   PostEscrow    — escrow output in state Open
 *   ClaimEscrow   — escrow output in state Claimed; an escrow of the family spent with Claim
 *   SubmitEscrow  — escrow output in state Submitted; an escrow of the family spent with Submit
 *   AcceptEscrow / ReleaseEscrow — Submitted escrow spent with Accept / Release
 *   ReclaimEscrow — Open or Claimed escrow spent with Reclaim, by anybody
 *   RefundRevokedEscrow — new escrow (Open, Claimed or Submitted) spent with RefundRevoked
 *
 * The redeemer of each escrow input comes from the transaction (decoded with
 * the shared escrow redeemer codec). An escrow input without a redeemer, or
 * with a redeemer that does not fit its prior state, gives no event and a
 * warning; the lineage then reports no terminal state for it (fail closed).
 *
 * Identity records. An output at the identity address that holds tokens of
 * the identity policy changes the records named by the token asset names.
 * The output is the record of `agentId` when it holds exactly one token, with
 * quantity 1, whose asset name is a 32-byte identifier (Part 1 §4).
 *
 * Module-1 disputes. Outputs with an inline datum at the Module-1 claim,
 * challenge and verdict (identity_party) addresses are created watched
 * outputs; a spend of one of them gives a module1Spends entry with its spend
 * redeemer. The dispute view (disputes/module1.ts) decodes them.
 *
 * Jury (jury SPEC §4). An output at a jury address with an inline datum and
 * exactly one token of the deployment's policy (quantity 1) is a jury output:
 * a created watched output and a juryOutputs entry (token name, lovelace). A
 * spend of one gives a jurySpends entry with its spend redeemer. The jury
 * view (jury/view.ts) decodes them.
 *
 * Documents (jury SPEC §10.1). Every transaction, also one that touches no
 * watched address, is checked for a document under metadata label 22084.
 *
 * Outputs created earlier in the same block are known to later transactions.
 */

import {
  decodeAnyAdvertDatum,
  decodeAnyEscrowDatum,
  decodeEscrowRedeemer,
  decodePlutusDataHex,
  encodePlutusDataHex,
  plutusAddressFromBech32,
  type AnyEscrowDatum,
  type EscrowRedeemer,
} from "@marketplace/shared/cbor";
import { isVectorId } from "@marketplace/shared/identity";
import { DOCUMENT_LABEL, parseDocument } from "../documents/document.js";
import type {
  DatumLayout,
  IndexerBlock,
  IndexerTx,
  MarketplaceEvent,
  MarketplaceEventType,
  TxOutput,
} from "./types.js";

export interface KnownUtxoInfo {
  address: string;
  datumHex?: string;
  /** Identity record output: the identifier that its token names. */
  agentId?: string | null;
  /** Module-1 challenge output: its challenge token name. */
  token?: string | null;
  /** Module-1 challenge output: genuine by jury SPEC §11.1. */
  genuine?: boolean | null;
}

export interface ScriptAddresses {
  /** Legacy advert address (13-field datum). Empty: not watched. */
  advertAddress: string;
  /** Legacy escrow address (14-field datum). Empty: not watched. */
  escrowAddress: string;
  /** New advert address (14-field datum with agent_id). */
  identityAdvertAddress?: string;
  /** New escrow address (16-field datum with agent_id and refund). */
  identityEscrowAddress?: string;
  /** Identity registry address `IA` (enterprise address of the identity policy). */
  identityAddress?: string;
  /** Identity registry policy ID (56 lowercase hex). */
  identityPolicyId?: string;
  /** Module-1 claim, challenge and identity_party addresses (empty or absent: not watched). */
  module1Addresses?: string[];
  /** Module-1 challenge address and its script hash (the challenge token policy), for §11.1. */
  module1Challenge?: { address: string; policyId: string };
  /** Jury deployments: the jury address and its script hash (also the token policy). */
  jury?: Array<{ address: string; scriptHash: string }>;
}

/** A watched output that the block creates. */
export interface CreatedUtxo {
  ref: string;
  address: string;
  datumHex: string;
  txHash: string;
  agentId: string | null;
  /** Module-1 challenge output: the challenge token and the §11.1 genuineness. */
  token?: string | null;
  genuine?: boolean | null;
}

/** ChallengeAction.SubmitEvidence (Module-1 types.ak): Constr 1, with any fields. */
function isSubmitEvidence(redeemerHex: string | undefined): boolean {
  if (!redeemerHex) return false;
  try {
    const d = decodePlutusDataHex(redeemerHex);
    return d.kind === "constr" && d.index === 1n;
  } catch {
    return false;
  }
}

/** ChallengeDatum (Module-1 types.ak): 11 fields; field 3 is stake_amount, fields 4 and 5 are evidence_hash and evidence_uri. */
const CHALLENGE_DATUM_FIELDS = 11;
const CHALLENGE_STAKE_FIELD = 3;
const CHALLENGE_EVIDENCE_FIELDS: ReadonlySet<number> = new Set([4, 5]);

/**
 * stake_amount (decimal) of the challenge datum `nextHex` when it is a SubmitEvidence continuation
 * of `previousHex`: every field is kept except evidence_hash and evidence_uri. null otherwise.
 */
function evidenceContinuationStake(previousHex: string | undefined, nextHex: string | undefined): string | null {
  if (!previousHex || !nextHex) return null;
  try {
    const previous = decodePlutusDataHex(previousHex);
    const next = decodePlutusDataHex(nextHex);
    if (previous.kind !== "constr" || next.kind !== "constr" || previous.index !== next.index) return null;
    if (previous.fields.length < CHALLENGE_DATUM_FIELDS || previous.fields.length !== next.fields.length) return null;
    for (let i = 0; i < next.fields.length; i++) {
      if (CHALLENGE_EVIDENCE_FIELDS.has(i)) continue;
      if (encodePlutusDataHex(previous.fields[i]!) !== encodePlutusDataHex(next.fields[i]!)) return null;
    }
    const stake = next.fields[CHALLENGE_STAKE_FIELD]!;
    return stake.kind === "int" ? stake.value.toString() : null;
  } catch {
    return null;
  }
}

const SCRIPT_HASH_CACHE = new Map<string, string | null>();
const SCRIPT_HASH_CACHE_MAX = 10_000;

/**
 * The script hash of the payment credential of a bech32 address; null for a key credential and for an
 * address without a Plutus Address form (Byron, reward). Module-1 checks only the payment credential of
 * an output (`find_output_at_script` and `outputs_at_script`, utils.ak), so the stake credential does not count.
 */
function paymentScriptHash(address: string): string | null {
  const cached = SCRIPT_HASH_CACHE.get(address);
  if (cached !== undefined) return cached;
  let hash: string | null = null;
  try {
    const credential = plutusAddressFromBech32(address).paymentCredential;
    hash = credential.type === "Script" ? credential.hash.toLowerCase() : null;
  } catch {
    hash = null;
  }
  if (SCRIPT_HASH_CACHE.size >= SCRIPT_HASH_CACHE_MAX) SCRIPT_HASH_CACHE.clear();
  SCRIPT_HASH_CACHE.set(address, hash);
  return hash;
}

/** The Module-1 scripts of the configuration: payment script hash → the configured (enterprise) address of that script. */
interface Module1Scripts {
  byScript: Map<string, string>;
  addresses: Set<string>;
}

const NO_MODULE1: Module1Scripts = { byScript: new Map(), addresses: new Set() };
const MODULE1_SCRIPTS = new WeakMap<readonly string[], Module1Scripts>();

function module1Scripts(addresses: ScriptAddresses): Module1Scripts {
  const configured = addresses.module1Addresses;
  if (!configured || configured.length === 0) return NO_MODULE1;
  let found = MODULE1_SCRIPTS.get(configured);
  if (!found) {
    found = { byScript: new Map(), addresses: new Set(configured) };
    for (const address of configured) {
      const script = paymentScriptHash(address);
      if (script !== null) found.byScript.set(script, address);
    }
    MODULE1_SCRIPTS.set(configured, found);
  }
  return found;
}

/**
 * The index of the first output of a transaction whose payment credential is Script(`scriptHash`),
 * whatever its stake credential, datum or value. This is how Module-1 finds the output that a
 * challenge spend checks (`find_output_at_script`). -1 when there is none.
 */
function firstOutputAtScript(outputs: TxOutput[], scriptHash: string): number {
  return outputs.findIndex((o) => paymentScriptHash(o.address) === scriptHash);
}

/**
 * Jury SPEC §11.1: a challenge output is genuine by one of two rules. The result is kept for each
 * output, so a chain of any number of SubmitEvidence steps is checked step by step.
 *   1. Its transaction minted exactly one token of the challenge policy (one entry, +1, no other
 *      entry of the policy) and the output holds it. OpenChallenge allows one output at the script.
 *   2. Its transaction spent a genuine challenge output with SubmitEvidence and minted or burned no
 *      token of the policy, and the output
 *        - holds the same token,
 *        - is the FIRST output of the transaction at the challenge script (SPEC §11.1 rule 2),
 *        - keeps every datum field of the spent output except evidence_hash and evidence_uri, and
 *        - holds exactly its stake_amount lovelace (Amendment 6).
 * `index` is the position of `output` in the transaction outputs.
 */
function challengeGenuineness(
  tx: IndexerTx,
  index: number,
  output: TxOutput,
  policyId: string,
  spentChallenges: SpentInput[],
): { token: string | null; genuine: boolean } {
  const held = policyAssets(output.value, policyId).filter(([, qty]) => qty === 1).map(([name]) => name);
  const minted = Object.entries(tx.mint?.[policyId] ?? {});
  if (minted.length === 1 && minted[0]![1] === 1 && held.includes(minted[0]![0])) {
    return { token: minted[0]![0], genuine: true };
  }
  if (minted.length === 0) {
    const source = spentChallenges.find((s) =>
      s.prior.genuine === true && s.prior.token && held.includes(s.prior.token) &&
      isSubmitEvidence(tx.spendRedeemers?.[s.ref]));
    if (
      source &&
      firstOutputAtScript(tx.outputs ?? [], policyId) === index &&
      evidenceContinuationStake(source.prior.datumHex, output.datum) === lovelaceOf(output.value)
    ) {
      return { token: source.prior.token!, genuine: true };
    }
  }
  return { token: held.length === 1 ? held[0]! : null, genuine: false };
}

/** A spend of a Module-1 output, with its spend redeemer (Plutus Data CBOR hex) when the transaction has one. */
export interface Module1Spend {
  ref: string;
  slot: number;
  txHash: string;
  redeemerHex: string | null;
}

/** A document that a transaction carries under label 22084 (jury SPEC §10.1). */
export interface CapturedDocument {
  txHash: string;
  type: string;
  mediaType: string;
  /** blake2b-256 of `bytes` (64 lowercase hex). */
  hash: string;
  bytes: Uint8Array;
}

/** A jury output: also a created watched output (its datum is there). */
export interface JuryOutput {
  ref: string;
  /** Script hash of the deployment. */
  deployment: string;
  /** The jury token name (hex). */
  token: string;
  /** Lovelace in the output (decimal). */
  lovelace: string;
}

/** A spend of a jury output, with its spend redeemer (Plutus Data CBOR hex) when the transaction has one. */
export type JurySpend = Module1Spend;

export interface ProcessBlockResult {
  events: MarketplaceEvent[];
  spentRefs: Array<{ ref: string; slot: number; txHash: string }>;
  /** Watched outputs in block order. Insert them before the spends are applied. */
  created: CreatedUtxo[];
  /** Identifiers whose identity record the block changed (sorted, unique). */
  identityChanges: string[];
  /** Spends of Module-1 outputs. Apply them with the other spends. */
  module1Spends: Module1Spend[];
  /** Jury outputs (also in `created`). */
  juryOutputs: JuryOutput[];
  /** Spends of jury outputs. */
  jurySpends: JurySpend[];
  /** Documents of the block's transactions, in block order. */
  documents: CapturedDocument[];
}

interface Family {
  layout: DatumLayout;
  address: string;
}

interface SpentInput {
  ref: string;
  prior: KnownUtxoInfo;
}

interface WatchedOutput {
  index: number;
  address: string;
  datumHex: string;
}

interface TxContext {
  tx: IndexerTx;
  slot: number;
  requiredSigners: string[];
  events: MarketplaceEvent[];
}

function families(legacy: string, identity: string | undefined): Family[] {
  const out: Family[] = [];
  if (legacy) out.push({ layout: "legacy", address: legacy });
  if (identity) out.push({ layout: "identity", address: identity });
  return out;
}

function isAdvertDatumAt(datumHex: string, family: Family): boolean {
  try {
    const decoded = decodeAnyAdvertDatum(datumHex);
    if (decoded.layout === family.layout) return true;
    console.warn(`[blockProcessor] ${decoded.layout} advert datum at the ${family.layout} advert address; ignored`);
  } catch (err) {
    console.warn(`[blockProcessor] failed to decode AdvertDatum: ${(err as Error).message}`);
  }
  return false;
}

function decodeEscrowAt(datumHex: string, family: Family): AnyEscrowDatum | null {
  try {
    const decoded = decodeAnyEscrowDatum(datumHex);
    if (decoded.layout === family.layout) return decoded;
    console.warn(`[blockProcessor] ${decoded.layout} escrow datum at the ${family.layout} escrow address; ignored`);
  } catch (err) {
    console.warn(`[blockProcessor] failed to decode EscrowDatum: ${(err as Error).message}`);
  }
  return null;
}

function redeemerOf(tx: IndexerTx, ref: string): EscrowRedeemer | null {
  const hex = tx.spendRedeemers?.[ref];
  if (hex === undefined) return null;
  try {
    return decodeEscrowRedeemer(hex);
  } catch (err) {
    console.warn(`[blockProcessor] escrow spend ${ref}: redeemer does not decode: ${(err as Error).message}`);
    return null;
  }
}

/** Terminal event for a spent escrow, or null when the redeemer does not fit the prior state. */
function terminalEvent(layout: DatumLayout, priorState: string, redeemer: EscrowRedeemer["type"]): MarketplaceEventType | null {
  if (redeemer === "RefundRevoked") {
    return layout === "identity" && (priorState === "Open" || priorState === "Claimed" || priorState === "Submitted")
      ? "RefundRevokedEscrow"
      : null;
  }
  if (priorState === "Submitted") {
    if (redeemer === "Accept") return "AcceptEscrow";
    if (redeemer === "Release") return "ReleaseEscrow";
    return null;
  }
  if (priorState === "Open" || priorState === "Claimed") {
    return redeemer === "Reclaim" ? "ReclaimEscrow" : null;
  }
  return null;
}

function pushEvent(
  ctx: TxContext,
  type: MarketplaceEventType,
  utxoRef: string,
  datumHex: string,
  address: string,
  layout: DatumLayout,
): void {
  ctx.events.push({
    type,
    slot: ctx.slot,
    txHash: ctx.tx.id,
    utxoRef,
    datumHex,
    address,
    layout,
    requiredSigners: ctx.requiredSigners,
  });
}

function processAdverts(ctx: TxContext, family: Family, spent: SpentInput[], outputs: WatchedOutput[]): void {
  const valid = outputs.filter((o) => isAdvertDatumAt(o.datumHex, family));
  if (valid.length > 0) {
    const type: MarketplaceEventType = spent.length > 0 ? "UpdateAdvert" : "PostAdvert";
    for (const out of valid) {
      pushEvent(ctx, type, `${ctx.tx.id}#${out.index}`, out.datumHex, out.address, family.layout);
    }
    return;
  }
  // Spend with no valid continuing advert of the family → RetireAdvert.
  for (const s of spent) {
    pushEvent(ctx, "RetireAdvert", s.ref, s.prior.datumHex ?? "", s.prior.address, family.layout);
  }
}

function processEscrows(ctx: TxContext, family: Family, spent: SpentInput[], outputs: WatchedOutput[]): void {
  const inputs = spent.map((s) => ({
    ...s,
    decoded: s.prior.datumHex ? decodeEscrowAt(s.prior.datumHex, family) : null,
    redeemer: redeemerOf(ctx.tx, s.ref),
  }));
  const claimed = inputs.some((i) => i.redeemer?.type === "Claim");
  const submitted = inputs.some((i) => i.redeemer?.type === "Submit");

  for (const out of outputs) {
    const decoded = decodeEscrowAt(out.datumHex, family);
    if (!decoded) continue;
    const state = decoded.datum.state;
    const type: MarketplaceEventType | null =
      state === "Open" ? "PostEscrow"
        : state === "Claimed" && claimed ? "ClaimEscrow"
          : state === "Submitted" && submitted ? "SubmitEscrow"
            : null;
    if (type) pushEvent(ctx, type, `${ctx.tx.id}#${out.index}`, out.datumHex, out.address, family.layout);
  }

  for (const input of inputs) {
    if (!input.decoded) continue;
    const priorState = input.decoded.datum.state;
    if (!input.redeemer) {
      console.warn(
        `[blockProcessor] escrow spend ${input.ref} (priorState=${priorState}) in tx ${ctx.tx.id} carried no escrow redeemer; emitting no event`,
      );
      continue;
    }
    const redeemer = input.redeemer.type;
    if (redeemer === "Claim" || redeemer === "Submit") continue; // continuation, reported by its output
    const type = terminalEvent(family.layout, priorState, redeemer);
    if (type === null) {
      console.warn(
        `[blockProcessor] redeemer/state mismatch on escrow spend ${input.ref}: redeemer=${redeemer} but priorState=${priorState} (${family.layout}); emitting no event`,
      );
      continue;
    }
    pushEvent(ctx, type, input.ref, input.prior.datumHex ?? "", input.prior.address, family.layout);
  }
}

/** Asset names (hex) of `policyId` with a non-zero quantity in an Ogmios value, and the quantities. */
function policyAssets(value: Record<string, unknown>, policyId: string): Array<[string, number]> {
  const assets = value[policyId];
  if (typeof assets !== "object" || assets === null) return [];
  return Object.entries(assets as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] !== 0)
    .map(([name, qty]) => [name.toLowerCase(), qty]);
}

/** Lovelace of an Ogmios v6 value (`{ ada: { lovelace } }`), as a decimal string. */
function lovelaceOf(value: Record<string, unknown>): string {
  const ada = value.ada as { lovelace?: unknown } | undefined;
  return typeof ada?.lovelace === "number" && Number.isSafeInteger(ada.lovelace) ? String(ada.lovelace) : "0";
}

function processTx(
  tx: IndexerTx,
  slot: number,
  known: Map<string, KnownUtxoInfo>,
  addresses: ScriptAddresses,
  result: ProcessBlockResult,
  identityChanges: Set<string>,
): void {
  const ctx: TxContext = {
    tx,
    slot,
    requiredSigners: (tx.requiredSigners ?? []).map((h) => h.toLowerCase()),
    events: result.events,
  };
  const advertFamilies = families(addresses.advertAddress, addresses.identityAdvertAddress);
  const escrowFamilies = families(addresses.escrowAddress, addresses.identityEscrowAddress);
  const identityAddress = addresses.identityPolicyId ? addresses.identityAddress : undefined;

  // 1) Spent inputs that hit known watched UTxOs.
  const spent: SpentInput[] = [];
  for (const input of tx.inputs ?? []) {
    const ref = `${input.transaction.id}#${input.index}`;
    const prior = known.get(ref);
    if (!prior) continue;
    result.spentRefs.push({ ref, slot, txHash: tx.id });
    spent.push({ ref, prior });
  }

  // 2) Outputs with an inline datum at the advert and escrow addresses.
  const outputs = (tx.outputs ?? []).map((o: TxOutput, index) => ({ o, index }));
  const watched: WatchedOutput[] = outputs
    .filter(({ o }) => o.datum && [...advertFamilies, ...escrowFamilies].some((f) => f.address === o.address))
    .map(({ o, index }) => ({ index, address: o.address, datumHex: o.datum! }));

  for (const family of advertFamilies) {
    processAdverts(
      ctx,
      family,
      spent.filter((s) => s.prior.address === family.address),
      watched.filter((w) => w.address === family.address),
    );
  }
  for (const family of escrowFamilies) {
    processEscrows(
      ctx,
      family,
      spent.filter((s) => s.prior.address === family.address),
      watched.filter((w) => w.address === family.address),
    );
  }

  const created: CreatedUtxo[] = watched.map((w) => ({
    ref: `${tx.id}#${w.index}`,
    address: w.address,
    datumHex: w.datumHex,
    txHash: tx.id,
    agentId: null,
  }));

  // 2b) Module-1 dispute outputs (claim, challenge, verdict) and their spends. Module-1 checks only the
  // payment credential of an output (Amendment 8), so an output counts when its payment credential is the
  // script of the claim, challenge or verdict address, with any stake credential. The row keeps the
  // configured (enterprise) address of that script.
  const module1 = module1Scripts(addresses);
  if (module1.addresses.size > 0) {
    for (const s of spent) {
      if (!module1.addresses.has(s.prior.address)) continue;
      result.module1Spends.push({ ref: s.ref, slot, txHash: tx.id, redeemerHex: tx.spendRedeemers?.[s.ref] ?? null });
    }
    const challenge = addresses.module1Challenge;
    for (const { o, index } of outputs) {
      if (!o.datum) continue;
      const script = paymentScriptHash(o.address);
      const address = script === null ? undefined : module1.byScript.get(script);
      if (address === undefined) continue;
      const marks = challenge && script === challenge.policyId
        ? challengeGenuineness(tx, index, o, challenge.policyId, spent.filter((s) => s.prior.address === address))
        : {};
      created.push({ ref: `${tx.id}#${index}`, address, datumHex: o.datum, txHash: tx.id, agentId: null, ...marks });
    }
  }

  // 2c) Jury outputs (one token of the deployment's policy, inline datum) and their spends.
  for (const deployment of addresses.jury ?? []) {
    for (const s of spent) {
      if (s.prior.address !== deployment.address) continue;
      result.jurySpends.push({ ref: s.ref, slot, txHash: tx.id, redeemerHex: tx.spendRedeemers?.[s.ref] ?? null });
    }
    for (const { o, index } of outputs) {
      if (o.address !== deployment.address || !o.datum) continue;
      const tokens = policyAssets(o.value, deployment.scriptHash);
      if (tokens.length !== 1 || tokens[0]![1] !== 1) continue;
      const ref = `${tx.id}#${index}`;
      created.push({ ref, address: o.address, datumHex: o.datum, txHash: tx.id, agentId: null });
      result.juryOutputs.push({ ref, deployment: deployment.scriptHash, token: tokens[0]![0], lovelace: lovelaceOf(o.value) });
    }
  }

  // 3) Identity records: spent record outputs and new outputs that hold identity tokens.
  if (identityAddress) {
    for (const s of spent) {
      if (s.prior.address === identityAddress && s.prior.agentId) identityChanges.add(s.prior.agentId);
    }
    for (const { o, index } of outputs) {
      if (o.address !== identityAddress) continue;
      const tokens = policyAssets(o.value, addresses.identityPolicyId!);
      if (tokens.length === 0) continue;
      for (const [name] of tokens) if (isVectorId(name)) identityChanges.add(name);
      const [only] = tokens;
      const agentId = tokens.length === 1 && only![1] === 1 && isVectorId(only![0]) ? only![0] : null;
      created.push({ ref: `${tx.id}#${index}`, address: o.address, datumHex: o.datum ?? "", txHash: tx.id, agentId });
    }
  }

  // 4) Later transactions of the same block see this transaction's effects.
  for (const s of spent) known.delete(s.ref);
  for (const c of created) {
    known.set(c.ref, { address: c.address, datumHex: c.datumHex, agentId: c.agentId, token: c.token, genuine: c.genuine });
  }
  result.created.push(...created);

  // 5) A document under label 22084, whatever addresses the transaction touches.
  const metadatum = tx.metadata?.[DOCUMENT_LABEL];
  if (metadatum) {
    const parsed = parseDocument(metadatum);
    if (parsed.ok) {
      const { type, mediaType, hash, bytes } = parsed.document;
      result.documents.push({ txHash: tx.id, type, mediaType, hash, bytes });
    } else {
      console.warn(`[blockProcessor] tx ${tx.id}: metadata label ${DOCUMENT_LABEL} is not a document (${parsed.reason})`);
    }
  }
}

export function processBlock(
  block: IndexerBlock,
  knownUtxos: Map<string, KnownUtxoInfo>,
  addresses: ScriptAddresses,
): ProcessBlockResult {
  const result: ProcessBlockResult = {
    events: [], spentRefs: [], created: [], identityChanges: [], module1Spends: [], juryOutputs: [], jurySpends: [], documents: [],
  };

  // Byron / null transactions → graceful no-op
  if (!block || !block.transactions) {
    return result;
  }

  const known = new Map(knownUtxos);
  const identityChanges = new Set<string>();
  for (const tx of block.transactions) {
    if (!tx) continue;
    processTx(tx, block.slot, known, addresses, result, identityChanges);
  }
  result.identityChanges = [...identityChanges].sort();
  return result;
}
