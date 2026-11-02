// Per-agent renderings of Part 2 Section 8.5. Each one uses only the on-chain profile of the view
// without options, the detected protocol and the listed keys.

import { keyHash } from "../codec/keys.js";
import { recordText } from "../codec/text.js";
import { buildDocument, type DidDocument } from "../resolve/document.js";
import { canonicalize } from "../resolve/jcs.js";
import type { ResolverSettings } from "../resolve/settings.js";
import { formatTime } from "../resolve/time.js";
import type { A2AInterface } from "../fetch/detect.js";
import { domainOf } from "../fetch/facts.js";
import { agentUrl, didWebOf, fallbackName, resolutionUrl, reverseHost, type RenderedAgent } from "./agent.js";
import { publicJwk, type PublicJwk } from "./jose.js";
import type { Ed25519Signer } from "./signer.js";

// ── did:web alias (https://w3c-ccg.github.io/did-method-web/) ──

/**
 * The did:web alias document. Its `alsoKnownAs` names the did:vector DID first, then the verified
 * domains. DID URLs are absolute, as did:web requires; keys and relationships are those of the
 * did:vector document (Part 1 Section 8.1).
 */
export function aliasDocument(agent: RenderedAgent, baseUrl: string): DidDocument {
  const id = didWebOf(baseUrl, agent.vectorId);
  const alsoKnownAs = [agent.did, ...agent.facts.verifiedDomains.map((d) => `https://${d.domain}`)];
  return buildDocument(id, agent.record.view, agent.record.legacyControllerKey, true, alsoKnownAs);
}

// ── JWK set (RFC 7517) ──

export interface AgentJwk extends PublicJwk {
  readonly kid: string;
  readonly alg: "EdDSA" | "ES256";
  readonly use: "sig";
}

/** The listed keys (P-256 keys only with a valid proof); for a legacy record, the key that the legacy key search found. `kid` is the key's DID URL. */
export function agentJwks(agent: RenderedAgent): { readonly keys: readonly AgentJwk[] } {
  const { view, legacyControllerKey } = agent.record;
  const keys =
    view.kind === "identity"
      ? view.keys.filter((k) => k.popValid).map((k) => ({ keyType: k.keyType, key: k.key, hash: k.keyHash }))
      : legacyControllerKey
        ? [{ keyType: "Ed25519" as const, key: legacyControllerKey, hash: keyHash(legacyControllerKey) }]
        : [];
  return {
    keys: keys.map((k) => ({ ...publicJwk(k.keyType, k.key), kid: `${agent.did}#${k.hash}`, alg: k.keyType === "P256" ? "ES256" : "EdDSA", use: "sig" })),
  };
}

// ── A2A agent card (A2A specification v1.0, https://a2a-protocol.org/latest/specification/) ──

export interface AgentCardSignature {
  readonly protected: string;
  readonly signature: string;
}

export interface AgentCard {
  readonly name: string;
  readonly description: string;
  readonly supportedInterfaces: readonly A2AInterface[];
  readonly provider?: { readonly organization: string; readonly url: string };
  readonly version: string;
  readonly documentationUrl: string;
  readonly capabilities: Record<string, never>;
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description: string; readonly tags: readonly string[] }>;
  readonly signatures?: readonly AgentCardSignature[];
}

/** A verified organisation of a party, Accountable Parties first: the card's provider. */
function provider(agent: RenderedAgent): AgentCard["provider"] {
  const { view } = agent.record;
  if (view.kind !== "identity") return undefined;
  const verified = new Set(agent.facts.verifiedOrganisations);
  const named = view.parties
    .map((p) => ({ role: p.role, text: p.organisation === null ? null : recordText(p.organisation) }))
    .filter((p): p is { role: typeof p.role; text: string } => p.text !== null && verified.has(p.text));
  const chosen = named.find((p) => p.role === "Accountable") ?? named[0];
  return chosen ? { organization: chosen.text, url: `https://${domainOf(chosen.text)}` } : undefined;
}

/**
 * The agent card of an A2A agent, unsigned; null for another protocol. The interfaces and the default
 * modes come from the detected card (only its interfaces on the endpoint's origin). Skills are the
 * on-chain capabilities. `version` is the record's versionId; `documentationUrl` is the gateway's
 * resolution URL of the DID, which binds the signed card to the identity.
 */
