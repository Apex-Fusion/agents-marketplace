/**
 * supplier-buyer-guard.test.ts — interim guard: one acceptable job per buyer.
 *
 * The deployed escrow validator lets a buyer Accept several Submitted escrows
 * of one supplier in one transaction and pay the supplier once. The supplier
 * therefore refuses (409 supplier_busy, escrow left Open) to Claim a buyer's
 * escrow while another escrow of that buyer and supplier key can still be
 * Accepted. See supplier/src/buyerGuard.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { createHash } from "crypto";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { chatSessionPromptHash } from "../../packages/shared/src/tx/escrow/postChatEscrow.js";
import { ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/index.js";
import type { SupplierConfig } from "../../supplier/src/config.js";
import { loadConfig, parseBuyerGuardExemptPkhs } from "../../supplier/src/config.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { ChatSessionStore } from "../../supplier/src/chatSession.js";
import { createApp } from "../../supplier/src/server.js";
import {
  BUYER_GUARD_MARGIN_MS,
  findAcceptableJobOfBuyer,
  retryAfterSeconds,
} from "../../supplier/src/buyerGuard.js";
import {
  buildSampleConfig,
  buildSampleEnv,
  SAMPLE_ADVERT_TX_HASH,
  SAMPLE_ADVERT_INDEX,
} from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey, SUPPLIER_PKH } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildOpenEscrowUtxo,
  BUYER_PKH,
  CAPABILITY_ID,
  DELIVER_BY,
  ESCROW_SCRIPT_ADDRESS,
  ESCROW_TX_HASH,
  POSTED_AT,
  TEST_MAX_OUTPUT_TOKENS,
  TEST_MODEL,
  TEST_RESPONSE_INPUT,
  TOTAL_LOCKED,
} from "../fixtures/supplier-side/sample-escrow-state.js";

const OTHER_BUYER = "ab".repeat(28);
const OPEN_REF = { txHash: ESCROW_TX_HASH, index: 0 };
const OPEN_REF_TEXT = `${ESCROW_TX_HASH}#0`;
const EARLIER_TX = "d".repeat(64);

/** The fixture's Open escrow datum, with overrides. */
function datum(overrides: Partial<EscrowDatum>): EscrowDatum {
  return { ...decodeEscrowDatum(buildOpenEscrowUtxo().datumHex!), ...overrides };
}

function seedEscrow(chain: MockChainProvider, txHash: string, d: EscrowDatum, address = ESCROW_SCRIPT_ADDRESS): void {
  chain.seed({
    ref: { txHash, index: 0 },
    address,
    lovelace: TOTAL_LOCKED,
    assets: {},
    datumHex: encodeEscrowDatum(d),
    scriptRef: null,
  });
}

