/**
 * supplier-chat-deadline-live.test.ts — RED phase tests for M1-F-time-cleanup
 *
 * Proves that the supplier chat route (/v1/chat/completions) deadline check:
 *   - Uses Date.now() when chain is a LiveOgmiosProvider
 *   - Uses mockSlotToWallclockMs(tip) when chain is a MockChainProvider (existing behavior)
 *
 * Strategy for the "200 path" (deadline check passes):
 *   - Inject LiveOgmiosProvider with a mocked fetch that returns a tip slot so
 *     low that tipSlot*1000 << Date.now() — this creates a discriminating case:
 *     if the route used tipSlot*1000, it would treat "now" as very small and
 *     allow past deliver_by values through.
 *   - The fetched advert + escrow UTxOs carry pre-computed hashes from the
 *     supplier-side fixture, and the request body matches those fixtures.
 *   - After deadline passes, we short-circuit the Claim→Ollama→Submit pipeline
 *     via spies so tests do not depend on lucid/CBOR internals.
 *
 * Uses vi.useFakeTimers() + vi.setSystemTime() for deterministic Date.now().
 *
 * M1-F-time-cleanup RED — tests for live branch fail until Catherine updates
 * the deadline check in supplier/src/server.ts to branch on LiveOgmiosProvider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { SupplierState } from "../../supplier/src/state.js";
import { createApp } from "../../supplier/src/server.js";
import {
  buildSampleConfig,
  SAMPLE_ADVERT_TX_HASH,
  SAMPLE_ADVERT_INDEX,
} from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey, SUPPLIER_PKH } from "../fixtures/supplier-side/wallet-keys.js";
import {
  ESCROW_TX_HASH,
  CAPABILITY_ID,
  TEST_MODEL,
  TEST_MAX_OUTPUT_TOKENS,
  TEST_MESSAGES,
  REQUEST_SPEC_HASH,
  PROMPT_HASH,
  PAYMENT_LOVELACE,
  BUYER_BOND,
  SUPPLIER_BOND,
  POSTED_AT,
  BUYER_PKH,
  ADVERT_TX_HASH,
  ADVERT_INDEX,
  ESCROW_SCRIPT_ADDRESS,
} from "../fixtures/supplier-side/sample-escrow-state.js";

// ─── Fixed fake time ──────────────────────────────────────────────────────────

const FAKE_NOW_DATE = new Date("2026-04-28T12:00:00Z");
const FAKE_NOW_MS = FAKE_NOW_DATE.getTime(); // 1777377600000

// ─── Low tip slot (discriminating value for live vs mock path) ────────────────

/**
 * TIP_SLOT is intentionally very low so that mockSlotToWallclockMs(TIP_SLOT)
 * is far below FAKE_NOW_MS. If the live path incorrectly uses slot*1000
 * instead of Date.now(), the discriminating deliver_by values below would
 * produce the wrong result.
 *
 * mockSlotToWallclockMs(1000) = 1_000_000 << 1_777_377_600_000 (FAKE_NOW_MS)
 */
const TIP_SLOT = 1_000;
const TIP_SLOT_MS = TIP_SLOT * 1_000; // 1_000_000 — well below FAKE_NOW_MS

// ─── deliver_by values ────────────────────────────────────────────────────────

// Well AFTER FAKE_NOW_MS — deadline has NOT expired relative to Date.now()
const DELIVER_BY_FUTURE = FAKE_NOW_MS + 300_000;

// BEFORE FAKE_NOW_MS but AFTER TIP_SLOT_MS — expired relative to Date.now()
// but if the route incorrectly used TIP_SLOT_MS, it would think deadline is fine
const DELIVER_BY_BEFORE_NOW_AFTER_TIPMS = FAKE_NOW_MS - 1_000;

// ─── Constants ────────────────────────────────────────────────────────────────

const OPEN_ESCROW_REF_HEADER = `${ESCROW_TX_HASH}#0`;
const COLLATERAL_LOVELACE = 5_000_000;

// ─── Fixtures — advert datum (matches supplier-side hash fixture) ─────────────

function buildLiveTestAdvertDatum(): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER_PKH,
    capability_id: CAPABILITY_ID,
    model: TEST_MODEL,
    max_output_tokens: TEST_MAX_OUTPUT_TOKENS,
    max_processing_ms: 60_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "http://supplier.example:8080",
    detail_uri: "ipfs://QmTest",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

/**
 * Build an Open escrow datum with a specific deliver_by and posted_at.
 * All hash fields match the supplier-side fixture so request_spec_hash +
 * prompt_hash checks pass.
 *
 * posted_at defaults to POSTED_AT (real-POSIX fixture value) which is
 * appropriate for the live tests where deliver_by is also real-POSIX.
 * Mock backend tests should pass a posted_at < deliver_by explicitly.
 */
