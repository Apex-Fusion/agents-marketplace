// The history of one record (Part 1 Sections 7.1 and 7.2): the token transactions of both
// registries, the versions they make, and the outputs each version owns. Everything is read as of
// one ledger tip; transactions in later blocks are left out, so a result depends only on that tip.
// `readHistoryInputs` reads the ledger; `historyAt` builds the history as of a tip from such a read
// and reads nothing, so a read can serve several tips (history-store.ts).

import type { Asset, ChainSource, ChainTip, LedgerTx, TxOutput } from "../chain/types.js";
import { identityDatumFromData, type IdentityDatum } from "../codec/identity-datum.js";
import { legacyDatumFromData, type LegacyDatum } from "../codec/legacy-datum.js";
import { plutusDataEqual, plutusDataFromHex, type PlutusData } from "../codec/plutus-data.js";
import type { Registry, RegistrySettings, ResolverSettings } from "./settings.js";
import { blockTimeMs } from "./time.js";

export type RegistryKind = "identity" | "legacy";
export type Origin = "native" | "adopted" | "legacy";

/** A transaction with the values that the tip and the genesis give it. */
export interface PlacedTx {
  readonly tx: LedgerTx;
  /** Block time, POSIX milliseconds. */
  readonly timeMs: number;
  /** Tip block height minus the block height of the transaction. */
  readonly confirmations: number;
}

/** An authentic record output (Part 1 Section 4). */
export interface RecordOutput {
  readonly at: PlacedTx;
  readonly outputIndex: number;
}

export type LegacyDatumError = "recordDatumInvalid" | "recordDatumUnavailable";

export type VersionContent =
  | { readonly kind: "identity"; readonly datum: IdentityDatum }
  | { readonly kind: "legacy"; readonly datum: LegacyDatum | null; readonly datumError: LegacyDatumError | null }
  /** A legacy deregistration: the end of a legacy record. */
  | { readonly kind: "legacyEnd" };

export interface Version {
  readonly number: number;
  /** The transaction that made the version. */
  readonly made: PlacedTx;
  readonly content: VersionContent;
  /** The record outputs that the version owns, oldest first; empty for the end of a legacy record. */
  readonly owned: readonly RecordOutput[];
}

/** Where a transaction left the record's token. */
export type TokenPlace = "authentic" | "notAuthentic" | "burned";

export interface TokenMove {
  readonly at: PlacedTx;
  readonly place: TokenPlace;
}

export interface RecordHistory {
  readonly vectorId: string;
  readonly origin: Origin;
  /** True when the legacy registry ever minted the identifier (Part 1 Section 7.1 step 4). */
  readonly legacyMinted: boolean;
  /** The transaction that first minted the identifier, in either registry. */
  readonly firstMint: PlacedTx;
  /** The legacy mint of a legacy or adopted record. */
  readonly legacyMint: PlacedTx | null;
  readonly versions: readonly Version[];
  /** Every transaction that moved the record's token (the legacy token, then the identity token), in ledger order. */
  readonly tokenMoves: readonly TokenMove[];
  /** Every transaction of the record's legacy token, in ledger order (the legacy key search, Part 1 Section 8.1). */
  readonly legacyTxs: readonly PlacedTx[];
}

export type HistoryLookup = { readonly found: true; readonly history: RecordHistory } | { readonly found: false; readonly reason: string };

/** The ledger as of one tip: the tip and the values that place transactions in time. */
export interface LedgerSnapshot {
  readonly tip: ChainTip;
  readonly settings: ResolverSettings;
}

export const ledgerOrder = (a: LedgerTx, b: LedgerTx): number => a.blockHeight - b.blockHeight || a.txIndex - b.txIndex;

/** The quantity of one token in a list of assets. */
export const tokenQuantity = (assets: readonly Asset[], policyId: string, assetName: string): bigint =>
  assets.reduce((n, a) => (a.policyId === policyId && a.assetName === assetName ? n + a.quantity : n), 0n);

/** Part 1 Section 4: at the exact registry address, with exactly one token of the policy, named by the identifier. */
export function isAuthentic(output: { address: string; assets: readonly Asset[] }, registry: Registry, vectorId: string): boolean {
  if (output.address !== registry.address) return false;
  const ofPolicy = output.assets.filter((a) => a.policyId === registry.policyId);
  return ofPolicy.length === 1 && ofPolicy[0]!.assetName === vectorId && ofPolicy[0]!.quantity === 1n;
}

/** A datum as far as the ledger shows it: the decoded data, or the bytes or hash when it does not decode. */
interface DatumValue {
  readonly data: PlutusData | null;
  readonly cbor: string | null;
  readonly hash: string | null;
}

