/**
 * buyer-sdk-submit-ocr-budget.test.ts — submitOcr() waits for the advert's SLA.
 *
 * 2026-09 Apify OCR outage: the OCR job poll had a fixed 180 s budget while
 * the advert committed to a 300 s SLA, so the SDK gave up on jobs the supplier
 * finished (and Submitted) inside its window. The budget must derive from the
 * escrow's deliver_by (posted_at + max_processing_ms + network buffer) plus
 * the Submit-confirmation slack, and it must surface `submitted_ref` from the
 * supplier's done payload so the buyer can settle without the indexer.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "crypto";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { SupplierError } from "../../buyer/src/sdk/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import { signReceipt } from "../../packages/shared/src/receipt/sign.js";
import { ocrPromptHash } from "../../packages/shared/src/tx/escrow/postOcrEscrow.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";

const ADVERT_REF: OutputReference = { txHash: "b".repeat(64), index: 0 };
const ADVERT_SCRIPT_ADDR = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";
const TIP_SLOT = 1_745_500_000;
const POSTED_AT_MS = TIP_SLOT * 1000; // mock convention: slot * 1000
const SLA_MS = 300_000;
const PAYMENT = 200_000n;
const SUBMITTED_REF = `${"c".repeat(64)}#0`;

const buyer = buildBuyerWalletKey();
const supplier = buildSupplierWalletKey();
const request = { image_b64: "aGVsbG8=", mime: "image/png", output_format: "markdown" };

function advert(): AdvertDatum {
  return {
    supplier_pkh: supplier.pubKeyHash,
    capability_id: "ocr.page.extract.chandra-ocr-2.v1",
    model: "historical-records-ocr-v1",
    max_output_tokens: 4096,
    max_processing_ms: SLA_MS,
    price_lovelace: PAYMENT,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: POSTED_AT_MS,
    status: "Active",
  };
}

function donePayload(escrowRef: string) {
  const content = "# Page 1";
  const responseHash = createHash("sha256")
    .update(canonicalize({ content, output_format: "markdown" }), "utf8")
    .digest("hex");
  const signed = signReceipt(
    buildReceipt({
      prompt_hash: ocrPromptHash(request),
      response_hash: responseHash,
      model: advert().model,
      prompt_tokens: 900,
      completion_tokens: 120,
      wallclock_ms: 240_000,
      supplier_pkh: supplier.pubKeyHash,
      escrow_ref: escrowRef,
    }),
    supplier.privateKeyHex,
  );
  return {
    output_format: "markdown",
    content,
    usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    receipt: signed.receipt,
    receipt_signature: signed.signature,
    escrow_ref: escrowRef,
    submitted_ref: SUBMITTED_REF,
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A supplier that accepts the job at once and reports done only once
 * `doneAtMs` has passed — the cold-cache shape from the incident. */
function slowSupplier(doneAtMs: number) {
  let escrowRef = "";
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      escrowRef = new Headers(init.headers).get("X-Escrow-Ref") ?? "";
      return json({ job_id: "0f7a2f5e-2f1c-4d4f-9a4e-6f2a4b8c9d10", status: "accepted" }, 202);
    }
    if (Date.now() < doneAtMs) return json({ status: "running", escrow_ref: escrowRef }, 202);
    return json(donePayload(escrowRef), 200);
  });
  return fetchImpl;
}

function marketplace(fetchImpl: typeof fetch): Marketplace {
  const chain = new MockChainProvider();
  chain.advanceSlot(TIP_SLOT);
  chain.seed({
    ref: ADVERT_REF,
    address: ADVERT_SCRIPT_ADDR,
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(advert()),
    scriptRef: null,
  });
  return new Marketplace({
    chain,
    indexerUrl: "http://indexer.test",
    walletKey: buyer,
    networkParams: { networkId: 0 },
    _fetch: fetchImpl,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Marketplace.submitOcr() — supplier budget follows the advert SLA", () => {
  it("keeps polling a job that finishes inside a 300 s SLA (past the old 180 s budget)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(POSTED_AT_MS);
    const fetchImpl = slowSupplier(POSTED_AT_MS + 250_000);
    const mp = marketplace(fetchImpl as unknown as typeof fetch);

    const pending = mp.submitOcr({ advertRef: ADVERT_REF, ...request, payment_lovelace: PAYMENT });
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(260_000);
    const result = await pending;

    expect(result.content).toBe("# Page 1");
    expect(result.submittedRef).toEqual({ txHash: "c".repeat(64), index: 0 });
    expect(Date.now() - POSTED_AT_MS).toBeGreaterThanOrEqual(250_000);
  });

  it("gives up once deliver_by plus the Submit slack has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(POSTED_AT_MS);
    // Never finishes: deliver_by = posted_at + SLA + 30 s, slack 90 s → 420 s.
    const fetchImpl = slowSupplier(Number.POSITIVE_INFINITY);
    const mp = marketplace(fetchImpl as unknown as typeof fetch);

    const pending = mp.submitOcr({ advertRef: ADVERT_REF, ...request, payment_lovelace: PAYMENT });
    const outcome = pending.then(() => "resolved", (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(419_000);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(100);
    await vi.advanceTimersByTimeAsync(5_000);

    const err = await outcome;
    expect(err).toBeInstanceOf(SupplierError);
    expect((err as SupplierError).reason).toBe("timeout");
  });
});
