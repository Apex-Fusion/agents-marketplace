/**
 * indexer-ui/src/api/client.ts — fetch helpers + types matching indexer JSON endpoints.
 *
 * baseUrl defaults to "" so calls hit the same origin (relative URLs in the
 * browser). When baseUrl is supplied (e.g. for cross-origin dev), it is
 * prepended verbatim — pass without a trailing slash.
 *
 * Errors carry HTTP status as `.status` so callers (e.g. EscrowLookup) can
 * distinguish 404 from network failures without parsing strings.
 */

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface HealthzResponse {
  ok: boolean;
  sync_slot: number;
  tip_slot: number;
  ogmios_status: "connected" | "disconnected";
  db_size_bytes: number;
}

export interface SupplierRow {
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
  detail_uri: string;
  detail_hash: string;
  advertised_at: number;
  status: "free" | "working" | "offline" | "unknown";
  advert_status: string;
  current_escrow_ref: string | null;
  last_seen_iso: string | null;
  created_slot: number;
}

export interface CapabilityCount {
  capability_id: string;
  supplier_count: number;
}

export interface EscrowView {
  utxo_ref: string;
  buyer_pkh: string;
  supplier_pkh: string;
  advert_ref: string;
  capability_id: string;
  request_spec_hash: string;
  prompt_hash: string;
  payment_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
  deliver_by: number;
  posted_at: number;
  submitted_at: number | null;
  result_receipt_hash: string | null;
  state: string;
  created_slot: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* ignore */ }
    const msg =
      body && typeof body === "object" && body !== null && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    throw new HttpError(res.status, msg);
  }
  return (await res.json()) as T;
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────

export async function fetchHealthz(baseUrl = ""): Promise<HealthzResponse> {
  return getJson<HealthzResponse>(`${baseUrl}/healthz`);
}

export async function fetchSuppliers(baseUrl = ""): Promise<SupplierRow[]> {
  return getJson<SupplierRow[]>(`${baseUrl}/suppliers`);
}

export async function fetchCapabilities(baseUrl = ""): Promise<CapabilityCount[]> {
  return getJson<CapabilityCount[]>(`${baseUrl}/capabilities`);
}

/**
 * Fetch a single escrow by its "<txhash>#<idx>" reference.
 *
 * Note: `ref` is the FIRST argument so call sites read naturally
 * (`fetchEscrow(VALID_REF)`); `baseUrl` is the second optional argument.
 * The escrow-lookup test mocks this signature directly.
 */
export async function fetchEscrow(ref: string, baseUrl = ""): Promise<EscrowView> {
  return getJson<EscrowView>(`${baseUrl}/escrows/${encodeURIComponent(ref)}`);
}
