import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import {
  ReceiptVerificationError,
  SupplierError,
} from "../../buyer/src/sdk/types.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import {
  BOUNDED_INPUT_DETAIL_MARKER,
  TxConstructionError,
} from "../../packages/shared/src/tx/index.js";
import {
  createResponse,
  responseRequestCommitment,
  responseResultCommitment,
  ResponseCompatibilityError,
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

function advert(overrides: Partial<AdvertDatum> = {}): AdvertDatum {
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

function seedAdvert(chain: MockChainProvider, datum = advert()): void {
  chain.seed({
    ref: ADVERT_REF,
    address: "addr_test1wfakeadvert",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  });
}

function capability(
  datum: AdvertDatum,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    ...overrides,
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function terminalBody(
  escrowRef: string,
  request: ResponseRequest,
  responseHash?: string,
) {
  const result = createResponse({
    id: "resp_test",
    model: advert().model,
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "4" }],
    }],
  });
  const receipt = buildReceipt({
    prompt_hash: sha256(responseRequestCommitment(request)),
    response_hash: responseHash ?? sha256(responseResultCommitment(result)),
    model: advert().model,
    prompt_tokens: 12,
    completion_tokens: 4,
    wallclock_ms: 800,
    supplier_pkh: supplier.pubKeyHash,
    escrow_ref: escrowRef,
  });
  return { ...result, receipt, receipt_signature: "f".repeat(128) };
}

function marketplace(chain: MockChainProvider, fetchImpl: typeof fetch): Marketplace {
  return new Marketplace({
    chain,
    indexerUrl: "http://indexer.test",
    walletKey: buyer,
    networkParams: { networkId: 0 },
    _fetch: fetchImpl,
  });
}

describe("Marketplace.submitPrompt Responses rejection paths", () => {
  let chain: MockChainProvider;

  beforeEach(() => {
    chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
  });

  it("rejects a supplier without inference_api=responses before locking funds", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum, {
      inference_api: undefined,
    }))) as unknown as typeof fetch;

    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TxConstructionError &&
        error.reason === "supplier_preflight_failed",
    );
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects an empty one-shot request before supplier calls or escrow funding", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum))) as unknown as typeof fetch;
    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: [],
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) => error instanceof TxConstructionError && error.reason === "invalid_response_request",
    );
    expect(submitSpy).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an orphan function result before supplier calls or escrow funding", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum))) as unknown as typeof fetch;
    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: [{ type: "function_call_output", call_id: "missing", output: "value" }],
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) => error instanceof TxConstructionError && error.reason === "invalid_response_request",
    );
    expect(submitSpy).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects a reasoning effort forbidden by supplier policy before funding", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum, {
      reasoning_disabled: true,
    }))) as unknown as typeof fetch;
    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      reasoning: { effort: "high" },
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TxConstructionError &&
        error.reason === "supplier_adapter_incompatible" &&
        error.cause instanceof ResponseCompatibilityError &&
        error.cause.param === "reasoning.effort",
    );
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects reasoning for a chat-completions adapter before locking funds", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum, {
      upstream_api: "chat-completions",
    }))) as unknown as typeof fetch;

    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: [
        {
          type: "reasoning",
          encrypted_content: "opaque",
        },
        ...INPUT,
      ],
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TxConstructionError &&
        error.reason === "supplier_adapter_incompatible",
    );
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects Chat text verbosity with a precise cause before locking funds", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum, {
      upstream_api: "chat-completions",
    }))) as unknown as typeof fetch;

    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      text: { verbosity: "high" },
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TxConstructionError &&
        error.reason === "supplier_adapter_incompatible" &&
        error.cause instanceof ResponseCompatibilityError &&
        error.cause.param === "text.verbosity",
    );
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects replayed function-call Items for Ollama before locking funds", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum, {
      upstream_api: "ollama",
    }))) as unknown as typeof fetch;

    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: [
        ...INPUT,
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "{\"query\":\"cardano\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "{\"result\":\"apex\"}",
        },
      ],
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TxConstructionError &&
        error.reason === "supplier_adapter_incompatible",
    );
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects a receipt that does not commit the terminal Response result", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/capability")) return json(capability(datum));
      const request = JSON.parse(String(init?.body)) as ResponseRequest & { model: string };
      const escrowRef = new Headers(init?.headers).get("X-Escrow-Ref") ?? "";
      return json(terminalBody(escrowRef, request, "0".repeat(64)));
    }) as unknown as typeof fetch;

    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ReceiptVerificationError &&
        error.reason === "response_hash_mismatch",
    );
  });

  it("surfaces an HTTP failure as a SupplierError and records no success", async () => {
    const datum = advert();
    seedAdvert(chain, datum);
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/capability")) return json(capability(datum));
      return json({ reason: "upstream_failed", message: "provider unavailable" }, 503);
    }) as unknown as typeof fetch;
    const sdk = marketplace(chain, fetchImpl);

    await expect(sdk.submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SupplierError &&
        error.reason === "upstream_failed",
    );
    expect(sdk.getTaskHistory()).toEqual([
      expect.objectContaining({ status: "failed", failure_reason: "upstream_failed" }),
    ]);
  });

  it("enforces a bounded supplier input limit before locking funds", async () => {
    const datum = advert({
      detail_uri: `https://supplier.example.com/reseller${BOUNDED_INPUT_DETAIL_MARKER}`,
    });
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum, {
      max_input_tokens: 1,
    }))) as unknown as typeof fetch;

    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TxConstructionError &&
        error.reason === "input_cap_exceeded",
    );
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("counts instructions and tool schemas before funding a bounded supplier", async () => {
    const datum = advert({
      detail_uri: `https://supplier.example.com/reseller${BOUNDED_INPUT_DETAIL_MARKER}`,
    });
    seedAdvert(chain, datum);
    const submitSpy = vi.spyOn(chain, "submitTx");
    const fetchImpl = vi.fn(async () => json(capability(datum, {
      max_input_tokens: 500,
    }))) as unknown as typeof fetch;

    await expect(marketplace(chain, fetchImpl).submitPrompt({
      advertRef: ADVERT_REF,
      input: INPUT,
      instructions: "Keep all of these constraints. ".repeat(100),
      tools: [{
        type: "function",
        name: "lookup",
        description: "Large bounded schema. ".repeat(100),
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Detailed query constraints. ".repeat(100),
            },
          },
          required: ["query"],
        },
      }],
      payment_lovelace: PAYMENT,
    })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TxConstructionError &&
        error.reason === "input_cap_exceeded",
    );
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