function submittedAt(at: number, overrides: Partial<EscrowDatum> = {}): EscrowDatum {
  return datum({ state: "Submitted", submitted_at: at, result_receipt_hash: "e".repeat(64), ...overrides });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── findAcceptableJobOfBuyer ─────────────────────────────────────────────────

describe("findAcceptableJobOfBuyer", () => {
  const guard = (chain: MockChainProvider, nowMs: number, exempt?: string[]) =>
    findAcceptableJobOfBuyer({
      chain,
      escrowAddress: ESCROW_SCRIPT_ADDRESS,
      supplierPkh: SUPPLIER_PKH,
      buyerPkh: BUYER_PKH,
      exclude: OPEN_REF,
      nowMs,
      exemptBuyerPkhs: exempt,
    });

  it("finds nothing when the buyer has no other escrow", async () => {
    const chain = new MockChainProvider();
    chain.seed(buildOpenEscrowUtxo());
    expect(await guard(chain, POSTED_AT)).toBeNull();
  });

  it("blocks on a Claimed escrow of the same buyer before its deliver_by", async () => {
    const chain = new MockChainProvider();
    seedEscrow(chain, EARLIER_TX, datum({ state: "Claimed" }));
    const job = await guard(chain, POSTED_AT);
    expect(job).toEqual({
      ref: { txHash: EARLIER_TX, index: 0 },
      state: "Claimed",
      acceptableUntilMs: DELIVER_BY + ACCEPT_WINDOW_MS,
    });
  });

  it("ignores a Claimed stray past its deliver_by (it can never be Submitted)", async () => {
    const chain = new MockChainProvider();
    seedEscrow(chain, EARLIER_TX, datum({ state: "Claimed" }));
    expect(await guard(chain, DELIVER_BY + BUYER_GUARD_MARGIN_MS)).toBeNull();
  });

  it("blocks on a Submitted escrow inside its accept window, and not after it", async () => {
    const chain = new MockChainProvider();
    seedEscrow(chain, EARLIER_TX, submittedAt(POSTED_AT));
    expect((await guard(chain, POSTED_AT + ACCEPT_WINDOW_MS))?.state).toBe("Submitted");
    expect(await guard(chain, POSTED_AT + ACCEPT_WINDOW_MS + BUYER_GUARD_MARGIN_MS + 1)).toBeNull();
  });

  it("ignores other buyers, other suppliers, Open escrows, foreign datums and the admitted escrow", async () => {
    const chain = new MockChainProvider();
    chain.seed(buildOpenEscrowUtxo()); // the escrow being admitted
    seedEscrow(chain, "1".repeat(64), submittedAt(POSTED_AT, { buyer_pkh: OTHER_BUYER }));
    seedEscrow(chain, "2".repeat(64), submittedAt(POSTED_AT, { supplier_pkh: "9".repeat(56) }));
    seedEscrow(chain, "3".repeat(64), datum({}));
    chain.seed({
      ref: { txHash: "4".repeat(64), index: 0 },
      address: ESCROW_SCRIPT_ADDRESS,
      lovelace: 2_000_000n,
      assets: {},
      datumHex: "d87980",
      scriptRef: null,
    });
    seedEscrow(chain, "5".repeat(64), submittedAt(POSTED_AT), "addr_test1wsomewhereelse");
    expect(await guard(chain, POSTED_AT)).toBeNull();
  });

  it("skips the check for exempt buyers, case-insensitively", async () => {
    const chain = new MockChainProvider();
    seedEscrow(chain, EARLIER_TX, submittedAt(POSTED_AT));
    expect(await guard(chain, POSTED_AT, [BUYER_PKH.toLowerCase()])).toBeNull();
  });

  it("returns the escrow acceptable longest when several block", async () => {
    const chain = new MockChainProvider();
    seedEscrow(chain, "1".repeat(64), submittedAt(POSTED_AT));
    seedEscrow(chain, "2".repeat(64), datum({ state: "Claimed" }));
    const job = await guard(chain, POSTED_AT);
    expect(job?.ref.txHash).toBe("2".repeat(64));
    expect(retryAfterSeconds(job!, POSTED_AT)).toBe(
      Math.ceil((DELIVER_BY + ACCEPT_WINDOW_MS + BUYER_GUARD_MARGIN_MS - POSTED_AT) / 1000),
    );
  });
});

// ─── POST /v1/responses (one-shot chat, capacity 1) ───────────────────────────

function advertDatum(): AdvertDatum {
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

function chatHarness(configOverrides: Partial<SupplierConfig> = {}) {
  const chain = new MockChainProvider();
  chain.seed({
    ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
    address: "addr_test1wfakeadvertaddress",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(advertDatum()),
    scriptRef: null,
  });
  chain.seed(buildOpenEscrowUtxo());
  chain.advanceSlot(1_000); // mock clock: now = max(tip ms, posted_at) = POSTED_AT
  const state = new SupplierState();
  const jobs = new JobStore();
  const app = createApp({
    chain,
    state,
    config: { ...buildSampleConfig(), ...configOverrides },
    supplierKey: buildSupplierWalletKey(),
    jobs,
  });
  // The model call never resolves: the 202 lands before it.
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })));
  return { chain, state, jobs, app };
}

const postChat = (h: ReturnType<typeof chatHarness>) =>
  request(h.app)
    .post("/v1/responses")
    .set("X-Escrow-Ref", OPEN_REF_TEXT)
    .send({ model: TEST_MODEL, input: TEST_RESPONSE_INPUT, max_output_tokens: TEST_MAX_OUTPUT_TOKENS });

