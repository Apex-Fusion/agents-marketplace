/**
 * supplier-routes-capability.test.ts — RED phase tests for GET /capability
 *
 * Uses supertest against createApp(deps) from supplier/src/server.ts.
 * Injects a mock ChainProvider and SupplierState.
 *
 * Covers:
 *   - 200: valid Active advert UTxO → returns decoded datum + advert_ref + supplier_pkh
 *   - 503: advert UTxO not found on chain
 *   - 503: advert datum.status === "Retired"
 *   - Cache-Control: no-store header
 *   - Response body shape
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { SupplierState } from "../../supplier/src/state.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig, SAMPLE_ADVERT_TX_HASH, SAMPLE_ADVERT_INDEX } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey, SUPPLIER_PKH, SUPPLIER_PUB_KEY_HEX } from "../fixtures/supplier-side/wallet-keys.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function buildActiveAdvertDatum(): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER_PKH,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
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

function buildRetiredAdvertDatum(): AdvertDatum {
  return { ...buildActiveAdvertDatum(), status: "Retired" };
}

function buildAdvertUtxo(datum: AdvertDatum) {
  return {
    ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
    address: "addr_test1wz0qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptqfakeadvert",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  };
}

// ─── Setup helpers ────────────────────────────────────────────────────────────

function makeApp(chain: MockChainProvider): Application {
  return createApp({
    chain,
    state: new SupplierState(),
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /capability — happy path", () => {
  let app: Application;

  beforeEach(() => {
    const chain = new MockChainProvider();
    chain.seed(buildAdvertUtxo(buildActiveAdvertDatum()));
    app = makeApp(chain);
  });

  it("returns 200", async () => {
    const res = await request(app).get("/capability");
    expect(res.status).toBe(200);
  });

  it("returns capability_id matching the advert", async () => {
    const res = await request(app).get("/capability");
    expect(res.body.capability_id).toBe("llm.text.generate.v1");
  });

  it("returns model from advert", async () => {
    const res = await request(app).get("/capability");
    expect(res.body.model).toBe("qwen2.5:0.5b");
  });

  it("returns max_output_tokens from advert", async () => {
    const res = await request(app).get("/capability");
    expect(res.body.max_output_tokens).toBe(512);
  });

  it("returns max_processing_ms from advert", async () => {
    const res = await request(app).get("/capability");
    expect(res.body.max_processing_ms).toBe(60_000);
  });

  it("returns advert_ref as <txHash>#<index>", async () => {
    const res = await request(app).get("/capability");
    expect(res.body.advert_ref).toBe(`${SAMPLE_ADVERT_TX_HASH}#${SAMPLE_ADVERT_INDEX}`);
  });

  it("returns supplier_pkh", async () => {
    const res = await request(app).get("/capability");
    expect(res.body.supplier_pkh).toBe(SUPPLIER_PKH);
  });

  it("sets Cache-Control: no-store header", async () => {
    const res = await request(app).get("/capability");
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  // SPEC FIX 2026-04-25: pub_key_hex required for buyer-side receipt verification
  it("returns pub_key_hex matching the supplier wallet public key", async () => {
    const res = await request(app).get("/capability");
    expect(res.body.pub_key_hex).toBe(SUPPLIER_PUB_KEY_HEX);
  });
});

describe("GET /capability — advert UTxO not found", () => {
  it("returns 503 when advert UTxO is absent from chain", async () => {
    // Chain has no UTxO seeded for the advert ref
    const chain = new MockChainProvider();
    const app = makeApp(chain);
    const res = await request(app).get("/capability");
    expect(res.status).toBe(503);
  });

  it("503 response body includes a reason", async () => {
    const chain = new MockChainProvider();
    const app = makeApp(chain);
    const res = await request(app).get("/capability");
    expect(res.body.reason ?? res.body.error ?? res.body.message).toBeTruthy();
  });
});

describe("GET /capability — advert is Retired", () => {
  it("returns 503 when advert status is Retired", async () => {
    const chain = new MockChainProvider();
    chain.seed(buildAdvertUtxo(buildRetiredAdvertDatum()));
    const app = makeApp(chain);
    const res = await request(app).get("/capability");
    expect(res.status).toBe(503);
  });

  it("503 body mentions retired or inactive", async () => {
    const chain = new MockChainProvider();
    chain.seed(buildAdvertUtxo(buildRetiredAdvertDatum()));
    const app = makeApp(chain);
    const res = await request(app).get("/capability");
    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).toMatch(/retired|inactive|not active/);
  });
});
