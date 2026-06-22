/**
 * buyer/src/config.ts — env loading for buyer app.
 *
 * Required env vars:
 *   BUYER_PRIV_KEY_HEX  — 32-byte (64-char) hex Ed25519 private key
 *   INDEXER_URL         — base URL of the indexer (e.g. http://localhost:3001)
 *   BUYER_PASSWORD      — plaintext password for the operator login screen.
 *                         Single-operator gate: anyone who knows this password
 *                         can drive the buyer (spend funds via /v1/submit-prompt
 *                         etc). Treat with the same care as BUYER_PRIV_KEY_HEX.
 *   SESSION_SECRET      — HMAC key for signing the buyer_session cookie.
 *                         Must be ≥ 32 chars. Generate with `openssl rand -hex 32`.
 *
 * Optional:
 *   BUYER_PORT          — port to listen on (default 3002)
 *   NETWORK_ID          — "0" (testnet) or "1" (mainnet), default "0"
 *   OGMIOS_URL          — Ogmios HTTP endpoint (required iff LIVE_CHAIN=1)
 *   LIVE_CHAIN          — "1" opts in to LiveOgmiosProvider (real submitTx).
 *                         Default off → ReadOnlyOgmiosProvider (safe).
 *   COOKIE_SECURE       — "1" (default) sets Secure on the session cookie so
 *                         it's only sent over HTTPS. Set "0" for plain-HTTP
 *                         local dev over loopback.
 *   TTS_PIPER_BASE_URL  — Base URL of the openedai-speech-min PiperTTS host.
 *                         When unset, /v1/synth-speech responds 503 (the
 *                         capability stays disabled — the rest of the
 *                         buyer-app boots normally).
 *   OPENROUTER_API_KEY  — Bearer token for the free Kimi K2.6 chat demo
 *                         (/v1/chat-demo/message). When unset, the demo
 *                         endpoint responds 503 (the paid chat path is
 *                         unaffected — it talks to on-chain suppliers).
 *   OPENROUTER_BASE_URL — Base URL for the demo proxy (default
 *                         "https://openrouter.ai/api"; the "/v1/chat/completions"
 *                         suffix is appended by the proxy).
 *   ARCHIVE_DIR         — Directory where the response archive (SQLite
 *                         metadata + per-escrow artefact files) lives.
 *                         Defaults to "./data/archive" relative to cwd.
 *                         When unset, archive is disabled (responses are
 *                         not persisted; /v1/responses* return 503).
 *   GATEWAY_PUBLIC_URL  — Public base URL of the OpenAI-compatible gateway
 *                         (e.g. https://api.marketplace.vector.apexfusion.org).
 *                         Injected into the SPA boot block so the "Generate
 *                         API key" page knows where to POST /signup. When
 *                         unset, the SPA falls back to deriving "api." +
 *                         current host.
 */

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const POS_INT_RE = /^[1-9]\d*$/;
const SESSION_SECRET_MIN_LEN = 32;

export interface BuyerConfig {
  privKeyHex: string;
  indexerUrl: string;
  port: number;
  networkId: 0 | 1;
  ogmiosUrl: string;
  liveChain: boolean;
  ttsPiperBaseUrl: string;
  openrouterApiKey: string;
  openrouterBaseUrl: string;
  archiveDir: string;
  password: string;
  sessionSecret: string;
  cookieSecure: boolean;
  gatewayPublicUrl: string;
}

function requireField(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`loadConfig: missing required env var ${name}`);
  }
  return v;
}