/** Part 1 Section 7.2: a new version starts when the datum differs, as Plutus Data, from the previous record output. */
function sameDatum(a: DatumValue, b: DatumValue): boolean {
  if (a.data && b.data) return plutusDataEqual(a.data, b.data);
  if (a.cbor !== null && b.cbor !== null) return a.cbor === b.cbor;
  return a.hash !== null && a.hash === b.hash;
}

function datumValue(output: TxOutput, known: ReadonlyMap<string, string>): DatumValue {
  const cbor = output.inlineDatum ?? (output.datumHash === null ? null : (known.get(output.datumHash) ?? null));
  let data: PlutusData | null = null;
  if (cbor !== null) {
    try {
      data = plutusDataFromHex(cbor);
    } catch {
      data = null;
    }
  }
  return { data, cbor, hash: output.datumHash };
}

function legacyContent(value: DatumValue): VersionContent {
  if (value.cbor === null) return { kind: "legacy", datum: null, datumError: "recordDatumUnavailable" };
  try {
    if (value.data === null) throw new Error("not Plutus Data");
    return { kind: "legacy", datum: legacyDatumFromData(value.data), datumError: null };
  } catch {
    return { kind: "legacy", datum: null, datumError: "recordDatumInvalid" };
  }
}

function identityContent(output: TxOutput, value: DatumValue): VersionContent {
  // The identity contract writes only valid inline datums (Part 2 Section 3.2), so anything else
  // is a broken ledger read or a broken contract, not a record state the resolver can show.
  if (output.inlineDatum === null || value.data === null) throw new Error("identity record output without a decodable inline datum");
  return { kind: "identity", datum: identityDatumFromData(value.data) };
}

/**
 * What the history of one identifier is built from: the token transactions of both registries
 * (also those after any tip) and the datums by hash of their legacy record outputs, as the ledger
 * source showed them at one read.
 */
export interface HistoryInputs {
  /** Transactions of the legacy token. */
  readonly legacy: ReadonlySet<string>;
  /** Transactions of the identity token. */
  readonly identity: ReadonlySet<string>;
  /** Every transaction of both tokens, in ledger order. */
  readonly txs: readonly LedgerTx[];
  /** Datum CBOR by hash, for legacy record outputs that carry only a datum hash. */
  readonly datums: ReadonlyMap<string, string>;
}

/** Reads the transactions of both tokens and the datums by hash that their legacy record outputs need; checks that the source returned every listed transaction. */
export async function readHistoryInputs(chain: ChainSource, registries: RegistrySettings, vectorId: string): Promise<HistoryInputs> {
  const { identity, legacy } = registries;
  const [legacyHashes, identityHashes] = await Promise.all([
    chain.assetTxHashes(legacy.policyId, vectorId),
    identity ? chain.assetTxHashes(identity.policyId, vectorId) : Promise.resolve([]),
  ]);
  const wanted = [...new Set([...legacyHashes, ...identityHashes])];
  const fetched = wanted.length ? await chain.transactions(wanted) : [];
  const byHash = new Map(fetched.map((t) => [t.txHash, t]));
  if (wanted.some((h) => !byHash.has(h))) throw new Error("the ledger source listed token transactions that it cannot return");
  const txs = [...byHash.values()].sort(ledgerOrder);
  const legacyTxs = new Set(legacyHashes);
  const missing = txs.flatMap((tx) =>
    legacyTxs.has(tx.txHash)
      ? tx.outputs.filter((o) => isAuthentic(o, legacy, vectorId) && o.inlineDatum === null && o.datumHash !== null).map((o) => o.datumHash!)
      : [],
  );
  const datums = missing.length ? await chain.datums([...new Set(missing)]) : new Map<string, string>();
  return { legacy: legacyTxs, identity: new Set(identityHashes), txs, datums };
}

/** Part 1 Section 7.1 steps 4-6 and Section 7.2, for one identifier: reads the ledger, then builds the history as of the snapshot's tip. */
export async function loadHistory(chain: ChainSource, snapshot: LedgerSnapshot, vectorId: string): Promise<HistoryLookup> {
  return historyAt(snapshot, vectorId, await readHistoryInputs(chain, snapshot.settings.registries, vectorId));
}

