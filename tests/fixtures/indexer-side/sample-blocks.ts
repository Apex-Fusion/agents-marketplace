/**
 * tests/fixtures/indexer-side/sample-blocks.ts — synthetic block builders for indexer tests.
 *
 * Builds mock Ogmios-shaped blocks/txs encoding all marketplace events.
 * Mirrors apex-dashboard's chain-sync-data.ts pattern.
 *
 * INDEPENDENCE rule: these builders are indexer-side only.
 * NO shared helpers with buyer-side or supplier-side fixture builders.
 * Both sides must derive from the spec independently.
 *
 * Script hashes are taken from contracts/marketplace/plutus.json:
 *   ADVERT_SCRIPT_HASH = "9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da"
 *   ESCROW_SCRIPT_HASH = "810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912"
 *
 * Addresses are DERIVED addresses for testnet (networkId = 0).
 * For tests we use stable synthetic addresses matching the script hashes.
 *
 * M1-D-fix: Added EscrowRedeemerTag inline (mirrors indexer/src/follower/types.ts).
 * All terminal-spend builders now attach tx.redeemers per the redeemer plumbing spec.
 * Added buildAmbiguousSubmittedSpendTx for fallback / warn tests.
 */

import { Tag } from "cbor-x";
import { encodePlutus } from "../../../packages/shared/src/cbor/plutus-encoder.js";

// ─── EscrowRedeemerTag (mirrors indexer/src/follower/types.ts) ──────────────
// Declared here as a const-type so fixture files are self-contained.
// Catherine's M1-D-fix-green will make blockProcessor.ts consume the one from types.ts.
export type EscrowRedeemerTag = "Claim" | "Submit" | "Accept" | "Reclaim" | "Release";

// ─── Script hashes from contracts/marketplace/plutus.json ──────────────────
export const ADVERT_SCRIPT_HASH = "9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da";
export const ESCROW_SCRIPT_HASH = "810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912";

// Synthetic testnet script addresses (stable for tests — Catherine derives real ones on boot).
export const ADVERT_SCRIPT_ADDRESS = "addr_test1wrffe0nxamt5nmpck6qgpd07k5kdgdfcftmw034g4n4f2yqstmzm7";
export const ESCROW_SCRIPT_ADDRESS = "addr_test1wpqwuq9xfmqpneyz7ft5k3pw0n0mt7qp7dp25esfy08xffqjrh3z6";

// ─── Test identities ────────────────────────────────────────────────────────
// Derived independently from ARCHITECTURE.md. MUST NOT share values with
// buyer-side or supplier-side fixture files.
export const INDEXER_SUPPLIER_PKH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const INDEXER_BUYER_PKH    = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
export const INDEXER_SUPPLIER_ENDPOINT = "https://indexer-test-supplier.example.com";

// ─── Helpers ────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function plutusTag(tagNumber: number, value: unknown): Tag {
  return new (Tag as unknown as new (a: unknown, b: unknown) => Tag)(tagNumber, value);
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ─── AdvertDatum builder ────────────────────────────────────────────────────

export interface AdvertDatumOpts {
  supplierPkh?: string;
  capabilityId?: string;
  model?: string;
  maxOutputTokens?: number;
  maxProcessingMs?: number;
  priceLovelace?: bigint;
  supplierBondLovelace?: bigint;
  buyerBondLovelace?: bigint;
  endpointUrl?: string;
  detailUri?: string;
  detailHash?: string;
  advertisedAt?: number;
  status?: "Active" | "Retired";
}

export function buildAdvertDatumHex(opts: AdvertDatumOpts = {}): string {
  const supplierPkh = opts.supplierPkh ?? INDEXER_SUPPLIER_PKH;
  const capabilityId = opts.capabilityId ?? "llm.text.generate.v1";
  const model = opts.model ?? "qwen2.5:0.5b";
  const maxOutputTokens = opts.maxOutputTokens ?? 512;
  const maxProcessingMs = opts.maxProcessingMs ?? 60_000;
  const priceLovelace = opts.priceLovelace ?? 2_000_000n;
  const supplierBondLovelace = opts.supplierBondLovelace ?? 1_000_000n;
  const buyerBondLovelace = opts.buyerBondLovelace ?? 1_000_000n;
  const endpointUrl = opts.endpointUrl ?? INDEXER_SUPPLIER_ENDPOINT;
  const detailUri = opts.detailUri ?? "ipfs://QmIndexerTest";
  const detailHash = opts.detailHash ?? "b".repeat(64);
  const advertisedAt = opts.advertisedAt ?? 1_750_000_000_000;
  const status = opts.status ?? "Active";

  const statusTag = status === "Active" ? plutusTag(121, []) : plutusTag(122, []);

  const datum = plutusTag(121, [
    hexToBytes(supplierPkh),
    utf8Bytes(capabilityId),
    utf8Bytes(model),
    maxOutputTokens,
    maxProcessingMs,
    priceLovelace,
    supplierBondLovelace,
    buyerBondLovelace,
    utf8Bytes(endpointUrl),
    utf8Bytes(detailUri),
    hexToBytes(detailHash),
    advertisedAt,
    statusTag,
  ]);

  return bytesToHex(encodePlutus(datum));
}

