/**
 * supplier-routes-capability.test.ts — GET /capability
 *
 * supertest against createApp(deps) from supplier/src/server.ts, over a MockChainProvider.
 *
 *   - 200: an Active advert UTxO → the decoded datum, advert_ref, supplier_pkh and pub_key_hex
 *   - 503 advert_unavailable: no advert UTxO on chain
 *   - 503 advert_not_active: the advert is Retired
 *   - Cache-Control: no-store
 */

import { describe, expect, it } from "vitest";
import request from "supertest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildActiveAdvertDatum, makeApp, seedAdvertUtxo } from "../fixtures/supplier-side/chat-harness.js";
import { SAMPLE_ADVERT_INDEX, SAMPLE_ADVERT_TX_HASH } from "../fixtures/supplier-side/sample-config.js";
import { CAPABILITY_ID, TEST_MAX_OUTPUT_TOKENS, TEST_MODEL } from "../fixtures/supplier-side/sample-escrow-state.js";
import { SUPPLIER_PKH, SUPPLIER_PUB_KEY_HEX } from "../fixtures/supplier-side/wallet-keys.js";

function seededChain(status: "Active" | "Retired" = "Active"): MockChainProvider {
  const chain = new MockChainProvider();
  seedAdvertUtxo(chain, { ...buildActiveAdvertDatum(), status });
  return chain;
}

describe("GET /capability", () => {
  it("serves the advert and the supplier key: 200, no-store", async () => {
    const { app } = makeApp(seededChain());

    const res = await request(app).get("/capability");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toMatchObject({
      capability_id: CAPABILITY_ID,
      model: TEST_MODEL,
      max_output_tokens: TEST_MAX_OUTPUT_TOKENS,
      max_processing_ms: 60_000,
      price_lovelace: "2000000",
      advert_ref: `${SAMPLE_ADVERT_TX_HASH}#${SAMPLE_ADVERT_INDEX}`,
      supplier_pkh: SUPPLIER_PKH,
      // SPEC FIX 2026-04-25: the buyer verifies receipts with this key.
      pub_key_hex: SUPPLIER_PUB_KEY_HEX,
      inference_api: "responses",
      upstream_api: "ollama",
      reasoning_disabled: false,
    });
  });

  it("advertises the operator reasoning policy", async () => {
    const { app } = makeApp(seededChain(), { config: { openaiReasoningDisabled: true } });

    const res = await request(app).get("/capability");

    expect(res.body.reasoning_disabled).toBe(true);
  });

  it.each([
    { name: "is not on chain", chain: () => new MockChainProvider(), reason: "advert_unavailable" },
    { name: "is Retired", chain: () => seededChain("Retired"), reason: "advert_not_active" },
  ])("503 $reason when the advert $name", async ({ chain, reason }) => {
    const { app } = makeApp(chain());

    const res = await request(app).get("/capability");

    expect(res.status).toBe(503);
    expect(res.body.reason).toBe(reason);
  });
});
