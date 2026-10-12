import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import {
  PAPER2AGENT_CAPABILITY_ID,
  paper2AgentManifestHash,
  paper2AgentModel,
  paper2AgentRequestHash,
  paper2AgentResultHash,
  paper2AgentToolName,
  parsePaper2AgentManifest,
  verifyPaper2AgentReceipt,
  type JsonObject,
} from "@marketplace/shared/paper2agent";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { buildReceipt, type Receipt } from "@marketplace/shared/receipt";
import { signReceipt } from "../../packages/shared/src/receipt/sign.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import { deriveWalletKey, genPrivKeyHex } from "../src/wallet.js";
import { seal } from "../src/crypto/seal.js";
import { hashApiKey } from "../src/middleware/apiKeyAuth.js";
import { parseApprovalCommand } from "../src/cli/paper2agent-approval.js";
import { GatewayError } from "../src/openai/errors.js";
import * as money from "../src/paper2agent/service.js";
import type { GatewayDeps } from "../src/deps.js";
import * as sharedTools from "@marketplace/shared/paper2agent";

const MASTER = "ab".repeat(32);
const MANIFEST = parsePaper2AgentManifest({
  schema_version: 1,
  name: "fixture_count",
  description: "Count the supplied fixture samples.",
  package_sha256: "a".repeat(64),
  input_schema: {
    type: "object", properties: { samples: { type: "array", items: { type: "number" }, maxItems: 100 } },
    required: ["samples"], additionalProperties: false,
  },
  output_schema: {
    type: "object", properties: { count: { type: "integer", minimum: 0 } },
    required: ["count"], additionalProperties: false,
  },
  limits: { max_input_bytes: 1024, max_output_bytes: 1024, max_runtime_ms: 1000 },
});
const HASH = paper2AgentManifestHash(MANIFEST);
const TOOL = paper2AgentToolName(MANIFEST);
const SUPPLIER = deriveWalletKey("11".repeat(32), 0);
const REF = { txHash: "a".repeat(64), index: 0 };
const INPUT = { samples: [2, 7, 9] };
const RESULT = { count: 3 };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(manifest = MANIFEST) {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-p2a-mcp-"));
  const store = new GatewayStore(dbDir);
  const config = loadConfig({
    GATEWAY_MASTER_KEY: MASTER, GATEWAY_DB_DIR: dbDir,
    LIVE_CHAIN: "1", INDEXER_URL: "https://indexer.test", OGMIOS_URL: "http://ogmios.test",
    KEY_RATE_MAX: "1000", DEMO_IP_RATE_MAX: "1000",
  });
  const chain = new MockChainProvider();
  const submit = vi.spyOn(chain, "submitTx");
  const advert: AdvertDatum = {
    supplier_pkh: SUPPLIER.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID,
    model: paper2AgentModel(manifest), max_output_tokens: 0, max_processing_ms: 180_000,
    price_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n, supplier_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.test", detail_uri: "", detail_hash: "b".repeat(64),
    advertised_at: Date.now(), status: "Active",
  };
  chain.seed({ ref: REF, address: loadBlueprint().advertScriptAddress(0), lovelace: 2_000_000n, assets: {}, datumHex: encodeAdvertDatum(advert), scriptRef: null });
  const capability: Record<string, unknown> = {
    ...advert,
    advert_ref: `${REF.txHash}#0`,
    price_lovelace: "1000000", buyer_bond_lovelace: "1000000", supplier_bond_lovelace: "1000000",
    pub_key_hex: SUPPLIER.pubKeyHex,
    paper2agent: { manifest, manifest_hash: paper2AgentManifestHash(manifest) },
  };
  const row = {
    ...capability, utxo_ref: `${REF.txHash}#0`, advert_status: "Active", status: "free",
  };
  const rows: unknown[] = [row];
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (init?.method && init.method !== "GET") throw new Error("No supplier spending is allowed in this HTTP boundary fixture");
    const target = String(url);
    const body = target.includes("/suppliers") ? rows : target.endsWith("/capability") ? capability : [];
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  const deps: GatewayDeps = {
    config, store, chain: chain as unknown as GatewayDeps["chain"], fetchFn,
    registry: new SdkRegistry({
      chain: chain as unknown as GatewayDeps["chain"], store, indexerUrl: config.indexerUrl,
      networkId: 0, masterKeyHex: MASTER, max: 10, fetchFn,
    }),
  };
  const server = createApp(deps).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test HTTP port");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store["db"].close();
    rmSync(dbDir, { recursive: true, force: true });
  });
  function addKey(demo = false) {
    const raw = `vk_test_${randomBytes(24).toString("hex")}`;
    const privateKey = genPrivKeyHex();
    const wallet = deriveWalletKey(privateKey, 0);
    const encrypted = seal(privateKey, MASTER);
    const id = randomUUID();
    store.insertKey({
      id, key_hash: hashApiKey(raw), key_prefix: raw.slice(0, 12), label: null,
      wallet_pkh: wallet.pubKeyHash, deposit_address: wallet.address,
      enc_priv_nonce: encrypted.nonce, enc_priv_ct: encrypted.ct, enc_priv_tag: encrypted.tag,
      master_key_version: 1, created_at: Date.now(), demo: demo ? 1 : 0,
    });
    return { id, raw };
  }
  async function connect(raw?: string, modern = false) {
    const client = new Client({ name: "paper2agent-http-test", version: "1.0.0" }, {
      ...(modern ? { versionNegotiation: { mode: "auto" as const } } : {}),
    });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: raw ? { authorization: `Bearer ${raw}` } : {} },
    }));
    return client;
  }
  return { deps, store, chain, submit, rows, capability, advert, fetchFn, addKey, connect, base };
}