function buildLiveOpenEscrowDatum(deliverBy: number, postedAt: number = POSTED_AT): EscrowDatum {
  return {
    buyer_pkh: BUYER_PKH,
    supplier_pkh: SUPPLIER_PKH,
    advert_ref: { txHash: ADVERT_TX_HASH, index: ADVERT_INDEX },
    capability_id: CAPABILITY_ID,
    request_spec_hash: REQUEST_SPEC_HASH,
    prompt_hash: PROMPT_HASH,
    payment_lovelace: PAYMENT_LOVELACE,
    buyer_bond_lovelace: BUYER_BOND,
    supplier_bond_lovelace: SUPPLIER_BOND,
    deliver_by: deliverBy,
    posted_at: postedAt,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rpcOk<T>(result: T) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) };
}

function makeOgmiosUtxo(
  txId: string,
  index: number,
  address: string,
  lovelace: number,
  datumHex?: string,
) {
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

function protocolParamsResponse() {
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

/**
 * Builds a LiveOgmiosProvider whose fetch returns:
 *   - tip with TIP_SLOT (intentionally low)
 *   - queryUtxo for the advert ref → advert UTxO with the fixture datum
 *   - queryUtxo for the escrow ref → escrow UTxO with the given datumHex
 *   - protocol params (for buildClaimTx)
 *   - supplier wallet UTxO for collateral (for buildClaimTx)
 *   - submitTransaction → fake hash
 */
function buildLiveMockFetch(escrowDatumHex: string): ReturnType<typeof vi.fn> {
  const advertDatumHex = encodeAdvertDatum(buildLiveTestAdvertDatum());
  const supplier = buildSupplierWalletKey();

  const mockFetch = vi.fn().mockImplementation(
    async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";

      if (method === "queryNetwork/tip") {
        return rpcOk({ slot: TIP_SLOT, id: "a".repeat(64) });
      }

      if (method === "queryLedgerState/protocolParameters") {
        return protocolParamsResponse();
      }

      if (method === "queryLedgerState/utxo") {
        const refs: Array<{ transaction?: { id?: string }; index?: number }> =
          body.params?.outputReferences ?? [];
        if (refs.length > 0) {
          const ref = refs[0];
          const txId = ref.transaction?.id ?? "";
          const idx = ref.index ?? 0;

          // Advert UTxO
          if (txId === SAMPLE_ADVERT_TX_HASH && idx === SAMPLE_ADVERT_INDEX) {
            return rpcOk([
              makeOgmiosUtxo(
                SAMPLE_ADVERT_TX_HASH,
                SAMPLE_ADVERT_INDEX,
                "addr_test1wfakeadvertaddress",
                2_000_000,
                advertDatumHex,
              ),
            ]);
          }
          // Escrow UTxO
          if (txId === ESCROW_TX_HASH && idx === 0) {
            return rpcOk([
              makeOgmiosUtxo(
                ESCROW_TX_HASH,
                0,
                ESCROW_SCRIPT_ADDRESS,
                Number(PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND),
                escrowDatumHex,
              ),
            ]);
          }
        }
        // Address query (collateral for buildClaimTx)
        return rpcOk([
          makeOgmiosUtxo("c".repeat(64), 0, supplier.address, COLLATERAL_LOVELACE),
        ]);
      }

      if (method === "submitTransaction") {
        return rpcOk({ transaction: { id: "d".repeat(64) } });
      }

      return rpcOk({});
    },
  );

  return mockFetch;
}

/**
 * Create the supplier app with a LiveOgmiosProvider. The chain's submitTx is
 * spied on to short-circuit the Claim tx (returns fake hash without real CBOR
 * validation). The Ollama fetch is mocked via vi.stubGlobal so the full pipeline
 * can reach 200 past the deadline check.
 */
function makeAppWithLiveChain(escrowDatumHex: string): {
  app: Application;
  chain: LiveOgmiosProvider;
} {
  const mockFetch = buildLiveMockFetch(escrowDatumHex);
  const chain = new LiveOgmiosProvider({
    ogmiosUrl: "http://ogmios:1337",
    fetch: mockFetch,
  });

  // Short-circuit the Claim + Submit tx pipeline so the route reaches 200
  // without needing real CBOR construction. These spies are reset in afterEach.
  vi.spyOn(chain, "submitTx").mockResolvedValue("d".repeat(64));

  // Also short-circuit awaitTx so the pipeline doesn't block
  vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined);

  const app = createApp({
    chain,
    state: new SupplierState(),
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
  });

  return { app, chain };
}

