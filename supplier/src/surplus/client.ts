export interface SurplusOffer {
  id: string;
  model: string;
  sellerBaseUrl: string;
  status: "active" | "inactive";
  capDailyUsd: number | null;
  costMultiplierPpm: number | null;
  inputMicroUsdPer1m: number | null;
  outputMicroUsdPer1m: number | null;
}

export interface SurplusDiscoveredModel {
  model: string;
  supported: boolean;
  inputUsdPer1m: number;
  outputUsdPer1m: number;
  priceUnit: string;
  priceVariable: boolean;
  providerModelId: string;
  modelType: string;
  availabilityStatus: string;
}

export interface SurplusMarketSummary {
  model: string;
  requests24h: number;
  volume24h: number;
  bestInputMicroUsdPer1m: number;
  bestOutputMicroUsdPer1m: number;
  healthySellerCount: number;
}

export interface SurplusOrderBookOffer {
  id: string;
  seller: string;
  sellerBaseUrl: string;
  inputMicroUsdPer1m: number;
  outputMicroUsdPer1m: number;
  available: boolean;
  healthy: boolean;
  trusted: boolean;
  trades24h: number;
}

export interface SurplusOrderBook {
  model: string;
  offers: SurplusOrderBookOffer[];
}

export interface SurplusOfferWrite {
  model: string;
  apiKey: string;
  sellerBaseUrl: string;
  costMultiplier: number;
  dailyCapUsd: number;
  payoutAddress: string;
  idempotencyKey: string;
}

export interface SurplusOfferPatch {
  costMultiplier: number;
  dailyCapUsd: number;
  idempotencyKey: string;
}

export interface SurplusSale {
  model: string;
  offerId: string | null;
  settlementStatus: string;
  createdAt: string | null;
  sellerCostMicroUsd: number;
}

export interface SurplusEarnings {
  totalEarnedMicroUsd: number;
  pendingMicroUsd: number;
  paidMicroUsd: number;
  recentSales: SurplusSale[];
}

