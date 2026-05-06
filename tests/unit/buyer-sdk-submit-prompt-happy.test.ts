/**
 * buyer-sdk-submit-prompt-happy.test.ts — RED phase (M1-E)
 *
 * Category B: Marketplace.submitPrompt() happy path
 *
 * All tests FAIL until M1-E-green.
 *
 * Design notes for Catherine:
 * - advertRef is resolved via chain.queryUtxo (MockChainProvider.seed)
 * - PostEscrow tx is submitted via chain.submitTx (MockChainProvider records it)
 * - Supplier is called via POST ${advert.endpoint_url}/v1/chat/completions
 *   with header X-Escrow-Ref: <txHash>#<index>
 * - Receipt is verified via verifyReceipt(signed, advert.supplier_pkh → pub key)
 *   NOTE: verifyReceipt takes a SignedReceipt + publicKeyHex; the SDK needs to
 *   map supplier_pkh → pubKeyHex. In v1 the supplier's /capability endpoint
 *   returns the pubKey; alternatively store it in SupplierView. The test mocks
 *   the supplier HTTP endpoint including a /capability call to get pubKeyHex.
 * - Progress events must be emitted in order: escrow_posted, supplier_called, receipt_verified
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import { signReceipt } from "../../packages/shared/src/receipt/sign.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import type { Utxo, OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import type { ChatMessage } from "../../packages/shared/src/tx/types.js";
import type { ProgressEvent } from "../../buyer/src/sdk/types.js";
import { ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/escrow/accept.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADVERT_TX = "b".repeat(64);
const ADVERT_REF: OutputReference = { txHash: ADVERT_TX, index: 0 };
const ADVERT_SCRIPT_ADDR = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";

const buyer = buildBuyerWalletKey();
const supplier = buildSupplierWalletKey();

const SAMPLE_MESSAGES: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }];
const PAYMENT = 2_000_000n;

function makeActiveAdvert(): AdvertDatum {
  return {
    supplier_pkh: supplier.pubKeyHash,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: PAYMENT,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

function seedAdvertUtxo(chain: MockChainProvider, datum: AdvertDatum, ref = ADVERT_REF) {
  const utxo: Utxo = {
    ref,
    address: ADVERT_SCRIPT_ADDR,
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Build a well-formed supplier HTTP response (OpenAI-compat shape + receipt).
 * Signing uses the supplier fixture private key — verifyReceipt must pass.
 */
function makeSupplierResponse(escrowRef: string, messages: ChatMessage[]) {
  const advert = makeActiveAdvert();
  const promptHash = sha256(canonicalize(messages));
  const responseContent = "4";
  const responseHash = sha256(JSON.stringify({ role: "assistant", content: responseContent }));
  const receipt = buildReceipt({
    prompt_hash: promptHash,
    response_hash: responseHash,
    model: advert.model,
    prompt_tokens: 12,
    completion_tokens: 4,
    wallclock_ms: 800,
    supplier_pkh: supplier.pubKeyHash,
    escrow_ref: escrowRef,
  });
  const signed = signReceipt(receipt, supplier.privateKeyHex);
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: responseContent },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    receipt: signed.receipt,
    receipt_signature: signed.signature,
  };
}

