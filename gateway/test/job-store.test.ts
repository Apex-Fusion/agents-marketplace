import { randomUUID } from "crypto";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayStore, type PendingWalletTransaction } from "../src/db/store.js";

const directories: string[] = [];

function databaseDirectory(label: string): string {
  const directory = join(tmpdir(), `gateway-${label}-${randomUUID()}`);
  directories.push(directory);
  return directory;
}

function closeStore(store: GatewayStore): void {
  store["db"].close();
}

function supplierCandidates(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    supplierPkh: `supplier-${index + 1}`,
    endpointUrl: `https://supplier-${index + 1}.example`,
    utxoRef: `advert-${index + 1}#0`,
    priceLovelace: BigInt(1_000_000 + index),
    maxProcessingMs: 30_000 + index,
  }));
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable one-shot job journal", () => {
  it("leases four different suppliers across two connections and enforces the active cap", () => {
    const directory = databaseDirectory("job-leases");
    const first = new GatewayStore(directory);
    const second = new GatewayStore(directory);
    const candidates = supplierCandidates(5);

    for (let index = 1; index <= 5; index += 1) {
      const store = index % 2 === 0 ? second : first;
      expect(store.insertOneShotJob({
        id: `job-${index}`,
        key_id: "key-1",
        owner_id: `worker-${index}`,
        model: "test-model",
        created_at: index,
      }, 10)).toBe(true);
    }

    const leased = [
      first.reserveOneShotSupplier("job-1", "worker-1", candidates),
      second.reserveOneShotSupplier("job-2", "worker-2", candidates),
      first.reserveOneShotSupplier("job-3", "worker-3", candidates),
      second.reserveOneShotSupplier("job-4", "worker-4", candidates),
    ];
    expect(leased.map((job) => job?.supplier_pkh)).toEqual([
      "supplier-1",
      "supplier-2",
      "supplier-3",
      "supplier-4",
    ]);
    expect(new Set(leased.map((job) => job?.supplier_pkh)).size).toBe(4);

    expect(first.reserveOneShotSupplier("job-5", "worker-5", candidates)).toBeUndefined();
    expect(second.getOneShotJob("job-5")?.state).toBe("queued");

    expect(second.completeOneShotJob("job-1", "worker-1", "completed")).toBe(true);
    expect(first.reserveOneShotSupplier("job-5", "worker-5", candidates)?.supplier_pkh)
      .toBe("supplier-1");

    closeStore(first);
    closeStore(second);
  });

  it("applies the outstanding queue bound atomically and counts recovering jobs", () => {
    const directory = databaseDirectory("job-admission");
    const first = new GatewayStore(directory);
    const second = new GatewayStore(directory);

    expect(first.insertOneShotJob({
      id: "job-1", key_id: "key-1", owner_id: "worker-1", model: "m", created_at: 1,
    }, 2)).toBe(true);
    expect(second.insertOneShotJob({
      id: "job-2", key_id: "key-1", owner_id: "worker-2", model: "m", created_at: 2,
    }, 2)).toBe(true);
    expect(first.updateOneShotJob("job-1", "worker-1", { state: "recovering" })).toBe(true);
    expect(second.insertOneShotJob({
      id: "job-3", key_id: "key-1", owner_id: "worker-3", model: "m", created_at: 3,
    }, 2)).toBe(false);

    expect(second.completeOneShotJob("job-1", "worker-1", "reclaimed")).toBe(true);
    expect(first.insertOneShotJob({
      id: "job-3", key_id: "key-1", owner_id: "worker-3", model: "m", created_at: 3,
    }, 2)).toBe(true);

    closeStore(first);
    closeStore(second);
  });

  it("persists funded reservations and fences stale recovery owners across restart", () => {
    const directory = databaseDirectory("job-restart");
    const original = new GatewayStore(directory);
    expect(original.insertOneShotJob({
      id: "funded-job",
      key_id: "key-1",
      owner_id: "worker-old",
      model: "m",
      created_at: 100,
    })).toBe(true);
    expect(original.reserveOneShotSupplier(
      "funded-job",
      "worker-old",
      supplierCandidates(1),
    )?.state).toBe("reserved");
    expect(original.updateOneShotJob("funded-job", "worker-old", {
      state: "funding",
      escrow_ref: "escrow#0",
      deliver_by: 900,
      heartbeat_at: 200,
    })).toBe(true);
    closeStore(original);

    const recovered = new GatewayStore(directory);
    expect(recovered.getOneShotJob("funded-job")).toMatchObject({
      state: "funding",
      supplier_pkh: "supplier-1",
      advert_ref: "advert-1#0",
      price_lovelace: "1000000",
      escrow_ref: "escrow#0",
      deliver_by: 900,
    });
    expect(recovered.claimOneShotJob("funded-job", "worker-new", 199)).toBe(false);
    expect(recovered.claimOneShotJob("funded-job", "worker-new", 200)).toBe(true);
    expect(recovered.updateOneShotJob("funded-job", "worker-old", { state: "running" }))
      .toBe(false);
    expect(recovered.updateOneShotJob("funded-job", "worker-new", { state: "recovering" }))
      .toBe(true);

    expect(recovered.insertOneShotJob({
      id: "next-job", key_id: "key-1", owner_id: "worker-next", model: "m", created_at: 300,
    })).toBe(true);
    expect(recovered.reserveOneShotSupplier(
      "next-job",
      "worker-next",
      supplierCandidates(1),
    )).toBeUndefined();
    closeStore(recovered);
  });
});