function approve(f: Pick<GatewayDeps, "store">, keyId: string, manifestHash = HASH) {
  money.approvePaper2Agent(f.store, {
    keyId, manifestHash, supplierPkh: SUPPLIER.pubKeyHash,
    maxPriceLovelace: 1_000_000n, maxTotalSpendLovelace: 30_000_000n, maxCalls: 1,
  });
}
function signedCall(manifest = MANIFEST, input: JsonObject = INPUT, result: JsonObject = RESULT) {
  const hash = paper2AgentManifestHash(manifest);
  const escrow = `${"c".repeat(64)}#0`;
  const receipt = buildReceipt({
    prompt_hash: paper2AgentRequestHash(hash, input),
    response_hash: paper2AgentResultHash(hash, paper2AgentRequestHash(hash, input), result),
    model: paper2AgentModel(manifest), prompt_tokens: 0, completion_tokens: 0,
    wallclock_ms: 1, supplier_pkh: SUPPLIER.pubKeyHash, escrow_ref: escrow,
  });
  const signed = signReceipt(receipt, SUPPLIER.privateKeyHex);
  return {
    job_id: "job-fixture", result, receipt: signed.receipt, receipt_signature: signed.signature,
    pub_key_hex: SUPPLIER.pubKeyHex, escrow_ref: escrow, submitted_ref: `${"d".repeat(64)}#0`,
    financial: { status: "accepted", actual_cost_lovelace: "1450000" },
  };
}
function vector(result: CallToolResult): Record<string, unknown> {
  return result._meta?.vector as Record<string, unknown>;
}

