// HTTP routes of the renderings (Part 2 Section 8.5) and of /policy (Part 2 Section 8.4). Bodies are
// JSON in JCS member order. Every response has `Cache-Control: no-store`, like the resolver, and
// `Access-Control-Allow-Origin: *`: the documents are public and read-only, and the MCP Server Card
// discovery rules require CORS. A per-agent request reads the record as a resolution does (the view
// without options at the current tip) and the stored facts; no request fetches anything.
//
// A card depends only on the stored facts of the record (one object for each background check) and
// on the record state that `changeKey` names. So the routes build, sign and render a card once for
// each pair and serve that body again (Part 1 Section 9: bounded work per request); an entry goes
// away with its facts object.

import type { IncomingMessage, ServerResponse } from "node:http";
import { FactsStore, changeKey, factInputs, type RecordFacts } from "../fetch/facts.js";
import type { ListingSnapshot, RecordSource } from "../fetch/scheduler.js";
import type { CurrentRecord } from "../resolve/resolver.js";
import type { ResolverSettings } from "../resolve/settings.js";
import { listingFailure, renderedAgent, type RenderedAgent } from "../render/agent.js";
import { A2A_CARD_TYPE, MCP_CARD_TYPE, aiCatalog, ardManifest, registryList, registryQuery } from "../render/catalogs.js";
import type { RenderConfig } from "../render/config.js";
import { agentCard, agentJwks, aliasDocument, oasfRecord, registrationFile, serverCard, signAgentCard } from "../render/documents.js";
import { renderJson } from "../render/json.js";
import { policyDocument } from "../render/policy.js";
import type { Ed25519Signer } from "../render/signer.js";
import type { Route } from "./http.js";

export interface RenderDeps {
  /** The current record of an identifier (VectorResolver.currentRecord). */
  readonly records: Pick<RecordSource, "currentRecord">;
  readonly facts: FactsStore;
  /** The records of the last background scan; the catalogs list from it. */
  readonly snapshot: () => ListingSnapshot;
  readonly settings: ResolverSettings;
  readonly config: RenderConfig;
  /** Signs agent cards. Null: no key is configured, and agent cards answer 503. */
  readonly signer: Ed25519Signer | null;
  /** Error log; messages never name a DID. */
  readonly log?: (message: string) => void;
}

