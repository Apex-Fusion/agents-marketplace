/**
 * buyer/src/config.ts — env loading for buyer app.
 *
 * Required env vars:
 *   BUYER_PRIV_KEY_HEX  — 32-byte (64-char) hex Ed25519 private key
 *   INDEXER_URL         — base URL of the indexer (e.g. http://localhost:3001)
 *
 * Optional:
 *   BUYER_PORT          — port to listen on (default 3002)
 *   NETWORK_ID          — "0" (testnet) or "1" (mainnet), default "0"
 *   OGMIOS_URL          — Ogmios HTTP endpoint (required iff LIVE_CHAIN=1)
 *   LIVE_CHAIN          — "1" opts in to LiveOgmiosProvider (real submitTx).
 *                         Default off → ReadOnlyOgmiosProvider (safe).
 */

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const POS_INT_RE = /^[1-9]\d*$/;

export interface BuyerConfig {
  privKeyHex: string;
  indexerUrl: string;
  port: number;
  networkId: 0 | 1;
  ogmiosUrl: string;
  liveChain: boolean;
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

  return { privKeyHex, indexerUrl, port, networkId, ogmiosUrl, liveChain };
}
