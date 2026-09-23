import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import type { ProgressEvent } from "../../buyer/src/sdk/types.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import { signReceipt } from "../../packages/shared/src/receipt/sign.js";
import {
  createResponse,
  responseRequestCommitment,
  responseResultCommitment,
  type ResponseItem,
  type ResponseRequest,
} from "../../packages/shared/src/responses.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ADVERT_REF: OutputReference = { txHash: "b".repeat(64), index: 0 };
const PAYMENT = 2_000_000n;
const buyer = buildBuyerWalletKey();
const supplier = buildSupplierWalletKey();
const INPUT: ResponseItem[] = [{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "What is 2+2?" }],
}];

function advert(): AdvertDatum {
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

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function seedAdvert(chain: MockChainProvider): void {
  const datum = advert();
  const utxo: Utxo = {
    ref: ADVERT_REF,
    address: "addr_test1wfakeadvert",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
}

function capability() {
  const datum = advert();
  return {
    capability_id: datum.capability_id,
    model: datum.model,
    max_output_tokens: datum.max_output_tokens,
    max_processing_ms: datum.max_processing_ms,
    price_lovelace: datum.price_lovelace.toString(),
    advert_ref: `${ADVERT_REF.txHash}#${ADVERT_REF.index}`,
    supplier_pkh: datum.supplier_pkh,
    pub_key_hex: supplier.pubKeyHex,
    inference_api: "responses",
    upstream_api: "responses",
  };
}

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function supplierResult(escrowRef: string, request: ResponseRequest) {
  const output: ResponseItem[] = [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "4", annotations: [] }],
  }];
  const result = createResponse({
    id: "resp_test",
    model: advert().model,
    output,
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  });
  const receipt = buildReceipt({
    prompt_hash: sha256(responseRequestCommitment(request)),
    response_hash: sha256(responseResultCommitment(result)),
    model: advert().model,
    prompt_tokens: 12,
    completion_tokens: 4,
    wallclock_ms: 800,
    supplier_pkh: supplier.pubKeyHash,
    escrow_ref: escrowRef,
  });
  const signed = signReceipt(receipt, supplier.privateKeyHex);
  return { ...result, receipt: signed.receipt, receipt_signature: signed.signature };
}

describe("Marketplace.submitPrompt Responses lifecycle", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvert(chain);
  });

  it("returns the canonical terminal result and exact text convenience", async () => {
    const events: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/capability")) return json(capability());
      if (String(url).endsWith("/v1/responses")) {
        const request = JSON.parse(String(init?.body)) as ResponseRequest & { model: string };
        const escrowRef = new Headers(init?.headers).get("X-Escrow-Ref") ?? "";
        return json(supplierResult(escrowRef, request));
      }
      return json({});
    });
    const marketplace = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchImpl as typeof fetch,
    });
    marketplace.on("progress", (event: ProgressEvent) => events.push(event.type));

    const result = await marketplace.submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      payment_lovelace: PAYMENT,
    });

    expect(result.response).toBe("4");
    expect(result.request).toEqual({ input: INPUT });
    expect(result.result.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message", role: "assistant" }),
    ]));
    expect(result.receipt.response_hash).toBe(sha256(responseResultCommitment(result.result)));
    expect(events).toEqual(["escrow_posted", "supplier_called", "receipt_verified"]);
  });

  it("leaves max_output_tokens absent when the buyer omits it", async () => {
    let postedRequest: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/capability")) return json(capability());
      const request = JSON.parse(String(init?.body)) as ResponseRequest & { model: string };
      postedRequest = request;
      return json(supplierResult(
        new Headers(init?.headers).get("X-Escrow-Ref") ?? "",
        request,
      ));
    });
    const marketplace = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchImpl as typeof fetch,
    });

    await marketplace.submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      payment_lovelace: PAYMENT,
    });

    expect(postedRequest).not.toHaveProperty("max_output_tokens");
  });

  it("funds and submits structured text formats to a Chat supplier", async () => {
    let postedRequest: ResponseRequest | undefined;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/capability")) {
        return json({ ...capability(), upstream_api: "chat-completions" });
      }
      const request = JSON.parse(String(init?.body)) as ResponseRequest & { model: string };
      postedRequest = request;
      return json(supplierResult(
        new Headers(init?.headers).get("X-Escrow-Ref") ?? "",
        request,
      ));
    });
    const marketplace = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchImpl as typeof fetch,
    });
    const text = {
      format: {
        type: "json_schema",
        name: "token",
        strict: true,
        schema: {
          type: "object",
          properties: { token: { type: "string", enum: ["ZQX-7741"] } },
          required: ["token"],
          additionalProperties: false,
        },
      },
    };

    const result = await marketplace.submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      text,
      payment_lovelace: PAYMENT,
    });

    expect(postedRequest?.text).toEqual(text);
    expect(result.request.text).toEqual(text);
  });

  it("caps an explicit buyer output limit before escrow and supplier submission", async () => {
    let postedRequest: ResponseRequest | undefined;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/capability")) {
        return json({ ...capability(), max_output_tokens: 256 });
      }
      const request = JSON.parse(String(init?.body)) as ResponseRequest & { model: string };
      postedRequest = request;
      return json(supplierResult(
        new Headers(init?.headers).get("X-Escrow-Ref") ?? "",
        request,
      ));
    });
    const marketplace = new Marketplace({
      chain,
      indexerUrl: "http://indexer.test",
      walletKey: buyer,
      networkParams: { networkId: 0 },
      _fetch: fetchImpl as typeof fetch,
    });

    const result = await marketplace.submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      max_output_tokens: 4_096,
      payment_lovelace: PAYMENT,
    });

    expect(postedRequest?.max_output_tokens).toBe(256);
    expect(result.receipt.prompt_hash).toBe(
      sha256(responseRequestCommitment({ input: INPUT, max_output_tokens: 256 })),
    );
  });
});