export function agentCard(agent: RenderedAgent, baseUrl: string): AgentCard | null {
  const a2a = agent.facts.detection?.protocol === "a2a" ? agent.facts.detection.a2a : null;
  if (!a2a) return null;
  const name = agent.name ?? fallbackName(agent);
  const description = agent.description ?? `An agent with the identity ${agent.did}.`;
  const skills = agent.capabilities.length
    ? agent.capabilities.map((c) => ({ id: c, name: c, description: `The capability ${c} that the record of ${agent.did} declares.`, tags: [c] }))
    : [{ id: "agent", name, description, tags: ["agent"] }];
  const card: AgentCard = {
    name,
    description,
    supportedInterfaces: a2a.interfaces,
    provider: provider(agent),
    version: String(agent.record.versionId),
    documentationUrl: resolutionUrl(baseUrl, agent.did),
    capabilities: {},
    defaultInputModes: a2a.defaultInputModes,
    defaultOutputModes: a2a.defaultOutputModes,
    skills,
  };
  // An absent provider stays undefined: JSON and JCS leave the member out (A2A Section 8.4.1, rule 1).
  return card;
}

/**
 * Signs a card as A2A Section 8.4 specifies: the JWS payload is the JCS (RFC 8785) form of the card
 * without `signatures`; the protected header has `alg` EdDSA (RFC 8037), `typ` JOSE, the signer's
 * `kid` and the `jku` of the gateway's JWK set.
 */
export async function signAgentCard(card: AgentCard, baseUrl: string, signer: Ed25519Signer): Promise<AgentCard> {
  const { signatures: _, ...unsigned } = card;
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JOSE", kid: signer.kid, jku: `${baseUrl}/.well-known/jwks.json` }), "utf8").toString("base64url");
  const payload = Buffer.from(canonicalize(unsigned), "utf8").toString("base64url");
  const signature = await signer.sign(new TextEncoder().encode(`${header}.${payload}`));
  return { ...unsigned, signatures: [{ protected: header, signature: Buffer.from(signature).toString("base64url") }] };
}

// ── MCP server card and server.json ──

/** At most `max` code points; a cut text ends with an ellipsis. */
function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/** Server Card schema v1 (https://github.com/modelcontextprotocol/ext-server-card, SEP-2127, commit 526201b). */
export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
/** The MCP Registry's current server.json schema (registry pkg/model CurrentSchemaVersion 2025-12-11). */
export const SERVER_JSON_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

export interface ServerIdentity {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly websiteUrl: string;
}

/** Name `<gateway host, reverse-DNS>/<identifier>`; description at most 100 characters (both schemas). */
function serverIdentity(agent: RenderedAgent, baseUrl: string): ServerIdentity {
  const name = agent.name ?? fallbackName(agent);
  return {
    name: `${reverseHost(baseUrl)}/${agent.vectorId}`,
    title: clip(name, 100),
    description: clip(agent.description ?? name, 100),
    version: String(agent.record.versionId),
    websiteUrl: resolutionUrl(baseUrl, agent.did),
  };
}

/** The MCP server card of an MCP agent; null for another protocol. */
export function serverCard(agent: RenderedAgent, baseUrl: string): Record<string, unknown> | null {
  const detection = agent.facts.detection;
  if (detection?.protocol !== "mcp" || agent.endpoint === null) return null;
  return {
    $schema: SERVER_CARD_SCHEMA,
    ...serverIdentity(agent, baseUrl),
    remotes: [{ type: "streamable-http", url: agent.endpoint, supportedProtocolVersions: detection.mcpVersions }],
    _meta: { [`${reverseHost(baseUrl)}/did`]: agent.did },
  };
}

/** A server.json entry (MCP Registry) of the subregistry list. */
export interface ServerJson extends ServerIdentity {
  readonly $schema: string;
  readonly remotes: ReadonlyArray<{ readonly type: "streamable-http"; readonly url: string }>;
}

/** The server.json entry of an MCP agent for the subregistry list; null for another protocol. */
export function serverJson(agent: RenderedAgent, baseUrl: string): ServerJson | null {
  if (agent.facts.detection?.protocol !== "mcp" || agent.endpoint === null) return null;
  return {
    $schema: SERVER_JSON_SCHEMA,
    ...serverIdentity(agent, baseUrl),
    remotes: [{ type: "streamable-http", url: agent.endpoint }],
  };
}