// Standard chat request body (matching the fixture hashes)
function validChatBody() {
  return {
    model: TEST_MODEL,
    messages: TEST_MESSAGES,
    max_tokens: TEST_MAX_OUTPUT_TOKENS,
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW_DATE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── Live backend — 200 path (deliver_by > Date.now()) ───────────────────────

describe("supplier chat route [live backend] — deliver_by > Date.now() → not 408", () => {
  it("returns non-408 when deliver_by is after Date.now() (not after tipSlot*1000 only)", async () => {
    // deliver_by = FAKE_NOW_MS + 300_000 — after Date.now(), after tipSlot*1000
    // This test verifies the route does NOT return 408 when the real clock is within budget.
    const escrowDatumHex = encodeEscrowDatum(buildLiveOpenEscrowDatum(DELIVER_BY_FUTURE));
    const { app } = makeAppWithLiveChain(escrowDatumHex);

    // Mock Ollama to return a valid response so the pipeline can reach 200
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
      // Only intercept Ollama calls (non-Ogmios)
      if (String(url).includes("11434")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: { role: "assistant", content: "Hello from live chain test." },
            done: true,
            prompt_eval_count: 10,
            eval_count: 20,
            total_duration: 1_000_000_000,
          }),
        };
      }
      return { ok: true, json: async () => ({ jsonrpc: "2.0", result: {} }) };
    }));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    // Must not be 408 (past_deliver_by) — the deadline has not expired
    expect(res.status).not.toBe(408);
  });
});

// ─── Live backend — 408 path (deliver_by < Date.now()) ───────────────────────

describe("supplier chat route [live backend] — deliver_by < Date.now() → 408", () => {
  it("returns 408 past_deliver_by when deliver_by < Date.now() (live backend uses real clock)", async () => {
    // deliver_by is BEFORE Date.now() but AFTER TIP_SLOT_MS.
    // If the route uses TIP_SLOT_MS for "now", it would incorrectly pass.
    // If it uses Date.now(), it correctly returns 408.
    const escrowDatumHex = encodeEscrowDatum(
      buildLiveOpenEscrowDatum(DELIVER_BY_BEFORE_NOW_AFTER_TIPMS),
    );
    const { app } = makeAppWithLiveChain(escrowDatumHex);

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    expect(res.status).toBe(408);
    expect(res.body.reason ?? res.body.error).toMatch(/past_deliver_by/i);
  });

  it("error message references Date.now() (a real-POSIX-ms number > 1.7e12), not tipSlot*1000", async () => {
    // tip slot 1_000 → tipSlot*1000 = 1_000_000 (way below 1.7e12)
    // Date.now() = FAKE_NOW_MS = 1_745_841_600_000 (> 1.7e12)
    // The error message must contain the real-clock ms value, not the tiny mock value.
    const escrowDatumHex = encodeEscrowDatum(
      buildLiveOpenEscrowDatum(DELIVER_BY_BEFORE_NOW_AFTER_TIPMS),
    );
    const { app } = makeAppWithLiveChain(escrowDatumHex);

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    expect(res.status).toBe(408);
    const bodyStr = JSON.stringify(res.body);
    // Extract the "now" value from the error body and verify it is in real-clock range
    // The server emits "now X >= deliver_by Y" — X must be > 1.7e12
    const nowMatch = bodyStr.match(/now\s+(\d+)/);
    expect(nowMatch).not.toBeNull();
    const reportedNow = Number(nowMatch![1]);
    expect(reportedNow).toBeGreaterThan(1.7e12);
    // And must equal FAKE_NOW_MS exactly (faked clock)
    expect(reportedNow).toBe(FAKE_NOW_MS);
  });
});

// ─── Mock backend — baseline behavior preserved ───────────────────────────────