// ─── EscrowDatum builder ────────────────────────────────────────────────────

export type EscrowStateTag = "Open" | "Claimed" | "Submitted" | "Accepted" | "Reclaimed" | "Released";

const ESCROW_STATE_MAP: Record<EscrowStateTag, number> = {
  Open: 121,
  Claimed: 122,
  Submitted: 123,
  Accepted: 124,
  Reclaimed: 125,
  Released: 126,
};

export const SAMPLE_ADVERT_REF_TX = "a".repeat(64);
export const SAMPLE_ADVERT_REF_INDEX = 0;
export const SAMPLE_DELIVER_BY = 1_750_000_600_000;   // posted_at + 600s
export const SAMPLE_POSTED_AT  = 1_750_000_000_000;
export const SAMPLE_SUBMITTED_AT = 1_750_000_120_000;
export const SAMPLE_RECEIPT_HASH = "d".repeat(64);
export const SAMPLE_REQUEST_SPEC_HASH = "e".repeat(64);
export const SAMPLE_PROMPT_HASH = "f".repeat(64);

export interface EscrowDatumOpts {
  buyerPkh?: string;
  supplierPkh?: string;
  advertRefTx?: string;
  advertRefIndex?: number;
  capabilityId?: string;
  requestSpecHash?: string;
  promptHash?: string;
  paymentLovelace?: bigint;
  buyerBondLovelace?: bigint;
  supplierBondLovelace?: bigint;
  deliverBy?: number;
  postedAt?: number;
  submittedAt?: number | null;
  resultReceiptHash?: string | null;
  state?: EscrowStateTag;
}

export function buildEscrowDatumHex(opts: EscrowDatumOpts = {}): string {
  const buyerPkh = opts.buyerPkh ?? INDEXER_BUYER_PKH;
  const supplierPkh = opts.supplierPkh ?? INDEXER_SUPPLIER_PKH;
  const advertRefTx = opts.advertRefTx ?? SAMPLE_ADVERT_REF_TX;
  const advertRefIndex = opts.advertRefIndex ?? SAMPLE_ADVERT_REF_INDEX;
  const capabilityId = opts.capabilityId ?? "llm.text.generate.v1";
  const requestSpecHash = opts.requestSpecHash ?? SAMPLE_REQUEST_SPEC_HASH;
  const promptHash = opts.promptHash ?? SAMPLE_PROMPT_HASH;
  const paymentLovelace = opts.paymentLovelace ?? 2_000_000n;
  const buyerBondLovelace = opts.buyerBondLovelace ?? 1_000_000n;
  const supplierBondLovelace = opts.supplierBondLovelace ?? 1_000_000n;
  const deliverBy = opts.deliverBy ?? SAMPLE_DELIVER_BY;
  const postedAt = opts.postedAt ?? SAMPLE_POSTED_AT;
  const submittedAt = opts.submittedAt !== undefined ? opts.submittedAt : null;
  const resultReceiptHash = opts.resultReceiptHash !== undefined ? opts.resultReceiptHash : null;
  const state = opts.state ?? "Open";

  const advertRef = plutusTag(121, [hexToBytes(advertRefTx), advertRefIndex]);
  const submittedAtOpt = submittedAt === null
    ? plutusTag(122, [])
    : plutusTag(121, [submittedAt]);
  const receiptHashOpt = resultReceiptHash === null
    ? plutusTag(122, [])
    : plutusTag(121, [hexToBytes(resultReceiptHash)]);
  const stateTag = plutusTag(ESCROW_STATE_MAP[state], []);

  const datum = plutusTag(121, [
    hexToBytes(buyerPkh),
    hexToBytes(supplierPkh),
    advertRef,
    utf8Bytes(capabilityId),
    hexToBytes(requestSpecHash),
    hexToBytes(promptHash),
    paymentLovelace,
    buyerBondLovelace,
    supplierBondLovelace,
    deliverBy,
    postedAt,
    submittedAtOpt,
    receiptHashOpt,
    stateTag,
  ]);

  return bytesToHex(encodePlutus(datum));
}