// ── OASF record (Open Agentic Schema Framework, schema 1.1.0, https://schema.oasf.outshift.com/1.1.0) ──

export const OASF_SCHEMA_VERSION = "1.1.0";

/**
 * Capability names of Vector services and the OASF 1.1.0 skill classes that describe them. A
 * capability matches a key when it equals it or continues it after a dot (e.g. llm.text.generate.v1).
 */
const OASF_SKILLS: ReadonlyArray<readonly [string, { readonly name: string; readonly id: number }]> = [
  ["llm.text.generate", { name: "language_processing/language_generation/text_completion", id: 10301 }],
  ["llm.chat", { name: "language_processing/language_generation/dialogue_generation", id: 10304 }],
  ["audio.synthesize", { name: "audio_speech_processing/speech_processing/text_to_speech", id: 30202 }],
  ["ocr.extract", { name: "computer_vision/image_analysis/optical_character_recognition", id: 20108 }],
  ["document-extraction", { name: "research_knowledge_productivity/document_processing/document_parsing", id: 130501 }],
];

export function oasfRecord(agent: RenderedAgent): Record<string, unknown> {
  const name = agent.name ?? fallbackName(agent);
  const skills = new Map<number, { name: string; id: number }>();
  for (const capability of agent.capabilities) {
    const match = OASF_SKILLS.find(([key]) => capability === key || capability.startsWith(`${key}.`));
    if (match) skills.set(match[1].id, match[1]);
  }
  const protocol = agent.facts.detection?.protocol;
  return {
    name,
    version: String(agent.record.versionId),
    schema_version: OASF_SCHEMA_VERSION,
    description: agent.description ?? name,
    authors: [agent.did],
    created_at: formatTime(agent.record.created),
    skills: [...skills.values()],
    locators: agent.endpoint ? [{ type: "url", urls: [agent.endpoint] }] : undefined,
    annotations: {
      did: agent.did,
      ...(protocol ? { protocol } : {}),
      ...(agent.capabilities.length ? { capabilities: JSON.stringify(agent.capabilities) } : {}),
    },
  };
}

// ── ERC-8004 registration file (https://eips.ethereum.org/EIPS/eip-8004, "Agent Registration File") ──

export const ERC8004_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/**
 * `agentId` is the identifier as an unsigned 256-bit integer, written in decimal. `agentRegistry` is
 * `vector:mainnet:<policy>` (provisional, Part 2 Section 8.5): the identity registry policy; for a
 * legacy record, which only the legacy registry holds, the legacy policy.
 */
export function registrationFile(agent: RenderedAgent, baseUrl: string, settings: ResolverSettings): Record<string, unknown> {
  const detection = agent.facts.detection;
  const services: Array<Record<string, string>> = [];
  if (detection?.protocol === "a2a" && detection.a2a) {
    services.push({ name: "A2A", endpoint: agentUrl(baseUrl, agent.vectorId, "agent-card.json"), version: detection.a2a.interfaces[0]!.protocolVersion });
  } else if (detection?.protocol === "mcp" && agent.endpoint) {
    services.push({ name: "MCP", endpoint: agent.endpoint, version: detection.mcpVersions[0]! });
  } else if (detection?.protocol === "web" && agent.endpoint) {
    services.push({ name: "web", endpoint: agent.endpoint });
  }
  services.push({ name: "OASF", endpoint: agentUrl(baseUrl, agent.vectorId, "oasf.json"), version: OASF_SCHEMA_VERSION });
  services.push({ name: "DID", endpoint: agent.did, version: "v1" });
  const policy = agent.record.origin === "legacy" ? settings.registries.legacy.policyId : settings.registries.identity?.policyId;
  const name = agent.name ?? fallbackName(agent);
  return {
    type: ERC8004_TYPE,
    name,
    description: agent.description ?? name,
    services,
    x402Support: false,
    active: true,
    registrations: policy ? [{ agentId: BigInt(`0x${agent.vectorId}`), agentRegistry: `vector:mainnet:${policy}` }] : [],
  };
}