describe("POST /v1/responses — one acceptable job per buyer", () => {
  it("refuses with 409 supplier_busy and Retry-After, without claiming, while the buyer's earlier job can be accepted", async () => {
    const h = chatHarness();
    seedEscrow(h.chain, EARLIER_TX, submittedAt(POSTED_AT - 1_000));
    const submit = vi.spyOn(h.chain, "submitTx");

    const res = await postChat(h);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("supplier_busy");
    expect(res.body.message).toContain(`${EARLIER_TX}#0`);
    expect(res.headers["retry-after"]).toBe(
      String(Math.ceil((POSTED_AT - 1_000 + ACCEPT_WINDOW_MS + BUYER_GUARD_MARGIN_MS - POSTED_AT) / 1000)),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(h.jobs.count()).toBe(0);
    expect(h.state.snapshot().activeSessions).toBe(0); // slot released
    expect((await h.chain.queryUtxo(OPEN_REF))).not.toBeNull(); // escrow still Open
  });

  it("claims once the earlier job is past its accept window", async () => {
    const h = chatHarness();
    seedEscrow(h.chain, EARLIER_TX, submittedAt(POSTED_AT - ACCEPT_WINDOW_MS - BUYER_GUARD_MARGIN_MS - 1));
    const res = await postChat(h);
    expect(res.status).toBe(202);
  });

  it("claims when the earlier job belongs to another buyer", async () => {
    const h = chatHarness();
    seedEscrow(h.chain, EARLIER_TX, submittedAt(POSTED_AT - 1_000, { buyer_pkh: OTHER_BUYER }));
    const res = await postChat(h);
    expect(res.status).toBe(202);
  });

  it("claims for an exempt buyer", async () => {
    const h = chatHarness({ buyerGuardExemptPkhs: [BUYER_PKH.toLowerCase()] });
    seedEscrow(h.chain, EARLIER_TX, submittedAt(POSTED_AT - 1_000));
    const res = await postChat(h);
    expect(res.status).toBe(202);
  });
});

// ─── POST /v1/chat/start (chat sessions, several at once) ─────────────────────

const SESSION_CAPABILITY = "llm.chat.v1";
const SESSION_MODEL = "kimi";
const SESSION_MAX_TOKENS = 512;

function sessionHarness() {
  const chain = new MockChainProvider();
  chain.seed({
    ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
    address: "addr_test1wfakeadvertaddress",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum({
      ...advertDatum(),
      capability_id: SESSION_CAPABILITY,
      model: SESSION_MODEL,
      max_output_tokens: SESSION_MAX_TOKENS,
      max_processing_ms: 1_800_000,
      price_lovelace: 200_000n,
    }),
    scriptRef: null,
  });
  const chatSessions = new ChatSessionStore();
  const state = new SupplierState(2);
  const app = createApp({
    chain,
    state,
    config: {
      ...buildSampleConfig(),
      capabilityKind: "chat-session",
      llmBackend: "openai",
      ollamaUrl: "",
      openaiBaseUrl: "http://up",
      openaiApiKey: "",
      openaiTimeoutMs: 5_000,
      openaiMaxTokens: 0,
      openaiReasoningDisabled: false,
      chatIdleTimeoutMs: 60_000,
      chatSettleMode: "full",
      maxChatSessions: 2,
    } as SupplierConfig,
    supplierKey: buildSupplierWalletKey(),
    jobs: new JobStore(),
    chatSessions,
  });
  const seedSession = (txHashChar: string, nonce: string): string => {
    const txHash = txHashChar.repeat(64);
    seedEscrow(chain, txHash, datum({
      capability_id: SESSION_CAPABILITY,
      request_spec_hash: createHash("sha256").update(canonicalize({
        capability_id: SESSION_CAPABILITY, max_output_tokens: SESSION_MAX_TOKENS, model: SESSION_MODEL,
      }), "utf8").digest("hex"),
      prompt_hash: chatSessionPromptHash({ session_nonce: nonce }),
      payment_lovelace: 200_000n,
    }));
    return `${txHash}#0`;
  };
  return { chain, state, app, chatSessions, seedSession };
}

describe("POST /v1/chat/start — one acceptable job per buyer", () => {
  it("admits one of two concurrent sessions from the same buyer and refuses the other", async () => {
    const h = sessionHarness();
    const refA = h.seedSession("6", "nonce-a");
    const refB = h.seedSession("7", "nonce-b");

    const [a, b] = await Promise.all([
      request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", refA).send({ session_nonce: "nonce-a" }),
      request(h.app).post("/v1/chat/start").set("X-Escrow-Ref", refB).send({ session_nonce: "nonce-b" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body.reason).toBe("supplier_busy");
    expect(h.state.snapshot().activeSessions).toBe(1);

    for (const ref of [refA, refB]) {
      const record = h.chatSessions.get(ref);
      if (record?.idleTimer) clearTimeout(record.idleTimer);
      if (record?.hardCapTimer) clearTimeout(record.hardCapTimer);
    }
  });
});

// ─── Config ───────────────────────────────────────────────────────────────────

describe("BUYER_GUARD_EXEMPT_PKHS", () => {
  it("parses a comma-separated list to lowercase and defaults to empty", () => {
    expect(parseBuyerGuardExemptPkhs(undefined)).toEqual([]);
    expect(parseBuyerGuardExemptPkhs("  ")).toEqual([]);
    expect(parseBuyerGuardExemptPkhs(` ${"AB".repeat(28)}, ${"cd".repeat(28)} ,`)).toEqual(["ab".repeat(28), "cd".repeat(28)]);
  });

  it("rejects anything that is not a 56-hex key hash", () => {
    expect(() => parseBuyerGuardExemptPkhs("zz")).toThrow(/BUYER_GUARD_EXEMPT_PKHS/);
    expect(() => parseBuyerGuardExemptPkhs(`${"ab".repeat(28)},${"ab".repeat(29)}`)).toThrow(/BUYER_GUARD_EXEMPT_PKHS/);
  });

  it("is read by loadConfig", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), BUYER_GUARD_EXEMPT_PKHS: "AB".repeat(28) });
    expect(cfg.buyerGuardExemptPkhs).toEqual(["ab".repeat(28)]);
  });
});