interface SurplusClientOptions {
  apiBaseUrl: string;
  sellerApiKey: string;
  timeoutMs: number;
  fetchFn?: typeof globalThis.fetch;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class SurplusHttpError extends Error {
  readonly status: number | null;
  readonly retryAfter: string | null;

  constructor(message: string, status: number | null, retryAfter: string | null = null) {
    super(message);
    this.name = "SurplusHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }

  get ambiguousMutation(): boolean {
    return this.status === null || this.status >= 500;
  }
}

export class SurplusClient {
  private readonly apiBaseUrl: string;
  private readonly sellerApiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: SurplusClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.sellerApiKey = options.sellerApiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async listAllOffers(): Promise<SurplusOffer[]> {
    const items: SurplusOffer[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    for (;;) {
      const params = new URLSearchParams();
      if (nextToken !== null) params.set("next_token", nextToken);
      const query = params.toString();
      const body = await this.requestJson(`/v1/seller/offers${query ? `?${query}` : ""}`);
      const root = record(body, "Surplus offers response");
      if (!Array.isArray(root.items)) {
        throw new Error("Surplus offers response.items must be an array");
      }
      items.push(...root.items.map((item, index) => parseOffer(item, items.length + index)));
      const rawNext = root.next_token;
      if (rawNext === undefined || rawNext === null || rawNext === "") break;
      if (typeof rawNext !== "string") {
        throw new Error("Surplus offers response.next_token must be a string or null");
      }
      if (seenTokens.has(rawNext)) {
        throw new Error("Surplus offers pagination repeated a next_token");
      }
      seenTokens.add(rawNext);
      nextToken = rawNext;
      if (seenTokens.size > 10_000) {
        throw new Error("Surplus offers pagination exceeded 10000 pages");
      }
    }
    return items;
  }

  async discoverModels(apiKey: string, baseUrl: string): Promise<SurplusDiscoveredModel[]> {
    const response = await this.requestText("/v1/seller/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, base_url: baseUrl }),
    }, true, [apiKey]);
    if (response.text.trim() === "") {
      throw new Error("Surplus discovery returned an empty body");
    }
    return response.text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line, index) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new Error(`Surplus discovery line ${index + 1} was not complete JSON`);
        }
        return parseDiscoveredModel(value, index);
      });
  }

  async getMarkets(): Promise<SurplusMarketSummary[]> {
    const body = await this.requestJson("/api/markets", {}, false);
    const root = record(body, "Surplus markets response");
    if (!Array.isArray(root.markets)) {
      throw new Error("Surplus markets response.markets must be an array");
    }
    return root.markets.map((item, index) => parseMarketSummary(item, index));
  }

  async getOrderBook(model: string): Promise<SurplusOrderBook> {
    const body = await this.requestJson(
      `/api/markets/${encodeURIComponent(model)}`,
      {},
      false,
    );
    const root = record(body, "Surplus order book response");
    const returnedModel = string(root.model, "Surplus order book model");
    if (returnedModel !== model) {
      throw new Error(`Surplus order book returned model ${returnedModel} for ${model}`);
    }
    if (!Array.isArray(root.offers)) {
      throw new Error("Surplus order book response.offers must be an array");
    }
    const ids = new Set<string>();
    const offers = root.offers.map((item, index) => {
      const offer = parseOrderBookOffer(item, index);
      if (ids.has(offer.id)) throw new Error(`Surplus order book repeated offer ${offer.id}`);
      ids.add(offer.id);
      return offer;
    });
    return { model, offers };
  }

  async testConnection(apiKey: string, baseUrl: string, model: string): Promise<number> {
    const body = await this.requestJson("/v1/seller/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, base_url: baseUrl, model }),
    }, true, [apiKey]);
    const root = record(body, "Surplus connection response");
    if (root.ok !== true) throw new Error("Surplus provider connection test failed");
    return nonNegativeNumber(root.latency_ms, "Surplus connection latency_ms");
  }

  async createOffer(input: SurplusOfferWrite): Promise<string> {
    const body = await this.requestJson("/v1/seller/offers", {
      method: "POST",
      headers: mutationHeaders(input.idempotencyKey),
      body: JSON.stringify({
        model: input.model,
        api_key: input.apiKey,
        seller_base_url: input.sellerBaseUrl,
        pricing_mode: "cost_multiplier",
        cost_multiplier: input.costMultiplier,
        cap_daily_usd: input.dailyCapUsd,
        payout_address: input.payoutAddress,
      }),
    }, true, [input.apiKey]);
    const root = record(body, "Surplus create offer response");
    return offerId(root, "Surplus create offer response");
  }

  async updateOffer(id: string, patch: SurplusOfferPatch): Promise<void> {
    await this.requestText(`/v1/seller/offers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: mutationHeaders(patch.idempotencyKey),
      body: JSON.stringify({
        pricing_mode: "cost_multiplier",
        cost_multiplier: patch.costMultiplier,
        cap_daily_usd: patch.dailyCapUsd,
      }),
    });
  }

  async pauseOffer(id: string, idempotencyKey: string): Promise<void> {
    await this.requestText(`/v1/seller/offers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: mutationHeaders(idempotencyKey),
      body: JSON.stringify({ status: "paused" }),
    });
  }

  async resumeOffer(id: string, idempotencyKey: string): Promise<void> {
    await this.requestText(`/v1/seller/offers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: mutationHeaders(idempotencyKey),
      body: JSON.stringify({ status: "active" }),
    });
  }

  async getEarnings(): Promise<SurplusEarnings> {
    const body = await this.requestJson("/v1/seller/earnings?range=lifetime");
    const root = record(body, "Surplus earnings response");
    const rawSales = root.recent_sales;
    if (!Array.isArray(rawSales)) {
      throw new Error("Surplus earnings response.recent_sales must be an array");
    }
    return {
      totalEarnedMicroUsd: microUsd(root.total_earned_usdc, "total_earned_usdc"),
      pendingMicroUsd: microUsd(root.pending_usdc, "pending_usdc"),
      paidMicroUsd: microUsd(root.paid_usdc, "paid_usdc"),
      recentSales: rawSales.map((sale, index) => parseSale(sale, index)),
    };
  }

  private async requestJson(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    additionalSecrets: readonly string[] = [],
  ): Promise<unknown> {
    const response = await this.requestText(
      path,
      init,
      authenticated,
      additionalSecrets,
    );
    if (response.text === "") return {};
    try {
      return JSON.parse(response.text);
    } catch {
      throw new Error(`Surplus ${path} response was not JSON`);
    }
  }

  private async requestText(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    additionalSecrets: readonly string[] = [],
  ): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", `Bearer ${this.sellerApiKey}`);
    try {
      const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      const text = await readBoundedText(response, controller);
      if (!response.ok) {
        throw new SurplusHttpError(
          `Surplus ${path} returned HTTP ${response.status}${
            text
              ? `: ${sanitizedErrorSnippet(
                  text,
                  [this.sellerApiKey, ...additionalSecrets],
                )}`
              : ""
          }`,
          response.status,
          response.headers.get("retry-after"),
        );
      }
      return { status: response.status, text };
    } catch (error) {
      if (error instanceof SurplusHttpError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new SurplusHttpError(`Surplus ${path} request failed: ${detail}`, null);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedText(
  response: Response,
  controller: AbortController,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function mutationHeaders(idempotencyKey: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("idempotency-key", idempotencyKey);
  return headers;
}

function parseOffer(value: unknown, index: number): SurplusOffer {
  const item = record(value, `Surplus offer ${index}`);
  const statusRaw = item.status;
  const status = statusRaw === "active" || item.active === true
    ? "active"
    : statusRaw === "inactive" || statusRaw === "paused" || item.active === false
      ? "inactive"
      : (() => { throw new Error(`Surplus offer ${index}.status was invalid`); })();
  return {
    id: offerId(item, `Surplus offer ${index}`),
    model: string(item.model, `Surplus offer ${index}.model`),
    sellerBaseUrl: string(item.seller_base_url, `Surplus offer ${index}.seller_base_url`),
    status,
    capDailyUsd: optionalNonNegativeNumber(item.cap_daily_usd, `Surplus offer ${index}.cap_daily_usd`),
    costMultiplierPpm: optionalMultiplierPpm(
      item.cost_multiplier,
      `Surplus offer ${index}.cost_multiplier`,
    ),
    inputMicroUsdPer1m: optionalMicroUsd(item.price_input_per_1m, `Surplus offer ${index}.price_input_per_1m`),
    outputMicroUsdPer1m: optionalMicroUsd(item.price_output_per_1m, `Surplus offer ${index}.price_output_per_1m`),
  };
}

function parseDiscoveredModel(value: unknown, index: number): SurplusDiscoveredModel {
  const item = record(value, `Surplus discovery item ${index}`);
  const model = string(item.model, `Surplus discovery item ${index}.model`);
  const supported = boolean(
    item.supported,
    `Surplus discovery item ${index}.supported`,
  );
  const pricing = optionalRecord(item.pricing);
  const metadata = optionalRecord(item.metadata) ?? {};
  return {
    model,
    supported,
    inputUsdPer1m: pricing
      ? optionalNonNegativeNumber(
          pricing.input_per_1m,
          `Surplus discovery item ${index}.pricing.input_per_1m`,
        ) ?? 0
      : 0,
    outputUsdPer1m: pricing
      ? optionalNonNegativeNumber(
          pricing.output_per_1m,
          `Surplus discovery item ${index}.pricing.output_per_1m`,
        ) ?? 0
      : 0,
    priceUnit: pricing
      ? optionalString(pricing.price_unit) ?? "M"
      : "unknown",
    priceVariable: pricing?.price_variable === undefined
      ? false
      : boolean(
          pricing.price_variable,
          `Surplus discovery item ${index}.pricing.price_variable`,
        ),
    providerModelId: optionalString(metadata.provider_model_id) ?? "",
    modelType: optionalString(metadata.model_type) ?? "unknown",
    availabilityStatus:
      optionalString(metadata.availability_status) ?? "unknown",
  };
}

function parseMarketSummary(value: unknown, index: number): SurplusMarketSummary {
  const item = record(value, `Surplus market ${index}`);
  return {
    model: string(item.model, `Surplus market ${index}.model`),
    requests24h: nonNegativeSafeInteger(item.requests_24h, `Surplus market ${index}.requests_24h`),
    volume24h: nonNegativeSafeInteger(item.volume_24h, `Surplus market ${index}.volume_24h`),
    bestInputMicroUsdPer1m: nonNegativeSafeInteger(item.best_input_per_1m, `Surplus market ${index}.best_input_per_1m`),
    bestOutputMicroUsdPer1m: nonNegativeSafeInteger(item.best_output_per_1m, `Surplus market ${index}.best_output_per_1m`),
    healthySellerCount: nonNegativeSafeInteger(item.healthy_seller_count, `Surplus market ${index}.healthy_seller_count`),
  };
}

function parseOrderBookOffer(value: unknown, index: number): SurplusOrderBookOffer {
  const item = record(value, `Surplus order book offer ${index}`);
  return {
    id: offerId(item, `Surplus order book offer ${index}`),
    seller: string(item.seller, `Surplus order book offer ${index}.seller`).toLowerCase(),
    sellerBaseUrl: string(item.seller_base_url, `Surplus order book offer ${index}.seller_base_url`),
    inputMicroUsdPer1m: positiveSafeInteger(item.effective_input_per_1m, `Surplus order book offer ${index}.effective_input_per_1m`),
    outputMicroUsdPer1m: positiveSafeInteger(item.effective_output_per_1m, `Surplus order book offer ${index}.effective_output_per_1m`),
    available: boolean(item.available, `Surplus order book offer ${index}.available`),
    healthy: boolean(item.healthy, `Surplus order book offer ${index}.healthy`),
    trusted: boolean(item.trusted, `Surplus order book offer ${index}.trusted`),
    trades24h: nonNegativeSafeInteger(item.trades_24h, `Surplus order book offer ${index}.trades_24h`),
  };
}

function parseSale(value: unknown, index: number): SurplusSale {
  const item = record(value, `Surplus sale ${index}`);
  return {
    model: string(item.model, `Surplus sale ${index}.model`),
    offerId: optionalString(item.offer_id),
    settlementStatus: string(item.settlement_status, `Surplus sale ${index}.settlement_status`),
    createdAt: optionalString(item.created_at),
    sellerCostMicroUsd: microUsd(item.seller_cost_usdc, `Surplus sale ${index}.seller_cost_usdc`),
  };
}

function offerId(item: Record<string, unknown>, field: string): string {
  const value = item.offer_id ?? item.id;
  return string(value, `${field}.id`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}


function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Optional Surplus object has the wrong type");
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeNumber(value, field);
}

function optionalMultiplierPpm(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
  const ppm = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(ppm) || ppm <= 0) {
    throw new Error(`${field} cannot be represented at six decimal places`);
  }
  return ppm;
}

function sanitizedErrorSnippet(
  value: string,
  secrets: readonly string[],
): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret !== "") sanitized = sanitized.replaceAll(secret, "[redacted]");
  }
  return sanitized
    .replace(/(?:si_seller_|sk-or-v1-)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function microUsd(value: unknown, field: string): number {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return nonNegativeSafeInteger(value, field);
}

function optionalMicroUsd(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return microUsd(value, field);
}

