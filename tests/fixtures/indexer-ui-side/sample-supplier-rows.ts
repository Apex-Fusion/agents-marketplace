/**
 * tests/fixtures/indexer-ui-side/sample-supplier-rows.ts
 *
 * Independent test data for the indexer-ui suppliers table tests.
 * NO sharing with buyer-side or indexer-side fixtures.
 * Derived from the SupplierRow shape in indexer-ui/src/api/client.ts.
 *
 * INDEPENDENCE rule: use distinct PKH/endpoint values from all other fixture files.
 */

import type { SupplierRow } from "../../../indexer-ui/src/api/client.js";

// Distinct identities — not shared with indexer-side or buyer-side fixtures.
export const UI_SUPPLIER_PKH_A = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
export const UI_SUPPLIER_PKH_B = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function buildUiSupplierRow(overrides: Partial<SupplierRow> = {}): SupplierRow {
  return {
    utxo_ref: "f".repeat(64) + "#0",
    supplier_pkh: UI_SUPPLIER_PKH_A,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "https://ui-test-supplier-a.example.com",
    detail_uri: "ipfs://QmUI000",
    detail_hash: "f".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "free",
    advert_status: "Active",
    current_escrow_ref: null,
    last_seen_iso: "2026-04-24T12:00:00.000Z",
    created_slot: 2000,
    ...overrides,
  };
}

export const SAMPLE_FREE_SUPPLIER: SupplierRow = buildUiSupplierRow({
  utxo_ref: "f".repeat(64) + "#0",
  supplier_pkh: UI_SUPPLIER_PKH_A,
  status: "free",
  price_lovelace: "2000000",
});

export const SAMPLE_WORKING_SUPPLIER: SupplierRow = buildUiSupplierRow({
  utxo_ref: "e".repeat(64) + "#1",
  supplier_pkh: UI_SUPPLIER_PKH_B,
  status: "working",
  price_lovelace: "1000000",
  model: "llama3.2:1b",
});

export const SAMPLE_OFFLINE_SUPPLIER: SupplierRow = buildUiSupplierRow({
  utxo_ref: "d".repeat(64) + "#2",
  supplier_pkh: "1111111111111111111111111111111111111111111111111111111111",
  status: "offline",
  price_lovelace: "3000000",
  model: "mistral:7b",
});

export const ALL_SAMPLE_SUPPLIERS: SupplierRow[] = [
  SAMPLE_FREE_SUPPLIER,
  SAMPLE_WORKING_SUPPLIER,
  SAMPLE_OFFLINE_SUPPLIER,
];