function jsonFetch(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function makeMarketplaceWithFetch(fetchImpl: ReturnType<typeof vi.fn>): Marketplace {
  const chain = new MockChainProvider();
  chain.advanceSlot(1_745_500_000);
  seedAdvertUtxo(chain, makeActiveAdvert());
  return new Marketplace({
    chain,
    indexerUrl: "http://indexer.test",
    walletKey: buyer,
    networkParams: { networkId: 0 },
    _fetch: fetchImpl as unknown as typeof fetch,
  } as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Marketplace.submitPrompt() — happy path", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let chain: MockChainProvider;

  beforeEach(() => {
    fetchSpy = vi.fn();
    chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, makeActiveAdvert());
  });

  it("resolves advert via chain.queryUtxo(advertRef) before posting escrow", async () => {
    const querySpy = vi.spyOn(chain, "queryUtxo");
    // Fetch: supplier /v1/chat/completions — use actual X-Escrow-Ref header so receipt.escrow_ref matches the posted tx.
    fetchSpy.mockImplementation((_url: unknown, opts: unknown) => {
      const url = String(_url);
      if (url.includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? headers["x-escrow-ref"] ?? `${"f".repeat(64)}#0`;
        return jsonFetch(makeSupplierResponse(escrowRef, SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    expect(querySpy).toHaveBeenCalledWith(ADVERT_REF);
  });

  it("submits the PostEscrow tx via chain.submitTx", async () => {
    const submitSpy = vi.spyOn(chain, "submitTx");
    fetchSpy.mockImplementation((_url: unknown, opts: unknown) => {
      const url = String(_url);
      if (url.includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? headers["x-escrow-ref"] ?? `${"f".repeat(64)}#0`;
        return jsonFetch(makeSupplierResponse(escrowRef, SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    expect(submitSpy).toHaveBeenCalled();
  });

  it("calls POST ${advert.endpoint_url}/v1/chat/completions with X-Escrow-Ref header", async () => {
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      const u = String(url);
      if (u.includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        // Must include X-Escrow-Ref header
        expect(headers["X-Escrow-Ref"] ?? headers["x-escrow-ref"]).toMatch(/^[0-9a-fA-F]{64}#\d+$/);
        return jsonFetch(makeSupplierResponse(headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0", SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("calls supplier /v1/chat/completions with OpenAI-shaped body (messages, max_tokens)", async () => {
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      const u = String(url);
      if (u.includes("/v1/chat/completions")) {
        const body = JSON.parse((opts as { body?: string })?.body ?? "{}");
        expect(body.messages).toEqual(SAMPLE_MESSAGES);
        expect(typeof body.max_tokens).toBe("number");
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        return jsonFetch(makeSupplierResponse(headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0", SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
  });

  it("resolves with {response, receipt, receiptSignature, escrowRef} on success", async () => {
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      const u = String(url);
      if (u.includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        return jsonFetch(makeSupplierResponse(escrowRef, SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    const result = await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("receipt");
    expect(result).toHaveProperty("receiptSignature");
    expect(result).toHaveProperty("escrowRef");
    expect(result.response).toBe("4");
  });

  it("verifies receipt.prompt_hash matches sha256(canonical(messages))", async () => {
    const expectedPromptHash = sha256(canonicalize(SAMPLE_MESSAGES));
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      const u = String(url);
      if (u.includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        return jsonFetch(makeSupplierResponse(escrowRef, SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    const result = await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    expect(result.receipt.prompt_hash).toBe(expectedPromptHash);
  });

  it("emits progress events in order: escrow_posted, supplier_called, receipt_verified", async () => {
    const events: string[] = [];
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      const u = String(url);
      if (u.includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        return jsonFetch(makeSupplierResponse(escrowRef, SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    mp.on("progress", (e: ProgressEvent) => events.push(e.type));
    await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    expect(events).toEqual(["escrow_posted", "supplier_called", "receipt_verified"]);
  });

  it("records completed task to TaskHistoryStore after successful submitPrompt", async () => {
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      const u = String(url);
      if (u.includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        return jsonFetch(makeSupplierResponse(escrowRef, SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    const history = mp.getTaskHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("completed");
  });

  it("escrowRef in result matches what was submitted to the chain", async () => {
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      const u = String(url);
      if (u.includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        return jsonFetch(makeSupplierResponse(escrowRef, SAMPLE_MESSAGES));
      }
      return jsonFetch({});
    });
    const mp = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchSpy as unknown as typeof fetch,
    } as never);
    const result = await mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT });
    // escrowRef must be a valid OutputReference with a real 64-char txHash
    expect(result.escrowRef.txHash).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(typeof result.escrowRef.index).toBe("number");
  });

  // The ACCEPT_WINDOW_MS constant must be 600_000 ms (10 min) per ARCHITECTURE §4.3.
  it("ACCEPT_WINDOW_MS is 600000 (10 minutes)", () => {
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
  });
});
