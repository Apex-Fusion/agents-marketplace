import { describe, it, expect, vi } from "vitest";
import { seal, open } from "../src/crypto/seal.js";
import { Mutex } from "../src/sdk/registry.js";
import { selectCandidates, listModels, parseRef } from "../src/routing/selectSupplier.js";
import { parseResponseRequest } from "../src/openai/validate.js";
import { publicResponse, responseSse, usageFromReceipt } from "../src/openai/shapes.js";
import { createResponse } from "@marketplace/shared/responses";
import { totalLovelace, hasCollateral, preflight } from "../src/onchain/preflight.js";
import { GatewayError } from "../src/openai/errors.js";

const MASTER = "ab".repeat(32); // 64 hex

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jsonResponse(body: unknown): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;
}

describe("crypto/seal", () => {
  it("round-trips and binds the master key", () => {
    const priv = "cd".repeat(32);
    const sealed = seal(priv, MASTER);
    expect(open(sealed, MASTER)).toBe(priv);
    // Wrong key fails the GCM auth tag.
    expect(() => open(sealed, "ff".repeat(32))).toThrow();
    // Tampered ciphertext fails.
    expect(() => open({ ...sealed, ct: sealed.ct.replace(/.$/, "0") }, MASTER)).toThrow();
  });
});

