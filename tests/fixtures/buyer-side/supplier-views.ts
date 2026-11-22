/**
 * tests/fixtures/buyer-side/supplier-views.ts — a supplier as the indexer lists it (`GET /suppliers`).
 *
 * One free supplier of `llm.text.generate.v1` with valid defaults. A test passes only the fields
 * that it cares about.
 */

import type { SupplierView } from "../../../buyer/src/sdk/types.js";

export function makeSupplierView(overrides: Partial<SupplierView> = {}): SupplierView {
  return {
    utxo_ref: "a".repeat(64) + "#0",
    supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "https://supplier.example.com",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "free",
    advert_status: "Active",
    current_escrow_ref: null,
    last_seen_iso: "2026-04-24T00:00:00.000Z",
    created_slot: 1000,
    agent_id: null,
    ...overrides,
  };
}
