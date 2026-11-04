/**
 * buyer/src/identity/routes.ts — same-origin proxy to the identity gateway.
 *
 * The gateway resolver and credential routes send no CORS headers, so the SPA
 * reads them through these routes. Answers are cached in memory for a short
 * time; concurrent requests for the same key share one gateway call.
 *
 *   GET /v1/identity/resolve/:did      → gateway DID resolution (status + JSON), 30 s
 *   GET /v1/identity/credential/:id    → { status, jwt, header, payload }, 60 s
 *   GET /v1/identity/status/bsl/:n     → gateway status-list JWT (text), 60 s
 *   GET /v1/identity/summaries?ids=a,b → { [id]: IdentitySummary }, 60 s, ≤ 60 ids
 */

import type { Express, Request, Response } from "express";

export const DEFAULT_IDENTITY_GATEWAY_URL = "https://id.vector.apexfusion.org";

const DID_RE = /^did:vector:(?:[0-9a-f]{64}|agent:[0-9a-f]{56}:[0-9a-f]{64})$/;
const ID_RE = /^[0-9a-f]{64}$/;
const LIST_RE = /^\d{1,4}$/;
const MAX_SUMMARY_IDS = 60;
const SUMMARY_CONCURRENCY = 4;
const GATEWAY_TIMEOUT_MS = 10_000;
/** Module-1 identity_party script hash (prefix): a party with this signer is Module-1. */
const MODULE1_SIGNER_PREFIX = "script:f6b094a8";

export interface IdentitySummary {
  did: string;
  /** HTTP status of the gateway resolution (200, 404, 410, …). */
  status: number;
  name: string | null;
  origin: string | null;
  effective: string | null;
  effectiveReason: string | null;
  accountable: boolean;
  module1: boolean;
  holds: Array<{ by: string | null; reason: string | null; since: string | null; until: string | null }>;
}

interface Upstream {
  status: number;
  text: string;
  contentType: string;
}

export interface IdentityRouteDeps {
  gatewayUrl: string;
  fetchImpl: typeof globalThis.fetch;
}

class TtlCache<V> {
  private readonly entries = new Map<string, { expires: number; value: V }>();
  constructor(private readonly ttlMs: number, private readonly max = 2000) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { expires: Date.now() + this.ttlMs, value });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

/** One shared promise per key; only answers that `keep` accepts stay cached. */
function cached<V>(cache: TtlCache<Promise<V>>, key: string, load: () => Promise<V>, keep: (value: V) => boolean): Promise<V> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pending = load();
  cache.set(key, pending);
  pending.then(
    (value) => {
      if (!keep(value)) cache.delete(key);
    },
    () => cache.delete(key),
  );
  return pending;
}

