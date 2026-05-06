/**
 * tx-post-escrow-live-time.test.ts — RED phase tests for M1-F-time-cleanup
 *
 * Verifies that buildPostEscrowTx() with a LiveOgmiosProvider derives time
 * fields using Date.now() (real POSIX ms) rather than mockSlotToWallclockMs(tipSlot).
 *
 * Key production decisions baked in:
 *   - Live backend: posted_at = Date.now()
 *   - Live backend: deliver_by = Date.now() + advert.max_processing_ms + NETWORK_BUFFER_MS
 *   - Mock backend (existing): posted_at = mockSlotToWallclockMs(tipSlot)  — UNCHANGED
 *
 * All tests use vi.useFakeTimers + vi.setSystemTime to lock Date.now() to a
 * fixed reference. Restored in afterEach.
 *
 * Mock-backend tests in tx-post-escrow.test.ts are NOT modified.
 *
 * M1-F-time-cleanup RED — fail until Catherine updates postEscrow.ts live path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildPostEscrowTx } from "../../packages/shared/src/tx/escrow/postEscrow.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { NETWORK_BUFFER_MS, mockSlotToWallclockMs } from "../../packages/shared/src/tx/internal/constants.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { ChatMessage } from "../../packages/shared/src/tx/types.js";

// ─── Fixed fake time ──────────────────────────────────────────────────────────

const FAKE_NOW_DATE = new Date("2026-04-27T12:00:00Z");
const FAKE_NOW_MS = FAKE_NOW_DATE.getTime();   // 1745748000000

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const ADVERT_TX_HASH = "b".repeat(64);
const ADVERT_INDEX = 0;
const SAMPLE_MESSAGES: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }];
const PAYMENT = 2_000_000n;
const MAX_PROCESSING_MS = 60_000;

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW_DATE);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeActiveAdvert(): AdvertDatum {
  const supplier = buildSupplierWalletKey();
  return {
    supplier_pkh: supplier.pubKeyHash,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: MAX_PROCESSING_MS,
    price_lovelace: PAYMENT,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com/v1",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

function rpcOk<T>(result: T) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) };
}

function makeOgmiosUtxo(txId: string, index: number, address: string, lovelace: number, datumHex?: string) {
  return {
    transaction: { id: txId },
    index,
    address,
    value: { ada: { lovelace } },
    datum: datumHex ?? null,
    datumHash: null,
    script: null,
  };
}

function setupLiveHappyPath(): void {
  const buyer = buildBuyerWalletKey();
  const advert = makeActiveAdvert();
  const advertDatumHex = encodeAdvertDatum(advert);

  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const method: string = body.method ?? "";

    if (method === "queryLedgerState/protocolParameters") {
      return rpcOk({
        minFeeCoefficient: 44,
        minFeeConstant: { ada: { lovelace: 155381 } },
        maxTransactionSize: { bytes: 16384 },
        maxValueSize: { bytes: 5000 },
        stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
        stakePoolDeposit: { ada: { lovelace: 500000000 } },
        prices: { memory: "0.0577", steps: "0.0000721" },
        maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
        coinsPerUtxoByte: { ada: { lovelace: 4310 } },
        collateralPercentage: 150,
        maxCollateralInputs: 3,
        plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
        monetaryExpansion: "0.003",
        treasuryExpansion: "0.2",
        minStakePoolCost: { ada: { lovelace: 340000000 } },
        minFeeReferenceScripts: { base: 15 },
        governanceActionDeposit: { ada: { lovelace: 100000000000 } },
        delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
      });
    }
    if (method === "queryLedgerState/utxo") {
      const params = body.params ?? {};
      if (params.outputReferences) {
        return rpcOk([makeOgmiosUtxo(ADVERT_TX_HASH, ADVERT_INDEX, "addr_advert", 2_000_000, advertDatumHex)]);
      }
      return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, buyer.address, 100_000_000)]);
    }
    if (method === "queryNetwork/tip") {
      // Tip slot is arbitrary for live path — time fields come from Date.now(), not tip
      return rpcOk({ slot: 100_000, id: "a".repeat(64) });
    }
    if (method === "submitTransaction") {
      return rpcOk({ transaction: { id: "d".repeat(64) } });
    }
    return rpcOk({});
  });
}

// ─── A. posted_at uses Date.now() on live backend ────────────────────────────

describe("buildPostEscrowTx() [live] — posted_at is Date.now() not slot*1000", () => {
  it("escrowDatum.posted_at equals faked Date.now() on live backend", async () => {
    setupLiveHappyPath();
    const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: mockFetch });
    const buyer = buildBuyerWalletKey();

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: PAYMENT,
    });

    // Decode the datum from the tx CBOR to inspect posted_at
    // The datum hex is embedded inside the CBOR; we can find it by looking for
    // the encoded escrow datum substring. Instead, we rebuild from the result
    // escrowOutputRef and verify via mock chain state.
    // The produced tx CBOR must contain the encoded datum.
    // We assert the datum decoded from the tx CBOR contains posted_at = FAKE_NOW_MS.
    // Strategy: since we control Date.now() via fake timers, and the live path
    // must use Date.now(), the datum's posted_at field must equal FAKE_NOW_MS.

    // We verify indirectly: the CBOR result has the datum embedded; we locate
    // the expected deliver_by based on FAKE_NOW_MS and the advert spec.
    const expectedPostedAt = FAKE_NOW_MS;
    const expectedDeliverBy = FAKE_NOW_MS + MAX_PROCESSING_MS + NETWORK_BUFFER_MS;

    // The result CBOR must contain the encoded datum which holds posted_at.
    // We can reconstruct the expected datum hex and check it appears in the CBOR.
    // This is the same approach as tx-claim-live.test.ts "contains datum hex".
    const advert = makeActiveAdvert();
    const { encodeEscrowDatum } = await import("../../packages/shared/src/cbor/EscrowDatum.js");
    const { canonicalize } = await import("../../packages/shared/src/cbor/canonical.js");
    const { createHash } = await import("crypto");
    const promptHash = createHash("sha256").update(canonicalize(SAMPLE_MESSAGES)).digest("hex");
    const requestSpecHash = createHash("sha256")
      .update(canonicalize({ capability_id: advert.capability_id, max_output_tokens: advert.max_output_tokens, model: advert.model }))
      .digest("hex");

    const expectedDatumHex = encodeEscrowDatum({
      buyer_pkh: buyer.pubKeyHash,
      supplier_pkh: advert.supplier_pkh,
      advert_ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      capability_id: advert.capability_id,
      request_spec_hash: requestSpecHash,
      prompt_hash: promptHash,
      payment_lovelace: PAYMENT,
      buyer_bond_lovelace: advert.buyer_bond_lovelace,
      supplier_bond_lovelace: advert.supplier_bond_lovelace,
      deliver_by: expectedDeliverBy,
      posted_at: expectedPostedAt,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Open",
    });

    expect(result.txCborHex).toContain(expectedDatumHex);
  });

  it("escrowDatum.posted_at is NOT slot*1000 on live backend (mock convention absent)", async () => {
    setupLiveHappyPath();
    const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: mockFetch });
    const buyer = buildBuyerWalletKey();

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: PAYMENT,
    });

    // The tip slot is 100_000; mock convention would give 100_000_000 ms.
    // Real Date.now() (faked) gives FAKE_NOW_MS = 1745748000000.
    // These must NOT be equal.
    const MOCK_CONVENTION_POSTED_AT = mockSlotToWallclockMs(100_000); // = 100_000_000

    const { encodeEscrowDatum } = await import("../../packages/shared/src/cbor/EscrowDatum.js");
    const { canonicalize } = await import("../../packages/shared/src/cbor/canonical.js");
    const { createHash } = await import("crypto");
    const advert = makeActiveAdvert();
    const promptHash = createHash("sha256").update(canonicalize(SAMPLE_MESSAGES)).digest("hex");
    const requestSpecHash = createHash("sha256")
      .update(canonicalize({ capability_id: advert.capability_id, max_output_tokens: advert.max_output_tokens, model: advert.model }))
      .digest("hex");

    const mockConventionDatumHex = encodeEscrowDatum({
      buyer_pkh: buyer.pubKeyHash,
      supplier_pkh: advert.supplier_pkh,
      advert_ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      capability_id: advert.capability_id,
      request_spec_hash: requestSpecHash,
      prompt_hash: promptHash,
      payment_lovelace: PAYMENT,
      buyer_bond_lovelace: advert.buyer_bond_lovelace,
      supplier_bond_lovelace: advert.supplier_bond_lovelace,
      deliver_by: MOCK_CONVENTION_POSTED_AT + MAX_PROCESSING_MS + NETWORK_BUFFER_MS,
      posted_at: MOCK_CONVENTION_POSTED_AT,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Open",
    });

    // The CBOR must NOT contain the mock-convention datum
    expect(result.txCborHex).not.toContain(mockConventionDatumHex);
  });
});

// ─── B. deliver_by = Date.now() + max_processing_ms + NETWORK_BUFFER_MS ──────

describe("buildPostEscrowTx() [live] — deliver_by is Date.now() + processing + buffer", () => {
  it("deliver_by in live datum = Date.now() + max_processing_ms + 30_000", async () => {
    setupLiveHappyPath();
    const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: mockFetch });
    const buyer = buildBuyerWalletKey();

    const expectedDeliverBy = FAKE_NOW_MS + MAX_PROCESSING_MS + NETWORK_BUFFER_MS;

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: PAYMENT,
    });

    const { encodeEscrowDatum } = await import("../../packages/shared/src/cbor/EscrowDatum.js");
    const { canonicalize } = await import("../../packages/shared/src/cbor/canonical.js");
    const { createHash } = await import("crypto");
    const advert = makeActiveAdvert();
    const promptHash = createHash("sha256").update(canonicalize(SAMPLE_MESSAGES)).digest("hex");
    const requestSpecHash = createHash("sha256")
      .update(canonicalize({ capability_id: advert.capability_id, max_output_tokens: advert.max_output_tokens, model: advert.model }))
      .digest("hex");

    const expectedDatumHex = encodeEscrowDatum({
      buyer_pkh: buyer.pubKeyHash,
      supplier_pkh: advert.supplier_pkh,
      advert_ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      capability_id: advert.capability_id,
      request_spec_hash: requestSpecHash,
      prompt_hash: promptHash,
      payment_lovelace: PAYMENT,
      buyer_bond_lovelace: advert.buyer_bond_lovelace,
      supplier_bond_lovelace: advert.supplier_bond_lovelace,
      deliver_by: expectedDeliverBy,
      posted_at: FAKE_NOW_MS,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Open",
    });

    expect(result.txCborHex).toContain(expectedDatumHex);
  });
});

// ─── C. Mock backend still uses slot-based convention ────────────────────────

/**
 * Decode the synthetic "testTxBody" hex format used by the mock CBOR path.
 * Format: [4 bytes BE uint32 JSON length][JSON UTF-8][optional trailer]
 * Returns the parsed TestTxBody object.
 */
