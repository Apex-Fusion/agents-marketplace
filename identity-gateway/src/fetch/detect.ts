// Protocol detection at a record's endpoint (Part 2 Section 8.5), as a background job:
// 1. A2A: <endpoint origin>/.well-known/agent-card.json returns a valid agent card (A2A
//    specification v1.0, https://a2a-protocol.org/latest/specification/ Sections 4.4 and 8; the
//    v0.3 card form with `url` and `protocolVersion` is accepted too) that declares an interface on
//    the endpoint's origin.
// 2. MCP: the endpoint answers an MCP request. Current MCP (revision 2026-07-28,
//    https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) has no `initialize`
//    handshake, so the job first sends the modern `server/discover` request; a server that does not
//    answer it as a modern server gets the `initialize` request of revision 2025-11-25, as Part 2
//    names it (the dual-era client rule of the 2026-07-28 Streamable HTTP transport).
// 3. Web: neither check succeeds, and a GET of the endpoint answers 2xx.
// The endpoint is reachable when one of these checks succeeds. A connection-level failure ends the
// detection at once: the other checks go to the same host.
//
// Detection keeps only small details (DETECTION_LIMITS): the renderings serve and sign them again
// for each request, so their size bounds the work of a request (Part 1 Section 9). It keeps the
// first interfaces, modes and versions in answer order and leaves out an item that is too long; a
// card with no interface or no mode left is not a valid card here.

import { formatTime } from "../resolve/time.js";
import type { VectorFetched } from "../resolve/metadata.js";
import { hostUnreachable, type FetchResult, type SafeFetcher } from "./fetcher.js";

export type Protocol = "a2a" | "mcp" | "web";

export interface A2AInterface {
  readonly url: string;
  readonly protocolBinding: string;
  readonly protocolVersion: string;
}

export interface A2ADetails {
  /** The card's interfaces on the endpoint's origin, in card order (at most DETECTION_LIMITS.interfaces). */
  readonly interfaces: readonly A2AInterface[];
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
}

/** The most that detection keeps of an answer. Sizes are UTF-8 bytes. */
export const DETECTION_LIMITS = {
  /** Interfaces on the endpoint's origin. */
  interfaces: 8,
  /** Size of an interface URL. */
  urlBytes: 512,
  /** Size of a protocol binding, a protocol version and an MCP protocol version. */
  nameBytes: 64,
  /** Default input modes, and default output modes. */
  modes: 16,
  /** Size of a mode: a media type has a type and a subtype name of at most 127 characters each (RFC 6838 Section 4.2). */
  modeBytes: 255,
  /** MCP protocol versions. */
  versions: 16,
} as const;

const fits = (text: string, maxBytes: number): boolean => Buffer.byteLength(text, "utf8") <= maxBytes;
/** The first `max` items that fit `maxBytes`. */
const kept = (items: readonly string[], max: number, maxBytes: number): string[] => items.filter((s) => fits(s, maxBytes)).slice(0, max);

export interface Detection {
  /** The endpoint (record text) that the detection checked. */
  readonly endpoint: string;
  /** POSIX milliseconds. */
  readonly checkedAt: number;
  /** Null when no check succeeded: the endpoint is not reachable. */
  readonly protocol: Protocol | null;
  /** Why no check succeeded. */
  readonly failure: string | null;
  /** The fetch whose answer gave the protocol. */
  readonly fetched: VectorFetched | null;
  readonly a2a: A2ADetails | null;
  /** MCP protocol versions that the endpoint named. */
  readonly mcpVersions: readonly string[];
}

export const MCP_MODERN_VERSION = "2026-07-28";
export const MCP_LEGACY_VERSION = "2025-11-25";
const CLIENT_INFO = { name: "vector-identity-gateway", version: "1.0.0" };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function parseJson(bytes: Uint8Array): Json | undefined {
  try {
    return JSON.parse(UTF8.decode(bytes)) as Json;
  } catch {
    return undefined;
  }
}

export const fetchedRecord = (result: FetchResult): VectorFetched => ({ url: result.url, fetchedAt: formatTime(result.fetchedAt), sha256: result.sha256 });

function cardInterfaces(card: JsonObject): A2AInterface[] | null {
  if (Array.isArray(card.supportedInterfaces)) {
    const list: A2AInterface[] = [];
    for (const i of card.supportedInterfaces) {
      if (!isObject(i) || !isText(i.url) || !isText(i.protocolBinding) || !isText(i.protocolVersion)) return null;
      list.push({ url: i.url, protocolBinding: i.protocolBinding, protocolVersion: i.protocolVersion });
    }
    return list.length ? list : null;
  }
  // A2A v0.3: the main interface in `url` (binding `preferredTransport`, default JSONRPC), more in `additionalInterfaces`.
  if (!isText(card.url) || !isText(card.protocolVersion)) return null;
  const version = card.protocolVersion;
  const list: A2AInterface[] = [{ url: card.url, protocolBinding: isText(card.preferredTransport) ? card.preferredTransport : "JSONRPC", protocolVersion: version }];
  for (const i of Array.isArray(card.additionalInterfaces) ? card.additionalInterfaces : []) {
    if (!isObject(i) || !isText(i.url) || !isText(i.transport)) return null;
    list.push({ url: i.url, protocolBinding: i.transport, protocolVersion: version });
  }
  return list;
}

const sameOrigin = (url: string, origin: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.origin === origin;
  } catch {
    return false;
  }
};