describe("pending signed wallet transactions", () => {
  it("persists an ambiguous transaction and refuses to replace it", () => {
    const directory = databaseDirectory("pending-transaction");
    const original = new GatewayStore(directory);
    const pending: PendingWalletTransaction = {
      key_id: "key-1",
      tx_hash: "tx-a",
      tx_cbor: "a100",
      created_at: 100,
      valid_until_slot: 500,
    };
    expect(original.putPendingWalletTransaction(pending)).toBe(true);
    closeStore(original);

    const recovered = new GatewayStore(directory);
    expect(recovered.getPendingWalletTransaction("key-1")).toEqual(pending);
    expect(recovered.putPendingWalletTransaction({ ...pending, created_at: 200 })).toBe(true);
    expect(recovered.getPendingWalletTransaction("key-1")).toEqual(pending);
    expect(recovered.putPendingWalletTransaction({
      ...pending,
      tx_hash: "tx-b",
      tx_cbor: "b100",
    })).toBe(false);
    expect(recovered.resolvePendingWalletTransaction("key-1", "tx-b", "rejected")).toBe(false);
    expect(recovered.clearPendingWalletTransaction("key-1", "tx-b")).toBe(false);
    expect(recovered.getPendingWalletTransaction("key-1")).toEqual(pending);
    expect(recovered.resolvePendingWalletTransaction("key-1", "tx-a", "confirmed")).toBe(true);
    expect(recovered.getPendingWalletTransaction("key-1")).toBeUndefined();
    expect(recovered.getWalletTransactionOutcome("key-1", "tx-a")).toMatchObject({
      state: "confirmed",
    });
    expect(recovered.resolvePendingWalletTransaction("key-1", "tx-a", "confirmed")).toBe(true);
    expect(recovered.resolvePendingWalletTransaction("key-1", "tx-a", "rejected")).toBe(false);
    closeStore(recovered);

    const restarted = new GatewayStore(directory);
    expect(restarted.getWalletTransactionOutcome("key-1", "tx-a")).toMatchObject({
      key_id: "key-1",
      tx_hash: "tx-a",
      state: "confirmed",
    });
    expect(restarted.getPendingWalletTransaction("key-1")).toBeUndefined();
    closeStore(restarted);
  });
});

describe("usage reconciliation", () => {
  it("updates one deterministic usage row instead of double counting it", () => {
    const store = new GatewayStore(databaseDirectory("usage-upsert"));
    const base = {
      id: "job-1",
      key_id: "key-1",
      created_at: 100,
      kind: "response",
      model: "m",
      capability_id: null,
      supplier_pkh: "supplier-1",
      escrow_ref: "escrow#0",
      cost_lovelace: "1000000",
      prompt_tokens: 10,
      completion_tokens: 0,
      status: "failed",
      failure_reason: "ambiguous",
    };
    store.upsertUsage(base);
    store.upsertUsage({
      ...base,
      completion_tokens: 20,
      status: "completed",
      failure_reason: null,
    });

    expect(store.countUsage("key-1")).toBe(1);
    expect(store.listUsage("key-1", 10)[0]).toMatchObject({
      id: "job-1",
      status: "completed",
      completion_tokens: 20,
      failure_reason: null,
    });
    closeStore(store);
  });
});
