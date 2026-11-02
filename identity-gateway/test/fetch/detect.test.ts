// Protocol detection (Part 2 Section 8.5): A2A agent card, then MCP (modern server/discover, then
// legacy initialize), then web.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { MCP_LEGACY_VERSION, MCP_MODERN_VERSION, detectProtocol } from "../../src/fetch/detect.js";
import { formatTime } from "../../src/resolve/time.js";
import { FakeNet } from "./support.js";

const ENDPOINT = "https://agent.example.org/a2a/v1";
const CARD_URL = "https://agent.example.org/.well-known/agent-card.json";

const CARD_V1 = {
  name: "Route planner",
  description: "Plans routes.",
  version: "1.2.0",
  supportedInterfaces: [
    { url: "https://agent.example.org/a2a/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    { url: "https://elsewhere.example.net/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    { url: "https://agent.example.org/a2a/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["application/json"],
  skills: [{ id: "route", name: "Route", description: "Plans a route.", tags: ["maps"] }],
};

function network(): FakeNet {
  return new FakeNet().host("agent.example.org").host("elsewhere.example.net");
}

describe("A2A", () => {
  test("a valid agent card: the interfaces on the endpoint's origin, the modes, the fetch record", async () => {
    const net = network().json(CARD_URL, CARD_V1);
    const detection = await detectProtocol(net.fetcher(), ENDPOINT, net.clock.now());
    const body = JSON.stringify(CARD_V1);
    expect(detection).toEqual({
      endpoint: ENDPOINT,
      checkedAt: net.clock.now(),
      protocol: "a2a",
      failure: null,
      fetched: { url: CARD_URL, fetchedAt: formatTime(net.clock.now()), sha256: createHash("sha256").update(body).digest("hex") },
      a2a: {
        interfaces: [CARD_V1.supportedInterfaces[0], CARD_V1.supportedInterfaces[2]],
        defaultInputModes: ["text/plain", "application/json"],
        defaultOutputModes: ["application/json"],
      },
      mcpVersions: [],
    });
    expect(net.calls.map((c) => c.url)).toEqual([CARD_URL]);
  });

  test("an A2A v0.3 card (url, preferredTransport, additionalInterfaces)", async () => {
    const card = {
      name: "Old agent",
      description: "",
      version: "0.1",
      url: "https://agent.example.org/rpc",
      protocolVersion: "0.3.0",
      additionalInterfaces: [{ url: "https://agent.example.org/rest", transport: "HTTP+JSON" }],
      capabilities: {},
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
    };
    const net = network().json(CARD_URL, card);
    const detection = await detectProtocol(net.fetcher(), "https://agent.example.org/rpc", net.clock.now());
    expect(detection.protocol).toBe("a2a");
    expect(detection.a2a?.interfaces).toEqual([
      { url: "https://agent.example.org/rpc", protocolBinding: "JSONRPC", protocolVersion: "0.3.0" },
      { url: "https://agent.example.org/rest", protocolBinding: "HTTP+JSON", protocolVersion: "0.3.0" },
    ]);
  });

  test.each([
    ["only interfaces on another origin", { ...CARD_V1, supportedInterfaces: [CARD_V1.supportedInterfaces[1]] }],
    ["no skills", { ...CARD_V1, skills: undefined }],
    ["no default input modes", { ...CARD_V1, defaultInputModes: [] }],
    ["an interface without a protocol version", { ...CARD_V1, supportedInterfaces: [{ url: ENDPOINT, protocolBinding: "JSONRPC" }] }],
    ["not an object", ["card"]],
  ])("a card with %s is not A2A; detection goes on", async (_name, card) => {
    const net = network().json(CARD_URL, card).on(ENDPOINT, { status: 200, body: "<html></html>" });
    const detection = await detectProtocol(net.fetcher(), ENDPOINT, net.clock.now());
    expect(detection.protocol).toBe("web");
    expect(net.calls).toHaveLength(4);
  });
});

describe("MCP", () => {
  const MCP = "https://agent.example.org/mcp";

  test("modern: server/discover with the request headers and metadata of revision 2026-07-28", async () => {
    const net = network().on(
      MCP,
      { headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { supportedVersions: [MCP_MODERN_VERSION, MCP_LEGACY_VERSION], capabilities: { tools: {} } } }) },
      "POST",
    );
    const detection = await detectProtocol(net.fetcher(), MCP, net.clock.now());
    expect(detection).toMatchObject({ protocol: "mcp", mcpVersions: [MCP_MODERN_VERSION, MCP_LEGACY_VERSION], fetched: { url: MCP } });
    const discover = net.calls[1]!;
    expect(discover).toMatchObject({ method: "POST", url: MCP });
    expect(discover.headers).toMatchObject({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_MODERN_VERSION,
      "mcp-method": "server/discover",
    });
    expect(JSON.parse(discover.body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "vector-identity-gateway", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    // The card check and the discover request are a minute apart (one fetch per host each minute).
    expect(net.clock.sleeps).toEqual([60_000]);
  });

  test("modern: an UnsupportedProtocolVersionError names the supported versions", async () => {
    const error = { jsonrpc: "2.0", id: 1, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2027-01-01"], requested: MCP_MODERN_VERSION } } };
    const net = network().on(MCP, { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify(error) }, "POST");
    expect(await detectProtocol(net.fetcher(), MCP, net.clock.now())).toMatchObject({ protocol: "mcp", mcpVersions: ["2027-01-01"] });
  });

  test("legacy: a server that does not speak the modern revision gets initialize; the answer may be an SSE stream", async () => {
    const net = network();
    net.on(
      MCP,
      (request) => {
        if (request.headers["mcp-method"] === "server/discover") return { status: 400, headers: { "content-type": "text/plain" }, body: "Bad Request: no valid session ID" };
        const result = { protocolVersion: MCP_LEGACY_VERSION, capabilities: { tools: {} }, serverInfo: { name: "paper2agent", version: "1.4.0" } };
        return {
          headers: { "content-type": "text/event-stream" },
          body: `event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\r\n\r\n`,
        };
      },
      "POST",
    );
    const detection = await detectProtocol(net.fetcher(), MCP, net.clock.now());
    expect(detection).toMatchObject({ protocol: "mcp", mcpVersions: [MCP_LEGACY_VERSION] });
    expect(JSON.parse(net.calls[2]!.body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: MCP_LEGACY_VERSION, capabilities: {}, clientInfo: { name: "vector-identity-gateway", version: "1.0.0" } },
    });
    expect(net.calls[2]!.headers["mcp-protocol-version"]).toBeUndefined();
  });

  test("an initialize answer without serverInfo is not MCP", async () => {
    const net = network()
      .on(MCP, { headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } }) }, "POST")
      .on(MCP, { status: 200 });
    expect((await detectProtocol(net.fetcher(), MCP, net.clock.now())).protocol).toBe("web");
  });
});

