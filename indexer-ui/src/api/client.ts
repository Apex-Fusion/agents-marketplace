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
  /** Part 2 §6.4: 64 lowercase hex for a new advert, null for a legacy advert. */
  agent_id: string | null;
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
  /** "legacy": the 14-field escrow; "identity": the new 16-field escrow (Part 2 §6.1). */
  layout: "legacy" | "identity";
  /** 64 lowercase hex for a new escrow, null for a legacy escrow. */
  agent_id: string | null;
  /**
   * Where buyer payouts go: a bech32 address (Plutus Data CBOR hex when it has
   * no bech32 form) and the inline datum CBOR hex or null. null: the buyer key.
   */
  refund: { address: string; datum: string | null } | null;
  /** false when payment + both bonds exceed 10,000 AP3X (F-29): no supplier can claim it. */
  routable: boolean;
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
