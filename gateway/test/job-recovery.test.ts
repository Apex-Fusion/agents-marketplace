import { randomUUID } from "crypto";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MockChainProvider,
  type OutputReference,
  type Utxo,
} from "@marketplace/shared/chain";
import { encodeEscrowDatum, type EscrowDatum } from "@marketplace/shared/cbor";
import type { WalletKey } from "@marketplace/shared/tx";
import { loadConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";
import { GatewayStore, type ApiKeyRow } from "../src/db/store.js";
import {
  recoverOneShotJobs,
  runOneShotJob,
  updateOneShotJob,
} from "../src/oneShotJobs.js";
import type { EscrowLineage } from "../src/onchain/settle.js";
import { Mutex, type KeyContext, type SdkRegistry } from "../src/sdk/registry.js";
import { deriveWalletKey, genPrivKeyHex } from "../src/wallet.js";

const MASTER_KEY = "c7".repeat(32);
const MODEL = "recovery-model";
const CAPABILITY = "llm.text.generate.v1";
const PRICE = 700_000n;
const directories: string[] = [];
const stores = new Set<GatewayStore>();

class ObservedMockChain extends MockChainProvider {
  readonly submissions: string[] = [];

  override async submitTx(txCborHex: string): Promise<string> {
    this.submissions.push(txCborHex);
    return super.submitTx(txCborHex);
  }
}

function databaseDirectory(label: string): string {
  const directory = join(tmpdir(), `gateway-recovery-${label}-${randomUUID()}`);
  directories.push(directory);
  return directory;
}

function openStore(directory: string): GatewayStore {
  const store = new GatewayStore(directory);
  stores.add(store);
  return store;
}

function closeStore(store: GatewayStore): void {
  if (!stores.delete(store)) return;
  const database: unknown = Reflect.get(store, "db");
  if (!database || typeof database !== "object" || !("close" in database) ||
      typeof database.close !== "function") {
    throw new Error("GatewayStore fixture has no close method");
  }
  database.close();
}

function keyFixture(id = `key-${randomUUID()}`): { key: ApiKeyRow; walletKey: WalletKey } {
  const walletKey = deriveWalletKey(genPrivKeyHex(), 0);
  return {
    walletKey,
    key: {
      id,
      key_hash: `hash-${id}`,
      key_prefix: "vk_recovery",
      label: null,
      wallet_pkh: walletKey.pubKeyHash,
      deposit_address: walletKey.address,
      enc_priv_nonce: "unused",
      enc_priv_ct: "unused",
      enc_priv_tag: "unused",
      master_key_version: 1,
      created_at: Date.now(),
      disabled: 0,
      demo: 0,
    },
  };
}

function registryFor(key: ApiKeyRow, walletKey: WalletKey, chain: ObservedMockChain): SdkRegistry {
  const context: KeyContext = {
    sdk: {} as KeyContext["sdk"],
    mutex: new Mutex(),
    walletKey,
    chain: chain as unknown as KeyContext["chain"],
    reconcilePendingWalletTransaction: async () => undefined,
  };
  return {
    getContext(row: ApiKeyRow): KeyContext {
      if (row.id !== key.id) throw new Error(`unexpected key ${row.id}`);
      return context;
    },
  } as unknown as SdkRegistry;
}

function unusedRegistry(): SdkRegistry {
  return {
    getContext(): never {
      throw new Error("recovery must not open a wallet context");
    },
  } as unknown as SdkRegistry;
}

function makeDeps(
  directory: string,
  store: GatewayStore,
  chain: ObservedMockChain,
  fetchFn: typeof globalThis.fetch,
  registry = unusedRegistry(),
): GatewayDeps {
  return {
    config: loadConfig({
      GATEWAY_MASTER_KEY: MASTER_KEY,
      INDEXER_URL: "http://indexer.test",
      OGMIOS_URL: "http://ogmios.test",
      LIVE_CHAIN: "1",
      NETWORK_ID: "0",
      GATEWAY_DB_DIR: directory,
    }),
    store,
    chain: chain as unknown as GatewayDeps["chain"],
    registry,
    fetchFn,
  };
}

function noIndexerCalls(): typeof globalThis.fetch {
  return (async () => {
    throw new Error("recovery must not call the indexer");
  }) as typeof globalThis.fetch;
}

function lineageIndexer(entries: Readonly<Record<string, EscrowLineage | null>>): {
  fetchFn: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const match = /\/escrows\/([^/]+)\/lineage$/.exec(new URL(url).pathname);
    if (!match) return new Response("not found", { status: 404 });
    const originalRef = decodeURIComponent(match[1]);
    const value = entries[originalRef];
    if (value === undefined || value === null) {
      return new Response("not found", { status: 404 });
    }
    return Response.json(value);
  }) as typeof globalThis.fetch;
  return { fetchFn, calls };
}

