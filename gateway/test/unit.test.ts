import { describe, it, expect } from "vitest";
import { seal, open } from "../src/crypto/seal.js";
import { Mutex } from "../src/sdk/registry.js";
import { selectCandidates, listModels, parseRef } from "../src/routing/selectSupplier.js";
import { parseChatRequest } from "../src/openai/validate.js";
import { buildChatCompletion, buildChunk, usageFromReceipt, renderMessages } from "../src/openai/shapes.js";
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

  it("parseRef", () => {
    expect(parseRef("aa".repeat(32) + "#3")).toEqual({ txHash: "aa".repeat(32), index: 3 });
    expect(parseRef("nope")).toBeNull();
  });
});

describe("openai/validate", () => {
  it("accepts a valid body and ignores temperature", () => {
    const p = parseChatRequest({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.7, max_tokens: 50 });
    expect(p.model).toBe("m");
    expect(p.maxTokens).toBe(50);
    expect(p.stream).toBe(false);
  });
  it("rejects tools/functions", () => {
    expect(() => parseChatRequest({ model: "m", messages: [{ role: "user", content: "x" }], tools: [] })).toThrow(GatewayError);
  });
  it("rejects empty messages and bad model", () => {
    expect(() => parseChatRequest({ model: "m", messages: [] })).toThrow();
    expect(() => parseChatRequest({ messages: [{ role: "user", content: "x" }] })).toThrow();
  });
});

describe("openai/shapes", () => {
  const receipt = { prompt_hash: "p", response_hash: "r", model: "m", prompt_tokens: 3, completion_tokens: 5, wallclock_ms: 1, supplier_pkh: "s", escrow_ref: "x#0" };
  it("usage + completion shape", () => {
    const usage = usageFromReceipt(receipt);
    expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
    const cc = buildChatCompletion({ id: "id", model: "m", content: "hello", usage, vector: { receipt, receipt_signature: "sig", escrow_ref: "x#0" } });
    expect(cc.object).toBe("chat.completion");
    expect((cc.choices as any)[0].message).toEqual({ role: "assistant", content: "hello" });
    expect((cc as any).x_vector.escrow_ref).toBe("x#0");
  });
  it("chunk shape", () => {
    const ch = buildChunk({ id: "id", model: "m", delta: { content: "tok" }, finishReason: null });
    expect(ch.object).toBe("chat.completion.chunk");
    expect((ch.choices as any)[0].delta.content).toBe("tok");
  });
  it("renderMessages folds roles", () => {
    expect(renderMessages([{ role: "system", content: "be nice" }, { role: "user", content: "hi" }])).toBe("System: be nice\n\nUser: hi");
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
    const cost = { priceLovelace: 2_000_000n, buyerBondLovelace: 1_000_000n, supplierBondLovelace: 1_000_000n };
    // required = 2 + 1 + 1 + 5 (collateral) + 2 (fee) = 11 ADA
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
