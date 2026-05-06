/**
 * tests/fixtures/indexer-side/sample-suppliers.ts — supplier /status response fixtures.
 *
 * Used by status-poller tests to mock fetch responses.
 * Independently constructed from ARCHITECTURE.md §5.1 — no shared helpers.
 */

export interface SupplierStatusResponseBody {
  status: "free" | "working" | "offline";
  current_escrow_ref?: string;
  last_seen?: string;
}

/** A supplier that is free and available */
export const STATUS_FREE: SupplierStatusResponseBody = {
  status: "free",
  last_seen: "2026-04-24T10:00:00.000Z",
};

/** A supplier currently working on a job */
export const STATUS_WORKING: SupplierStatusResponseBody = {
  status: "working",
  current_escrow_ref: "a".repeat(64) + "#0",
  last_seen: "2026-04-24T10:00:00.000Z",
};

/** A supplier that is offline */
export const STATUS_OFFLINE: SupplierStatusResponseBody = {
  status: "offline",
  last_seen: "2026-04-24T09:50:00.000Z",
};

/** Malformed body — not valid SupplierStatusResponseBody */
export const STATUS_MALFORMED = "not-json-at-all";

/** Empty object — missing required status field */
export const STATUS_EMPTY = {};

/** Valid JSON but wrong shape */
export const STATUS_WRONG_SHAPE = { foo: "bar", baz: 42 };
