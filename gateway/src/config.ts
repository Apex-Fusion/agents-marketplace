/**
 * gateway/src/config.ts — env loading for the OpenAI-compatible gateway.
 *
 * Mirrors buyer/src/config.ts conventions (requireField, HEX64_RE, LIVE_CHAIN
 * semantics) but for a multi-tenant, custodial service. See docs/gateway.md.
 *
 * Required:
 *   GATEWAY_MASTER_KEY  — 64-char hex (32 bytes). AES-256-GCM key wrapping every
 *                         user's custodial wallet private key at rest. Losing it
 *                         permanently locks all user funds.
 *   INDEXER_URL         — internal indexer base URL.
 *   OGMIOS_URL          — Ogmios HTTP endpoint (required; the gateway submits txs).
 *
 * Optional:
 *   LIVE_CHAIN          — must be "1" (the gateway always needs a live provider).
 *   NETWORK_ID          — "0" testnet (default) | "1" mainnet.
 *   GATEWAY_PORT        — default 3010.
 *   GATEWAY_DB_DIR      — default "./data/gateway".
 *   GATEWAY_ADMIN_TOKEN — server-only token for the operator key list.
 *                         At least 32 chars; unset disables the list.
 *   SIGNUP_RATE_MAX / SIGNUP_RATE_WINDOW_MS  — per-IP signup limiter.
 *   KEY_RATE_MAX / KEY_RATE_WINDOW_MS        — per-key request limiter.
 *   SWEEPER_INTERVAL_MS / WALLET_HEALTH_INTERVAL_MS — background tick cadences.
 *   SDK_REGISTRY_MAX    — max cached per-key Marketplace instances (LRU).
 *   ONE_SHOT_CONCURRENCY — active paid LLM jobs per key (default 4).
 *   ONE_SHOT_MAX_OUTSTANDING — active + queued + recovering jobs per key (default 64).
 *   ONE_SHOT_QUEUE_TIMEOUT_MS — wait for admission before spending (default 60000).
 *   MCP_IP_RATE_MAX / MCP_IP_RATE_WINDOW_MS — public /mcp requests per IP (default 120/min).
 *   MCP_CALL_IP_RATE_MAX / MCP_CALL_IP_RATE_WINDOW_MS — tools/call per IP (default 20/min).
 *   MCP_CALL_IP_CONCURRENCY — tools/call in flight per IP (default 1).
 *   MCP_CALL_CONCURRENCY — tool calls in flight for the gateway (default 2).
 *   MCP_CALL_QUEUE_TIMEOUT_MS — wait for a free tool slot (default 60000).
 *   MCP_CATALOG_TTL_MS — cache time of the tools/list catalog (default 30000).
 *   PAPER2AGENT_TOOL_CALL_TOKEN — shared secret for free tool calls through the
 *                         publisher. At least 32 chars; unset disables tools/call.
 *   PAPER2AGENT_PUBLISHER_PUBLIC_URL — the publisher's public base URL, the same
 *                         value as the publisher's. /mcp lists only tools whose
 *                         advert endpoint is under <url>/tools/, so the token
 *                         never goes to another host. Required with the token.
 *   GATEWAY_CORS_ORIGINS — comma-separated allowlist of browser Origins that may
 *                         call the gateway cross-origin (e.g. the marketplace
 *                         frontend's "Generate API key" page). Default empty =
 *                         CORS off (no Access-Control-* headers emitted).
 */

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const POS_INT_RE = /^[1-9]\d*$/;
const PKH_RE = /^[0-9a-fA-F]{56}$/;