interface Answer {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

const JSON_TYPE = "application/json";
const AGENT_PATH = /^\/agents\/([0-9a-f]{64})\/(did\.json|agent-card\.json|server-card|oasf\.json|registration\.json|jwks\.json)$/;
/** Every key starts with "/", so no inherited object member can match a path. */
const OTHER_PATHS: Record<string, true> = {
  "/.well-known/ai-catalog.json": true,
  "/.well-known/ard.json": true,
  "/v0/servers": true,
  "/v0.1/servers": true,
  "/policy": true,
};

const ok = (type: string, value: unknown): Answer => ({ status: 200, type, body: renderJson(value) });
const failure = (status: number, error: string): Answer => ({ status, type: JSON_TYPE, body: renderJson({ error }) });

/** The card media type when the Accept header names it, else application/json. */
const cardType = (req: IncomingMessage, type: string): string => ((req.headers.accept ?? "").toLowerCase().includes(type) ? type : JSON_TYPE);

function send(req: IncomingMessage, res: ServerResponse, answer: Answer): void {
  res.writeHead(answer.status, {
    "content-type": answer.type,
    "content-length": Buffer.byteLength(answer.body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(req.method === "HEAD" ? undefined : answer.body);
}

export function renderRoutes(deps: RenderDeps): Route {
  const log = deps.log ?? ((message: string) => console.error(message));
  const { baseUrl } = deps.config;
  const legacyPolicy = deps.settings.registries.legacy.policyId;
  const agentOf = (record: CurrentRecord): RenderedAgent =>
    renderedAgent(record, deps.facts.current(record.vectorId, factInputs(record, legacyPolicy)), deps.settings.network);
  const listed = (): RenderedAgent[] => deps.snapshot().records.map(agentOf).filter((agent) => listingFailure(agent) === null);
  const gatewayDid = (): string | null => (deps.signer?.kid.startsWith("did:") ? deps.signer.kid.split("#")[0]! : null);
  /** Card bodies by facts object, then by file: the record state that the body shows and the body. */
  const cards = new WeakMap<RecordFacts, Map<string, { readonly change: string; readonly body: string }>>();

  /** The agent card or the server card: the kept body for the same facts and record state, else a new one. */
  async function cardAnswer(req: IncomingMessage, agent: RenderedAgent, stored: RecordFacts | undefined, file: "agent-card.json" | "server-card"): Promise<Answer> {
    const type = cardType(req, file === "agent-card.json" ? A2A_CARD_TYPE : MCP_CARD_TYPE);
    const change = changeKey(agent.record);
    const known = stored === undefined ? undefined : cards.get(stored)?.get(file);
    if (known?.change === change) return { status: 200, type, body: known.body };
    let body: string;
    if (file === "agent-card.json") {
      const card = agentCard(agent, baseUrl);
      if (!card) return failure(404, "the agent is not an A2A agent");
      if (!deps.signer) return failure(503, "no key to sign agent cards is configured");
      body = renderJson(await signAgentCard(card, baseUrl, deps.signer));
    } else {
      const card = serverCard(agent, baseUrl);
      if (!card) return failure(404, "the agent is not an MCP agent");
      body = renderJson(card);
    }
    if (stored !== undefined) {
      const byFile = cards.get(stored) ?? new Map<string, { readonly change: string; readonly body: string }>();
      byFile.set(file, { change, body });
      cards.set(stored, byFile);
    }
    return { status: 200, type, body };
  }

  async function agentAnswer(req: IncomingMessage, vectorId: string, file: string): Promise<Answer> {
    const lookup = await deps.records.currentRecord(vectorId);
    if (!lookup.found) return failure(404, "the identifier does not resolve");
    if (lookup.record.deactivated) return failure(410, "the DID is deactivated");
    // The facts object and the facts that the agent shows are read together, before any wait.
    const stored = deps.facts.get(vectorId);
    const agent = agentOf(lookup.record);
    if (file === "did.json" || file === "jwks.json") {
      // Keys are shown only while a relying party may accept new actions by them (Part 1 Section 7.3).
      if (agent.record.effective.status !== "active") return failure(404, "the effective status of the agent is not Active");
      return file === "did.json" ? ok("application/did+json", aliasDocument(agent, baseUrl)) : ok("application/jwk-set+json", agentJwks(agent));
    }
    const notListed = listingFailure(agent);
    if (notListed) return failure(404, `the agent is not listed (${notListed})`);
    switch (file) {
      case "agent-card.json":
      case "server-card":
        return cardAnswer(req, agent, stored, file);
      case "oasf.json":
        return ok(JSON_TYPE, oasfRecord(agent));
      default:
        return ok(JSON_TYPE, registrationFile(agent, baseUrl, deps.settings));
    }
  }

  function otherAnswer(path: string, query: string): Answer {
    switch (path) {
      case "/.well-known/ai-catalog.json":
        return ok("application/ai-catalog+json", aiCatalog(listed(), baseUrl, gatewayDid()));
      case "/.well-known/ard.json":
        return ok(JSON_TYPE, ardManifest(listed(), baseUrl));
      case "/policy":
        return ok(JSON_TYPE, policyDocument(deps.config));
      default: {
        const parsed = registryQuery(new URLSearchParams(query));
        return typeof parsed === "string" ? failure(400, parsed) : ok(JSON_TYPE, registryList(listed(), baseUrl, parsed));
      }
    }
  }

  return async (req, res, path, query) => {
    const agentPath = AGENT_PATH.exec(path);
    if (!agentPath && !OTHER_PATHS[path]) return false;
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "Accept, Content-Type, If-None-Match",
        "access-control-max-age": "86400",
      });
      res.end();
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, OPTIONS", "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("method not allowed\n");
      return true;
    }
    let answer: Answer;
    try {
      answer = agentPath ? await agentAnswer(req, agentPath[1]!, agentPath[2]!) : otherAnswer(path, query);
    } catch (e) {
      log(`identity-gateway: a rendering failed: ${e instanceof Error ? e.message : String(e)}`);
      answer = failure(500, "internal error: the gateway could not read the ledger");
    }
    send(req, res, answer);
    return true;
  };
}
