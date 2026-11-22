/**
 * tests/fixtures/indexer-ui-side/sample-escrow.ts
 *
 * Independent test data for the indexer-ui escrow lookup tests.
 * Derived from the EscrowView shape in indexer-ui/src/api/client.ts.
 */

import type { EscrowView } from "../../../indexer-ui/src/api/client.js";

export const UI_ESCROW_REF = "a".repeat(64) + "#0";

/** A legacy escrow in the Open state, as GET /escrows/<ref> sends it. A test passes only the fields that it cares about. */
export function buildUiEscrowView(overrides: Partial<EscrowView> = {}): EscrowView {
  return {
    utxo_ref: UI_ESCROW_REF,
    buyer_pkh: "c".repeat(56),
    supplier_pkh: "b".repeat(56),
    advert_ref: "b".repeat(64) + "#0",
    capability_id: "llm.text.generate.v1",
    request_spec_hash: "d".repeat(64),
    prompt_hash: "e".repeat(64),
    payment_lovelace: "2000000",
    buyer_bond_lovelace: "1000000",
    supplier_bond_lovelace: "1000000",
    deliver_by: 1_745_600_000,
    posted_at: 1_745_500_000,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    created_slot: 3000,
    layout: "legacy",
    agent_id: null,
    refund: null,
    routable: true,
    ...overrides,
  };
}