export interface GatewayConfig {
  masterKeyHex: string;
  indexerUrl: string;
  ogmiosUrl: string;
  networkId: 0 | 1;
  liveChain: boolean;
  port: number;
  dbDir: string;
  adminToken?: string;
  signupRate: { max: number; windowMs: number };
  keyRate: { max: number; windowMs: number };
  demoIpRate: { max: number; windowMs: number };
  sweeperIntervalMs: number;
  /** Close demo chat sessions idle this long (frees the supplier slot).
   * Keep below the supplier's CHAT_IDLE_TIMEOUT_MS so the gateway closes
   * first and records usage. */
  demoSessionIdleMs: number;
  /** Chat-session settlement mode this deployment runs. "full" = suppliers
   * Claim/Submit and the gateway Accepts; "ticket" = the escrow post at open
   * is the only chain op and the sweeper Reclaims it after deliver_by.
   * Must agree with the suppliers' CHAT_SETTLE_MODE. */
  chatSettleMode: "full" | "ticket";
  walletHealthIntervalMs: number;
  sdkRegistryMax: number;
  oneShotConcurrency: number;
  oneShotMaxOutstanding: number;
  oneShotQueueTimeoutMs: number;
  mcpIpRate: { max: number; windowMs: number };
  mcpCallIpRate: { max: number; windowMs: number };
  mcpCallIpConcurrency: number;
  mcpCallConcurrency: number;
  mcpCallQueueTimeoutMs: number;
  mcpCatalogTtlMs: number;
  /** Bearer token for the publisher's free tool-call route. Unset disables tools/call. */
  paper2agentToolCallToken?: string;
  /** `<PAPER2AGENT_PUBLISHER_PUBLIC_URL>/tools/`: the only endpoint prefix that /mcp lists and calls. */
  paper2agentToolEndpointPrefix?: string;
  corsOrigins: string[];
  /** Capability id the /v1/ocr/extract route escrows against. Model-scoped
   * per the marketplace convention (one model, one id). Env: OCR_CAPABILITY_ID. */
  ocrCapabilityId: string;
  /** Seller preferred for matching one-shot models. Other suppliers remain fallback. */
  preferredSupplierPkh?: string;
}

function requireField(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`loadConfig: missing required env var ${name}`);
  }
  return v;
}

function chatSettleMode(env: Record<string, string | undefined>): "full" | "ticket" {
  const v = env.CHAT_SETTLE_MODE ?? "full";
  if (v !== "full" && v !== "ticket") {
    throw new Error('loadConfig: CHAT_SETTLE_MODE must be "full" or "ticket"');
  }
  return v;
}

function posInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  if (!POS_INT_RE.test(v)) {
    throw new Error(`loadConfig: ${name} must be a positive integer`);
  }
  return Number(v);
}

