import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { GatewayStore, type ApiKeyRow } from "../src/db/store.js";
import { CREATE_TABLES_SQL } from "../src/db/schema.js";
import type { Paper2AgentTransactionRow } from "../src/db/paper2agent.js";
import { approvePaper2Agent, revokePaper2Agent, isPaper2AgentOnlyKey, getPaper2AgentCall, listPaper2AgentCalls } from "../src/paper2agent/service.js";
import { startWalletHealthTicker } from "../src/walletHealth.js";
import type { GatewayDeps } from "../src/deps.js";
import { mkdirSync } from "node:fs";

const directories: string[] = [];
const stores: GatewayStore[] = [];
const manifestHash = "ab".repeat(32);
const supplierPkh = "cd".repeat(28);
const key: ApiKeyRow = { id: "buyer", key_hash: "hash", key_prefix: "vk_test", label: null,
  wallet_pkh: "ef".repeat(28), deposit_address: "unused", enc_priv_nonce: "unused", enc_priv_ct: "unused",
  enc_priv_tag: "unused", master_key_version: 1, created_at: 1, disabled: 0, demo: 0 };

function fixture(total = 20_000_000n, calls = 2) {
  const directory = join(tmpdir(), `paper2agent-money-${randomUUID()}`);
  directories.push(directory);
  const store = new GatewayStore(directory);
  stores.push(store);
  store.insertKey(key);
  approvePaper2Agent(store, { keyId: key.id, manifestHash, supplierPkh, maxPriceLovelace: 2_000_000n, maxTotalSpendLovelace: total, maxCalls: calls });
  return { store, directory };
}

function reserve(store: GatewayStore, id = "job") {
  store.insertOneShotJob({ id, key_id: key.id, owner_id: "owner", model: `paper2agent:${manifestHash}`, created_at: 1 }, 64,
    () => store.paper2agent.reserve(id, key.id, manifestHash));
}

function transaction(phase: Paper2AgentTransactionRow["phase"], debit: bigint): Omit<Paper2AgentTransactionRow, "confirmed"> {
  return { job_id: "job", phase, tx_hash: (phase === "post" ? "11" : phase === "accept" ? "22" : "33").repeat(32),
    tx_cbor: `signed-${phase}`, fee_lovelace: "200000", wallet_debit_lovelace: debit.toString(),
    collateral_lovelace: phase === "post" ? "0" : "5000000", supplier_payout_lovelace: phase === "accept" ? "4000000" : "0", facts_json: "{}" };
}

