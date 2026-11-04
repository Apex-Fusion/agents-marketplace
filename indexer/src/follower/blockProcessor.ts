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
 * Outputs created earlier in the same block are known to later transactions.
 */

import {
  decodeAnyAdvertDatum,
  decodeAnyEscrowDatum,
  decodeEscrowRedeemer,
  type AnyEscrowDatum,
  type EscrowRedeemer,
} from "@marketplace/shared/cbor";
import { isVectorId } from "@marketplace/shared/identity";
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
}

/** A watched output that the block creates. */
export interface CreatedUtxo {
  ref: string;
  address: string;
  datumHex: string;
  txHash: string;
  agentId: string | null;
}

/** A spend of a Module-1 output, with its spend redeemer (Plutus Data CBOR hex) when the transaction has one. */
export interface Module1Spend {
  ref: string;
  slot: number;
  txHash: string;
  redeemerHex: string | null;
}

export interface ProcessBlockResult {
  events: MarketplaceEvent[];
  spentRefs: Array<{ ref: string; slot: number; txHash: string }>;
  /** Watched outputs in block order. Insert them before the spends are applied. */
  created: CreatedUtxo[];
  /** Identifiers whose identity record the block changed (sorted, unique). */
  identityChanges: string[];
  /** Spends of Module-1 outputs. Apply them with the other spends. */
  module1Spends: Module1Spend[];
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

  // 2b) Module-1 dispute outputs (claim, challenge, verdict) and their spends.
  const module1 = new Set(addresses.module1Addresses ?? []);
  if (module1.size > 0) {
    for (const s of spent) {
      if (!module1.has(s.prior.address)) continue;
      result.module1Spends.push({ ref: s.ref, slot, txHash: tx.id, redeemerHex: tx.spendRedeemers?.[s.ref] ?? null });
    }
    for (const { o, index } of outputs) {
      if (!o.datum || !module1.has(o.address)) continue;
      created.push({ ref: `${tx.id}#${index}`, address: o.address, datumHex: o.datum, txHash: tx.id, agentId: null });
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
  for (const c of created) known.set(c.ref, { address: c.address, datumHex: c.datumHex, agentId: c.agentId });
  result.created.push(...created);
}

export function processBlock(
  block: IndexerBlock,
  knownUtxos: Map<string, KnownUtxoInfo>,
  addresses: ScriptAddresses,
): ProcessBlockResult {
  const result: ProcessBlockResult = { events: [], spentRefs: [], created: [], identityChanges: [], module1Spends: [] };

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