describe("Mutex", () => {
  it("serializes in submission order and survives rejection", async () => {
    const m = new Mutex();
    const order: number[] = [];
    const p1 = m.run(async () => {
      await delay(20);
      order.push(1);
    });
    const p2 = m.run(async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);

    await m.run(async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    expect(await m.run(async () => 42)).toBe(42);
  });

  it("does not abandon a session operation at the wallet mutex deadline", async () => {
    vi.useFakeTimers();
    try {
      const mutex = new Mutex({ timeoutMs: 0 });
      let release: (() => void) | undefined;
      const first = mutex.run(() => new Promise<void>((resolve) => {
        release = resolve;
      }), "session-turn");
      let secondRan = false;
      const second = mutex.run(async () => {
        secondRan = true;
      }, "session-turn");

      await vi.advanceTimersByTimeAsync(300_000);
      expect(secondRan).toBe(false);
      release?.();
      await Promise.all([first, second]);
      expect(secondRan).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("routing/selectSupplier", () => {
  const rows = [
    { utxo_ref: "aa".repeat(32) + "#0", supplier_pkh: "s1", capability_id: "llm.text.generate.v1", model: "m", max_output_tokens: 1, price_lovelace: "2", supplier_bond_lovelace: "1", buyer_bond_lovelace: "1", endpoint_url: "http://a", advert_status: "Active", status: "free" },
    { utxo_ref: "bb".repeat(32) + "#1", supplier_pkh: "s2", capability_id: "llm.text.generate.v1", model: "m", max_output_tokens: 1, price_lovelace: "9", supplier_bond_lovelace: "1", buyer_bond_lovelace: "1", endpoint_url: "http://b", advert_status: "Active", status: "unknown" },
    { utxo_ref: "cc".repeat(32) + "#0", supplier_pkh: "s3", capability_id: "llm.text.generate.v1", model: "m", max_output_tokens: 1, price_lovelace: "1", supplier_bond_lovelace: "1", buyer_bond_lovelace: "1", endpoint_url: "http://c", advert_status: "Retired", status: "free" },
    { utxo_ref: "dd".repeat(32) + "#0", supplier_pkh: "s4", capability_id: "llm.chat.v1", model: "m", max_output_tokens: 1, price_lovelace: "1", supplier_bond_lovelace: "1", buyer_bond_lovelace: "1", endpoint_url: "http://d", advert_status: "Active", status: "free" },
    { utxo_ref: "ee".repeat(32) + "#0", supplier_pkh: "s5", capability_id: "llm.text.generate.v1", model: "other", max_output_tokens: 1, price_lovelace: "1", supplier_bond_lovelace: "1", buyer_bond_lovelace: "1", endpoint_url: "http://e", advert_status: "Active", status: "free" },
  ];

  it("matches capability + model + Active + (free|unknown), free first", async () => {
    const got = await selectCandidates({
      indexerUrl: "http://ix",
      model: "m",
      capabilityId: "llm.text.generate.v1",
      fetchFn: jsonResponse(rows),
    });
    expect(got.map((c) => c.supplierPkh)).toEqual(["s1", "s2"]); // s3 Retired, s4 chat, s5 other model
    expect(got[0].status).toBe("free");
    expect(got[1].status).toBe("unknown");
    expect(got[0].priceLovelace).toBe(2n);
  });

  it("pins routing to an exact supplier when requested", async () => {
    const got = await selectCandidates({
      indexerUrl: "http://ix",
      model: "m",
      capabilityId: "llm.text.generate.v1",
      supplierPkh: "s2",
      fetchFn: jsonResponse(rows),
    });
    expect(got.map((candidate) => candidate.supplierPkh)).toEqual(["s2"]);
  });

  it("orders the preferred supplier first and keeps fallback candidates", async () => {
    const got = await selectCandidates({
      indexerUrl: "http://ix",
      model: "m",
      capabilityId: "llm.text.generate.v1",
      preferredSupplierPkh: "s2",
      fetchFn: jsonResponse(rows),
    });
    expect(got.map((candidate) => candidate.supplierPkh)).toEqual(["s2", "s1"]);
  });

  it("routes chat.v1 separately", async () => {
    const got = await selectCandidates({
      indexerUrl: "http://ix",
      model: "m",
      capabilityId: "llm.chat.v1",
      fetchFn: jsonResponse(rows),
    });
    expect(got.map((c) => c.supplierPkh)).toEqual(["s4"]);
  });

  it("lists distinct Active models", async () => {
    expect(await listModels({ indexerUrl: "http://ix", fetchFn: jsonResponse(rows) })).toEqual(["m", "other"]);
  });

  it("lists only one capability's models when capabilityId is given", async () => {
    expect(await listModels({ indexerUrl: "http://ix", capabilityId: "llm.chat.v1", fetchFn: jsonResponse(rows) })).toEqual(["m"]);
  });

  it("parseRef", () => {
    expect(parseRef("aa".repeat(32) + "#3")).toEqual({ txHash: "aa".repeat(32), index: 3 });
    expect(parseRef("nope")).toBeNull();
  });

  it("ignoreStatusFor readmits a busy supplier by pkh (stale indexer status)", async () => {
    const busy = [
      { ...rows[0], status: "working" },
      { ...rows[1], status: "offline" },
    ];
    const base = { indexerUrl: "http://ix", model: "m", capabilityId: "llm.text.generate.v1" };
    const excluded = await selectCandidates({ ...base, fetchFn: jsonResponse(busy) });
    expect(excluded).toEqual([]);

    const readmitted = await selectCandidates({
      ...base,
      fetchFn: jsonResponse(busy),
      ignoreStatusFor: new Set(["s1"]),
    });
    expect(readmitted.map((c) => c.supplierPkh)).toEqual(["s1"]);
  });
});

describe("openai/Responses", () => {
  it("normalizes string input and supported controls", () => {
    const parsed = parseResponseRequest({
      model: "m",
      input: "hi",
      temperature: 0.7,
      max_output_tokens: 50,
      tools: [{ type: "function", name: "clock", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "clock" },
    });
    expect(parsed.input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    }]);
    expect(parsed.max_output_tokens).toBe(50);
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.store).toBe(true);
    expect(parsed.stream).toBe(false);
    expect(parsed.tools?.[0].name).toBe("clock");
  });

  it("accepts continuation without new input and validates Vector supplier pins", () => {
    const supplierPkh = "a".repeat(56);
    const parsed = parseResponseRequest({
      model: "m",
      previous_response_id: "resp_parent",
      x_vector: { supplier_pkh: supplierPkh },
      store: false,
    });
    expect(parsed.input).toEqual([]);
    expect(parsed.previousResponseId).toBe("resp_parent");
    expect(parsed.supplierPkh).toBe(supplierPkh);
    expect(parsed.store).toBe(false);
    expect(() => parseResponseRequest({
      model: "m", input: "x", x_vector: { supplier_pkh: "bad" },
    })).toThrow(GatewayError);
  });

  it("preserves typed reasoning and public storage controls", () => {
    const reasoning = {
      id: "rs_1",
      type: "reasoning" as const,
      summary: [{ type: "summary_text", text: "summary" }],
      encrypted_content: "opaque",
      status: "completed",
    };
    const parsed = parseResponseRequest({
      model: "m",
      input: [reasoning],
      instructions: "current turn only",
      include: ["reasoning.encrypted_content"],
      metadata: { trace: "one" },
    });
    expect(parsed.input).toEqual([reasoning]);
    expect(parsed.instructions).toBe("current turn only");
    expect(parsed.include).toEqual(["reasoning.encrypted_content"]);
    expect(parsed.metadata).toEqual({ trace: "one" });
  });

  it("rejects old and unsupported controls instead of ignoring them", () => {
    expect(() => parseResponseRequest({ model: "m", messages: [] })).toThrow(GatewayError);
    expect(() => parseResponseRequest({ model: "m", input: "x", max_tokens: 5 })).toThrow(GatewayError);
    expect(() => parseResponseRequest({
      model: "m", input: "x", tools: [{ type: "web_search_preview" }],
    })).toThrow(GatewayError);
    expect(() => parseResponseRequest({ model: "m", input: "x", conversation: "conv_1" }))
      .toThrow(GatewayError);
    expect(() => parseResponseRequest({ model: "m", input: [] })).toThrow(GatewayError);
  });

  const receipt = {
    prompt_hash: "p", response_hash: "r", model: "m", prompt_tokens: 3,
    completion_tokens: 5, wallclock_ms: 1, supplier_pkh: "s", escrow_ref: "x#0",
  };
  it("builds one typed terminal object for JSON and canonical SSE", () => {
    const usage = usageFromReceipt(receipt);
    expect(usage).toEqual({ input_tokens: 3, output_tokens: 5, total_tokens: 8 });
    const result = createResponse({
      id: "supplier",
      model: "m",
      output: [{
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      }],
      usage,
    });
    const response = publicResponse({
      id: "resp_1",
      model: "m",
      result,
      vector: { receipt, receipt_signature: "sig", escrow_ref: "x#0" },
    });
    expect(response.object).toBe("response");
    expect(response.output).toEqual(result.output);
    expect(response.x_vector).toEqual({
      receipt, receipt_signature: "sig", escrow_ref: "x#0",
    });
    const stream = responseSse(response);
    expect(stream).not.toContain("[DONE]");
    const payloads = stream.trim().split("\n\n").map((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new Error("SSE frame has no data");
      return JSON.parse(data.slice(6)) as unknown;
    });
    const eventTypes = payloads.map((payload) =>
      typeof payload === "object" && payload !== null && "type" in payload ? payload.type : undefined);
    expect(eventTypes).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const sequence = payloads.map((payload) =>
      typeof payload === "object" && payload !== null && "sequence_number" in payload
        ? payload.sequence_number
        : undefined);
    expect(sequence).toEqual(payloads.map((_, index) => index));
    const createdPayload = payloads[0];
    if (typeof createdPayload !== "object" || createdPayload === null ||
        !("response" in createdPayload) || typeof createdPayload.response !== "object" ||
        createdPayload.response === null) throw new Error("created SSE frame has no response");
    expect("x_vector" in createdPayload.response).toBe(false);
    const terminalPayload = payloads.at(-1);
    if (typeof terminalPayload !== "object" || terminalPayload === null ||
        !("response" in terminalPayload)) throw new Error("terminal SSE frame has no response");
    expect(terminalPayload.response).toEqual(response);
  });
});

describe("onchain/preflight", () => {
  const pure = (lov: bigint) => ({ ref: { txHash: "x", index: 0 }, address: "a", lovelace: lov, assets: {}, datumHex: null, scriptRef: null });
  const mixed = (lov: bigint) => ({ ...pure(lov), assets: { "policy.tok": 1n } });

  it("totalLovelace + hasCollateral", () => {
    expect(totalLovelace([pure(3_000_000n), pure(4_000_000n)])).toBe(7_000_000n);
    expect(hasCollateral([pure(4_000_000n)])).toBe(false); // < 5 ADA
    expect(hasCollateral([mixed(6_000_000n)])).toBe(false); // has native asset
    expect(hasCollateral([pure(6_000_000n)])).toBe(true);
  });

  it("preflight requires balance AND collateral", async () => {
    const cost = {
      capabilityId: "llm.text.generate.v1",
      priceLovelace: 2_000_000n,
      buyerBondLovelace: 1_000_000n,
      supplierBondLovelace: 1_000_000n,
    };
    // required = escrowLockFloor(2 + 1 + 1) + 5 (collateral) + 2 (fee) = 11 ADA
    // — at this economic total (4 ADA) the Submitted-state min-ada floor for a
    // short capability id (~2.2 ADA) stays well under the raw total, so the
    // floor is a no-op here; tx-minada-floor.test.ts covers the lifted case.
    const fakeChain = { queryUtxosByAddress: async () => [pure(20_000_000n)] } as any;
    const ok = await preflight(fakeChain, "a", cost);
    expect(ok.ok).toBe(true);
    expect(ok.requiredLovelace).toBe(11_000_000n);

    const poor = { queryUtxosByAddress: async () => [pure(4_000_000n)] } as any;
    const bad = await preflight(poor, "a", cost);
    expect(bad.ok).toBe(false);
    expect(bad.collateralOk).toBe(false);
  });
});