export function loadConfig(env: Record<string, string | undefined>): BuyerConfig {
  const privKeyHex = requireField(env, "BUYER_PRIV_KEY_HEX");
  if (!HEX64_RE.test(privKeyHex)) {
    throw new Error("loadConfig: BUYER_PRIV_KEY_HEX must be 64 hex chars (32 bytes)");
  }
  const indexerUrl = requireField(env, "INDEXER_URL");

  let port = 3002;
  const portStr = env.BUYER_PORT;
  if (portStr !== undefined && portStr !== "") {
    if (!POS_INT_RE.test(portStr)) {
      throw new Error("loadConfig: BUYER_PORT must be a positive integer");
    }
    port = Number(portStr);
  }

  let networkId: 0 | 1 = 0;
  const networkIdStr = env.NETWORK_ID;
  if (networkIdStr !== undefined && networkIdStr !== "") {
    if (networkIdStr !== "0" && networkIdStr !== "1") {
      throw new Error('loadConfig: NETWORK_ID must be "0" (testnet) or "1" (mainnet)');
    }
    networkId = networkIdStr === "1" ? 1 : 0;
  }

  // LIVE_CHAIN: only the literal "1" opts in. Mirrors supplier/src/config.ts
  // semantics so the boot model is symmetric across the two services.
  const liveChain = env.LIVE_CHAIN === "1";

  // OGMIOS_URL is required iff LIVE_CHAIN=1 (the LiveOgmiosProvider needs an
  // endpoint to submit/await against). In ReadOnly mode it's not strictly
  // needed, but we still accept it so the config has a stable shape.
  const ogmiosUrl = env.OGMIOS_URL ?? "";
  if (liveChain && ogmiosUrl === "") {
    throw new Error("loadConfig: OGMIOS_URL is required when LIVE_CHAIN=1");
  }

  // TTS_PIPER_BASE_URL is purely optional — empty string means the
  // /v1/synth-speech endpoint stays disabled. We don't validate the URL
  // shape here; an unreachable URL surfaces as a clear 502 from the proxy.
  const ttsPiperBaseUrl = env.TTS_PIPER_BASE_URL ?? "";

  // OPENROUTER_API_KEY — optional. Empty string disables the free Kimi chat
  // demo (/v1/chat-demo/message responds 503). The base URL defaults to the
  // public OpenRouter host; the proxy appends "/v1/chat/completions".
  const openrouterApiKey = env.OPENROUTER_API_KEY ?? "";
  const openrouterBaseUrl = (env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api").replace(/\/+$/, "");

  // ARCHIVE_DIR — host path (typically a docker bind-mount) where the
  // response archive lives. Default is a per-process relative dir to keep
  // dev ergonomics; in production the compose file overrides to a
  // bind-mounted /repo/data/archive.
  const archiveDir = env.ARCHIVE_DIR ?? "./data/archive";

  const password = requireField(env, "BUYER_PASSWORD");
  const sessionSecret = requireField(env, "SESSION_SECRET");
  if (sessionSecret.length < SESSION_SECRET_MIN_LEN) {
    throw new Error(
      `loadConfig: SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LEN} chars (generate with: openssl rand -hex 32)`,
    );
  }

  // COOKIE_SECURE: defaults to true. Operators running the buyer-app behind
  // a plain-HTTP loopback for local dev set "0" so the cookie still rides
  // along (browsers drop Secure cookies on http://). Accept only "0" / "1"
  // to keep boot-time misconfig loud.
  let cookieSecure = true;
  const cookieSecureStr = env.COOKIE_SECURE;
  if (cookieSecureStr !== undefined && cookieSecureStr !== "") {
    if (cookieSecureStr !== "0" && cookieSecureStr !== "1") {
      throw new Error('loadConfig: COOKIE_SECURE must be "0" or "1"');
    }
    cookieSecure = cookieSecureStr === "1";
  }

  // GATEWAY_PUBLIC_URL — optional. Public base URL of the gateway, surfaced to
  // the SPA via the boot block (no trailing slash). Empty string means the SPA
  // derives the URL from its own host ("api." + location.host).
  const gatewayPublicUrl = (env.GATEWAY_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

  return {
    privKeyHex,
    indexerUrl,
    port,
    networkId,
    ogmiosUrl,
    liveChain,
    ttsPiperBaseUrl,
    openrouterApiKey,
    openrouterBaseUrl,
    archiveDir,
    password,
    sessionSecret,
    cookieSecure,
    gatewayPublicUrl,
  };
}