/** A valid agent card with at least one interface on `origin`; null otherwise. Only what DETECTION_LIMITS allows is kept. */
export function a2aDetails(value: Json | undefined, origin: string): A2ADetails | null {
  if (!isObject(value)) return null;
  if (!isText(value.name) || typeof value.description !== "string" || typeof value.version !== "string" || !isObject(value.capabilities)) return null;
  if (!isTextList(value.defaultInputModes) || !value.defaultInputModes.length || !isTextList(value.defaultOutputModes) || !value.defaultOutputModes.length) return null;
  if (!Array.isArray(value.skills) || !value.skills.every((s) => isObject(s) && isText(s.id) && isText(s.name))) return null;
  const all = cardInterfaces(value);
  if (!all) return null;
  const { interfaces: maxInterfaces, urlBytes, nameBytes, modes, modeBytes } = DETECTION_LIMITS;
  const interfaces: A2AInterface[] = [];
  for (const i of all) {
    if (interfaces.length === maxInterfaces) break;
    if (fits(i.url, urlBytes) && fits(i.protocolBinding, nameBytes) && fits(i.protocolVersion, nameBytes) && sameOrigin(i.url, origin)) interfaces.push(i);
  }
  const defaultInputModes = kept(value.defaultInputModes, modes, modeBytes);
  const defaultOutputModes = kept(value.defaultOutputModes, modes, modeBytes);
  if (!interfaces.length || !defaultInputModes.length || !defaultOutputModes.length) return null;
  return { interfaces, defaultInputModes, defaultOutputModes };
}

/** The JSON-RPC response with `id` from a JSON or an SSE (text/event-stream) body. */
export function rpcResponse(result: FetchResult, id: number): JsonObject | null {
  const type = (result.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const matches = (v: Json | undefined): v is JsonObject => isObject(v) && v.jsonrpc === "2.0" && v.id === id && ("result" in v || "error" in v);
  if (type === "application/json") {
    const value = parseJson(result.body);
    return matches(value) ? value : null;
  }
  if (type !== "text/event-stream") return null;
  let text: string;
  try {
    text = UTF8.decode(result.body);
  } catch {
    return null;
  }
  // https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
  let data: string[] = [];
  for (const line of [...text.split(/\r\n|\r|\n/), ""]) {
    if (line === "") {
      if (data.length) {
        const value = parseJson(new TextEncoder().encode(data.join("\n")));
        if (matches(value)) return value;
      }
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(line[5] === " " ? 6 : 5));
    }
  }
  return null;
}

const RPC_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** Modern MCP: a DiscoverResult, or an UnsupportedProtocolVersionError that lists the supported versions. */
function modernVersions(response: JsonObject | null): string[] | null {
  if (!response) return null;
  const { result, error } = response;
  let named: string[] | null = null;
  if (isObject(result) && isTextList(result.supportedVersions) && isObject(result.capabilities)) named = result.supportedVersions;
  else if (isObject(error) && error.code === -32022 && isObject(error.data) && isTextList(error.data.supported)) named = error.data.supported;
  const versions = named && kept(named, DETECTION_LIMITS.versions, DETECTION_LIMITS.nameBytes);
  return versions?.length ? versions : null;
}

/** Legacy MCP: an InitializeResult. */
function legacyVersion(response: JsonObject | null): string | null {
  const result = response?.result;
  if (!isObject(result) || !isText(result.protocolVersion) || !fits(result.protocolVersion, DETECTION_LIMITS.nameBytes) || !isObject(result.capabilities)) return null;
  const info = result.serverInfo;
  return isObject(info) && typeof info.name === "string" && typeof info.version === "string" ? result.protocolVersion : null;
}

/** Runs the checks in order. Never throws. */
export async function detectProtocol(fetcher: SafeFetcher, endpoint: string, now: number): Promise<Detection> {
  const base = { endpoint, checkedAt: now, a2a: null, mcpVersions: [] as string[] };
  const failed = (failure: string): Detection => ({ ...base, protocol: null, failure, fetched: null });
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return failed("the endpoint is not a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) return failed("the endpoint is not an https URL without credentials");

  const probes: Array<() => Promise<Detection | null>> = [
    async () => {
      const result = await fetcher.fetch(`${url.origin}/.well-known/agent-card.json`, { headers: { accept: "application/json" } });
      const a2a = result.status === 200 ? a2aDetails(parseJson(result.body), url.origin) : null;
      return a2a ? { ...base, protocol: "a2a", failure: null, fetched: fetchedRecord(result), a2a } : null;
    },
    async () => {
      const result = await fetcher.fetch(endpoint, {
        method: "POST",
        headers: { ...RPC_HEADERS, "mcp-protocol-version": MCP_MODERN_VERSION, "mcp-method": "server/discover" },
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION,
                "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        ),
      });
      const versions = modernVersions(rpcResponse(result, 1));
      return versions ? { ...base, protocol: "mcp", failure: null, fetched: fetchedRecord(result), mcpVersions: versions } : null;
    },
    async () => {
      const result = await fetcher.fetch(endpoint, {
        method: "POST",
        headers: RPC_HEADERS,
        body: new TextEncoder().encode(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }),
        ),
      });
      const version = legacyVersion(rpcResponse(result, 1));
      return version ? { ...base, protocol: "mcp", failure: null, fetched: fetchedRecord(result), mcpVersions: [version] } : null;
    },
    async () => {
      const result = await fetcher.fetch(endpoint, { headers: { accept: "text/html, application/json;q=0.9, */*;q=0.8" } });
      if (result.status >= 200 && result.status < 300) return { ...base, protocol: "web", failure: null, fetched: fetchedRecord(result) };
      // Not a fetch failure: the host answered, so the loop ends after this last check.
      throw new Error(`the endpoint answered HTTP ${result.status}`);
    },
  ];

  let failure = "no check succeeded";
  for (const probe of probes) {
    try {
      const found = await probe();
      if (found) return found;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      if (hostUnreachable(e)) break;
    }
  }
  return failed(failure);
}