// ─── Block / Tx builders ─────────────────────────────────────────────────────

export interface MockTxOutput {
  address: string;
  value: Record<string, unknown>;
  datum?: string;
}

export interface MockTxInput {
  transaction: { id: string };
  index: number;
}

export interface MockTx {
  id: string;
  inputs: MockTxInput[];
  outputs: MockTxOutput[];
  /** Optional redeemer map: "<spentTxHash>#<outputIndex>" → EscrowRedeemerTag */
  redeemers?: Record<string, EscrowRedeemerTag>;
}

export interface MockBlock {
  slot: number;
  id: string;
  ancestor: string;
  transactions: MockTx[];
}

export function buildMockBlock(opts: {
  slot: number;
  id?: string;
  ancestor?: string;
  transactions?: MockTx[];
}): MockBlock {
  return {
    slot: opts.slot,
    id: opts.id ?? `block_${opts.slot}`,
    ancestor: opts.ancestor ?? `block_${opts.slot - 1}`,
    transactions: opts.transactions ?? [],
  };
}

// ─── Tx builders ─────────────────────────────────────────────────────────────

let _txCounter = 1;
function nextTxHash(): string {
  return (_txCounter++).toString(16).padStart(64, "0");
}

/** PostAdvert — creates a new active advert UTxO at ADVERT_SCRIPT_ADDRESS */
export function buildPostAdvertTx(opts: {
  txId?: string;
  advertDatumOpts?: AdvertDatumOpts;
} = {}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  return {
    id: txId,
    inputs: [{ transaction: { id: "prev_" + txId.slice(0, 8).padStart(64, "0") }, index: 0 }],
    outputs: [{
      address: ADVERT_SCRIPT_ADDRESS,
      value: { ada: { lovelace: 2_000_000 } },
      datum: buildAdvertDatumHex(opts.advertDatumOpts),
    }],
  };
}

/** UpdateAdvert — spends old advert UTxO, creates new one at same address */
export function buildUpdateAdvertTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  newAdvertDatumOpts?: AdvertDatumOpts;
}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }],
    outputs: [{
      address: ADVERT_SCRIPT_ADDRESS,
      value: { ada: { lovelace: 2_000_000 } },
      datum: buildAdvertDatumHex(opts.newAdvertDatumOpts),
    }],
  };
}

/** RetireAdvert — spends advert UTxO, no continuing output at script address */
export function buildRetireAdvertTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  supplierAddress?: string;
}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }],
    outputs: [{
      address: opts.supplierAddress ?? "addr_test1vqfrg4ncjz4ummcjx3t83y9tehh3ydzk0zg2hn00zg69v7q7sa96j",
      value: { ada: { lovelace: 2_000_000 } },
    }],
  };
}

/** PostEscrow — creates a new Open escrow UTxO at ESCROW_SCRIPT_ADDRESS */
export function buildPostEscrowTx(opts: {
  txId?: string;
  escrowDatumOpts?: EscrowDatumOpts;
} = {}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  return {
    id: txId,
    inputs: [{ transaction: { id: "prev_" + txId.slice(0, 8).padStart(64, "0") }, index: 0 }],
    outputs: [{
      address: ESCROW_SCRIPT_ADDRESS,
      value: { ada: { lovelace: 4_000_000 } },
      datum: buildEscrowDatumHex({ ...opts.escrowDatumOpts, state: "Open" }),
    }],
  };
}

/** ClaimEscrow — spends Open escrow, produces Claimed output */
export function buildClaimEscrowTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  escrowDatumOpts?: EscrowDatumOpts;
}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  const spentKey = `${opts.spentRef.txId}#${opts.spentRef.index}`;
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }],
    outputs: [{
      address: ESCROW_SCRIPT_ADDRESS,
      value: { ada: { lovelace: 4_000_000 } },
      datum: buildEscrowDatumHex({ ...opts.escrowDatumOpts, state: "Claimed" }),
    }],
    redeemers: { [spentKey]: "Claim" },
  };
}

