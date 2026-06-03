/**
 * buyer-pdf-supplier-pool.test.ts — capability filtering (must drop the weak
 * qwen model and non-parseable demo refs) + round-robin with failover.
 */

import { describe, it, expect } from "vitest";
import {
  isCapableModel,
  filterSuppliers,
  SupplierPool,
} from "../../buyer/src/pdf/supplier-pool.js";
import { loadPdfCaps } from "../../buyer/src/pdf/caps.js";
import type { SupplierView } from "../../buyer/src/sdk/types.js";

const caps = loadPdfCaps({});

function view(p: Partial<SupplierView>): SupplierView {
  return {
    utxo_ref: `${"a".repeat(64)}#0`,
    supplier_pkh: "pkh",
    capability_id: "llm.text.generate.v1",
    model: "kimi-k2",
    max_output_tokens: 512,
    max_processing_ms: 60000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "http://supplier",
    detail_uri: "",
    detail_hash: "",
    advertised_at: 0,
    status: "active",
    advert_status: "Active",
    current_escrow_ref: null,
    last_seen_iso: null,
    created_slot: 0,
    ...p,
  };
}

describe("isCapableModel", () => {
  it("excludes deny-listed models, allows allow-listed", () => {
    expect(isCapableModel("kimi-k2.6", ["kimi", "deepseek", "gpt"], ["qwen2.5:0.5b"])).toBe(true);
    expect(isCapableModel("deepseek-chat", ["kimi", "deepseek", "gpt"], ["qwen2.5:0.5b"])).toBe(true);
    expect(isCapableModel("qwen2.5:0.5b", ["kimi", "deepseek", "gpt"], ["qwen2.5:0.5b"])).toBe(false);
    expect(isCapableModel("llama3", ["kimi", "deepseek", "gpt"], [])).toBe(false);
  });

  it("deny wins over allow", () => {
    expect(isCapableModel("gpt-qwen2.5:0.5b", ["gpt"], ["qwen2.5:0.5b"])).toBe(false);
  });

  it("empty allowlist allows anything not denied", () => {
    expect(isCapableModel("anything", [], ["bad"])).toBe(true);
  });
});

describe("filterSuppliers", () => {
  it("keeps capable suppliers and drops qwen + demo + wrong-capability", () => {
    const views = [
      view({ model: "kimi-k2.6", utxo_ref: `${"a".repeat(64)}#0` }),
      view({ model: "deepseek-chat", utxo_ref: `${"b".repeat(64)}#1` }),
      view({ model: "qwen2.5:0.5b", utxo_ref: `${"c".repeat(64)}#0` }),
      view({ model: "kimi", utxo_ref: "demo:piper-tts" }), // unparseable ref
      view({ model: "gpt-4o", capability_id: "audio.synthesize.piper.v1", utxo_ref: `${"d".repeat(64)}#0` }),
    ];
    const out = filterSuppliers(views, caps);
    expect(out.map((s) => s.model).sort()).toEqual(["deepseek-chat", "kimi-k2.6"]);
    expect(out[0].priceLovelace).toBe(2_000_000n);
  });

  it("dedups by utxo_ref", () => {
    const ref = `${"a".repeat(64)}#0`;
    const out = filterSuppliers([view({ utxo_ref: ref }), view({ utxo_ref: ref })], caps);
    expect(out).toHaveLength(1);
  });
});

describe("SupplierPool.next", () => {
  function pool(): SupplierPool {
    return new SupplierPool(
      filterSuppliers(
        [
          view({ model: "kimi", utxo_ref: `${"a".repeat(64)}#0` }),
          view({ model: "deepseek", utxo_ref: `${"b".repeat(64)}#0` }),
          view({ model: "gpt-4o", utxo_ref: `${"c".repeat(64)}#0` }),
        ],
        caps,
      ),
    );
  }

  it("round-robins through all suppliers", () => {
    const p = pool();
    const seen = [p.next()?.model, p.next()?.model, p.next()?.model, p.next()?.model];
    expect(seen.slice(0, 3).sort()).toEqual(["deepseek", "gpt-4o", "kimi"]);
    expect(seen[3]).toBe(seen[0]); // wrapped around
  });

  it("skips excluded suppliers and returns null when all excluded", () => {
    const p = pool();
    const all = p.all().map((s) => s.utxoRef);
    const exclude = new Set(all);
    expect(p.next(exclude)).toBeNull();
    const excludeTwo = new Set(all.slice(0, 2));
    expect(p.next(excludeTwo)?.utxoRef).toBe(all[2]);
  });
});
