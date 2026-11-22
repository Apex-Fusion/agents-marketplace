/**
 * tests/unit/__helpers__/fakeIndexerDeps.ts — a stub cache and worker for the tests of `createApp`.
 *
 * The stub cache gives back the rows that a test hands it and filters nothing. The listing of adverts (status, capability,
 * supplier, value cap) is the work of SqliteCache, and its tests use a real database (indexer-sqlite-cache.test.ts,
 * indexer-identity-listing.test.ts). A route test that uses this stub checks what the route adds on top of the cache.
 */

import type { AdvertRow, EscrowLineage, EscrowRow, SupplierStatusRow } from "../../../indexer/src/db/cache.js";
import type { FollowerHealth } from "../../../indexer/src/follower/worker.js";
import type { IndexerDeps } from "../../../indexer/src/server.js";
import { makeAdvertRow } from "../../fixtures/indexer-side/rows.js";

export interface FakeIndexerData {
  /** The listed adverts. Default: one Active advert. */
  adverts?: AdvertRow[];
  /** Escrows that `getEscrowByRef` finds by ref and that the buyer and supplier lists return. Default: none. */
  escrows?: EscrowRow[];
  /**
   * Changes to the supplier_status row of a supplier, by supplier_pkh. null: the supplier has no row (it was never polled).
   * Without an entry, a supplier has a `free` row.
   */
  statuses?: Record<string, Partial<SupplierStatusRow> | null>;
  /** What `getEscrowLineage` returns. Default: null (the origin is not known). */
  lineage?: EscrowLineage | null;
  /** `getEscrowLineage` throws this error. */
  lineageError?: Error;
  /** Changes to the health of the follower. Default: following, 500 slots behind the tip. */
  health?: Partial<FollowerHealth>;
}

export function makeIndexerDeps(data: FakeIndexerData = {}): IndexerDeps {
  const adverts = data.adverts ?? [makeAdvertRow()];
  const escrows = data.escrows ?? [];
  const health: FollowerHealth = {
    state: "following",
    connected: true,
    syncSlot: 1_000_000,
    tip: { slot: 1_000_500, id: "f".repeat(64) },
    tipAgeMs: 1_000,
    error: null,
    ...data.health,
  };

  const cache = {
    listActiveAdvertisements: () => adverts,
    getEscrowByRef: (ref: string) => escrows.find((e) => e.utxo_ref === ref) ?? null,
    getEscrowLineage: () => {
      if (data.lineageError) throw data.lineageError;
      return data.lineage ?? null;
    },
    listEscrowsByBuyer: () => escrows,
    listEscrowsBySupplier: () => escrows,
    getSupplierStatus: (pkh: string): SupplierStatusRow | null => {
      const change = data.statuses?.[pkh];
      if (change === null) return null;
      return {
        supplier_pkh: pkh,
        advert_ref: `${"a".repeat(64)}#0`,
        status: "free",
        last_seen_iso: "2026-04-24T10:00:00.000Z",
        current_escrow_ref: null,
        polled_at: 1,
        ...change,
      };
    },
    dbSizeBytes: () => 4096,
  } as unknown as IndexerDeps["cache"];

  // The worker only reports its health. `on` and `off` take the listeners that createApp and the event stream attach.
  const worker = { getHealth: () => health, on: () => undefined, off: () => undefined } as unknown as IndexerDeps["worker"];

  return { cache, worker };
}
