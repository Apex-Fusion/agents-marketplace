/**
 * gateway/src/routing/selectSupplier.ts — capability + model routing.
 *
 * Queries the indexer for suppliers advertising the requested model under the
 * required capability. Per the design: match by capability + model, pick an
 * AVAILABLE supplier (status free|unknown), NOT the cheapest. We return all
 * eligible candidates so the caller can fall back to the next one when the
 * chosen supplier turns out to be busy/offline at escrow-post time.
 *
 * `status==="unknown"` is treated as eligible: the indexer poller (~20s) leaves
 * freshly-advertised suppliers as "unknown" until first polled, and excluding
 * them would create artificial availability gaps.
 */

import type { OutputReference } from "@marketplace/shared/chain";
import { GatewayError } from "../openai/errors.js";

/** Subset of the indexer's SupplierView we depend on. */
interface SupplierView {
  utxo_ref: string;
  supplier_pkh: string;
  capability_id: string;
  model: string;
  max_output_tokens: number;
  max_processing_ms: number;
  price_lovelace: string;
  supplier_bond_lovelace: string;
  buyer_bond_lovelace: string;
  endpoint_url: string;
  advert_status: string;
  status: string;
}

export interface SupplierCandidate {
  advertRef: OutputReference;
  utxoRef: string;
  supplierPkh: string;
  model: string;
  capabilityId: string;
  endpointUrl: string;
  priceLovelace: bigint;
  buyerBondLovelace: bigint;
  supplierBondLovelace: bigint;
  maxOutputTokens: number;
  /** Advert SLA; every wait budget for a job against this supplier derives from it. */
  maxProcessingMs: number;
  status: string;
}

const ESCROW_REF_RE = /^([0-9a-fA-F]{64})#(\d+)$/;
const STATUS_PROBE_CONCURRENCY = 4;
const STATUS_PROBE_TIMEOUT_MS = 2_000;

type LiveSupplierStatus = "free" | "working" | "unavailable";

function toCandidate(raw: SupplierView, status = raw.status): SupplierCandidate | null {
  const advertRef = parseRef(raw.utxo_ref);
  if (!advertRef) return null;
  return {
    advertRef,
    utxoRef: raw.utxo_ref,
    supplierPkh: raw.supplier_pkh,
    model: raw.model,
    capabilityId: raw.capability_id,
    endpointUrl: raw.endpoint_url,
    priceLovelace: BigInt(raw.price_lovelace),
    buyerBondLovelace: BigInt(raw.buyer_bond_lovelace),
    supplierBondLovelace: BigInt(raw.supplier_bond_lovelace),
    maxOutputTokens: raw.max_output_tokens,
    maxProcessingMs: raw.max_processing_ms,
    status,
  };
}

