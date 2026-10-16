import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import {
  PAPER2AGENT_CAPABILITY_ID,
  paper2AgentManifestHash,
  paper2AgentModel,
  paper2AgentToolName,
  parsePaper2AgentManifest,
  type JsonObject,
  type Paper2AgentManifest,
} from "@marketplace/shared/paper2agent";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { GatewayStore } from "../src/db/store.js";
import type { SdkRegistry } from "../src/sdk/registry.js";
import { deriveWalletKey } from "../src/wallet.js";
import { recoverOneShotJobs } from "../src/oneShotJobs.js";
import { ToolCallGate } from "../src/paper2agent/service.js";
import type { GatewayDeps } from "../src/deps.js";
import * as sharedTools from "@marketplace/shared/paper2agent";

const MASTER = "ab".repeat(32);
const TOKEN = "t".repeat(40);
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
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Free MCP must never open a key wallet. */
const noWallets = {
  getContext(): never {
    throw new Error("free MCP must not open a wallet context");
  },
} as unknown as SdkRegistry;

type CallHook = (body: { manifest_hash: string; input: JsonObject }, init: RequestInit) => Response | Promise<Response>;

async function fixture(options: { manifest?: Paper2AgentManifest; env?: Record<string, string> } = {}) {
  const manifest = options.manifest ?? MANIFEST;
  const dbDir = mkdtempSync(join(tmpdir(), "gw-p2a-mcp-"));
  const store = new GatewayStore(dbDir);
  const config = loadConfig({
    GATEWAY_MASTER_KEY: MASTER, GATEWAY_DB_DIR: dbDir,
    LIVE_CHAIN: "1", INDEXER_URL: "https://indexer.test", OGMIOS_URL: "http://ogmios.test",
    PAPER2AGENT_TOOL_CALL_TOKEN: TOKEN, PAPER2AGENT_PUBLISHER_PUBLIC_URL: "https://publisher.test/p2a/",
    ...options.env,
  });
  const chain = new MockChainProvider();
  const submit = vi.spyOn(chain, "submitTx");
  const advert: AdvertDatum = {
    supplier_pkh: SUPPLIER.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID,
    model: paper2AgentModel(manifest), max_output_tokens: 0, max_processing_ms: 180_000,
    price_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n, supplier_bond_lovelace: 1_000_000n,
    endpoint_url: "https://publisher.test/p2a/tools/slot-1", detail_uri: "", detail_hash: "b".repeat(64),
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
  const rows: Array<Record<string, unknown>> = [{
    ...capability, utxo_ref: `${REF.txHash}#0`, advert_status: "Active", status: "free",
  }];
  const hooks: { call: CallHook; suppliers?: () => Promise<void> } = {
    call: (body) => json({ manifest_hash: body.manifest_hash, result: RESULT, wallclock_ms: 7 }),
  };
  const posts: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    if (init?.method === "POST") {
      if (!target.endsWith("/v1/paper2agent/call")) throw new Error(`unexpected POST ${target}`);
      posts.push({ url: target, init });
      return hooks.call(JSON.parse(String(init.body)), init);
    }
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (target.includes("/suppliers")) {
      await hooks.suppliers?.();
      return json(rows);
    }
    return json(target.endsWith("/capability") ? capability : []);
  });
  const deps: GatewayDeps = {
    config, store, chain: chain as unknown as GatewayDeps["chain"], fetchFn, registry: noWallets,
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
  /** `ip` sets X-Forwarded-For; the gateway trusts its proxy for req.ip. */
  async function connect(options: { ip?: string; modern?: boolean; headers?: Record<string, string> } = {}) {
    const client = new Client({ name: "paper2agent-http-test", version: "1.0.0" }, {
      ...(options.modern ? { versionNegotiation: { mode: "auto" as const } } : {}),
    });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { ...(options.ip ? { "x-forwarded-for": options.ip } : {}), ...options.headers } },
    }));
    return client;
  }
  const suppliersReads = () => fetchFn.mock.calls.filter(([url]) => String(url).includes("/suppliers")).length;
  return { deps, store, chain, submit, rows, capability, advert, fetchFn, hooks, posts, connect, base, suppliersReads };
}