function supplierCandidate(supplierPkh: string, marker = "a") {
  return {
    supplierPkh,
    endpointUrl: `https://supplier-${marker}.test`,
    utxoRef: `${marker.repeat(64)}#0`,
    priceLovelace: PRICE,
    maxProcessingMs: 30_000,
  };
}

function insertFundedJob(store: GatewayStore, args: {
  id: string;
  keyId: string;
  ownerId?: string;
  supplierPkh: string;
  escrowRef: string;
  createdAt?: number;
  state?: "funding" | "running" | "submitted" | "recovering";
  receiptHash?: string;
  deliverBy?: number;
  advertMarker?: string;
  postValidUntilSlot?: number;
}): void {
  const ownerId = args.ownerId ?? `old-owner-${args.id}`;
  const stale = Date.now() - 120_000;
  expect(store.insertOneShotJob({
    id: args.id,
    key_id: args.keyId,
    owner_id: ownerId,
    model: MODEL,
    created_at: args.createdAt ?? stale,
  })).toBe(true);
  expect(store.reserveOneShotSupplier(
    args.id,
    ownerId,
    [supplierCandidate(args.supplierPkh, args.advertMarker ?? "a")],
  )).toBeDefined();
  expect(store.updateOneShotJob(args.id, ownerId, {
    state: args.state ?? "funding",
    escrow_ref: args.escrowRef,
    receipt_hash: args.receiptHash ?? null,
    deliver_by: args.deliverBy ?? null,
    post_valid_until_slot: args.postValidUntilSlot ?? null,
    heartbeat_at: stale,
  })).toBe(true);
}

function escrowDatum(args: {
  buyerPkh: string;
  supplierPkh: string;
  state: "Open" | "Claimed" | "Submitted";
  deliverBy: number;
  receiptHash?: string;
  submittedAt?: number;
  marker?: string;
}): EscrowDatum {
  const marker = args.marker ?? "d";
  return {
    buyer_pkh: args.buyerPkh,
    supplier_pkh: args.supplierPkh,
    advert_ref: { txHash: marker.repeat(64), index: 0 },
    capability_id: CAPABILITY,
    request_spec_hash: "1".repeat(64),
    prompt_hash: "2".repeat(64),
    payment_lovelace: PRICE,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: args.deliverBy,
    posted_at: args.deliverBy - 30_000,
    submitted_at: args.state === "Submitted" ? (args.submittedAt ?? Date.now()) : null,
    result_receipt_hash: args.state === "Submitted" ? (args.receiptHash ?? "3".repeat(64)) : null,
    state: args.state,
  };
}

