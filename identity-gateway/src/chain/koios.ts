// Minimal Koios REST client (https://api.koios.rest). Koios answers at most 1000 rows per call;
// postAll pages with offset/limit under an explicit order so that pages neither overlap nor skip.

export const KOIOS_PAGE = 1000;

export interface KoiosClientOptions {
  /** API root, for example https://v2.koios.vector.mainnet.apexfusion.org/api/v1 */
  baseUrl: string;
  /** Optional Koios bearer token; sent as `Authorization: Bearer <token>`. */
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class KoiosClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: KoiosClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = { accept: "application/json", "content-type": "application/json" };
    if (options.token) this.headers.authorization = `Bearer ${options.token}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  /** Every row of a POST endpoint. `order` must name a unique key of the rows (PostgREST syntax). */
  async postAll<T>(path: string, body: unknown, order: string): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += KOIOS_PAGE) {
      const page = await this.post<T[]>(`${path}?order=${order}&offset=${offset}&limit=${KOIOS_PAGE}`, body);
      rows.push(...page);
      if (page.length < KOIOS_PAGE) return rows;
    }
  }

  private async request<T>(path: string, init: { method: string; body?: string }): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      ...init,
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Koios ${init.method} ${path.split("?")[0]} answered HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

// Row shapes, limited to the fields this package reads.

export interface KoiosAsset {
  policy_id: string;
  asset_name: string | null;
  quantity: string;
}

export interface KoiosTipRow {
  hash: string;
  abs_slot: number;
  block_height: number;
}

export interface KoiosBlockRow {
  hash: string;
  abs_slot: number;
  block_height: number;
}

export interface KoiosAssetUtxoRow {
  tx_hash: string;
  tx_index: number;
  address: string;
  inline_datum: { bytes: string | null } | null;
  asset_list: KoiosAsset[] | null;
}

export interface KoiosTxRefRow {
  tx_hash: string;
  block_height: number;
}

export interface KoiosTxInfoRow {
  tx_hash: string;
  block_hash: string;
  block_height: number;
  absolute_slot: number;
  tx_timestamp: number;
  tx_block_index: number;
  inputs: Array<{ tx_hash: string; tx_index: number; payment_addr: { bech32: string }; asset_list: KoiosAsset[] | null }>;
  outputs: Array<{ tx_index: number; payment_addr: { bech32: string }; asset_list: KoiosAsset[] | null }>;
  assets_minted: KoiosAsset[] | null;
}