function decodeSyntheticTxBody(txCborHex: string): Record<string, unknown> {
  const lengthHex = txCborHex.slice(0, 8);
  const jsonByteLength = parseInt(lengthHex, 16);
  const jsonHex = txCborHex.slice(8, 8 + jsonByteLength * 2);
  const jsonStr = Buffer.from(jsonHex, "hex").toString("utf8");
  return JSON.parse(jsonStr) as Record<string, unknown>;
}

describe("buildPostEscrowTx() [mock] — posted_at unchanged (still slot*1000)", () => {
  it("mock backend posted_at = mockSlotToWallclockMs(tipSlot), NOT Date.now()", async () => {
    // Mock path must remain unchanged — Tier-1 tests must not regress.
    const TIP_SLOT = 1_000;
    const expectedPostedAt = mockSlotToWallclockMs(TIP_SLOT); // = 1_000_000
    const advert = makeActiveAdvert();
    const advertDatumHex = encodeAdvertDatum(advert);

    const chain = new MockChainProvider();
    chain.advanceSlot(TIP_SLOT);
    // Seed the advert UTxO
    chain.seed({
      ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      address: "addr_advert",
      lovelace: 2_000_000n,
      assets: {},
      datumHex: advertDatumHex,
      scriptRef: null,
    });

    const buyer = buildBuyerWalletKey();
    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
      messages: SAMPLE_MESSAGES,
      payment_lovelace: PAYMENT,
    });

    // Decode the mock-path synthetic CBOR to verify posted_at
    const decoded = decodeSyntheticTxBody(result.txCborHex);
    const outputs = decoded.outputs as Array<{ datumHex?: string }>;
    const escrowOutput = outputs.find((o) => o.datumHex);
    expect(escrowOutput).toBeDefined();
    const datum = decodeEscrowDatum(escrowOutput!.datumHex!);

    // Mock convention: posted_at must be slot * 1000, NOT Date.now() (1745748000000)
    expect(datum.posted_at).toBe(expectedPostedAt);
    expect(datum.posted_at).not.toBe(FAKE_NOW_MS);
  });
});
