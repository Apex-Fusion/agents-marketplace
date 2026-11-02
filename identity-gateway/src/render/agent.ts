// What the renderings know about an agent (Part 2 Section 8.5, "Rendering source"): the on-chain
// profile of the view without options, the detected protocol and the listed keys. Also the listing
// rule of Part 2 Section 8.4.

import { recordText } from "../codec/text.js";
import { canonicalDid } from "../resolve/did.js";
import type { CurrentRecord } from "../resolve/resolver.js";
import type { NetworkParameters } from "../resolve/settings.js";
import { blockTimeMs } from "../resolve/time.js";
import type { CurrentFacts } from "../fetch/facts.js";
import { endpointOf } from "../fetch/facts.js";

export interface RenderedAgent {
  readonly vectorId: string;
  /** did:vector:<id> */
  readonly did: string;
  readonly record: CurrentRecord;
  readonly facts: CurrentFacts;
  /** Profile text; null when empty or not valid text (Part 1 Section 8.2). */
  readonly name: string | null;
  readonly description: string | null;
  readonly endpoint: string | null;
  readonly capabilities: readonly string[];
  /** Block time of the newest record output that the base version owns (POSIX ms). */
  readonly updatedAt: number;
}

const textOf = (bytes: Uint8Array | undefined): string | null => (bytes && recordText(bytes)) || null;

export function renderedAgent(record: CurrentRecord, facts: CurrentFacts, network: NetworkParameters): RenderedAgent {
  const { view } = record;
  const profile = view.kind === "identity" ? view : view.profile;
  return {
    vectorId: record.vectorId,
    did: canonicalDid(record.vectorId),
    record,
    facts,
    name: textOf(profile?.name),
    description: textOf(profile?.description),
    endpoint: endpointOf(record),
    capabilities: (profile?.capabilities ?? []).map(recordText).filter((c): c is string => !!c),
    updatedAt: blockTimeMs(record.ledger.slot, network),
  };
}

export type ListingFailure = "notIndependent" | "notActive" | "notReachable";

/**
 * Part 2 Section 8.4: catalogs, the MCP subregistry and DNS-AID list only an independent agent
 * (lineage Root) whose effective status without options is Active and whose endpoint is reachable
 * (the last detection of the current endpoint succeeded). Null when the agent is listed.
 */
export function listingFailure(agent: RenderedAgent): ListingFailure | null {
  const { view, effective } = agent.record;
  if (view.kind === "identity" && view.lineage.type !== "Root") return "notIndependent";
  if (effective.status !== "active") return "notActive";
  if (!agent.facts.detection?.protocol) return "notReachable";
  return null;
}

/** The did:web alias of an agent: did:web:<host>:agents:<id>, with a port colon percent-encoded (did:web Section "Method-specific identifier"). */
export function didWebOf(baseUrl: string, vectorId: string): string {
  return `did:web:${new URL(baseUrl).host.replace(":", "%3A")}:agents:${vectorId}`;
}

/** The gateway host in reverse-DNS order, the namespace of MCP server names (e.g. org.apexfusion.vector.id). */
export function reverseHost(baseUrl: string): string {
  return new URL(baseUrl).hostname.split(".").reverse().join(".");
}

export const agentUrl = (baseUrl: string, vectorId: string, file: string): string => `${baseUrl}/agents/${vectorId}/${file}`;

/** The gateway's resolution URL of the DID: the documentation link of the renderings. */
export const resolutionUrl = (baseUrl: string, did: string): string => `${baseUrl}/1.0/identifiers/${did}`;

/** The display name of an agent without a readable name. */
export const fallbackName = (agent: RenderedAgent): string => `Vector agent ${agent.vectorId.slice(0, 12)}`;