/** The history as of the snapshot's tip, from a read of the ledger made after the tip was read. */
export function historyAt(snapshot: LedgerSnapshot, vectorId: string, inputs: HistoryInputs): HistoryLookup {
  const { tip, settings } = snapshot;
  const { identity, legacy } = settings.registries;
  // Transactions after the tip came in after the tip was read; the result describes the tip.
  const tokenTxs = { legacy: inputs.legacy, identity: inputs.identity, txs: inputs.txs.filter((t) => t.blockHeight <= tip.blockHeight) };
  const place = (tx: LedgerTx): PlacedTx => ({
    tx,
    timeMs: blockTimeMs(tx.slot, settings.network),
    confirmations: tip.blockHeight - tx.blockHeight,
  });

  const legacyMintTx = tokenTxs.txs.find((t) => tokenQuantity(t.mint, legacy.policyId, vectorId) > 0n) ?? null;
  const identityMintTx = identity ? (tokenTxs.txs.find((t) => tokenQuantity(t.mint, identity.policyId, vectorId) > 0n) ?? null) : null;

  let origin: Origin;
  if (identityMintTx) {
    origin = tokenQuantity(identityMintTx.mint, legacy.policyId, vectorId) < 0n ? "adopted" : "native";
    if (origin === "adopted" && legacyMintTx === null) throw new Error("an adoption burned a legacy token that was never minted");
  } else if (legacyMintTx) {
    const cutoff = settings.registries.cutoffSlot;
    if (cutoff !== null && legacyMintTx.slot >= cutoff) return { found: false, reason: "the legacy registry minted the identifier at or after the cutoff slot" };
    origin = "legacy";
  } else {
    return { found: false, reason: "no registry minted the identifier" };
  }

  // The transactions that belong to the record, each with the registry whose token it moves.
  const steps: Array<{ tx: LedgerTx; registry: RegistryKind }> = [];
  if (origin !== "native") {
    const end = origin === "adopted" ? identityMintTx : null;
    for (const tx of tokenTxs.txs) {
      if (!tokenTxs.legacy.has(tx.txHash) || ledgerOrder(tx, legacyMintTx!) < 0) continue;
      if (end && ledgerOrder(tx, end) >= 0) break;
      steps.push({ tx, registry: "legacy" });
    }
  }
  if (identityMintTx) {
    for (const tx of tokenTxs.txs) {
      if (tokenTxs.identity.has(tx.txHash) && ledgerOrder(tx, identityMintTx) >= 0) steps.push({ tx, registry: "identity" });
    }
  }

  // Datums by hash for legacy record outputs that carry only a datum hash.
  const known = inputs.datums;

  const versions: Array<Version & { owned: RecordOutput[] }> = [];
  const tokenMoves: TokenMove[] = [];
  let previous: DatumValue | null = null;
  let ended = false;
  for (const { tx, registry } of steps) {
    if (ended) break;
    const reg = registry === "legacy" ? legacy : identity!;
    const at = place(tx);
    const holders = tx.outputs.filter((o) => tokenQuantity(o.assets, reg.policyId, vectorId) > 0n);
    const record = holders.find((o) => isAuthentic(o, reg, vectorId));
    if (record) {
      tokenMoves.push({ at, place: "authentic" });
      const value = datumValue(record, known);
      const adoption = registry === "identity" && origin === "adopted" && tx === identityMintTx;
      const last = versions[versions.length - 1];
      if (!last || adoption || previous === null || !sameDatum(value, previous)) {
        const content = registry === "identity" ? identityContent(record, value) : legacyContent(value);
        versions.push({ number: versions.length, made: at, content, owned: [{ at, outputIndex: record.outputIndex }] });
      } else {
        last.owned.push({ at, outputIndex: record.outputIndex });
      }
      previous = value;
    } else if (holders.length > 0) {
      tokenMoves.push({ at, place: "notAuthentic" });
    } else if (tokenQuantity(tx.mint, reg.policyId, vectorId) < 0n) {
      if (registry === "identity") throw new Error("an identity token was burned");
      tokenMoves.push({ at, place: "burned" });
      versions.push({ number: versions.length, made: at, content: { kind: "legacyEnd" }, owned: [] });
      ended = true;
    }
    // Otherwise the transaction did not move the token (for example, it only lists it as collateral).
  }
  if (versions.length === 0) return { found: false, reason: "no authentic record output exists" };

  const firstMintTx = [legacyMintTx, identityMintTx].filter((t): t is LedgerTx => t !== null).sort(ledgerOrder)[0]!;
  return {
    found: true,
    history: {
      vectorId,
      origin,
      legacyMinted: legacyMintTx !== null,
      firstMint: place(firstMintTx),
      legacyMint: origin === "native" || legacyMintTx === null ? null : place(legacyMintTx),
      versions,
      tokenMoves,
      legacyTxs: steps.filter((s) => s.registry === "legacy").map((s) => place(s.tx)),
    },
  };
}
