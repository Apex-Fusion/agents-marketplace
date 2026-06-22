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
 *   SIGNUP_RATE_MAX / SIGNUP_RATE_WINDOW_MS  — per-IP signup limiter.
 *   KEY_RATE_MAX / KEY_RATE_WINDOW_MS        — per-key request limiter.
 *   SWEEPER_INTERVAL_MS / WALLET_HEALTH_INTERVAL_MS — background tick cadences.
 *   SDK_REGISTRY_MAX    — max cached per-key Marketplace instances (LRU).
 *   GATEWAY_CORS_ORIGINS — comma-separated allowlist of browser Origins that may
 *                         call the gateway cross-origin (e.g. the marketplace
 *                         frontend's "Generate API key" page). Default empty =
 *                         CORS off (no Access-Control-* headers emitted).
 */

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const POS_INT_RE = /^[1-9]\d*$/;

export interface GatewayConfig {
  masterKeyHex: string;
  indexerUrl: string;
  ogmiosUrl: string;
  networkId: 0 | 1;
  liveChain: boolean;
  port: number;
  dbDir: string;
  signupRate: { max: number; windowMs: number };
  keyRate: { max: number; windowMs: number };
  sweeperIntervalMs: number;
  walletHealthIntervalMs: number;
  sdkRegistryMax: number;
  corsOrigins: string[];
}

function requireField(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`loadConfig: missing required env var ${name}`);
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

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const masterKeyHex = requireField(env, "GATEWAY_MASTER_KEY");
  if (!HEX64_RE.test(masterKeyHex)) {
    throw new Error(
      "loadConfig: GATEWAY_MASTER_KEY must be 64 hex chars (32 bytes); generate with: openssl rand -hex 32",
    );
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

  return {
    masterKeyHex,
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
    sweeperIntervalMs: posInt(env, "SWEEPER_INTERVAL_MS", 60 * 1000),
    walletHealthIntervalMs: posInt(env, "WALLET_HEALTH_INTERVAL_MS", 10 * 60 * 1000),
    sdkRegistryMax: posInt(env, "SDK_REGISTRY_MAX", 500),
    corsOrigins: (env.GATEWAY_CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter((o) => o !== ""),
  };
}