function savePost(store: GatewayStore, debit = 6_200_000n) {
  const row = transaction("post", debit);
  store.paper2agent.saveTransaction(row, "owner", { escrow_ref: `${row.tx_hash}#0`, original_datum_hex: "d87980", locked_lovelace: "6000000" });
  return row;
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) if (store["db"].open) store["db"].close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Paper2Agent durable approval and accounting", () => {
  it("adds tables to a legacy database and keeps immutable approval after restart and revoke", () => {
    const directory = join(tmpdir(), `paper2agent-migrate-${randomUUID()}`);
    directories.push(directory);
    mkdirSync(directory);
    const legacy = new Database(join(directory, "gateway.db"));
    legacy.exec(CREATE_TABLES_SQL);
    // A call journal written before the Post snapshot column existed.
    legacy.exec(`CREATE TABLE paper2agent_calls (job_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
      reserved_lovelace TEXT NOT NULL, prepared_json TEXT, original_datum_hex TEXT, result_json TEXT,
      result_status TEXT NOT NULL DEFAULT 'pending', financial_status TEXT NOT NULL DEFAULT 'reserved',
      actual_cost_lovelace TEXT, locked_lovelace TEXT, error TEXT, accounted INTEGER NOT NULL DEFAULT 0);
      INSERT INTO paper2agent_calls (job_id, key_id, manifest_hash, reserved_lovelace) VALUES ('old-call', 'gone', 'x', '0');`);
    legacy.close();
    const first = new GatewayStore(directory);
    stores.push(first);
    expect(first.paper2agent.call("old-call")).toMatchObject({ posted_json: null });
    first.insertKey(key);
    const input = { keyId: key.id, manifestHash, supplierPkh, maxPriceLovelace: 2n, maxTotalSpendLovelace: 30_000_000n, maxCalls: 1 };
    approvePaper2Agent(first, input);
    revokePaper2Agent(first, key.id);
    revokePaper2Agent(first, key.id);
    expect(() => revokePaper2Agent(first, "missing")).toThrow("paper2agent_approval_missing");
    first["db"].close();
    const restarted = new GatewayStore(directory);
    stores.push(restarted);
    expect(isPaper2AgentOnlyKey(restarted, key.id)).toBe(true);
    expect(() => approvePaper2Agent(restarted, { ...input, maxCalls: 99 })).toThrow("paper2agent_approval_exists");
    expect(() => reserve(restarted)).toThrow("paper2agent_not_approved");
    expect(restarted.getOneShotJob("job")).toBeUndefined();
  });

  it("admits only one liability across connections and restart without consuming a rejected admission", () => {
    const { store, directory } = fixture();
    const other = new GatewayStore(directory);
    stores.push(other);
    reserve(store);
    expect(() => reserve(other, "racing")).toThrow("paper2agent_budget_reserved");
    expect(other.getOneShotJob("racing")).toBeUndefined();
    savePost(store);
    store["db"].close();
    const restarted = new GatewayStore(directory);
    stores.push(restarted);
    expect(() => reserve(restarted, "retry")).toThrow("paper2agent_budget_reserved");
    expect(restarted.paper2agent.approval(key.id)).toMatchObject({ calls: 1, reserved_lovelace: "20000000", spent_lovelace: "0" });
    expect(restarted.paper2agent.transactions("job")[0].tx_cbor).toBe("signed-post");
    expect(() => restarted.paper2agent.finalize("job", "unfunded", 0n)).toThrow("paper2agent_signed_liability");
  });

  it("checks bonds, fees and collateral exposure before authorizing signed Post", () => {
    const { store } = fixture(10_000_000n);
    reserve(store);
    expect(() => savePost(store)).toThrow("paper2agent_exposure_limit");
    expect(store.paper2agent.transactions("job")).toEqual([]);
    expect(store.getOneShotJob("job")!.escrow_ref).toBeNull();
    store.paper2agent.finalize("job", "unfunded", 0n);
    expect(store.paper2agent.approval(key.id)).toMatchObject({ calls: 0, reserved_lovelace: "0" });
  });

  it("records failed-but-paid results and both bonds/fees without double accounting", () => {
    const { store } = fixture();
    reserve(store);
    const post = savePost(store);
    const accept = transaction("accept", -1_800_000n);
    store.paper2agent.saveTransaction(accept, "owner", {});
    store.paper2agent.update("job", { result_status: "failed", error: "delivery_failed" });
    expect(() => store.paper2agent.finalize("job", "accepted", 4_400_000n)).toThrow("paper2agent_settlement_not_confirmed");
    store.paper2agent.confirm("job", post.tx_hash);
    store.paper2agent.confirm("job", accept.tx_hash);
    expect(() => store.paper2agent.finalize("job", "accepted", 2_000_000n)).toThrow("paper2agent_actual_cost_mismatch");
    store.paper2agent.finalize("job", "accepted", 4_400_000n);
    store.paper2agent.finalize("job", "accepted", 4_400_000n);
    expect(store.paper2agent.call("job")).toMatchObject({ result_status: "failed", financial_status: "accepted", actual_cost_lovelace: "4400000" });
    expect(store.paper2agent.approval(key.id)).toMatchObject({ calls: 1, spent_lovelace: "4400000", reserved_lovelace: "0" });
    expect(store.listUsage(key.id, 10)).toMatchObject([{ id: "job", status: "failed", cost_lovelace: "4400000" }]);
    reserve(store, "second");
    expect(store.paper2agent.call("second")!.reserved_lovelace).toBe("15600000");
  });

  it("retains unknown liabilities and charges confirmed Reclaim fees rather than zero", () => {
    const { store } = fixture(20_000_000n, 1);
    reserve(store);
    const post = savePost(store);
    store.paper2agent.finalize("job", "unknown", null);
    expect(store.paper2agent.call("job")).toMatchObject({ financial_status: "unknown", actual_cost_lovelace: null, accounted: 0 });
    expect(() => reserve(store, "second")).toThrow("paper2agent_call_limit");
    const reclaim = transaction("reclaim", -5_800_000n);
    store.paper2agent.saveTransaction(reclaim, "owner", {});
    store.paper2agent.confirm("job", post.tx_hash);
    store.paper2agent.confirm("job", reclaim.tx_hash);
    store.paper2agent.finalize("job", "reclaimed", 400_000n);
    expect(store.paper2agent.call("job")).toMatchObject({ financial_status: "reclaimed", actual_cost_lovelace: "400000" });
    expect(() => reserve(store, "after-refund")).toThrow("paper2agent_call_limit");
  });

  it("blocks queued maintenance and legacy writes but allows exact authorized recovery bytes", () => {
    const { store } = fixture();
    const unauthorized = { key_id: key.id, tx_hash: "99".repeat(32), tx_cbor: "legacy-withdraw", created_at: 1, valid_until_slot: null };
    expect(store.putPendingWalletTransaction(unauthorized)).toBe(false);
    reserve(store);
    const post = savePost(store);
    const authorized = { ...unauthorized, tx_hash: post.tx_hash, tx_cbor: post.tx_cbor };
    expect(store.putPendingWalletTransaction({ ...authorized, tx_cbor: "different-bytes" })).toBe(false);
    expect(store.putPendingWalletTransaction(authorized)).toBe(true);
    revokePaper2Agent(store, key.id);
    expect(store.putPendingWalletTransaction(authorized)).toBe(true);
    expect(store.resolvePendingWalletTransaction(key.id, post.tx_hash, "confirmed")).toBe(true);
    expect(store.paper2agent.transactions("job")[0].tx_cbor).toBe(post.tx_cbor);
  });

  it("rejects approval while a legacy signed transaction is pending or after it resolves", () => {
    const { store } = fixture();
    store.insertKey({ ...key, id: "legacy", key_hash: "legacy-hash" });
    const input = { keyId: "legacy", manifestHash, supplierPkh, maxPriceLovelace: 1n, maxTotalSpendLovelace: 20_000_000n, maxCalls: 1 };
    expect(store.putPendingWalletTransaction({ key_id: "legacy", tx_hash: "99".repeat(32), tx_cbor: "legacy", created_at: 1, valid_until_slot: null })).toBe(true);
    expect(() => approvePaper2Agent(store, input)).toThrow("paper2agent_requires_unused_key");
    // A confirmed outcome can be durable before the legacy route writes usage.
    expect(store.resolvePendingWalletTransaction("legacy", "99".repeat(32), "confirmed")).toBe(true);
    expect(store.getPendingWalletTransaction("legacy")).toBeUndefined();
    expect(() => approvePaper2Agent(store, input)).toThrow("paper2agent_requires_unused_key");
  });

  it("skips automatic maintenance even after approval revocation", async () => {
    vi.useFakeTimers();
    const { store } = fixture();
    revokePaper2Agent(store, key.id);
    const getContext = vi.fn(() => { throw new Error("maintenance must not open the dedicated wallet"); });
    const stop = startWalletHealthTicker({ store, registry: { getContext }, config: { walletHealthIntervalMs: 100 } } as unknown as GatewayDeps);
    await vi.advanceTimersByTimeAsync(100);
    stop();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("keeps own-job reads separate from foreign jobs and distinguishes unknown cost", async () => {
    const { store } = fixture();
    reserve(store);
    store.paper2agent.finalize("job", "unknown", null);
    const deps = { store } as GatewayDeps;
    expect(await getPaper2AgentCall(deps, "other", "job")).toBeUndefined();
    expect(await getPaper2AgentCall(deps, key.id, "job")).toMatchObject({ job_id: "job", financial: { status: "unknown", actual_cost_lovelace: null } });
  });

  it("pages own jobs newest first and treats a foreign cursor like an unknown one", async () => {
    const { store } = fixture();
    const created = new Map<string, number>();
    for (let i = 0; i < 21; i++) {
      const id = `job-${String(i).padStart(2, "0")}`;
      // Pairs share created_at, so the page boundary falls inside a tie.
      created.set(id, 100 - Math.floor((i + 1) / 2));
      store.insertOneShotJob({ id, key_id: key.id, owner_id: "owner", model: `paper2agent:${manifestHash}`, created_at: created.get(id)! }, 64,
        () => store.paper2agent.reserve(id, key.id, manifestHash));
      store.paper2agent.finalize(id, "unfunded", 0n);
    }
    store.insertKey({ ...key, id: "other", key_hash: "other-hash" });
    approvePaper2Agent(store, { keyId: "other", manifestHash, supplierPkh, maxPriceLovelace: 1n, maxTotalSpendLovelace: 20_000_000n, maxCalls: 1 });
    store.insertOneShotJob({ id: "foreign", key_id: "other", owner_id: "owner", model: `paper2agent:${manifestHash}`, created_at: 200 }, 64,
      () => store.paper2agent.reserve("foreign", "other", manifestHash));
    const deps = { store } as GatewayDeps;
    const newest = [...created.keys()].sort((a, b) => created.get(b)! - created.get(a)! || b.localeCompare(a));
    const first = await listPaper2AgentCalls(deps, key.id);
    expect(first.jobs.map((job) => job.job_id)).toEqual(newest.slice(0, 20));
    expect(first.jobs[0]).toEqual(await getPaper2AgentCall(deps, key.id, newest[0]!));
    expect(first.next_cursor).toBe(newest[19]);
    const second = await listPaper2AgentCalls(deps, key.id, first.next_cursor!);
    expect(second.jobs.map((job) => job.job_id)).toEqual([newest[20]]);
    expect(second.next_cursor).toBeNull();
    for (const cursor of ["foreign", "missing"]) {
      await expect(listPaper2AgentCalls(deps, key.id, cursor)).rejects.toMatchObject({ code: "paper2agent_invalid_cursor" });
    }
    expect((await listPaper2AgentCalls(deps, "other")).jobs.map((job) => job.job_id)).toEqual(["foreign"]);
  });
});
