/**
 * indexer/src/poller/statusPoller.ts — supplier status poller.
 *
 * Polls each Active supplier's /status endpoint every STATUS_POLL_MS ms.
 * Writes results to supplier_status table via SqliteCache.
 *
 * Design:
 *   - In-process setInterval loop (default 20_000 ms)
 *   - Pluggable interval (pass 0 or undefined, then use tickOnce() for tests)
 *   - tickOnce() is a test-only synchronous/async trigger for a single poll cycle
 *   - Supplier 503 / network error → row with status="offline", error logged
 *   - Retired advertisements are NOT polled (cache.listActiveAdvertisements filters them out)
 *   - fetch is the HTTP client (can be stubbed via vi.stubGlobal in tests)
 */

import type { SqliteCache } from "../db/cache.js";

const STATUS_POLL_TIMEOUT_MS = 5000;
const VALID_STATUSES = new Set(["free", "working", "offline"]);

export interface StatusPollerOpts {
  cache: SqliteCache;
  pollIntervalMs?: number;  // default 20_000; pass 0 to disable auto-tick
}

export interface SupplierStatusResponse {
  status: "free" | "working" | "offline";
  current_escrow_ref?: string;
  last_seen?: string;
}

export class StatusPoller {
  private cache: SqliteCache;
  private pollIntervalMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: StatusPollerOpts) {
    this.cache = opts.cache;
    this.pollIntervalMs = opts.pollIntervalMs ?? 20_000;
  }

  start(): void {
    if (this.intervalHandle !== null) return;
    if (this.pollIntervalMs <= 0) return;
    this.intervalHandle = setInterval(() => {
      void this.tickOnce();
    }, this.pollIntervalMs);
    if (typeof (this.intervalHandle as unknown as { unref?: () => void }).unref === "function") {
      (this.intervalHandle as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * tickOnce — test-only: runs a single poll cycle immediately.
   * Returns when all Active suppliers have been polled (or failed).
   */
  async tickOnce(): Promise<void> {
    const adverts = this.cache.listActiveAdvertisements();
    if (adverts.length === 0) return;

    await Promise.all(
      adverts.map(async (advert) => {
        await this.pollOne(advert.endpoint_url, advert.supplier_pkh, advert.utxo_ref);
      })
    );
  }

  private async pollOne(endpointUrl: string, supplierPkh: string, advertRef: string): Promise<void> {
    const url = `${endpointUrl}/status`;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    const writeOffline = (): void => {
      this.cache.upsertSupplierStatus({
        supplier_pkh: supplierPkh,
        advert_ref: advertRef,
        status: "offline",
        last_seen_iso: nowIso,
        current_escrow_ref: null,
        polled_at: nowMs,
      });
    };

    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATUS_POLL_TIMEOUT_MS);
    try {
      response = await fetch(url, { method: "GET", signal: controller.signal });
    } catch (err) {
      console.warn(`[statusPoller] fetch failed for ${url}: ${(err as Error).message}`);
      writeOffline();
      return;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      console.warn(`[statusPoller] non-OK status from ${url}: ${response.status}`);
      writeOffline();
      return;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      console.warn(`[statusPoller] malformed JSON from ${url}: ${(err as Error).message}`);
      writeOffline();
      return;
    }

    const parsed = this.parseStatusBody(body);
    if (parsed === null) {
      console.warn(`[statusPoller] wrong-shape body from ${url}`);
      writeOffline();
      return;
    }

    this.cache.upsertSupplierStatus({
      supplier_pkh: supplierPkh,
      advert_ref: advertRef,
      status: parsed.status,
      last_seen_iso: parsed.last_seen ?? nowIso,
      current_escrow_ref: parsed.current_escrow_ref ?? null,
      polled_at: nowMs,
    });
  }

  private parseStatusBody(body: unknown): SupplierStatusResponse | null {
    if (typeof body !== "object" || body === null) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.status !== "string") return null;
    if (!VALID_STATUSES.has(b.status)) return null;
    const out: SupplierStatusResponse = { status: b.status as SupplierStatusResponse["status"] };
    if (typeof b.current_escrow_ref === "string") out.current_escrow_ref = b.current_escrow_ref;
    if (typeof b.last_seen === "string") out.last_seen = b.last_seen;
    return out;
  }
}
