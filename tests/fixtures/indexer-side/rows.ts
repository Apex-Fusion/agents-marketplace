/**
 * tests/fixtures/indexer-side/rows.ts — builders of the rows that the indexer cache stores.
 *
 * One advert row and one escrow row with valid defaults (legacy datum layout). A test passes only
 * the fields that it cares about. A row is valid input for `SqliteCache.upsertAdvertisement` and
 * `upsertEscrow`, and valid output of a stub cache.
 */

import type { AdvertRow, EscrowRow } from "../../../indexer/src/db/cache.js";
import {
  buildAdvertDatumHex,
  buildEscrowDatumHex,
  INDEXER_BUYER_PKH,
  INDEXER_SUPPLIER_ENDPOINT,
  INDEXER_SUPPLIER_PKH,
  SAMPLE_DELIVER_BY,
  SAMPLE_POSTED_AT,
  SAMPLE_PROMPT_HASH,
  SAMPLE_REQUEST_SPEC_HASH,
} from "./sample-blocks.js";

export function makeAdvertRow(overrides: Partial<AdvertRow> = {}): AdvertRow {
  return {
    utxo_ref: "a".repeat(64) + "#0",
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: INDEXER_SUPPLIER_ENDPOINT,
    detail_uri: "ipfs://QmTest",
    detail_hash: "b".repeat(64),
    advertised_at: SAMPLE_POSTED_AT,
    status: "Active",
    created_slot: 1_000_000,
    datum_hex: buildAdvertDatumHex(),
    rolled_back: 0,
    layout: "legacy",
    agent_id: null,
    creator_signed: 0,
    ...overrides,
  };
}

export function makeEscrowRow(overrides: Partial<EscrowRow> = {}): EscrowRow {
  return {
    utxo_ref: "c".repeat(64) + "#0",
    buyer_pkh: INDEXER_BUYER_PKH,
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    advert_ref_tx: "a".repeat(64),
    advert_ref_index: 0,
    capability_id: "llm.text.generate.v1",
    request_spec_hash: SAMPLE_REQUEST_SPEC_HASH,
    prompt_hash: SAMPLE_PROMPT_HASH,
    payment_lovelace: "2000000",
    buyer_bond_lovelace: "1000000",
    supplier_bond_lovelace: "1000000",
    deliver_by: SAMPLE_DELIVER_BY,
    posted_at: SAMPLE_POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    created_slot: 1_000_000,
    datum_hex: buildEscrowDatumHex({ state: "Open" }),
    rolled_back: 0,
    layout: "legacy",
    agent_id: null,
    refund_address: null,
    refund_datum: null,
    ...overrides,
  };
}