async function readLiveStatus(
  raw: SupplierView,
  fetchFn: typeof globalThis.fetch,
): Promise<LiveSupplierStatus> {
  try {
    const res = await fetchFn(`${raw.endpoint_url.replace(/\/+$/, "")}/status`, {
      method: "GET",
      signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return "unavailable";
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object" || !("status" in body)) return "unavailable";
    const status = body.status;
    if (status === "free" || status === "working") return status;
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

async function probeStatuses(
  rows: SupplierView[],
  fetchFn: typeof globalThis.fetch,
): Promise<Array<{ raw: SupplierView; status: LiveSupplierStatus }>> {
  const results = new Array<{ raw: SupplierView; status: LiveSupplierStatus }>(rows.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const index = next++;
      const raw = rows[index];
      results[index] = { raw, status: await readLiveStatus(raw, fetchFn) };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STATUS_PROBE_CONCURRENCY, rows.length) }, () => worker()),
  );
  return results;
}

function orderCandidates(
  candidates: SupplierCandidate[],
  preferredSupplierPkh?: string,
): SupplierCandidate[] {
  candidates.sort((left, right) => {
    const leftRank =
      (left.supplierPkh === preferredSupplierPkh ? 0 : 2) +
      (left.status === "free" ? 0 : 1);
    const rightRank =
      (right.supplierPkh === preferredSupplierPkh ? 0 : 2) +
      (right.status === "free" ? 0 : 1);
    return leftRank - rightRank;
  });
  return candidates;
}

export function parseRef(ref: string): OutputReference | null {
  const m = ESCROW_REF_RE.exec(ref);
  if (!m) return null;
  return { txHash: m[1], index: Number(m[2]) };
}

export interface SelectSupplierOpts {
  indexerUrl: string;
  /** Exact model match; "" matches ANY model under the capability (used by
   * single-model capabilities like the ocr.* ids, where the capability
   * already pins the model). */
  model: string;
  capabilityId: string;
  /** Optional exact seller identity pin for deterministic agent routing. */
  supplierPkh?: string;
  /** Preferred seller ordered first when it is eligible. */
  preferredSupplierPkh?: string;
  fetchFn?: typeof globalThis.fetch;
  /** Supplier identities just freed by managed-demo eviction. These are live
   * rechecked even if another cached candidate looks ready, because that other
   * candidate may be the busy supplier that caused the eviction. */
  ignoreStatusFor?: ReadonlySet<string>;
}

/**
 * Return eligible candidates for (model, capability), ordered for fallback.
 * Cached free/unknown suppliers use the normal fast path. When that path has
 * no usable candidate, cached working/offline suppliers get a bounded live
 * status check so a completed supplier need not wait for the indexer poller.
 */
export async function selectCandidates(opts: SelectSupplierOpts): Promise<SupplierCandidate[]> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const url = `${opts.indexerUrl}/suppliers?capability_id=${encodeURIComponent(opts.capabilityId)}`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`indexer /suppliers returned ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error("indexer /suppliers did not return an array");
  }

  const matching: SupplierView[] = [];
  for (const raw of body as SupplierView[]) {
    if (raw.capability_id !== opts.capabilityId) continue;
    if (opts.model !== "" && raw.model !== opts.model) continue;
    if (opts.supplierPkh !== undefined && raw.supplier_pkh !== opts.supplierPkh) {
      continue;
    }
    if (raw.advert_status !== "Active") continue;
    matching.push(raw);
  }
  if (matching.length === 0) return [];

  const candidates: SupplierCandidate[] = [];
  for (const raw of matching) {
    if (raw.status !== "free" && raw.status !== "unknown") continue;
    const candidate = toCandidate(raw);
    if (candidate) candidates.push(candidate);
  }

  const explicitlyFreed = opts.ignoreStatusFor
    ? matching.filter((raw) =>
      opts.ignoreStatusFor?.has(raw.supplier_pkh) &&
      (raw.status === "working" || raw.status === "offline"))
    : [];
  if (candidates.length > 0 && explicitlyFreed.length === 0) {
    return orderCandidates(candidates, opts.preferredSupplierPkh);
  }

  const rowsToProbe = candidates.length > 0
    ? explicitlyFreed
    : matching.filter((raw) => raw.status === "working" || raw.status === "offline");
  const liveStatuses = await probeStatuses(rowsToProbe, fetchFn);
  for (const result of liveStatuses) {
    if (result.status !== "free") continue;
    const candidate = toCandidate(result.raw, "free");
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length > 0) {
    return orderCandidates(candidates, opts.preferredSupplierPkh);
  }

  const target = opts.model === ""
    ? `capability "${opts.capabilityId}"`
    : `model "${opts.model}" under capability "${opts.capabilityId}"`;
  if (liveStatuses.some((result) => result.status === "working")) {
    throw new GatewayError(
      503,
      "server_error",
      "overloaded",
      `all matching suppliers for ${target} are busy`,
    );
  }
  throw new GatewayError(
    503,
    "server_error",
    "suppliers_unavailable",
    `matching suppliers for ${target} are unavailable`,
  );
}

/** Distinct models across Active suppliers (for GET /openai/v1/models).
 * Pass capabilityId to list only models under one capability (demo keys see
 * only llm.chat.v1 models — the session-backed executor's routing target). */
export async function listModels(opts: {
  indexerUrl: string;
  capabilityId?: string;
  fetchFn?: typeof globalThis.fetch;
}): Promise<string[]> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const url = opts.capabilityId
    ? `${opts.indexerUrl}/suppliers?capability_id=${encodeURIComponent(opts.capabilityId)}`
    : `${opts.indexerUrl}/suppliers`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`indexer /suppliers returned ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("indexer /suppliers did not return an array");
  const models = new Set<string>();
  for (const raw of body as SupplierView[]) {
    if (raw.advert_status !== "Active" || typeof raw.model !== "string") continue;
    if (opts.capabilityId !== undefined && raw.capability_id !== opts.capabilityId) continue;
    models.add(raw.model);
  }
  return [...models].sort();
}
