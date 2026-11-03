// Minimal Koios REST client (https://api.koios.rest). Koios answers at most 1000 rows per call;
// postAll and getAll page with offset/limit under an explicit order so that pages neither overlap
// nor skip. Error messages name the endpoint only, never the requested values. Every call goes
// through the client's KoiosLimiter (limiter.ts): its rate, its lanes and its pauses after HTTP 429.

import { KoiosLimiter, RateLimited, retryAfterMs } from "./limiter.js";

export const KOIOS_PAGE = 1000;

export interface KoiosClientOptions {
  /** API root, for example https://v2.koios.vector.mainnet.apexfusion.org/api/v1 */
  baseUrl: string;
  /** Optional Koios bearer token; sent as `Authorization: Bearer <token>`. */
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The limit of every Koios call of the process; default: a limiter with the default limits for this client alone. */
  limiter?: KoiosLimiter;
}

export class KoiosClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly limiter: KoiosLimiter;

  constructor(options: KoiosClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = { accept: "application/json", "content-type": "application/json" };
    if (options.token) this.headers.authorization = `Bearer ${options.token}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.limiter = options.limiter ?? new KoiosLimiter();
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  /** Every row of a POST endpoint. `order` must name a unique key of the rows (PostgREST syntax); `path` may carry query parameters. */
  async postAll<T>(path: string, body: unknown, order: string): Promise<T[]> {
    const rows: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let offset = 0; ; offset += KOIOS_PAGE) {
      const page = await this.post<T[]>(`${path}${separator}order=${order}&offset=${offset}&limit=${KOIOS_PAGE}`, body);
      rows.push(...page);
      if (page.length < KOIOS_PAGE) return rows;
    }
  }

  /** Every row of a GET endpoint; `path` already carries its query parameters. */
  async getAll<T>(path: string, order: string): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += KOIOS_PAGE) {
      const page = await this.get<T[]>(`${path}&order=${order}&offset=${offset}&limit=${KOIOS_PAGE}`);
      rows.push(...page);
      if (page.length < KOIOS_PAGE) return rows;
    }
  }

  private request<T>(path: string, init: { method: string; body?: string }): Promise<T> {
    const endpoint = path.split("?")[0];
    return this.limiter.run(async () => {
      const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        ...init,
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429) {
        await res.body?.cancel();
        throw new RateLimited(`Koios ${init.method} ${endpoint} answered HTTP 429`, retryAfterMs(res.headers.get("retry-after"), Date.now()));
      }
      if (!res.ok) throw new Error(`Koios ${init.method} ${endpoint} answered HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error(`Koios ${init.method} ${endpoint} did not answer a JSON array`);
      return body as T;
    });
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

export interface KoiosGenesisRow {
  networkmagic: string | number;
  systemstart: string | number;
  slotlength: string | number;
  securityparam: string | number;
}

export interface KoiosBlockRow {
  hash: string;
  abs_slot: number;
  block_height: number;
}

export interface KoiosTxRefRow {
  tx_hash: string;
  block_height: number;
}

export interface KoiosTxOutputRow {
  tx_index: number;
  payment_addr: { bech32: string };
  value: string;
  asset_list: KoiosAsset[] | null;
  datum_hash: string | null;
  inline_datum: { bytes: string | null } | null;
  reference_script: unknown;
}

export interface KoiosTxInputRow {
  tx_hash: string;
  tx_index: number;
  payment_addr: { bech32: string };
  asset_list: KoiosAsset[] | null;
}

export interface KoiosTxInfoRow {
  tx_hash: string;
  block_hash: string;
  block_height: number;
  absolute_slot: number;
  tx_block_index: number;
  inputs: KoiosTxInputRow[];
  outputs: KoiosTxOutputRow[];
  assets_minted: KoiosAsset[] | null;
}

export interface KoiosDatumRow {
  datum_hash: string;
  bytes: string | null;
}

export interface KoiosPolicyAssetMintRow {
  asset_name: string | null;
  minting_tx_hash: string;
  mint_cnt: number;
  /** Block time of the first mint, POSIX seconds. */
  creation_time: number | null;
}

/** A row of `asset_utxos` with `_extended`: an unspent output and every asset in it. */
export interface KoiosAssetUtxoRow {
  tx_hash: string;
  tx_index: number;
  block_height: number;
  asset_list: KoiosAsset[] | null;
}
