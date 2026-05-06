/**
 * buyer-sdk-submit-prompt-reject.test.ts — RED phase (M1-E)
 *
 * Category C: Marketplace.submitPrompt() rejection / error paths (~20 tests)
 *
 * All tests FAIL until M1-E-green.
 *
 * Each test seeds appropriate chain state and verifies the SDK throws the
 * right error class with the right `.reason` string.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { HttpError } from "../../buyer/src/sdk/httpClient.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import {
  ReceiptVerificationError,
  SupplierError,
} from "../../buyer/src/sdk/types.js";
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADVERT_TX = "b".repeat(64);
const ADVERT_REF: OutputReference = { txHash: ADVERT_TX, index: 0 };
const ADVERT_SCRIPT_ADDR = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";

const buyer = buildBuyerWalletKey();
const supplier = buildSupplierWalletKey();

const SAMPLE_MESSAGES: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }];
const PAYMENT = 2_000_000n;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeActiveAdvert(overrides: Partial<AdvertDatum> = {}): AdvertDatum {
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
    ...overrides,
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

function makeValidSupplierResponse(escrowRef: string, messages: ChatMessage[]) {
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
    choices: [{ message: { role: "assistant", content: responseContent }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
    receipt: signed.receipt,
    receipt_signature: signed.signature,
  };
}

function jsonFetch(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  );
}

function makeMarketplace(chain: MockChainProvider, fetchImpl: ReturnType<typeof vi.fn>): Marketplace {
  return new Marketplace({
    chain,
    indexerUrl: "http://indexer.test",
    walletKey: buyer,
    networkParams: { networkId: 0 },
    _fetch: fetchImpl as unknown as typeof fetch,
  } as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Marketplace.submitPrompt() — rejection paths", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let chain: MockChainProvider;

  beforeEach(() => {
    fetchSpy = vi.fn();
    chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
  });

  // 1. advert UTxO not found
  it("throws TxConstructionError('advert ref not on chain') when advert UTxO does not exist", async () => {
    // Do NOT seed any utxo
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof TxConstructionError && e.reason === "advert ref not on chain"
    );
  });

  // 2. advert.status === "Retired"
  it("throws TxConstructionError('advert is retired') when advert status is Retired", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert({ status: "Retired" }));
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof TxConstructionError && e.reason === "advert is retired"
    );
  });

  // 3. payment !== advert.price
  it("throws TxConstructionError('payment must equal advertised price') when payment differs", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert({ price_lovelace: 3_000_000n }));
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT }) // 2M != 3M
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof TxConstructionError && e.reason === "payment must equal advertised price"
    );
  });

  // 4. buyer pkh === supplier pkh
  it("throws TxConstructionError('buyer cannot be supplier') when buyer pkh equals supplier pkh", async () => {
    // Seed advert whose supplier_pkh equals buyer's pubKeyHash
    seedAdvertUtxo(chain, makeActiveAdvert({ supplier_pkh: buyer.pubKeyHash }));
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof TxConstructionError && e.reason === "buyer cannot be supplier"
    );
  });

  // 5. empty messages
  it("throws TxConstructionError('messages required') when messages array is empty", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: [], payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof TxConstructionError && e.reason === "messages required"
    );
  });

  // 6. supplier returns 4xx
  it("throws SupplierError with status 400 when supplier returns 4xx", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        return jsonFetch({ error: "bad request", reason: "capability_mismatch" }, 400);
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SupplierError && (e.status === 400 || e.status === 422)
    );
  });

  // 7. supplier returns 5xx
  it("throws SupplierError when supplier returns 503", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        return jsonFetch({ error: "service unavailable", reason: "chain_submit_failed" }, 503);
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toBeInstanceOf(SupplierError);
  });

  // 8. supplier returns malformed body (no receipt field)
  it("throws SupplierError(reason='malformed_response') when supplier body has no receipt", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        return jsonFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] }); // no receipt
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SupplierError && e.reason === "malformed_response"
    );
  });

  // 9. receipt prompt_hash mismatch
  it("throws ReceiptVerificationError('prompt_hash_mismatch') when receipt.prompt_hash doesn't match messages", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        const resp = makeValidSupplierResponse(escrowRef, SAMPLE_MESSAGES);
        // Tamper the prompt_hash
        resp.receipt = { ...resp.receipt, prompt_hash: "f".repeat(64) };
        return jsonFetch(resp);
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ReceiptVerificationError && e.reason === "prompt_hash_mismatch"
    );
  });

  // 10. receipt request_spec_hash mismatch
  it("throws ReceiptVerificationError('request_spec_hash_mismatch') when receipt request_spec doesn't match advert", async () => {
    // The SDK computes request_spec_hash = sha256(canonical({capability_id, max_output_tokens, model}))
    // and must verify the escrow datum's request_spec_hash was bound correctly.
    // In the mock we tamper by using a supplier that advertises a different model.
    // The escrow datum has the correct request_spec_hash; the receipt should bind to it.
    // Since the SDK verifies request_spec_hash from the escrow datum, we seed
    // an escrow UTxO (after escrow is posted) with a wrong request_spec_hash.
    // Simpler approach: return a receipt with a wrong model.
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        // Build a receipt with a wrong request_spec_hash-equivalent (model mismatch)
        const wrongSpecHash = sha256(canonicalize({
          capability_id: "llm.text.generate.v1",
          max_output_tokens: 512,
          model: "different-model",          // mismatch
        }));
        const advert = makeActiveAdvert();
        const promptHash = sha256(canonicalize(SAMPLE_MESSAGES));
        const responseHash = sha256(JSON.stringify({ role: "assistant", content: "4" }));
        const receipt = buildReceipt({
          prompt_hash: promptHash,
          response_hash: responseHash,
          model: "different-model",
          prompt_tokens: 12,
          completion_tokens: 4,
          wallclock_ms: 800,
          supplier_pkh: supplier.pubKeyHash,
          escrow_ref: escrowRef,
        });
        const signed = signReceipt(receipt, supplier.privateKeyHex);
        return jsonFetch({
          choices: [{ message: { role: "assistant", content: "4" } }],
          receipt: signed.receipt,
          receipt_signature: signed.signature,
        });
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ReceiptVerificationError && e.reason === "request_spec_hash_mismatch"
    );
  });

  // 11. receipt signature invalid
  it("throws ReceiptVerificationError('invalid_signature') when receipt_signature is corrupt", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        const resp = makeValidSupplierResponse(escrowRef, SAMPLE_MESSAGES);
        resp.receipt_signature = "0".repeat(128); // zeroed-out invalid signature
        return jsonFetch(resp);
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ReceiptVerificationError && e.reason === "invalid_signature"
    );
  });

  // 12. supplier_pkh in receipt ≠ advert.supplier_pkh
  it("throws ReceiptVerificationError('wrong_supplier') when receipt.supplier_pkh != advert.supplier_pkh", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        const resp = makeValidSupplierResponse(escrowRef, SAMPLE_MESSAGES);
        // Tamper supplier_pkh in the receipt
        resp.receipt = { ...resp.receipt, supplier_pkh: buyer.pubKeyHash };
        return jsonFetch(resp);
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ReceiptVerificationError && e.reason === "wrong_supplier"
    );
  });

  // 13. escrow_ref in receipt ≠ what was posted
  it("throws ReceiptVerificationError('wrong_escrow_ref') when receipt.escrow_ref doesn't match", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        const resp = makeValidSupplierResponse("e".repeat(64) + "#99", SAMPLE_MESSAGES); // wrong ref
        return jsonFetch(resp);
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ReceiptVerificationError && e.reason === "wrong_escrow_ref"
    );
  });

  // 14. network timeout
  it("throws SupplierError('timeout') when supplier HTTP request times out", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        // Simulate abort/timeout
        return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SupplierError && e.reason === "timeout"
    );
  });

  // 15. chain.submitTx fails
  it("re-throws chain error and emits progress event 'chain_submit_failed' when chain.submitTx throws", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    const chainError = new Error("chain: connection refused");
    vi.spyOn(chain, "submitTx").mockRejectedValue(chainError);
    const events: string[] = [];
    const mp = makeMarketplace(chain, fetchSpy);
    mp.on("progress", (e: ProgressEvent) => events.push(e.type));
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toThrow("chain: connection refused");
    expect(events).toContain("chain_submit_failed");
  });

  // 16. failure path does NOT emit 'receipt_verified'
  it("does not emit 'receipt_verified' when supplier returns 5xx", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        return jsonFetch({ error: "internal" }, 500);
      }
      return jsonFetch({});
    });
    const events: string[] = [];
    const mp = makeMarketplace(chain, fetchSpy);
    mp.on("progress", (e: ProgressEvent) => events.push(e.type));
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toBeInstanceOf(SupplierError);
    expect(events).not.toContain("receipt_verified");
  });

  // 17. failure path records task with status: "failed" + reason
  it("records task with status 'failed' and failure_reason when supplier returns 5xx", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        return jsonFetch({ error: "internal", reason: "ollama_failure" }, 500);
      }
      return jsonFetch({});
    });
    const mp = makeMarketplace(chain, fetchSpy);
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toBeInstanceOf(SupplierError);
    const history = mp.getTaskHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("failed");
    expect(history[0].failure_reason).toBeTruthy();
  });

  // 18. failure on receipt verification still does NOT emit 'receipt_verified'
  it("does not emit 'receipt_verified' when receipt signature is invalid", async () => {
    seedAdvertUtxo(chain, makeActiveAdvert());
    fetchSpy.mockImplementation((url: unknown, opts: unknown) => {
      if (String(url).includes("/v1/chat/completions")) {
        const headers = (opts as { headers?: Record<string, string> })?.headers ?? {};
        const escrowRef = headers["X-Escrow-Ref"] ?? "x".repeat(64) + "#0";
        const resp = makeValidSupplierResponse(escrowRef, SAMPLE_MESSAGES);
        resp.receipt_signature = "0".repeat(128);
        return jsonFetch(resp);
      }
      return jsonFetch({});
    });
    const events: string[] = [];
    const mp = makeMarketplace(chain, fetchSpy);
    mp.on("progress", (e: ProgressEvent) => events.push(e.type));
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toBeInstanceOf(ReceiptVerificationError);
    expect(events).not.toContain("receipt_verified");
  });

  // 19. TxConstructionError name field
  it("TxConstructionError has name='TxConstructionError'", () => {
    const e = new TxConstructionError("test reason");
    expect(e.name).toBe("TxConstructionError");
    expect(e.reason).toBe("test reason");
  });

  // 20. ReceiptVerificationError name field
  it("ReceiptVerificationError has name='ReceiptVerificationError'", () => {
    const e = new ReceiptVerificationError("test reason");
    expect(e.name).toBe("ReceiptVerificationError");
    expect(e.reason).toBe("test reason");
  });
});

// ─── M1-F-1: isSyncThrow dead-code removal (RED) ─────────────────────────────
//
// ARCH §9 #10: `HttpError.isSyncThrow` is dead code — production fetch never
// throws synchronously; the flag was a defensive workaround for a now-fixed
// Caroline test fixture. The sentinel return branch in Marketplace.submitPrompt
// must also be removed. These two tests stay RED until Catherine removes both.
//
// Audit note: no existing test in this file relies on the sentinel-return path.
// All tests above (1-20) correctly expect submitPrompt to REJECT on error.
// The sentinel branch (isSyncThrow → resolve with { response: "", receipt: ... })
// is never triggered by any test because the existing fetch mocks return Promises
// (not synchronous throws). Safe to remove without updating any existing test.

describe("M1-F-1: isSyncThrow flag removal", () => {
  // 21. isSyncThrow flag does not exist on HttpError
  it("RED: HttpError has no isSyncThrow property (flag removed)", () => {
    // Will RED until Catherine removes `public readonly isSyncThrow` from HttpError.
    // After removal, new HttpError(...) must NOT expose isSyncThrow.
    // HttpError is statically imported at top of file.
    const err = new HttpError("network", "test error");
    expect((err as unknown as Record<string, unknown>).isSyncThrow).toBeUndefined();
  });

  // 22. Synchronously-throwing fetch rejects (not sentinel-resolves)
  it("RED: submitPrompt REJECTS (not resolves) when injected fetch throws synchronously", async () => {
    // Will RED until Catherine removes the isSyncThrow sentinel branch.
    // Currently: a sync-throwing fetch → sentinel resolve { response: "", ... }.
    // After fix:  a sync-throwing fetch → HttpError("network", ...) → propagation → REJECT.
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, makeActiveAdvert());

    // A fetch that throws SYNCHRONOUSLY (not returning a Promise).
    const syncThrowFetch = vi.fn(() => {
      throw new Error("sync throw from mock fetch");
    });

    const mp = makeMarketplace(chain, syncThrowFetch);
    // Must REJECT — the sentinel-return path must not exist after M1-F-1-green.
    await expect(
      mp.submitPrompt({ advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT })
    ).rejects.toThrow();
  });
});
