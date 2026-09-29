import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express, type Response as ExpressResponse } from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  MockChainProvider,
  type OutputReference,
  type Utxo,
} from "@marketplace/shared/chain";
import { buildPostAdvertTx } from "@marketplace/shared/tx";
import { decodeEscrowDatum } from "@marketplace/shared/cbor";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { createApp as createSupplierApp } from "../../supplier/src/server.js";
import { loadConfig as loadSupplierConfig } from "../../supplier/src/config.js";
import { SupplierState } from "../../supplier/src/state.js";
import { createApp } from "../src/server.js";
import { loadConfig, type GatewayConfig } from "../src/config.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import { hashApiKey } from "../src/middleware/apiKeyAuth.js";
import { deriveWalletKey, genPrivKeyHex } from "../src/wallet.js";
import type { GatewayDeps } from "../src/deps.js";

const MODEL = "concurrent-chat-model";
const PRICE = 200_000n;
const SUPPLIER_COUNT = 4;

class Barrier<T = void> {
  readonly promise: Promise<T>;
  private settle!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.settle = resolve;
    });
  }

  release(value: T): void {
    this.settle(value);
  }
}

function transactionType(txCborHex: string): string | null {
  try {
    const bytes = Buffer.from(txCborHex, "hex");
    if (bytes.byteLength < 4) return null;
    const length = bytes.readUInt32BE(0);
    if (length <= 0 || length > bytes.byteLength - 4) return null;
    const body = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")) as { type?: unknown };
    return typeof body.type === "string" ? body.type : null;
  } catch {
    return null;
  }
}

/** Makes the first buyer Accept visible only after the test releases it. */
class ControlledChain extends MockChainProvider {
  readonly transactionTypes: string[] = [];
  readonly acceptConfirmationBlocked = new Barrier();
  private heldAcceptHash: string | null = null;
  private acceptVisible = false;

  override async submitTx(txCborHex: string): Promise<string> {
    const type = transactionType(txCborHex);
    if (type !== null) this.transactionTypes.push(type);
    const hash = await super.submitTx(txCborHex);
    if (type === "accept" && this.heldAcceptHash === null) this.heldAcceptHash = hash;
    return hash;
  }

  override async queryUtxo(ref: OutputReference): Promise<Utxo | null> {
    if (ref.txHash === this.heldAcceptHash && !this.acceptVisible) {
      this.acceptConfirmationBlocked.release();
      return null;
    }
    return super.queryUtxo(ref);
  }

  releaseAcceptConfirmation(): void {
    this.acceptVisible = true;
  }
}

interface JsonReply {
  status: number;
  body: Record<string, unknown>;
}