function seedEscrow(chain: ObservedMockChain, ref: OutputReference, datum: EscrowDatum): void {
  const utxo: Utxo = {
    ref,
    address: "addr_test1_escrow_recovery",
    lovelace: datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace,
    assets: {},
    datumHex: encodeEscrowDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
}

function liveLineage(ref: string, state: string, postedAt: number): EscrowLineage {
  return {
    original_ref: ref,
    rows: [{ utxo_ref: ref, state, posted_at: postedAt, spent_tx: null }],
    terminal: null,
  };
}

function syntheticTransactionType(txCborHex: string): string {
  const byteLength = Number.parseInt(txCborHex.slice(0, 8), 16);
  const bodyHex = txCborHex.slice(8, 8 + byteLength * 2);
  const body = JSON.parse(Buffer.from(bodyHex, "hex").toString("utf8")) as { type?: unknown };
  if (typeof body.type !== "string") throw new Error("synthetic transaction has no type");
  return body.type;
}

afterEach(() => {
  for (const store of [...stores]) closeStore(store);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("one-shot financial recovery", () => {
  it("keeps an interrupted store:false journal without storing prompt or result payloads", async () => {
    const directory = databaseDirectory("store-false");
    const store = openStore(directory);
    const chain = new ObservedMockChain();
    const { key } = keyFixture("key-store-false");
    const escrowRef = `${"4".repeat(64)}#0`;
    const deps = makeDeps(directory, store, chain, noIndexerCalls());
    const privateContent = "private prompt or generated output in an upstream error";

    await expect(runOneShotJob(deps, key, { id: "job-store-false", model: MODEL }, async () => {
      updateOneShotJob(deps, "job-store-false", {
        state: "funding",
        supplier_pkh: "5".repeat(56),
        price_lovelace: PRICE.toString(),
        escrow_ref: escrowRef,
      });
      throw new Error(privateContent);
    })).rejects.toThrow();

    expect(store.getOneShotJob("job-store-false")).toMatchObject({
      state: "recovering",
      escrow_ref: escrowRef,
      price_lovelace: PRICE.toString(),
    });
    expect(store.listStoredResponses()).toEqual([]);
    expect(store.listUsage(key.id, 10)).toEqual([]);
    closeStore(store);

    const restarted = openStore(directory);
    expect(restarted.getOneShotJob("job-store-false")).toMatchObject({
      id: "job-store-false",
      key_id: key.id,
      state: "recovering",
      escrow_ref: escrowRef,
    });
    expect(restarted.listStoredResponses()).toEqual([]);
    expect(JSON.stringify(restarted.getOneShotJob("job-store-false"))).not.toContain(privateContent);
  });

  it("fails an owner-lost job before funding without opening a wallet or spending", async () => {
    const directory = databaseDirectory("unfunded");
    const original = openStore(directory);
    const stale = Date.now() - 120_000;
    expect(original.insertOneShotJob({
      id: "job-unfunded",
      key_id: "key-unfunded",
      owner_id: "dead-owner",
      model: MODEL,
      created_at: stale,
    })).toBe(true);
    closeStore(original);

    const restarted = openStore(directory);
    const chain = new ObservedMockChain();
    await recoverOneShotJobs(makeDeps(directory, restarted, chain, noIndexerCalls()));

    expect(restarted.getOneShotJob("job-unfunded")).toMatchObject({
      state: "failed",
      error: "request interrupted before payment",
      escrow_ref: null,
    });
    expect(restarted.listUsage("key-unfunded", 10)).toEqual([
      expect.objectContaining({
        id: "job-unfunded",
        status: "failed",
        cost_lovelace: null,
      }),
    ]);
    expect(chain.submissions).toEqual([]);
  });

  it("does not steal a job whose owner heartbeat is still live", async () => {
    const directory = databaseDirectory("live-owner");
    const ownerStore = openStore(directory);
    expect(ownerStore.insertOneShotJob({
      id: "job-live",
      key_id: "key-live",
      owner_id: "live-owner",
      model: MODEL,
      created_at: Date.now(),
    })).toBe(true);

    const recoveryStore = openStore(directory);
    const chain = new ObservedMockChain();
    await recoverOneShotJobs(makeDeps(directory, recoveryStore, chain, noIndexerCalls()));

    expect(recoveryStore.getOneShotJob("job-live")).toMatchObject({
      owner_id: "live-owner",
      state: "queued",
    });
    expect(recoveryStore.listUsage("key-live", 10)).toEqual([]);
    expect(chain.submissions).toEqual([]);
  });

  it("reconciles exact Accept and Reclaim terminals for same-time jobs once each", async () => {
    const directory = databaseDirectory("terminal-lineage");
    const store = openStore(directory);
    const chain = new ObservedMockChain();
    const { key, walletKey } = keyFixture("key-terminal");
    store.insertKey(key);
    const createdAt = Date.now() - 120_000;
    const acceptRef = `${"6".repeat(64)}#0`;
    const reclaimRef = `${"7".repeat(64)}#1`;
    const acceptSupplier = "8".repeat(56);
    const reclaimSupplier = "9".repeat(56);
    insertFundedJob(store, {
      id: "job-accept",
      keyId: key.id,
      supplierPkh: acceptSupplier,
      escrowRef: acceptRef,
      createdAt,
      advertMarker: "8",
    });
    insertFundedJob(store, {
      id: "job-reclaim",
      keyId: key.id,
      supplierPkh: reclaimSupplier,
      escrowRef: reclaimRef,
      createdAt,
      advertMarker: "9",
    });
    const acceptedTx = "a".repeat(64);
    const reclaimedTx = "b".repeat(64);
    const indexer = lineageIndexer({
      [acceptRef]: {
        original_ref: acceptRef,
        rows: [{
          utxo_ref: acceptRef,
          state: "Submitted",
          posted_at: createdAt,
          spent_tx: acceptedTx,
        }],
        terminal: { type: "AcceptEscrow", tx_hash: acceptedTx },
      },
      [reclaimRef]: {
        original_ref: reclaimRef,
        rows: [{
          utxo_ref: reclaimRef,
          state: "Open",
          posted_at: createdAt,
          spent_tx: reclaimedTx,
        }],
        terminal: { type: "ReclaimEscrow", tx_hash: reclaimedTx },
      },
    });
    const deps = makeDeps(directory, store, chain, indexer.fetchFn, registryFor(key, walletKey, chain));

    await recoverOneShotJobs(deps);
    await recoverOneShotJobs(deps);

    expect(store.getOneShotJob("job-accept")).toMatchObject({
      state: "completed",
      settle_tx_hash: acceptedTx,
    });
    expect(store.getOneShotJob("job-reclaim")).toMatchObject({
      state: "reclaimed",
      settle_tx_hash: reclaimedTx,
    });
    const usage = store.listUsage(key.id, 10);
    expect(usage).toHaveLength(2);
    expect(usage.find(row => row.id === "job-accept")).toMatchObject({
      status: "completed",
      escrow_ref: acceptRef,
      cost_lovelace: PRICE.toString(),
    });
    expect(usage.find(row => row.id === "job-reclaim")).toMatchObject({
      status: "reclaimed",
      escrow_ref: reclaimRef,
      cost_lovelace: null,
    });
    expect(store.sumCostLovelace(key.id)).toBe(PRICE);
    expect(indexer.calls).toHaveLength(4);
    expect(chain.submissions).toEqual([]);
    expect(store.insertOneShotJob({
      id: "job-after-accept",
      key_id: key.id,
      owner_id: "next-owner-accept",
      model: MODEL,
      created_at: Date.now(),
    })).toBe(true);
    expect(store.insertOneShotJob({
      id: "job-after-reclaim",
      key_id: key.id,
      owner_id: "next-owner-reclaim",
      model: MODEL,
      created_at: Date.now(),
    })).toBe(true);
    expect(store.reserveOneShotSupplier(
      "job-after-accept",
      "next-owner-accept",
      [supplierCandidate(acceptSupplier, "8")],
    )).toBeDefined();
    expect(store.reserveOneShotSupplier(
      "job-after-reclaim",
      "next-owner-reclaim",
      [supplierCandidate(reclaimSupplier, "9")],
    )).toBeDefined();
  });

  it("settles only each job's live lineage through the real Accept and Reclaim builders", async () => {
    const directory = databaseDirectory("live-lineage");
    const store = openStore(directory);
    const chain = new ObservedMockChain();
    chain.advanceSlot(Math.floor(Date.now() / 1_000));
    const { key, walletKey } = keyFixture("key-live-lineage");
    store.insertKey(key);
    const createdAt = Date.now() - 120_000;
    const submittedRef = `${"c".repeat(64)}#0`;
    const openRef = `${"d".repeat(64)}#1`;
    const submittedReceipt = "e".repeat(64);
    const submittedSupplier = "a".repeat(56);
    const openSupplier = "b".repeat(56);
    const expiredDeliverBy = Date.now() - 61_000;
    insertFundedJob(store, {
      id: "job-live-accept",
      keyId: key.id,
      supplierPkh: submittedSupplier,
      escrowRef: submittedRef,
      createdAt,
      state: "submitted",
      receiptHash: submittedReceipt,
      advertMarker: "c",
    });
    insertFundedJob(store, {
      id: "job-live-reclaim",
      keyId: key.id,
      supplierPkh: openSupplier,
      escrowRef: openRef,
      createdAt,
      deliverBy: expiredDeliverBy,
      advertMarker: "d",
    });
    seedEscrow(chain, { txHash: "c".repeat(64), index: 0 }, escrowDatum({
      buyerPkh: key.wallet_pkh,
      supplierPkh: submittedSupplier,
      state: "Submitted",
      deliverBy: Date.now() + 30_000,
      receiptHash: submittedReceipt,
      marker: "c",
    }));
    seedEscrow(chain, { txHash: "d".repeat(64), index: 1 }, escrowDatum({
      buyerPkh: key.wallet_pkh,
      supplierPkh: openSupplier,
      state: "Open",
      deliverBy: expiredDeliverBy,
      marker: "d",
    }));
    const indexer = lineageIndexer({
      [submittedRef]: liveLineage(submittedRef, "Submitted", createdAt),
      [openRef]: liveLineage(openRef, "Open", createdAt),
    });

    await recoverOneShotJobs(makeDeps(
      directory,
      store,
      chain,
      indexer.fetchFn,
      registryFor(key, walletKey, chain),
    ));

    expect(store.getOneShotJob("job-live-accept")).toMatchObject({ state: "completed" });
    expect(store.getOneShotJob("job-live-reclaim")).toMatchObject({ state: "reclaimed" });
    expect(store.getOneShotJob("job-live-accept")?.settle_tx_hash)
      .not.toBe(store.getOneShotJob("job-live-reclaim")?.settle_tx_hash);
    expect(await chain.queryUtxo({ txHash: "c".repeat(64), index: 0 })).toBeNull();
    expect(await chain.queryUtxo({ txHash: "d".repeat(64), index: 1 })).toBeNull();
    expect(chain.submissions.map(syntheticTransactionType).sort()).toEqual(["accept", "reclaim"]);
    expect(store.countUsage(key.id)).toBe(2);
  });

  it("releases a rejected post only after its exact origin remains absent", async () => {
    const directory = databaseDirectory("rejected-post");
    const original = openStore(directory);
    const { key, walletKey } = keyFixture("key-rejected");
    original.insertKey(key);
    const postTxHash = "0".repeat(64);
    const escrowRef = `${postTxHash}#0`;
    const supplierPkh = "e".repeat(56);
    insertFundedJob(original, {
      id: "job-rejected",
      keyId: key.id,
      supplierPkh,
      escrowRef,
      advertMarker: "7",
    });
    expect(original.putPendingWalletTransaction({
      key_id: key.id,
      tx_hash: postTxHash,
      tx_cbor: "a100",
      created_at: Date.now() - 120_000,
      valid_until_slot: 400,
    })).toBe(true);
    expect(original.resolvePendingWalletTransaction(key.id, postTxHash, "rejected")).toBe(true);
    closeStore(original);

    const restarted = openStore(directory);
    const chain = new ObservedMockChain();
    const indexer = lineageIndexer({ [escrowRef]: null });
    await recoverOneShotJobs(makeDeps(
      directory,
      restarted,
      chain,
      indexer.fetchFn,
      registryFor(key, walletKey, chain),
    ));

    expect(restarted.getOneShotJob("job-rejected")).toMatchObject({
      state: "failed",
      escrow_ref: escrowRef,
    });
    expect(restarted.listUsage(key.id, 10)).toEqual([
      expect.objectContaining({
        id: "job-rejected",
        status: "failed",
        cost_lovelace: null,
      }),
    ]);
    expect(restarted.insertOneShotJob({
      id: "job-after-rejection",
      key_id: key.id,
      owner_id: "next-owner",
      model: MODEL,
      created_at: Date.now(),
    })).toBe(true);
    expect(restarted.reserveOneShotSupplier(
      "job-after-rejection",
      "next-owner",
      [supplierCandidate(supplierPkh, "7")],
    )).toBeDefined();
    expect(indexer.calls).toHaveLength(2);
    expect(chain.submissions).toEqual([]);
  });

  it("holds an expired post until a fixed checkpoint is indexed and the origin is still absent", async () => {
    const directory = databaseDirectory("expired-post");
    const original = openStore(directory);
    const { key, walletKey } = keyFixture("key-expired");
    original.insertKey(key);
    const postTxHash = "5".repeat(64);
    const escrowRef = `${postTxHash}#0`;
    const supplierPkh = "6".repeat(56);
    insertFundedJob(original, {
      id: "job-expired",
      keyId: key.id,
      supplierPkh,
      escrowRef,
      advertMarker: "6",
      postValidUntilSlot: 400,
    });
    closeStore(original);

    const restarted = openStore(directory);
    const chain = new ObservedMockChain();
    chain.advanceSlot(500);
    let syncSlot = 499;
    const indexerCalls: string[] = [];
    const fetchFn = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      indexerCalls.push(url);
      const pathname = new URL(url).pathname;
      if (pathname === "/healthz") {
        return Response.json({
          ok: true,
          sync_slot: syncSlot,
          tip_slot: await chain.tip(),
          ogmios_status: "connected",
          db_size_bytes: 0,
        });
      }
      if (pathname === `/escrows/${encodeURIComponent(escrowRef)}/lineage`) {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unexpected indexer request ${pathname}`);
    }) as typeof globalThis.fetch;
    const deps = makeDeps(
      directory,
      restarted,
      chain,
      fetchFn,
      registryFor(key, walletKey, chain),
    );

    const protection = await recoverOneShotJobs(deps);

    expect(restarted.getOneShotJob("job-expired")).toMatchObject({
      state: "funding",
      recovery_slot: 500,
      supplier_pkh: supplierPkh,
    });
    expect(restarted.getPendingWalletTransaction(key.id)).toBeUndefined();
    expect(protection.protectedRefs).toContain(escrowRef);
    expect(protection.protectedKeys).toContain(key.id);
    expect(restarted.insertOneShotJob({
      id: "job-blocked-until-sync",
      key_id: key.id,
      owner_id: "next-owner",
      model: MODEL,
      created_at: Date.now(),
    })).toBe(true);
    expect(restarted.reserveOneShotSupplier(
      "job-blocked-until-sync",
      "next-owner",
      [supplierCandidate(supplierPkh, "6")],
    )).toBeUndefined();
    expect(restarted.listUsage(key.id, 10)).toEqual([]);

    chain.advanceSlot(100);
    syncSlot = 500;
    await recoverOneShotJobs(deps);

    expect(restarted.getOneShotJob("job-expired")).toMatchObject({
      state: "failed",
      recovery_slot: 500,
      error: "escrow transaction expired without payment",
    });
    expect(restarted.reserveOneShotSupplier(
      "job-blocked-until-sync",
      "next-owner",
      [supplierCandidate(supplierPkh, "6")],
    )).toBeDefined();
    expect(restarted.listUsage(key.id, 10)).toEqual([
      expect.objectContaining({
        id: "job-expired",
        status: "failed",
        cost_lovelace: null,
      }),
    ]);
    expect(indexerCalls.filter(url => new URL(url).pathname === "/healthz")).toHaveLength(2);
    expect(indexerCalls.filter(url => new URL(url).pathname.endsWith("/lineage"))).toHaveLength(5);
    expect(chain.submissions).toEqual([]);
  });

  it("retains an unknown posted transaction and its supplier reservation", async () => {
    const directory = databaseDirectory("unknown-post");
    const store = openStore(directory);
    const chain = new ObservedMockChain();
    const { key, walletKey } = keyFixture("key-unknown");
    store.insertKey(key);
    const postTxHash = "f".repeat(64);
    const escrowRef = `${postTxHash}#0`;
    const supplierPkh = "c".repeat(56);
    insertFundedJob(store, {
      id: "job-unknown",
      keyId: key.id,
      supplierPkh,
      escrowRef,
      advertMarker: "e",
    });
    expect(store.putPendingWalletTransaction({
      key_id: key.id,
      tx_hash: postTxHash,
      tx_cbor: "a100",
      created_at: Date.now() - 120_000,
      valid_until_slot: null,
    })).toBe(true);
    const indexer = lineageIndexer({ [escrowRef]: null });
    const deps = makeDeps(directory, store, chain, indexer.fetchFn, registryFor(key, walletKey, chain));

    const protection = await recoverOneShotJobs(deps);
    await recoverOneShotJobs(deps);

    expect(store.getOneShotJob("job-unknown")).toMatchObject({
      state: "funding",
      supplier_pkh: supplierPkh,
      escrow_ref: escrowRef,
    });
    expect(store.getPendingWalletTransaction(key.id)).toMatchObject({ tx_hash: postTxHash });
    expect(protection.protectedRefs).toContain(escrowRef);
    expect(protection.protectedKeys).toContain(key.id);
    expect(store.insertOneShotJob({
      id: "job-next",
      key_id: key.id,
      owner_id: "next-owner",
      model: MODEL,
      created_at: Date.now(),
    })).toBe(true);
    expect(store.reserveOneShotSupplier(
      "job-next",
      "next-owner",
      [supplierCandidate(supplierPkh, "e")],
    )).toBeUndefined();
    expect(store.listUsage(key.id, 10)).toEqual([]);
    expect(chain.submissions).toEqual([]);
  });

  it("refuses settlement when the Submitted receipt differs and keeps the reservation", async () => {
    const directory = databaseDirectory("receipt-mismatch");
    const store = openStore(directory);
    const chain = new ObservedMockChain();
    chain.advanceSlot(Math.floor(Date.now() / 1_000));
    const { key, walletKey } = keyFixture("key-receipt");
    store.insertKey(key);
    const escrowRef = `${"1".repeat(64)}#2`;
    const supplierPkh = "d".repeat(56);
    const expectedReceipt = "2".repeat(64);
    const actualReceipt = "3".repeat(64);
    insertFundedJob(store, {
      id: "job-receipt",
      keyId: key.id,
      supplierPkh,
      escrowRef,
      state: "submitted",
      receiptHash: expectedReceipt,
      advertMarker: "f",
    });
    seedEscrow(chain, { txHash: "1".repeat(64), index: 2 }, escrowDatum({
      buyerPkh: key.wallet_pkh,
      supplierPkh,
      state: "Submitted",
      deliverBy: Date.now() + 30_000,
      receiptHash: actualReceipt,
      marker: "f",
    }));
    const indexer = lineageIndexer({
      [escrowRef]: liveLineage(escrowRef, "Submitted", Date.now() - 120_000),
    });

    await recoverOneShotJobs(makeDeps(
      directory,
      store,
      chain,
      indexer.fetchFn,
      registryFor(key, walletKey, chain),
    ));

    expect(store.getOneShotJob("job-receipt")).toMatchObject({
      state: "recovering",
      supplier_pkh: supplierPkh,
      error: "escrow receipt commitment mismatch",
    });
    expect(store.insertOneShotJob({
      id: "job-after-mismatch",
      key_id: key.id,
      owner_id: "next-owner",
      model: MODEL,
      created_at: Date.now(),
    })).toBe(true);
    expect(store.reserveOneShotSupplier(
      "job-after-mismatch",
      "next-owner",
      [supplierCandidate(supplierPkh, "f")],
    )).toBeUndefined();
    expect(await chain.queryUtxo({ txHash: "1".repeat(64), index: 2 })).not.toBeNull();
    expect(store.listUsage(key.id, 10)).toEqual([]);
    expect(chain.submissions).toEqual([]);
  });
});