/** SubmitEscrow — spends Claimed escrow, produces Submitted output with result_receipt_hash */
export function buildSubmitEscrowTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  receiptHash?: string;
  escrowDatumOpts?: EscrowDatumOpts;
}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  const spentKey = `${opts.spentRef.txId}#${opts.spentRef.index}`;
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }],
    outputs: [{
      address: ESCROW_SCRIPT_ADDRESS,
      value: { ada: { lovelace: 4_000_000 } },
      datum: buildEscrowDatumHex({
        ...opts.escrowDatumOpts,
        state: "Submitted",
        submittedAt: SAMPLE_SUBMITTED_AT,
        resultReceiptHash: opts.receiptHash ?? SAMPLE_RECEIPT_HASH,
      }),
    }],
    redeemers: { [spentKey]: "Submit" },
  };
}

/** AcceptEscrow — spends Submitted escrow, no continuing output (terminal).
 *  Attaches redeemers: { [spentRef]: "Accept" } so blockProcessor can
 *  unambiguously emit AcceptEscrow ONLY (not ReleaseEscrow). */
export function buildAcceptEscrowTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  buyerAddress?: string;
}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  const spentKey = `${opts.spentRef.txId}#${opts.spentRef.index}`;
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }],
    outputs: [{
      address: opts.buyerAddress ?? "addr_test1vqfrg4ncjz4ummcjx3t83y9tehh3ydzk0zg2hn00zg69v7q7sa96j",
      value: { ada: { lovelace: 4_000_000 } },
    }],
    redeemers: { [spentKey]: "Accept" },
  };
}

/** ReclaimEscrow — spends Open/Claimed escrow, no continuing output (terminal).
 *  Attaches redeemers: { [spentRef]: "Reclaim" }. */
export function buildReclaimEscrowTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  buyerAddress?: string;
}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  const spentKey = `${opts.spentRef.txId}#${opts.spentRef.index}`;
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }],
    outputs: [{
      address: opts.buyerAddress ?? "addr_test1vqfrg4ncjz4ummcjx3t83y9tehh3ydzk0zg2hn00zg69v7q7sa96j",
      value: { ada: { lovelace: 4_000_000 } },
    }],
    redeemers: { [spentKey]: "Reclaim" },
  };
}

/** ReleaseEscrow — spends Submitted escrow, no continuing output (terminal).
 *  Attaches redeemers: { [spentRef]: "Release" } so blockProcessor emits
 *  ReleaseEscrow ONLY (not AcceptEscrow). */
export function buildReleaseEscrowTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  supplierAddress?: string;
}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  const spentKey = `${opts.spentRef.txId}#${opts.spentRef.index}`;
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }],
    outputs: [{
      address: opts.supplierAddress ?? "addr_test1vz4ummcpydzk0zdtehhszg69v7y6hn00qy352euf40x77qgmly3us",
      value: { ada: { lovelace: 4_000_000 } },
    }],
    redeemers: { [spentKey]: "Release" },
  };
}

/** AmbiguousSubmittedSpendTx — spends a Submitted escrow with NO redeemer.
 *  Used to test the defensive fallback: blockProcessor should emit exactly ONE
 *  AcceptEscrow event and call console.warn when redeemer info is absent. */
export function buildAmbiguousSubmittedSpendTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }],
    outputs: [{
      address: "addr_test1vqfrg4ncjz4ummcjx3t83y9tehh3ydzk0zg2hn00zg69v7q7sa96j",
      value: { ada: { lovelace: 4_000_000 } },
    }],
    // NO redeemers field — deliberately absent to trigger fallback path
  };
}

/** Malformed datum at watched address — for error-handling tests */
export function buildMalformedDatumTx(opts: {
  txId?: string;
  address?: string;
} = {}): MockTx {
  const txId = opts.txId ?? nextTxHash();
  return {
    id: txId,
    inputs: [{ transaction: { id: "prev_" + txId.slice(0, 8).padStart(64, "0") }, index: 0 }],
    outputs: [{
      address: opts.address ?? ADVERT_SCRIPT_ADDRESS,
      value: { ada: { lovelace: 2_000_000 } },
      datum: "deadbeef",  // not a valid Plutus constructor
    }],
  };
}

/** Byron-era block — no transactions field */
export function buildByronBlock(opts: { slot: number }): Omit<MockBlock, "transactions"> {
  return {
    slot: opts.slot,
    id: `byron_${opts.slot}`,
    ancestor: `byron_${opts.slot - 1}`,
    // transactions intentionally omitted (Byron blocks have no tx list in Ogmios shape)
  };
}