function vector(result: CallToolResult): Record<string, unknown> {
  return result._meta?.vector as Record<string, unknown>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Paper2Agent public MCP HTTP", () => {
  it("serves discovery without an API key or a wallet and keeps other routes authenticated", async () => {
    const f = await fixture();
    const anonymous = await f.connect();
    expect((await anonymous.listTools()).tools.map((tool) => tool.name)).toEqual([TOOL]);
    // A stale or invalid bearer header is ignored, not rejected.
    const stale = await f.connect({ headers: { authorization: "Bearer invalid-key" } });
    expect((await stale.listTools()).tools).toHaveLength(1);
    expect((await fetch(`${f.base}/mcp`, { method: "OPTIONS" })).status).toBe(204);
    expect((await fetch(`${f.base}/openai/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(401);
    expect((await fetch(`${f.base}/v1/paper2agent/jobs`)).status).toBe(404);
    expect(f.store.listOneShotJobs()).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("rejects an unapproved browser Origin before discovery", async () => {
    const f = await fixture();
    const response = await fetch(`${f.base}/mcp`, {
      method: "POST",
      headers: { origin: "https://attacker.test", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("mcp_origin_denied");
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("limits all /mcp requests per client IP", async () => {
    const f = await fixture({ env: { MCP_IP_RATE_MAX: "3" } });
    const post = (ip: string) => fetch(`${f.base}/mcp`, {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    for (let index = 0; index < 3; index++) expect((await post("198.51.100.7")).status).not.toBe(429);
    const limited = await post("198.51.100.7");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await limited.json()).error.code).toBe("rate_limit_exceeded");
    expect((await post("198.51.100.8")).status).not.toBe(429);
  });

  it.each([false, true])("discovers real schemas through official HTTP in modern=%s mode", async (modern) => {
    const f = await fixture();
    const listing = await (await f.connect({ modern })).listTools();
    expect(listing.tools).toHaveLength(1);
    expect(listing.tools[0]).toMatchObject({
      name: TOOL, inputSchema: MANIFEST.input_schema, outputSchema: MANIFEST.output_schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    });
  });

  it("keeps busy and not yet polled tools listed, but not offline ones", async () => {
    for (const [status, listed] of [["working", 1], ["unknown", 1], ["offline", 0]] as const) {
      const f = await fixture();
      f.rows[0]!.status = status;
      expect((await (await f.connect()).listTools()).tools).toHaveLength(listed);
    }
  });

  it("shares one cached discovery between requests and refreshes it after the TTL", async () => {
    const f = await fixture();
    const gate = deferred();
    f.hooks.suppliers = () => gate.promise;
    const [first, second] = [await f.connect({ ip: "203.0.113.1" }), await f.connect({ ip: "203.0.113.2" })];
    const listings = Promise.all([first.listTools(), second.listTools()]);
    await vi.waitFor(() => expect(f.suppliersReads()).toBe(1));
    gate.resolve();
    expect((await listings).map((listing) => listing.tools.length)).toEqual([1, 1]);
    expect((await first.callTool({ name: TOOL, arguments: INPUT })).isError).not.toBe(true);
    expect(f.suppliersReads()).toBe(1);

    // A removed advert stays cached until the TTL ends, then leaves listing and calls.
    f.rows.splice(0);
    expect((await first.listTools()).tools).toHaveLength(1);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + f.deps.config.mcpCatalogTtlMs);
    expect(vector(await first.callTool({ name: TOOL, arguments: INPUT })).code).toBe("paper2agent_tool_not_found");
    expect((await first.listTools()).tools).toEqual([]);
    expect(f.suppliersReads()).toBe(2);
  });

  it("calls the tool for free with the route token and returns only the result and small metadata", async () => {
    const f = await fixture();
    const client = await f.connect();
    await client.listTools();
    const response = await client.callTool({ name: TOOL, arguments: INPUT });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(RESULT);
    expect(response.content).toEqual([{ type: "text", text: JSON.stringify(RESULT) }]);
    expect(vector(response)).toEqual({ manifest_hash: HASH, supplier_pkh: SUPPLIER.pubKeyHash, wallclock_ms: 7 });
    expect(f.posts).toHaveLength(1);
    const { url, init } = f.posts[0]!;
    expect(url).toBe("https://publisher.test/p2a/tools/slot-1/v1/paper2agent/call");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.has("x-escrow-ref")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ manifest_hash: HASH, input: INPUT });
    expect(init.redirect).toBe("error");
    // No escrow, journal row, or chain transaction.
    expect(f.store.listOneShotJobs()).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line)).filter((line) => line.includes("paper2agent_call"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ evt: "paper2agent_call", tool: TOOL, status: "ok" });
    expect(lines[0]).not.toContain("samples");
  });

  it("rejects unknown names and invalid arguments before the supplier", async () => {
    const f = await fixture();
    const client = await f.connect();
    expect(vector(await client.callTool({ name: "invented", arguments: INPUT })).code).toBe("paper2agent_tool_not_found");
    // request() avoids client-side schema validation, so this checks the server.
    for (const arguments_ of [{ samples: ["2"] }, { samples: [2], max_calls: 999 }, { samples: [2], api_key: "do-not-forward" }]) {
      const denied = await client.request({ method: "tools/call", params: { name: TOOL, arguments: arguments_ } });
      expect(vector(denied as CallToolResult).code).toBe("paper2agent_invalid_input");
    }
    expect(f.posts).toEqual([]);
  });

  it.each([
    ["output outside the schema", { manifest_hash: HASH, result: { count: -1 }, wallclock_ms: 1 }, "paper2agent_invalid_output"],
    ["a different manifest", { manifest_hash: "f".repeat(64), result: RESULT, wallclock_ms: 1 }, "paper2agent_supplier_error"],
    ["no wallclock", { manifest_hash: HASH, result: RESULT }, "paper2agent_supplier_error"],
  ])("rejects a supplier result with %s", async (_label, body, code) => {
    const f = await fixture();
    f.hooks.call = () => json(body);
    const response = await (await f.connect()).request({ method: "tools/call", params: { name: TOOL, arguments: INPUT } }) as CallToolResult;
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(vector(response).code).toBe(code);
  });

  it.each([
    [400, "invalid_tool_request", "paper2agent_invalid_input"],
    [401, "unauthorized", "paper2agent_calls_unavailable"],
    [404, "not_found", "paper2agent_tool_unavailable"],
    [409, "supplier_busy", "paper2agent_tool_busy"],
    [413, "request_too_large", "paper2agent_input_too_large"],
    [502, "tool_execution_failed", "paper2agent_tool_failed"],
    [503, "supplier_draining", "paper2agent_tool_unavailable"],
    [503, "supplier_unavailable", "paper2agent_tool_unavailable"],
  ])("maps HTTP %i %s to %s", async (status, reason, code) => {
    const f = await fixture();
    f.hooks.call = () => json({ reason, message: reason }, status);
    const response = await (await f.connect()).callTool({ name: TOOL, arguments: INPUT });
    expect(response.isError).toBe(true);
    expect(vector(response)).toEqual({ code });
    expect(f.posts).toHaveLength(1);
  });

  it("maps an unreachable supplier and an HTML proxy error without a retry", async () => {
    const f = await fixture({ env: { MCP_CALL_IP_RATE_MAX: "10" } });
    const client = await f.connect();
    f.hooks.call = () => { throw new TypeError("fetch failed"); };
    expect(vector(await client.callTool({ name: TOOL, arguments: INPUT })).code).toBe("paper2agent_supplier_unavailable");
    f.hooks.call = () => new Response("<html>bad gateway</html>", { status: 502 });
    expect(vector(await client.callTool({ name: TOOL, arguments: INPUT })).code).toBe("paper2agent_supplier_error");
    expect(f.posts).toHaveLength(2);
  });

  it("answers a clear tool error when the gateway has no call token", async () => {
    const f = await fixture({ env: { PAPER2AGENT_TOOL_CALL_TOKEN: "" } });
    const client = await f.connect();
    expect((await client.listTools()).tools).toHaveLength(1);
    const response = await client.callTool({ name: TOOL, arguments: INPUT });
    expect(response.isError).toBe(true);
    expect(vector(response).code).toBe("paper2agent_calls_unavailable");
    expect(response.content).toEqual([{ type: "text", text: "Free tool calls are not configured on this gateway." }]);
    expect(f.posts).toEqual([]);
  });

  it("limits tools/call per client IP by rate and by calls in flight", async () => {
    const f = await fixture({ env: { MCP_CALL_IP_RATE_MAX: "2" } });
    const client = await f.connect({ ip: "203.0.113.10" });
    const gate = deferred();
    f.hooks.call = async (body) => {
      await gate.promise;
      return json({ manifest_hash: body.manifest_hash, result: RESULT, wallclock_ms: 1 });
    };
    const running = client.callTool({ name: TOOL, arguments: INPUT });
    await vi.waitFor(() => expect(f.posts).toHaveLength(1));
    expect(vector(await client.callTool({ name: TOOL, arguments: INPUT })).code).toBe("paper2agent_client_busy");
    gate.resolve();
    expect((await running).structuredContent).toEqual(RESULT);
    const limited = await client.callTool({ name: TOOL, arguments: INPUT });
    expect(vector(limited).code).toBe("rate_limit_exceeded");
    expect(f.posts).toHaveLength(1);
    const other = await f.connect({ ip: "203.0.113.11" });
    expect((await other.callTool({ name: TOOL, arguments: INPUT })).structuredContent).toEqual(RESULT);
  });

  it("runs one call per supplier at a time, queues the next, and reports busy after the queue wait", async () => {
    const f = await fixture();
    let active = 0;
    let maximum = 0;
    const gates: Array<() => void> = [];
    f.hooks.call = async (body) => {
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active--;
      return json({ manifest_hash: body.manifest_hash, result: RESULT, wallclock_ms: 1 });
    };
    const [first, second, third] = await Promise.all(["203.0.113.21", "203.0.113.22", "203.0.113.23"]
      .map((ip) => f.connect({ ip })));
    const acquire = vi.spyOn(ToolCallGate.prototype, "acquire");
    const running = first!.callTool({ name: TOOL, arguments: INPUT });
    await vi.waitFor(() => expect(f.posts).toHaveLength(1));
    const queued = second!.callTool({ name: TOOL, arguments: INPUT });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    expect(f.posts).toHaveLength(1);
    gates.shift()!();
    expect((await running).structuredContent).toEqual(RESULT);
    await vi.waitFor(() => expect(f.posts).toHaveLength(2));

    // The shortest real queue wait; the queue timer runs inside the HTTP server.
    f.deps.config.mcpCallQueueTimeoutMs = 1;
    const busy = await third!.callTool({ name: TOOL, arguments: INPUT });
    expect(vector(busy).code).toBe("paper2agent_tool_busy");
    expect(busy.content).toEqual([{ type: "text", text: "The tool is busy with other calls. Try again in a few minutes." }]);
    gates.shift()!();
    expect((await queued).structuredContent).toEqual(RESULT);
    expect(f.posts).toHaveLength(2);
    expect(maximum).toBe(1);
  });

  it("executes tuple tools without changing the manifest", async () => {
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
    const f = await fixture({ manifest });
    const input = { point: [5, "ref"] };
    const result = { label: ["ref", 5] };
    f.hooks.call = (body) => json({ manifest_hash: body.manifest_hash, result, wallclock_ms: 2 });
    const client = await f.connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([paper2AgentToolName(manifest)]);
    const response = await client.callTool({ name: paper2AgentToolName(manifest), arguments: input });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(result);
    expect(JSON.parse(String(f.posts[0]!.init.body))).toEqual({ manifest_hash: paper2AgentManifestHash(manifest), input });
  });

  it("omits ambiguous tool names without removing unrelated verified tools", async () => {
    const f = await fixture();
    const metadata = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < 2; index++) {
      const manifest = parsePaper2AgentManifest({ ...MANIFEST, name: `collision_${index}` });
      const ref = { txHash: (index + 1).toString(16).padStart(64, "0"), index: 0 };
      const advert = { ...f.advert, model: paper2AgentModel(manifest), endpoint_url: `https://publisher.test/p2a/tools/collision-${index}` };
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
      ? json(metadata.get(String(url)))
      : fetch(url, init));
    const toolName = sharedTools.paper2AgentToolName;
    vi.spyOn(sharedTools, "paper2AgentToolName").mockImplementation((manifest) =>
      manifest.name.startsWith("collision_") ? "colliding_short_name" : toolName(manifest));
    const client = await f.connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([TOOL]);
  });

  it("never lists or calls a tool whose advert endpoint is outside the publisher URL", async () => {
    const f = await fixture();
    const metadata = new Map<string, Record<string, unknown>>();
    const outside = ["https://attacker.test/p2a/tools/slot-2", "https://publisher.test/p2a/tools/../../evil"];
    outside.forEach((endpoint, index) => {
      const manifest = parsePaper2AgentManifest({ ...MANIFEST, name: `outside_${index}` });
      const ref = { txHash: (index + 1).toString(16).padStart(64, "0"), index: 0 };
      const advert = { ...f.advert, model: paper2AgentModel(manifest), endpoint_url: endpoint };
      f.chain.seed({ ref, address: loadBlueprint().advertScriptAddress(0), lovelace: 2_000_000n, assets: {}, datumHex: encodeAdvertDatum(advert), scriptRef: null });
      const capability = {
        ...f.capability, model: advert.model, endpoint_url: endpoint, advert_ref: `${ref.txHash}#0`,
        paper2agent: { manifest, manifest_hash: paper2AgentManifestHash(manifest) },
      };
      metadata.set(`${new URL(endpoint).href}/capability`, capability);
      f.rows.push({ ...capability, utxo_ref: `${ref.txHash}#0`, advert_status: "Active", status: "free" });
    });
    const fetch = f.fetchFn.getMockImplementation()!;
    f.fetchFn.mockImplementation(async (url, init) => metadata.has(new URL(String(url)).href)
      ? json(metadata.get(new URL(String(url)).href))
      : fetch(url, init));
    const client = await f.connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([TOOL]);
    const response = await client.callTool({ name: paper2AgentToolName(parsePaper2AgentManifest({ ...MANIFEST, name: "outside_0" })), arguments: INPUT });
    expect(vector(response).code).toBe("paper2agent_tool_not_found");
    expect(f.posts).toEqual([]);
  });

  it("refuses a tool-call token without the publisher URL that bounds where it goes", () => {
    expect(() => loadConfig({
      GATEWAY_MASTER_KEY: MASTER, LIVE_CHAIN: "1", INDEXER_URL: "https://indexer.test", OGMIOS_URL: "http://ogmios.test",
      PAPER2AGENT_TOOL_CALL_TOKEN: TOKEN,
    })).toThrow(/PAPER2AGENT_PUBLISHER_PUBLIC_URL is required/);
  });
});

describe("free tool-call gate", () => {
  it("allows one call per endpoint, caps the total, and grants waiters in order", async () => {
    const gate = new ToolCallGate(2);
    const a = await gate.acquire("a", 1000);
    const b = await gate.acquire("b", 1000);
    expect(a && b).toBeTruthy();
    const order: string[] = [];
    const c = gate.acquire("c", 1000).then((release) => { order.push("c"); return release; });
    const a2 = gate.acquire("a", 1000).then((release) => { order.push("a2"); return release; });
    await Promise.resolve();
    expect(order).toEqual([]);
    a!();
    a!();
    const releaseC = await c;
    expect(order).toEqual(["c"]);
    b!();
    const releaseA2 = await a2;
    expect(order).toEqual(["c", "a2"]);
    releaseC!();
    releaseA2!();
    expect(await gate.acquire("a", 1000)).toBeTypeOf("function");
  });

  it("gives up after the timeout, on abort, and when the queue is full", async () => {
    vi.useFakeTimers();
    const gate = new ToolCallGate(1, 1);
    const held = await gate.acquire("a", 1000);
    const timedOut = gate.acquire("b", 20);
    vi.advanceTimersByTime(20);
    expect(await timedOut).toBeUndefined();
    const controller = new AbortController();
    const waiting = gate.acquire("b", 1000, controller.signal);
    expect(await gate.acquire("c", 1000)).toBeUndefined();
    controller.abort();
    expect(await waiting).toBeUndefined();
    held!();
    expect(await gate.acquire("b", 1000)).toBeTypeOf("function");
  });
});

describe("legacy paid Paper2Agent records", () => {
  it("keep their tables and do not break startup or one-shot recovery", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "gw-p2a-legacy-"));
    cleanups.push(async () => rmSync(dbDir, { recursive: true, force: true }));
    const first = new GatewayStore(dbDir);
    first["db"].exec(`CREATE TABLE paper2agent_approvals (key_id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL);
      CREATE TABLE paper2agent_calls (job_id TEXT PRIMARY KEY, key_id TEXT NOT NULL);
      INSERT INTO paper2agent_approvals VALUES ('legacy-key', '${HASH}');
      INSERT INTO paper2agent_calls VALUES ('legacy-job', 'legacy-key');`);
    expect(first.insertOneShotJob({
      id: "legacy-job", key_id: "legacy-key", owner_id: "dead-owner",
      model: paper2AgentModel(MANIFEST), created_at: Date.now() - 120_000,
    })).toBe(true);
    first["db"].close();

    const restarted = new GatewayStore(dbDir);
    cleanups.push(async () => restarted["db"].close());
    const chain = new MockChainProvider();
    const submit = vi.spyOn(chain, "submitTx");
    await recoverOneShotJobs({
      config: loadConfig({
        GATEWAY_MASTER_KEY: MASTER, GATEWAY_DB_DIR: dbDir,
        LIVE_CHAIN: "1", INDEXER_URL: "https://indexer.test", OGMIOS_URL: "http://ogmios.test",
      }),
      store: restarted, chain: chain as unknown as GatewayDeps["chain"], registry: noWallets,
      fetchFn: vi.fn(async () => { throw new Error("no indexer read for an unfunded job"); }),
    });
    expect(restarted.getOneShotJob("legacy-job")).toMatchObject({ state: "failed", escrow_ref: null });
    expect(restarted["db"].prepare("SELECT COUNT(*) AS n FROM paper2agent_calls").get()).toEqual({ n: 1 });
    expect(submit).not.toHaveBeenCalled();
  });
});