/** `<publisher URL>/tools/` in normalized form, or undefined when the URL is unset. */
function paper2AgentToolEndpointPrefix(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" ||
      url.search !== "" || url.hash !== "") {
    throw new Error("loadConfig: PAPER2AGENT_PUBLISHER_PUBLIC_URL must be an http(s) URL without credentials, query or fragment");
  }
  return `${url.href.replace(/\/+$/, "")}/tools/`;
}

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const masterKeyHex = requireField(env, "GATEWAY_MASTER_KEY");
  if (!HEX64_RE.test(masterKeyHex)) {
    throw new Error(
      "loadConfig: GATEWAY_MASTER_KEY must be 64 hex chars (32 bytes); generate with: openssl rand -hex 32",
    );
  }
  const adminToken = (env.GATEWAY_ADMIN_TOKEN ?? "").trim();
  if (adminToken !== "" && adminToken.length < 32) {
    throw new Error("loadConfig: GATEWAY_ADMIN_TOKEN must be at least 32 chars");
  }
  const toolCallToken = (env.PAPER2AGENT_TOOL_CALL_TOKEN ?? "").trim();
  if (toolCallToken !== "" && toolCallToken.length < 32) {
    throw new Error("loadConfig: PAPER2AGENT_TOOL_CALL_TOKEN must be at least 32 chars");
  }
  const toolEndpointPrefix = paper2AgentToolEndpointPrefix(env.PAPER2AGENT_PUBLISHER_PUBLIC_URL ?? "");
  if (toolCallToken !== "" && toolEndpointPrefix === undefined) {
    throw new Error("loadConfig: PAPER2AGENT_PUBLISHER_PUBLIC_URL is required with PAPER2AGENT_TOOL_CALL_TOKEN");
  }

  const indexerUrl = requireField(env, "INDEXER_URL").replace(/\/+$/, "");

  // The gateway always posts/settles escrows, so a live provider is mandatory.
  const liveChain = env.LIVE_CHAIN === "1";
  const ogmiosUrl = env.OGMIOS_URL ?? "";
  if (!liveChain) {
    throw new Error("loadConfig: LIVE_CHAIN=1 is required (the gateway submits transactions)");
  }
  if (ogmiosUrl === "") {
    throw new Error("loadConfig: OGMIOS_URL is required when LIVE_CHAIN=1");
  }

  let networkId: 0 | 1 = 0;
  const networkIdStr = env.NETWORK_ID;
  if (networkIdStr !== undefined && networkIdStr !== "") {
    if (networkIdStr !== "0" && networkIdStr !== "1") {
      throw new Error('loadConfig: NETWORK_ID must be "0" (testnet) or "1" (mainnet)');
    }
    networkId = networkIdStr === "1" ? 1 : 0;
  }
  const preferredSupplierPkhRaw =
    (env.GATEWAY_PREFERRED_SUPPLIER_PKH ?? "").trim();
  if (
    preferredSupplierPkhRaw !== "" &&
    !PKH_RE.test(preferredSupplierPkhRaw)
  ) {
    throw new Error(
      "loadConfig: GATEWAY_PREFERRED_SUPPLIER_PKH must be a 28-byte hex payment-key hash",
    );
  }


  return {
    masterKeyHex,
    adminToken: adminToken || undefined,
    indexerUrl,
    ogmiosUrl,
    networkId,
    liveChain,
    port: posInt(env, "GATEWAY_PORT", 3010),
    dbDir: env.GATEWAY_DB_DIR ?? "./data/gateway",
    signupRate: {
      max: posInt(env, "SIGNUP_RATE_MAX", 5),
      windowMs: posInt(env, "SIGNUP_RATE_WINDOW_MS", 60 * 60 * 1000),
    },
    keyRate: {
      max: posInt(env, "KEY_RATE_MAX", 60),
      windowMs: posInt(env, "KEY_RATE_WINDOW_MS", 60 * 1000),
    },
    demoIpRate: {
      max: posInt(env, "DEMO_IP_RATE_MAX", 20),
      windowMs: posInt(env, "DEMO_IP_RATE_WINDOW_MS", 60 * 1000),
    },
    sweeperIntervalMs: posInt(env, "SWEEPER_INTERVAL_MS", 60 * 1000),
    demoSessionIdleMs: posInt(env, "DEMO_SESSION_IDLE_MS", 3 * 60 * 1000),
    chatSettleMode: chatSettleMode(env),
    walletHealthIntervalMs: posInt(env, "WALLET_HEALTH_INTERVAL_MS", 10 * 60 * 1000),
    sdkRegistryMax: posInt(env, "SDK_REGISTRY_MAX", 500),
    oneShotConcurrency: posInt(env, "ONE_SHOT_CONCURRENCY", 4),
    oneShotMaxOutstanding: posInt(env, "ONE_SHOT_MAX_OUTSTANDING", 64),
    oneShotQueueTimeoutMs: posInt(env, "ONE_SHOT_QUEUE_TIMEOUT_MS", 60_000),
    mcpIpRate: {
      max: posInt(env, "MCP_IP_RATE_MAX", 120),
      windowMs: posInt(env, "MCP_IP_RATE_WINDOW_MS", 60 * 1000),
    },
    mcpCallIpRate: {
      max: posInt(env, "MCP_CALL_IP_RATE_MAX", 20),
      windowMs: posInt(env, "MCP_CALL_IP_RATE_WINDOW_MS", 60 * 1000),
    },
    mcpCallIpConcurrency: posInt(env, "MCP_CALL_IP_CONCURRENCY", 1),
    mcpCallConcurrency: posInt(env, "MCP_CALL_CONCURRENCY", 2),
    mcpCallQueueTimeoutMs: posInt(env, "MCP_CALL_QUEUE_TIMEOUT_MS", 60_000),
    mcpCatalogTtlMs: posInt(env, "MCP_CATALOG_TTL_MS", 30_000),
    paper2agentToolCallToken: toolCallToken || undefined,
    paper2agentToolEndpointPrefix: toolEndpointPrefix,
    ocrCapabilityId: env.OCR_CAPABILITY_ID ?? "ocr.page.extract.chandra-ocr-2.v1",
    preferredSupplierPkh: preferredSupplierPkhRaw === ""
      ? undefined
      : preferredSupplierPkhRaw.toLowerCase(),
    corsOrigins: (env.GATEWAY_CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter((o) => o !== ""),
  };
}