/** Gateway answers that do not change within the TTL (not 5xx, not 429). */
function stable(up: Upstream): boolean {
  return up.status < 500 && up.status !== 429;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function decodeJwtPart(part: string | undefined): unknown {
  if (part === undefined || part === "") return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export function summarizeResolution(id: string, status: number, body: unknown): IdentitySummary {
  const meta = record(record(body)?.didDocumentMetadata) ?? {};
  const vectorStatus = record(meta.vectorStatus) ?? {};
  const current = record(meta.vectorCurrent) ?? {};
  const profile = record(meta.vectorProfile) ?? {};
  const parties = Array.isArray(meta.vectorParties)
    ? meta.vectorParties.map(record).filter((p): p is Record<string, unknown> => p !== null)
    : [];
  const holds = Array.isArray(vectorStatus.holds)
    ? vectorStatus.holds.map(record).filter((h): h is Record<string, unknown> => h !== null).map((h) => ({
        by: str(h.by),
        reason: str(h.reason),
        since: str(h.since),
        until: str(h.until),
      }))
    : [];
  return {
    did: `did:vector:${id}`,
    status,
    name: str(profile.name),
    origin: str(meta.vectorOrigin),
    effective: str(vectorStatus.effective) ?? str(current.effective) ?? (meta.deactivated === true ? "deactivated" : null),
    effectiveReason: str(vectorStatus.effectiveReason) ?? str(current.effectiveReason),
    accountable: parties.some((p) => p.role === "accountable"),
    module1: parties.some((p) => typeof p.signer === "string" && p.signer.toLowerCase().startsWith(MODULE1_SIGNER_PREFIX)),
    holds,
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function sendError(res: Response, status: number, error: string, message: string): Response {
  return res.status(status).json({ error, message });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerIdentityRoutes(app: Express, deps: IdentityRouteDeps): void {
  const base = deps.gatewayUrl.replace(/\/+$/, "");
  const resolutions = new TtlCache<Promise<Upstream>>(30_000);
  const credentials = new TtlCache<Promise<Upstream>>(60_000);
  const lists = new TtlCache<Promise<Upstream>>(60_000);
  const summaries = new TtlCache<Promise<IdentitySummary>>(60_000);

  async function gatewayGet(path: string, accept: string): Promise<Upstream> {
    const upstream = await deps.fetchImpl(`${base}${path}`, {
      headers: { Accept: accept },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    return {
      status: upstream.status,
      text: await upstream.text(),
      contentType: upstream.headers.get("content-type") ?? "",
    };
  }

  const resolve = (did: string): Promise<Upstream> =>
    cached(resolutions, did, () => gatewayGet(`/1.0/identifiers/${did}`, "application/did-resolution"), stable);

  app.get("/v1/identity/resolve/:did", async (req: Request, res: Response) => {
    const did = String(req.params.did ?? "").trim().toLowerCase();
    if (!DID_RE.test(did)) {
      return sendError(res, 400, "did_invalid", "expected did:vector:<64 hex> or did:vector:agent:<56 hex>:<64 hex>");
    }
    try {
      const up = await resolve(did);
      if (parseJson(up.text) === undefined) {
        return sendError(res, 502, "identity_gateway_bad_response", `gateway answered ${up.status} without JSON`);
      }
      res.status(up.status).setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(up.text);
    } catch (err) {
      return sendError(res, 502, "identity_gateway_unreachable", errorText(err));
    }
  });

  app.get("/v1/identity/credential/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "").trim().toLowerCase();
    if (!ID_RE.test(id)) return sendError(res, 400, "id_invalid", "expected 64 lowercase hex");
    try {
      const up = await cached(credentials, id, () => gatewayGet(`/agents/${id}/credential`, "application/vc+jwt"), stable);
      if (up.status !== 200) {
        const body = record(parseJson(up.text));
        return res.status(up.status).json({
          status: up.status,
          jwt: null,
          header: null,
          payload: null,
          error: str(body?.error),
          message: str(body?.error_description) ?? up.text.slice(0, 300),
        });
      }
      const jwt = up.text.trim();
      const parts = jwt.split(".");
      return res.status(200).json({ status: 200, jwt, header: decodeJwtPart(parts[0]), payload: decodeJwtPart(parts[1]) });
    } catch (err) {
      return sendError(res, 502, "identity_gateway_unreachable", errorText(err));
    }
  });

  app.get("/v1/identity/status/bsl/:n", async (req: Request, res: Response) => {
    const n = String(req.params.n ?? "");
    if (!LIST_RE.test(n)) return sendError(res, 400, "list_invalid", "expected a list number");
    try {
      const up = await cached(lists, n, () => gatewayGet(`/status/bsl/${Number(n)}`, "application/vc+jwt"), stable);
      res.status(up.status).setHeader("Content-Type", up.contentType || "text/plain; charset=utf-8");
      return res.send(up.text);
    } catch (err) {
      return sendError(res, 502, "identity_gateway_unreachable", errorText(err));
    }
  });

  app.get("/v1/identity/summaries", async (req: Request, res: Response) => {
    const raw = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => ID_RE.test(s)))];
    if (ids.length > MAX_SUMMARY_IDS) {
      return sendError(res, 400, "too_many_ids", `at most ${MAX_SUMMARY_IDS} ids`);
    }
    const results = await mapLimit(ids, SUMMARY_CONCURRENCY, async (id) => {
      try {
        return await cached(
          summaries,
          id,
          async () => {
            const up = await resolve(`did:vector:${id}`);
            return summarizeResolution(id, up.status, parseJson(up.text));
          },
          (summary) => summary.status < 500 && summary.status !== 429,
        );
      } catch {
        return null;
      }
    });
    const out: Record<string, IdentitySummary> = {};
    ids.forEach((id, i) => {
      const summary = results[i];
      if (summary) out[id] = summary;
    });
    return res.status(200).json(out);
  });
}