describe("Paper2Agent authenticated MCP HTTP", () => {
  it("authenticates initialization and every later exchange, including GET and DELETE", async () => {
    const f = await fixture();
    await expect(f.connect()).rejects.toThrow();
    await expect(f.connect("invalid-key")).rejects.toThrow();
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      expect((await fetch(`${f.base}/mcp`, { method })).status).toBe(401);
    }
    for (const path of ["/mcp", "/MCP/"]) {
      expect((await fetch(`${f.base}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{invalid",
      })).status).toBe(401);
      expect((await fetch(`${f.base}${path}`, { method: "OPTIONS" })).status).toBe(401);
    }
    const key = f.addKey();
    const client = await f.connect(key.raw);
    f.store["db"].prepare("UPDATE api_keys SET disabled = 1 WHERE id = ?").run(key.id);
    await expect(client.listTools()).rejects.toThrow();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("rejects an unapproved browser Origin before discovery", async () => {
    const f = await fixture();
    const key = f.addKey();
    const response = await fetch(`${f.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.raw}`, origin: "https://attacker.test", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("mcp_origin_denied");
    expect(f.deps.fetchFn).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each([false, true])("discovers real schemas through official HTTP in modern=%s mode without spending", async (modern) => {
    const f = await fixture();
    const key = f.addKey();
    const client = await f.connect(key.raw, modern);
    const listing = await client.listTools();
    expect(listing.tools).toHaveLength(1);
    expect(listing.tools[0]).toMatchObject({
      name: TOOL, inputSchema: MANIFEST.input_schema, outputSchema: MANIFEST.output_schema,
      annotations: { idempotentHint: false, readOnlyHint: false },
    });
    expect(f.store.listOneShotJobs()).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
    f.capability.pub_key_hex = "00".repeat(32);
    expect((await client.listTools()).tools).toEqual([]);
  });

  it("revalidates adverts for each discovery and call, rather than trusting stale tool names", async () => {
    const f = await fixture();
    const key = f.addKey();
    approve(f, key.id);
    const client = await f.connect(key.raw);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([TOOL]);
    f.rows.splice(0);
    const result = await client.callTool({ name: TOOL, arguments: INPUT });
    expect(result.isError).toBe(true);
    expect(vector(result).code).toBe("paper2agent_tool_not_found");
    expect((await client.listTools()).tools).toEqual([]);
    expect(f.store.listOneShotJobs()).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("rejects demo calls, unknown names, and invalid arguments before admission", async () => {
    const f = await fixture();
    const dispatch = vi.spyOn(money, "executePaper2AgentCall");
    const demo = await f.connect(f.addKey(true).raw);
    expect((await demo.listTools()).tools).toHaveLength(1);
    expect(vector(await demo.callTool({ name: TOOL, arguments: INPUT })).code).toBe("demo_key_restricted");
    const key = f.addKey();
    approve(f, key.id);
    const client = await f.connect(key.raw);
    expect(vector(await client.callTool({ name: "invented", arguments: INPUT })).code).toBe("paper2agent_tool_not_found");
    // request() avoids client-side schema validation, so this checks the server.
    for (const arguments_ of [{ samples: ["2"] }, { samples: [2], max_calls: 999 }, { samples: [2], api_key: "do-not-forward" }]) {
      const denied = await client.request({ method: "tools/call", params: { name: TOOL, arguments: arguments_ } });
      expect(vector(denied as CallToolResult).code).toBe("paper2agent_invalid_input");
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.store.listOneShotJobs()).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("uses real immutable approvals for missing, wrong-manifest, and revoked denials", async () => {
    const f = await fixture();
    const unapproved = f.addKey();
    const wrong = f.addKey();
    const revoked = f.addKey();
    approve(f, wrong.id, "f".repeat(64));
    approve(f, revoked.id);
    money.revokePaper2Agent(f.store, revoked.id);
    for (const key of [unapproved, wrong, revoked]) {
      const result = await (await f.connect(key.raw)).callTool({ name: TOOL, arguments: INPUT });
      expect(result.isError).toBe(true);
    }
    expect(f.store.listOneShotJobs()).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("does not admit a second call while the single approved call has an unresolved liability", async () => {
    const f = await fixture();
    const key = f.addKey();
    approve(f, key.id);
    const jobId = randomUUID();
    f.store.insertOneShotJob({
      id: jobId, key_id: key.id, owner_id: "test-owner", model: paper2AgentModel(MANIFEST), created_at: Date.now(),
    }, 64, () => f.store.paper2agent.reserve(jobId, key.id, HASH));
    f.store.paper2agent.update(jobId, { financial_status: "unknown" });
    const before = f.store.paper2agent.approval(key.id);
    const response = await (await f.connect(key.raw)).callTool({ name: TOOL, arguments: INPUT });
    expect(response.isError).toBe(true);
    expect(vector(response).code).toBe("paper2agent_call_limit");
    expect(f.store.listOneShotJobs().map((job) => job.id)).toEqual([jobId]);
    expect(f.store.paper2agent.approval(key.id)).toEqual(before);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("keeps scientific output separate from independently verifiable Vector metadata", async () => {
    const f = await fixture();
    const key = f.addKey();
    approve(f, key.id);
    // The transport test substitutes only the paid service success boundary.
    // Discovery, schemas, auth, HTTP framing, and signature verification are real.
    const paid = signedCall();
    vi.spyOn(money, "executePaper2AgentCall").mockResolvedValueOnce(paid);
    const client = await f.connect(key.raw);
    await client.listTools();
    const response = await client.callTool({ name: TOOL, arguments: INPUT });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(RESULT);
    expect(response.structuredContent).not.toHaveProperty("receipt");
    expect(response.structuredContent).not.toHaveProperty("financial");
    expect(vector(response)).toEqual({
      job_id: paid.job_id, receipt: paid.receipt, receipt_signature: paid.receipt_signature,
      pub_key_hex: paid.pub_key_hex, escrow_ref: paid.escrow_ref, submitted_ref: paid.submitted_ref, financial: paid.financial,
    });
    verifyPaper2AgentReceipt({
      manifest: MANIFEST, input: INPUT, result: response.structuredContent as typeof RESULT,
      receipt: paid.receipt, signature: String(vector(response).receipt_signature), publicKeyHex: String(vector(response).pub_key_hex),
      supplierPkh: SUPPLIER.pubKeyHash, escrowRef: String(vector(response).escrow_ref),
    });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("does not repeat a paid call after an ambiguous financial error", async () => {
    const f = await fixture();
    const key = f.addKey();
    approve(f, key.id);
    f.rows.unshift(...Array.from({ length: 129 }, (_, index) => ({
      ...f.capability, supplier_pkh: "f".repeat(56), advert_status: "Active", status: "free",
      utxo_ref: `${index.toString(16).padStart(64, "0")}#0`,
    })));
    const dispatch = vi.spyOn(money, "executePaper2AgentCall").mockRejectedValueOnce(new GatewayError(
      503, "server_error", "paper2agent_pending", "Payment is unresolved. Check the job before another call.",
      { job_id: "funded-job", financial: { status: "unknown" } },
    ));
    const response = await (await f.connect(key.raw)).callTool({ name: TOOL, arguments: INPUT });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(vector(response)).toMatchObject({ code: "paper2agent_pending", job_id: "funded-job", financial: { status: "unknown" } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("blocks dedicated keys on other spending paths, also after revoke, but keeps account reads", async () => {
    const f = await fixture();
    const key = f.addKey();
    approve(f, key.id);
    for (const revoked of [false, true]) {
      if (revoked) money.revokePaper2Agent(f.store, key.id);
      for (const path of ["/account/withdraw", "/openai/v1/responses", "/openai/v1/chat/completions", "/v1/ocr/extract"]) {
        const response = await fetch(`${f.base}${path}`, {
          method: "POST", headers: { authorization: `Bearer ${key.raw}`, "content-type": "application/json" }, body: "{}",
        });
        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe("paper2agent_key_restricted");
      }
      expect((await fetch(`${f.base}/account`, { headers: { authorization: `Bearer ${key.raw}` } })).status).toBe(200);
    }
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("does not expose an own-job result or financial state to another authenticated key", async () => {
    const f = await fixture();
    const owner = f.addKey();
    const stranger = f.addKey();
    approve(f, owner.id);
    const jobId = randomUUID();
    f.store.insertOneShotJob({
      id: jobId, key_id: owner.id, owner_id: "test-owner", model: paper2AgentModel(MANIFEST), created_at: Date.now(),
    }, 64, () => f.store.paper2agent.reserve(jobId, owner.id, HASH));
    f.store.paper2agent.update(jobId, { financial_status: "unknown", error: "confirmation pending" });
    const path = `${f.base}/v1/paper2agent/jobs/${jobId}`;
    expect((await fetch(path)).status).toBe(401);
    const denied = await fetch(path, { headers: { authorization: `Bearer ${stranger.raw}` } });
    const missing = await fetch(`${f.base}/v1/paper2agent/jobs/missing`, { headers: { authorization: `Bearer ${stranger.raw}` } });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual(await missing.json());
    const own = await fetch(path, { headers: { authorization: `Bearer ${owner.raw}` } });
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("no-store");
    const job = await own.json();
    expect(job.job_id).toBe(jobId);
    expect(job.financial).toMatchObject({ status: "unknown" });
    expect(JSON.stringify(job)).not.toContain(owner.raw);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("executes tuple tools without changing the approved manifest", async () => {
    const manifest = parsePaper2AgentManifest({
      ...MANIFEST, name: "tuple_tool",
      input_schema: {
        type: "object", properties: {
          point: { type: "array", prefixItems: [{ type: "number" }, { type: "string" }], minItems: 2, maxItems: 2 },
        }, required: ["point"], additionalProperties: false,
      },
      output_schema: {
        type: "object", properties: {
          label: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], minItems: 2, maxItems: 2 },
        }, required: ["label"], additionalProperties: false,
      },
    });
    const f = await fixture(manifest);
    const key = f.addKey();
    approve(f, key.id, paper2AgentManifestHash(manifest));
    const input = { point: [5, "ref"] };
    const result = { label: ["ref", 5] };
    vi.spyOn(money, "executePaper2AgentCall").mockResolvedValueOnce(signedCall(manifest, input, result));
    const client = await f.connect(key.raw);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([paper2AgentToolName(manifest)]);
    const response = await client.callTool({ name: paper2AgentToolName(manifest), arguments: input });
    expect(response.structuredContent).toEqual(result);
    expect(response.isError).not.toBe(true);
    verifyPaper2AgentReceipt({
      manifest, input, result: response.structuredContent as JsonObject,
      receipt: vector(response).receipt as Receipt,
      signature: String(vector(response).receipt_signature), publicKeyHex: String(vector(response).pub_key_hex),
      supplierPkh: SUPPLIER.pubKeyHash, escrowRef: String(vector(response).escrow_ref),
    });
  });

  it("omits ambiguous tool names without removing unrelated verified tools", async () => {
    const f = await fixture();
    const metadata = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < 2; index++) {
      const manifest = parsePaper2AgentManifest({ ...MANIFEST, name: `collision_${index}` });
      const ref = { txHash: (index + 1).toString(16).padStart(64, "0"), index: 0 };
      const advert = { ...f.advert, model: paper2AgentModel(manifest), endpoint_url: `https://collision-${index}.test` };
      f.chain.seed({ ref, address: loadBlueprint().advertScriptAddress(0), lovelace: 2_000_000n, assets: {}, datumHex: encodeAdvertDatum(advert), scriptRef: null });
      const capability = {
        ...f.capability, model: advert.model, advert_ref: `${ref.txHash}#0`,
        paper2agent: { manifest, manifest_hash: paper2AgentManifestHash(manifest) },
      };
      metadata.set(`${advert.endpoint_url}/capability`, capability);
      f.rows.push({ ...capability, utxo_ref: `${ref.txHash}#0`, advert_status: "Active", status: "free" });
    }
    const fetch = f.fetchFn.getMockImplementation()!;
    f.fetchFn.mockImplementation(async (url, init) => metadata.has(String(url))
      ? new Response(JSON.stringify(metadata.get(String(url))), { headers: { "content-type": "application/json" } })
      : fetch(url, init));
    const toolName = sharedTools.paper2AgentToolName;
    vi.spyOn(sharedTools, "paper2AgentToolName").mockImplementation((manifest) =>
      manifest.name.startsWith("collision_") ? "colliding_short_name" : toolName(manifest));
    const client = await f.connect(f.addKey().raw);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([TOOL]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("finds an own job after a lost MCP response without exposing other keys or spending again", async () => {
    const f = await fixture();
    const owner = f.addKey();
    const stranger = f.addKey();
    const ids = [randomUUID(), randomUUID()];
    for (const [index, key] of [owner, stranger].entries()) {
      approve(f, key.id);
      f.store.insertOneShotJob({
        id: ids[index]!, key_id: key.id, owner_id: "test-owner", model: paper2AgentModel(MANIFEST), created_at: Date.now(),
      }, 64, () => f.store.paper2agent.reserve(ids[index]!, key.id, HASH));
      f.store.paper2agent.update(ids[index]!, { financial_status: "unknown" });
    }
    money.revokePaper2Agent(f.store, owner.id);
    const path = `${f.base}/v1/paper2agent/jobs`;
    expect((await fetch(path)).status).toBe(401);
    const headers = { authorization: `Bearer ${owner.raw}` };
    const response = await fetch(path, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.json();
    expect(page.jobs.map((job: { job_id: string }) => job.job_id)).toEqual([ids[0]]);
    expect(page.jobs[0].financial.status).toBe("unknown");
    const after = await fetch(`${path}?cursor=${ids[0]}`, { headers });
    expect(await after.json()).toEqual({ jobs: [], next_cursor: null });
    const foreign = await fetch(`${path}?cursor=${ids[1]}`, { headers });
    const missing = await fetch(`${path}?cursor=missing`, { headers });
    expect(foreign.ok).toBe(false);
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(f.submit).not.toHaveBeenCalled();
  });
});

describe("operator approval CLI limits", () => {
  const base = ["approve", "--key-id", "operator-selected-id", "--manifest-hash", HASH, "--supplier-pkh", SUPPLIER.pubKeyHash];
  it("requires both money limits and preserves integers above Number precision", () => {
    expect(() => parseApprovalCommand(base)).toThrow();
    expect(() => parseApprovalCommand([...base, "--max-price-lovelace", "1000000"])).toThrow();
    const command = parseApprovalCommand([...base, "--max-price-lovelace", "1000000", "--max-total-spend-lovelace", "9007199254740993"]);
    if (command.action !== "approve") throw new Error("wrong command");
    expect(command.input.maxTotalSpendLovelace).toBe(9007199254740993n);
  });
  it("rejects money coercion, unsafe call counts, raw API keys, and revoke escalation flags", () => {
    for (const amount of ["-1", "1e6", "1.5"]) {
      expect(() => parseApprovalCommand([...base, "--max-price-lovelace", amount, "--max-total-spend-lovelace", "10000000"])).toThrow();
    }
    expect(() => parseApprovalCommand([...base, "--max-price-lovelace", "0", "--max-total-spend-lovelace", "0"])).toThrow();
    expect(() => parseApprovalCommand([...base, "--max-price-lovelace", "1", "--max-total-spend-lovelace", "2", "--max-calls", "9007199254740993"])).toThrow();
    expect(() => parseApprovalCommand(["revoke", "--key-id", "vk_test_secret"])).toThrow();
    expect(() => parseApprovalCommand(["revoke", "--key-id", "id", "--max-calls", "100"])).toThrow();
  });
});