describe("web and unreachable endpoints", () => {
  test("neither check succeeds and the endpoint answers 2xx: web, from the GET of the endpoint", async () => {
    const net = network().on(ENDPOINT, { status: 405 }, "POST").on(ENDPOINT, { status: 200, body: "hello" });
    const detection = await detectProtocol(net.fetcher(), ENDPOINT, net.clock.now());
    expect(detection).toMatchObject({ protocol: "web", failure: null, fetched: { url: ENDPOINT } });
    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${CARD_URL}`, `POST ${ENDPOINT}`, `POST ${ENDPOINT}`, `GET ${ENDPOINT}`]);
    expect(net.clock.sleeps).toEqual([60_000, 60_000, 60_000]);
  });

  test("no check succeeds and the endpoint answers 404: not reachable", async () => {
    const net = network();
    expect(await detectProtocol(net.fetcher(), ENDPOINT, net.clock.now())).toMatchObject({
      protocol: null,
      failure: "the endpoint answered HTTP 404",
      fetched: null,
      a2a: null,
    });
  });

  test("a connection-level failure ends the detection at once", async () => {
    const net = new FakeNet().host("agent.example.org", "192.168.1.20");
    const detection = await detectProtocol(net.fetcher(), ENDPOINT, net.clock.now());
    expect(detection).toMatchObject({ protocol: null, failure: "the host resolves to an address that is not public unicast" });
    expect(net.calls).toEqual([]);
    expect(net.lookups).toHaveLength(1);
  });

  test.each([
    ["http", "http://agent.example.org/"],
    ["credentials", "https://u:p@agent.example.org/"],
    ["not a URL", "agent at example dot org"],
  ])("an endpoint that is %s is not fetched", async (_name, endpoint) => {
    const net = network();
    expect((await detectProtocol(net.fetcher(), endpoint, net.clock.now())).protocol).toBeNull();
    expect(net.lookups).toEqual([]);
  });
});