describe("supplier chat route [mock backend] — mockSlotToWallclockMs convention preserved", () => {
  it("returns non-408 when deliver_by > mockSlotToWallclockMs(tip) (mock convention)", async () => {
    // MockChainProvider with tip slot 1_000 → tipMs = 1_000_000
    // deliver_by = tipMs + 10_000 = 1_010_000 — well within budget
    // posted_at must be < deliver_by so Math.max(tipMs, posted_at) < deliver_by
    const MOCK_TIP_SLOT = 1_000;
    const MOCK_TIP_MS = MOCK_TIP_SLOT * 1_000; // mockSlotToWallclockMs(1000) = 1_000_000
    const deliverBy = MOCK_TIP_MS + 10_000;       // 1_010_000
    const postedAt = MOCK_TIP_MS - 1_000;          // 999_000 — below tipMs and deliverBy

    const chain = new MockChainProvider();
    chain.advanceSlot(MOCK_TIP_SLOT);

    const advertDatum = buildLiveTestAdvertDatum();
    chain.seed({
      ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
      address: "addr_test1wfakeadvertaddress",
      lovelace: 2_000_000n,
      assets: {},
      datumHex: encodeAdvertDatum(advertDatum),
      scriptRef: null,
    });

    // Use explicit postedAt so Math.max(tipMs, postedAt) = tipMs = 1_000_000 < deliverBy
    const escrowDatum = buildLiveOpenEscrowDatum(deliverBy, postedAt);
    chain.seed({
      ref: { txHash: ESCROW_TX_HASH, index: 0 },
      address: ESCROW_SCRIPT_ADDRESS,
      lovelace: PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND,
      assets: {},
      datumHex: encodeEscrowDatum(escrowDatum),
      scriptRef: null,
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: { role: "assistant", content: "Mock response." },
        done: true,
        prompt_eval_count: 5,
        eval_count: 10,
        total_duration: 500_000_000,
      }),
    }));

    const app = createApp({
      chain,
      state: new SupplierState(),
      config: buildSampleConfig(),
      supplierKey: buildSupplierWalletKey(),
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    // Must not 408 — mock tip clock allows this
    expect(res.status).not.toBe(408);
  });

  it("returns 408 when deliver_by < mockSlotToWallclockMs(tip) (mock convention)", async () => {
    // MockChainProvider with tip slot 1_000 → tipMs = 1_000_000
    // deliver_by = 500 — before tipMs, so past deadline
    const MOCK_TIP_SLOT = 1_000;
    const deliverBy = 500; // before tipMs

    const chain = new MockChainProvider();
    chain.advanceSlot(MOCK_TIP_SLOT);

    const advertDatum = buildLiveTestAdvertDatum();
    chain.seed({
      ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
      address: "addr_test1wfakeadvertaddress",
      lovelace: 2_000_000n,
      assets: {},
      datumHex: encodeAdvertDatum(advertDatum),
      scriptRef: null,
    });

    const escrowDatum: EscrowDatum = {
      ...buildLiveOpenEscrowDatum(deliverBy),
      posted_at: 1, // must be < deliverBy or at least < deliver_by
    };
    chain.seed({
      ref: { txHash: ESCROW_TX_HASH, index: 0 },
      address: ESCROW_SCRIPT_ADDRESS,
      lovelace: PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND,
      assets: {},
      datumHex: encodeEscrowDatum(escrowDatum),
      scriptRef: null,
    });

    const app = createApp({
      chain,
      state: new SupplierState(),
      config: buildSampleConfig(),
      supplierKey: buildSupplierWalletKey(),
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    expect(res.status).toBe(408);
    expect(res.body.reason ?? res.body.error).toMatch(/past_deliver_by/i);
  });

  it("mock backend 408 error message uses mockSlotToWallclockMs value (tipSlot*1000), not Date.now()", async () => {
    // tip slot 1_000 → mockSlotToWallclockMs = 1_000_000 (a value <= 5e10)
    // Date.now() = FAKE_NOW_MS = 1_745_841_600_000 (> 1.7e12)
    // The error message's "now" value must be from the mock clock (tipMs), not Date.now()
    const MOCK_TIP_SLOT = 1_000;
    const MOCK_TIP_MS = 1_000_000; // mockSlotToWallclockMs(1000) per convention
    const deliverBy = 500;

    const chain = new MockChainProvider();
    chain.advanceSlot(MOCK_TIP_SLOT);

    const advertDatum = buildLiveTestAdvertDatum();
    chain.seed({
      ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
      address: "addr_test1wfakeadvertaddress",
      lovelace: 2_000_000n,
      assets: {},
      datumHex: encodeAdvertDatum(advertDatum),
      scriptRef: null,
    });

    const escrowDatum: EscrowDatum = {
      ...buildLiveOpenEscrowDatum(deliverBy),
      posted_at: 1,
    };
    chain.seed({
      ref: { txHash: ESCROW_TX_HASH, index: 0 },
      address: ESCROW_SCRIPT_ADDRESS,
      lovelace: PAYMENT_LOVELACE + BUYER_BOND + SUPPLIER_BOND,
      assets: {},
      datumHex: encodeEscrowDatum(escrowDatum),
      scriptRef: null,
    });

    const app = createApp({
      chain,
      state: new SupplierState(),
      config: buildSampleConfig(),
      supplierKey: buildSupplierWalletKey(),
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("X-Escrow-Ref", OPEN_ESCROW_REF_HEADER)
      .send(validChatBody());

    expect(res.status).toBe(408);
    const bodyStr = JSON.stringify(res.body);
    // Extract reported "now" from the error
    const nowMatch = bodyStr.match(/now\s+(\d+)/);
    expect(nowMatch).not.toBeNull();
    const reportedNow = Number(nowMatch![1]);
    // Mock clock value must be <= 5e10 (far below real POSIX range)
    // mockSlotToWallclockMs(1000) = 1_000_000
    expect(reportedNow).toBeLessThanOrEqual(5e10);
    expect(reportedNow).toBe(MOCK_TIP_MS);
  });
});
