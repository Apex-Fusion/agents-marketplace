// Catalog renderings of Part 2 Section 8.5. They list only agents that meet the listing rule
// (Part 2 Section 8.4), and only those with a protocol card: an A2A agent through its agent card, an
// MCP agent through its server card. A web agent has neither card, so the catalog formats cannot
// describe it; its per-agent renderings stay available.

import { formatTime } from "../resolve/time.js";
import { agentUrl, fallbackName, reverseHost, type RenderedAgent } from "./agent.js";
import { serverJson } from "./documents.js";

export const A2A_CARD_TYPE = "application/a2a-agent-card+json";
export const MCP_CARD_TYPE = "application/mcp-server-card+json";

interface CardRef {
  readonly agent: RenderedAgent;
  readonly protocol: "a2a" | "mcp";
  readonly identifier: string;
  readonly type: string;
  readonly url: string;
}

/** `urn:air:<gateway host>:agent:<identifier>`: the gateway publishes these renderings under its own domain. */
function cardRefs(agents: readonly RenderedAgent[], baseUrl: string): CardRef[] {
  const host = new URL(baseUrl).hostname;
  return agents.flatMap((agent): CardRef[] => {
    const protocol = agent.facts.detection?.protocol;
    const identifier = `urn:air:${host}:agent:${agent.vectorId}`;
    if (protocol === "a2a") return [{ agent, protocol, identifier, type: A2A_CARD_TYPE, url: agentUrl(baseUrl, agent.vectorId, "agent-card.json") }];
    if (protocol === "mcp") return [{ agent, protocol, identifier, type: MCP_CARD_TYPE, url: agentUrl(baseUrl, agent.vectorId, "server-card") }];
    return [];
  });
}

/**
 * AI Catalog (https://github.com/Agent-Card/ai-catalog, specification/ai-catalog.md at 9aac2c1,
 * specVersion 1.0). Entries leave out the name, description and version that the referenced card
 * carries, as the specification recommends.
 */
export function aiCatalog(agents: readonly RenderedAgent[], baseUrl: string, gatewayDid: string | null): Record<string, unknown> {
  return {
    specVersion: "1.0",
    host: { displayName: "Vector identity gateway", ...(gatewayDid ? { identifier: gatewayDid } : {}), documentationUrl: `${baseUrl}/policy` },
    entries: cardRefs(agents, baseUrl).map((ref) => ({
      identifier: ref.identifier,
      type: ref.type,
      url: ref.url,
      ...(ref.agent.capabilities.length ? { tags: ref.agent.capabilities } : {}),
      updatedAt: formatTime(ref.agent.updatedAt),
    })),
  };
}

/** ARD manifest (Agentic Resource Discovery v0.91, https://github.com/ards-project/ard-spec, spec/ard.md at f073b1e). */
export function ardManifest(agents: readonly RenderedAgent[], baseUrl: string): Record<string, unknown> {
  return {
    entries: cardRefs(agents, baseUrl).map((ref) => ({
      identifier: ref.identifier,
      displayName: ref.agent.name ?? fallbackName(ref.agent),
      type: ref.type,
      url: ref.url,
      ...(ref.agent.description ? { description: ref.agent.description } : {}),
      ...(ref.agent.capabilities.length ? { capabilities: ref.agent.capabilities } : {}),
      updatedAt: formatTime(ref.agent.updatedAt),
      metadata: { did: ref.agent.did, protocol: ref.protocol },
    })),
  };
}

export interface RegistryQuery {
  readonly cursor: string | null;
  readonly limit: number;
  readonly search: string | null;
  readonly version: string | null;
  /** POSIX ms. */
  readonly updatedSince: number | null;
}

export const REGISTRY_DEFAULT_LIMIT = 30;
export const REGISTRY_MAX_LIMIT = 100;

/**
 * Reads the GET /v0/servers query (MCP Registry generic API, docs/reference/api/openapi.yaml of
 * modelcontextprotocol/registry at 01e5c93). Unknown parameters are ignored. Returns an error text
 * for an invalid value.
 */
export function registryQuery(params: URLSearchParams): RegistryQuery | string {
  const limitText = params.get("limit");
  const limit = limitText === null ? REGISTRY_DEFAULT_LIMIT : Number(limitText);
  if (limitText !== null && (!/^\d+$/.test(limitText) || limit < 1 || limit > REGISTRY_MAX_LIMIT)) return `limit must be an integer in [1, ${REGISTRY_MAX_LIMIT}]`;
  const since = params.get("updated_since");
  const updatedSince = since === null ? null : Date.parse(since);
  if (since !== null && (Number.isNaN(updatedSince) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(since))) {
    return "updated_since must be an RFC 3339 date-time";
  }
  return { cursor: params.get("cursor"), limit, search: params.get("search"), version: params.get("version"), updatedSince };
}

/**
 * The MCP subregistry list: one entry per listed MCP agent (its current version only), ordered by
 * server name. `nextCursor` is the name of the last entry of the page; the next page starts after it.
 */
export function registryList(agents: readonly RenderedAgent[], baseUrl: string, query: RegistryQuery): Record<string, unknown> {
  const metaKey = `${reverseHost(baseUrl)}/did`;
  const matching = agents
    .flatMap((agent) => {
      const server = serverJson(agent, baseUrl);
      return server ? [{ agent, server, name: server.name, version: server.version }] : [];
    })
    .filter((s) => query.search === null || s.name.toLowerCase().includes(query.search.toLowerCase()))
    .filter((s) => query.version === null || query.version === "latest" || s.version === query.version)
    .filter((s) => query.updatedSince === null || s.agent.updatedAt >= query.updatedSince)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .filter((s) => query.cursor === null || s.name > query.cursor);
  const page = matching.slice(0, query.limit);
  return {
    servers: page.map((s) => ({ server: s.server, _meta: { [metaKey]: s.agent.did } })),
    metadata: { count: page.length, ...(matching.length > page.length ? { nextCursor: page[page.length - 1]!.name } : {}) },
  };
}