async function eventually<T>(readValue: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = readValue();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("fixture barrier timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe.sequential("paid one-shot concurrency", () => {
  const chain = new ControlledChain();
  const servers: Server[] = [];
  const supplierStates: SupplierState[] = [];
  const pendingInferenceResponses: ExpressResponse[] = [];
  const allInferenceActive = new Barrier();
  const heldSupplierSnapshotRequested = new Barrier();
  const heldSupplierSnapshotRelease = new Barrier();
  let holdNextSupplierSnapshot = false;
  let stallSupplierDiscovery = false;
  let config: GatewayConfig;
  let store: GatewayStore;
  let directory = "";
  let gatewayUrl = "";
  let apiKey = "";
  let keyId = "";
  let supplierViews: Array<Record<string, unknown>> = [];

  async function listen(serverApp: Express): Promise<string> {
    const server = createServer(serverApp);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<JsonReply> {
    const response = await fetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    };
  }

  function releaseInference(): void {
    pendingInferenceResponses.splice(0).forEach((response, index) => {
      if (response.headersSent) return;
      response.json({
        id: `chatcmpl-concurrency-${index}`,
        object: "chat.completion",
        created: 1,
        model: MODEL,
        choices: [{
          index: 0,
          message: { role: "assistant", content: `parallel answer ${index}` },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      });
    });
  }

  beforeAll(async () => {
    chain.advanceSlot(Math.floor(Date.now() / 1_000));
    directory = mkdtempSync(join(tmpdir(), "gateway-concurrency-"));

    const upstream = express();
    upstream.use(express.json());
    upstream.post("/v1/chat/completions", (_req, res) => {
      pendingInferenceResponses.push(res);
      if (pendingInferenceResponses.length === SUPPLIER_COUNT) allInferenceActive.release();
    });
    const upstreamUrl = await listen(upstream);

    const advertised: Array<Record<string, unknown>> = [];
    for (let index = 0; index < SUPPLIER_COUNT; index++) {
      const supplierKey = deriveWalletKey(genPrivKeyHex(), 0);
      const state = new SupplierState();
      supplierStates.push(state);
      const supplierConfig = loadSupplierConfig({
        SUPPLIER_PRIV_KEY_HEX: supplierKey.privateKeyHex,
        OGMIOS_URL: "http://unused.test",
        ADVERT_REF: `${(index + 1).toString(16).repeat(64)}#0`,
        NETWORK_ID: "0",
        LLM_BACKEND: "openai",
        OPENAI_UPSTREAM_API: "chat-completions",
        OPENAI_BASE_URL: upstreamUrl,
        OPENAI_TIMEOUT_MS: "30000",
        WALLET_HEALTH_INTERVAL_MS: "0",
      });
      const supplierUrl = await listen(createSupplierApp({
        chain,
        state,
        config: supplierConfig,
        supplierKey,
      }));
      const advert = {
        supplier_pkh: supplierKey.pubKeyHash,
        capability_id: "llm.text.generate.v1",
        model: MODEL,
        max_output_tokens: 256,
        max_processing_ms: 30_000,
        price_lovelace: PRICE,
        supplier_bond_lovelace: 1_000_000n,
        buyer_bond_lovelace: 1_000_000n,
        endpoint_url: supplierUrl,
        detail_uri: "",
        detail_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        advertised_at: (await chain.tip()) * 1_000,
        status: "Active" as const,
      };
      const posted = await buildPostAdvertTx({
        chain,
        walletKey: supplierKey,
        advertDatum: advert,
        deposit_lovelace: 1_000_000n,
      });
      supplierConfig.advertRef = posted.advertOutputRef;
      advertised.push({
        ...advert,
        price_lovelace: PRICE.toString(),
        supplier_bond_lovelace: "1000000",
        buyer_bond_lovelace: "1000000",
        utxo_ref: `${posted.expectedTxHash}#0`,
        advert_status: "Active",
        // The stale indexer view is intentional. SQL reservation, not this
        // cached status, must keep concurrent jobs on distinct suppliers.
        status: "free",
      });
    }
    supplierViews = advertised;

    const indexer = express();
    indexer.get("/suppliers", async (_req, res) => {
      if (stallSupplierDiscovery) return;
      if (holdNextSupplierSnapshot) {
        holdNextSupplierSnapshot = false;
        heldSupplierSnapshotRequested.release();
        await heldSupplierSnapshotRelease.promise;
      }
      res.json(supplierViews);
    });
    indexer.get("/escrows", async (_req, res) => {
      const utxos = await chain.queryUtxosByAddress(loadBlueprint().escrowScriptAddress(0));
      res.json(utxos.filter((utxo) => utxo.datumHex).map((utxo) => {
        const datum = decodeEscrowDatum(utxo.datumHex!);
        return {
          utxo_ref: `${utxo.ref.txHash}#${utxo.ref.index}`,
          state: datum.state,
          posted_at: datum.posted_at,
          deliver_by: datum.deliver_by,
          buyer_pkh: datum.buyer_pkh,
          supplier_pkh: datum.supplier_pkh,
          payment_lovelace: datum.payment_lovelace.toString(),
          buyer_bond_lovelace: datum.buyer_bond_lovelace.toString(),
          supplier_bond_lovelace: datum.supplier_bond_lovelace.toString(),
        };
      }));
    });
    indexer.get("/escrows/:ref/lineage", (_req, res) => res.status(404).json({ error: "not indexed" }));
    const indexerUrl = await listen(indexer);

    config = loadConfig({
      GATEWAY_MASTER_KEY: randomBytes(32).toString("hex"),
      INDEXER_URL: indexerUrl,
      LIVE_CHAIN: "1",
      OGMIOS_URL: "http://unused.test",
      NETWORK_ID: "0",
      GATEWAY_DB_DIR: directory,
      ONE_SHOT_CONCURRENCY: "4",
      ONE_SHOT_MAX_OUTSTANDING: "5",
      ONE_SHOT_QUEUE_TIMEOUT_MS: "60000",
    });
    store = new GatewayStore(directory);
    const gatewayChain = chain as unknown as GatewayDeps["chain"];
    const registry = new SdkRegistry({
      chain: gatewayChain,
      store,
      indexerUrl,
      networkId: 0,
      masterKeyHex: config.masterKeyHex,
      max: 10,
      fetchFn: fetch,
    });
    gatewayUrl = await listen(createApp({
      config,
      store,
      chain: gatewayChain,
      registry,
      fetchFn: fetch,
    }));

    const signup = await post("/signup", { label: "same-key concurrency regression" });
    expect(signup.status).toBe(201);
    apiKey = String(signup.body.api_key);
    const key = store.getKeyByHash(hashApiKey(apiKey));
    if (!key) throw new Error("fixture signup did not persist its API key");
    keyId = key.id;
    for (const [index, lovelace] of [100_000_000n, 5_000_000n].entries()) {
      chain.seed({
        ref: { txHash: "b".repeat(64), index },
        address: String(signup.body.deposit_address),
        lovelace,
        assets: {},
        datumHex: null,
        scriptRef: null,
      });
    }
  });

  afterAll(async () => {
    releaseInference();
    heldSupplierSnapshotRelease.release();
    chain.releaseAcceptConfirmation();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
    if (store) store["db"].close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("runs four suppliers concurrently while wallet spends, queueing, and billing stay serialized", async () => {
    const requests = [
      post("/openai/v1/responses", { model: MODEL, input: "responses request zero", store: false }),
      post("/openai/v1/chat/completions", {
        model: MODEL,
        messages: [{ role: "user", content: "chat request one" }],
      }),
      post("/openai/v1/responses", { model: MODEL, input: "responses request two", store: false }),
      post("/openai/v1/chat/completions", {
        model: MODEL,
        messages: [{ role: "user", content: "chat request three" }],
      }),
    ];

    await allInferenceActive.promise;
    const activeRefs = supplierStates.flatMap((state) => {
      const snapshot = state.snapshot();
      expect(snapshot.status).toBe("working");
      expect(snapshot.activeSessions).toBe(1);
      return snapshot.activeEscrowRefs;
    });
    expect(new Set(activeRefs).size).toBe(SUPPLIER_COUNT);
    expect(chain.transactionTypes.filter((type) => type === "post-escrow")).toHaveLength(SUPPLIER_COUNT);

    // The four slots are full. Keep the fifth supplier snapshot unresolved so
    // its journal row is observably queued and cannot reach escrow funding.
    holdNextSupplierSnapshot = true;
    const cancelled = new AbortController();
    const fifthOutcome = post("/openai/v1/responses", {
      model: MODEL,
      input: "cancel before funding",
      store: false,
    }, cancelled.signal).then(
      (reply) => ({ reply }),
      (error: unknown) => ({ error }),
    );
    await heldSupplierSnapshotRequested.promise;
    const queued = store.listOneShotJobs(keyId).find((job) => job.state === "queued");
    expect(queued).toBeDefined();
    expect(queued?.escrow_ref).toBeNull();
    expect(store.listOneShotJobs(keyId)).toHaveLength(5);

    const overflow = await post("/openai/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "bounded overflow" }],
    });
    expect(overflow.status).toBe(429);
    expect(overflow.body.error).toMatchObject({ code: "concurrency_queue_full" });
    expect(store.listOneShotJobs(keyId)).toHaveLength(5);
    expect(chain.transactionTypes.filter((type) => type === "post-escrow")).toHaveLength(SUPPLIER_COUNT);

    cancelled.abort();
    const cancelledResult = await fifthOutcome;
    expect("error" in cancelledResult).toBe(true);
    heldSupplierSnapshotRelease.release();
    if (!queued) throw new Error("queued cancellation fixture was not created");
    await eventually(() => store.getOneShotJob(queued.id)?.state === "failed" ? true : undefined);
    expect(store.getOneShotJob(queued.id)?.escrow_ref).toBeNull();
    expect(chain.transactionTypes.filter((type) => type === "post-escrow")).toHaveLength(SUPPLIER_COUNT);

    releaseInference();
    await chain.acceptConfirmationBlocked.promise;
    await eventually(() => {
      const funded = store.listOneShotJobs(keyId).filter((job) => job.escrow_ref !== null);
      return funded.length === SUPPLIER_COUNT && funded.every((job) => job.submitted_ref !== null)
        ? funded
        : undefined;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(chain.transactionTypes.filter((type) => type === "accept")).toHaveLength(1);
    const blockedStates = store.listOneShotJobs(keyId)
      .filter((job) => job.escrow_ref !== null)
      .map((job) => job.state);
    expect(blockedStates.filter((state) => state === "settling")).toHaveLength(1);
    expect(blockedStates.filter((state) => state === "submitted")).toHaveLength(3);

    chain.releaseAcceptConfirmation();
    const replies = await Promise.all(requests);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);

    const vectors = replies.map((reply) => reply.body.x_vector as {
      escrow_ref: string;
      receipt: { escrow_ref: string; supplier_pkh: string };
    });
    const originalRefs = vectors.map((vector) => vector.escrow_ref);
    const receiptSuppliers = vectors.map((vector) => vector.receipt.supplier_pkh);
    expect(new Set(originalRefs).size).toBe(SUPPLIER_COUNT);
    expect(new Set(receiptSuppliers).size).toBe(SUPPLIER_COUNT);
    expect(vectors.every((vector) => vector.receipt.escrow_ref === vector.escrow_ref)).toBe(true);

    const jobs = store.listOneShotJobs(keyId);
    const fundedJobs = jobs.filter((job) => job.escrow_ref !== null);
    expect(fundedJobs).toHaveLength(SUPPLIER_COUNT);
    expect(fundedJobs.every((job) => job.state === "completed")).toBe(true);
    expect(new Set(fundedJobs.map((job) => job.supplier_pkh)).size).toBe(SUPPLIER_COUNT);
    expect(new Set(fundedJobs.map((job) => job.escrow_ref)).size).toBe(SUPPLIER_COUNT);
    expect(new Set(fundedJobs.map((job) => job.escrow_ref))).toEqual(new Set(originalRefs));
    expect(new Set(fundedJobs.map((job) => job.supplier_pkh))).toEqual(new Set(receiptSuppliers));
    expect(fundedJobs.every((job) => job.settle_tx_hash !== null)).toBe(true);
    expect(new Set(fundedJobs.map((job) => job.settle_tx_hash)).size).toBe(SUPPLIER_COUNT);
    expect(await chain.queryUtxosByAddress(loadBlueprint().escrowScriptAddress(0))).toEqual([]);

    const usage = store.listUsage(keyId, 20);
    expect(usage).toHaveLength(6);
    expect(new Set(usage.map((row) => row.id)).size).toBe(6);
    const charged = usage.filter((row) => row.cost_lovelace !== null);
    const uncharged = usage.filter((row) => row.cost_lovelace === null);
    expect(charged).toHaveLength(SUPPLIER_COUNT);
    expect(charged.every((row) => row.status === "completed" && row.cost_lovelace === PRICE.toString())).toBe(true);
    expect(new Set(charged.map((row) => row.escrow_ref)).size).toBe(SUPPLIER_COUNT);
    expect(new Set(charged.map((row) => row.escrow_ref))).toEqual(new Set(originalRefs));
    expect(uncharged).toHaveLength(2);
    expect(uncharged.every((row) => row.status === "failed" && row.escrow_ref === null)).toBe(true);

    const accountResponse = await fetch(`${gatewayUrl}/account`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const account = await accountResponse.json() as {
      spend: { total_cost_lovelace: string; request_count: number };
      balance: { locked_in_escrow_lovelace: string };
    };
    expect(accountResponse.status).toBe(200);
    expect(account.spend).toEqual({
      total_cost_lovelace: (PRICE * BigInt(SUPPLIER_COUNT)).toString(),
      request_count: 6,
    });
    expect(account.balance.locked_in_escrow_lovelace).toBe("0");
  }, 30_000);

  it("ends stalled supplier discovery at the admission deadline without funding", async () => {
    const before = new Set(store.listOneShotJobs(keyId).map(job => job.id));
    const paidBefore = store.sumCostLovelace(keyId);
    const previousTimeout = config.oneShotQueueTimeoutMs;
    config.oneShotQueueTimeoutMs = 40;
    stallSupplierDiscovery = true;
    try {
      const response = await post("/openai/v1/responses", {
        model: MODEL, input: "discovery must respect admission timeout", store: false,
      });
      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({ code: "supplier_capacity_timeout" });
      const jobs = store.listOneShotJobs(keyId).filter(job => !before.has(job.id));
      expect(jobs).toEqual([expect.objectContaining({ state: "failed", escrow_ref: null })]);
      expect(store.sumCostLovelace(keyId)).toBe(paidBefore);
      expect(await chain.queryUtxosByAddress(loadBlueprint().escrowScriptAddress(0))).toEqual([]);
    } finally {
      stallSupplierDiscovery = false;
      config.oneShotQueueTimeoutMs = previousTimeout;
    }
  }, 2_000);
});
