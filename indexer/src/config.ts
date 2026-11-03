/**
 * indexer/src/config.ts — environment loading for the indexer.
 *
 * loadConfig(env) is a PURE function: it reads from the supplied env map,
 * validates required fields, and returns a typed config object.
 * This makes it trivially testable without process.env mutation.
 *
 * Required env vars:
 *   OGMIOS_URL      — WebSocket URL for Ogmios (e.g. ws://localhost:1337)
 *   DB_PATH         — path to the SQLite database file
 *   NETWORK_ID      — "0" (Vector testnet) | "1" (Vector mainnet)
 *
 * SPEC FIX 2026-04-27: NETWORK_ID standardized across all services to the
 * numeric string form "0"|"1" (mapped to NetworkId 0|1). This aligns the
 * indexer with supplier/buyer (previous indexer-side drift used the labels
 * "testnet"/"mainnet"). Legacy values are now rejected.
 *
 * Optional env vars (with defaults):
 *   INDEXER_PORT                — HTTP port (default 8090)
 *   STATUS_POLL_MS              — status poll interval in ms (default 20000)
 *   SKIP_BEFORE_SLOT            — skip blocks before this slot (default 0)
 *   OGMIOS_RESPONSE_TIMEOUT_MS  — watchdog timeout; reconnect Ogmios WS if no
 *                                 response in this window (default 90000, 0 = off)
 *   MAX_SYNC_LAG_SLOTS          — GET /healthz reports ok: false when the indexer is
 *                                 more slots than this behind the chain tip (default 600)
 *   ADVERT_SCRIPT_ADDRESS       — legacy advert address (unset: not watched)
 *   ESCROW_SCRIPT_ADDRESS       — legacy escrow address (unset: not watched)
 *
 * Identity registry (Part 2 §6.4). Set all of them, or none:
 *   IDENTITY_POLICY_ID             — identity registry policy ID (56 hex)
 *   IDENTITY_ADVERT_SCRIPT_ADDRESS — new advert address (enterprise script address)
 *   IDENTITY_ESCROW_SCRIPT_ADDRESS — new escrow address (enterprise script address)
 *   IDENTITY_GATEWAY_URL           — internal identity gateway origin (http or https)
 * Optional with them:
 *   IDENTITY_ADDRESS        — identity address; default and required value: the
 *                             enterprise address of IDENTITY_POLICY_ID on NETWORK_ID
 *   IDENTITY_REFRESH_MS     — ask the gateway again after this time (default 60000,
 *                             1000 ≤ value < 600000)
 *   IDENTITY_LOAD_AT_START  — "1": load the current outputs at the identity address
 *                             from Ogmios at each start (backfill, default off)
 *   SWITCH_SLOT             — switch slot (§9.6): from it on, legacy adverts are not listed
 * Resync (one time per point):
 *   RESYNC_FROM_SLOT, RESYNC_FROM_BLOCK_HASH — a block of the current chain. The
 *                             state after it goes, and the follower reads the later
 *                             blocks again. Uses: the backfill before the identity
 *                             deployment, and the recovery when the node has none of
 *                             the saved blocks (GET /healthz follower "no_intersection").
 */

import type { NetworkId } from "@marketplace/shared";
import { plutusAddressFromBech32, plutusAddressToBech32, type PlutusAddress } from "@marketplace/shared/cbor";
import { DEFAULT_REFRESH_MS } from "./identity/refresher.js";
import { IDENTITY_RESULT_MAX_AGE_MS } from "./listing/rule.js";
import { DEFAULT_MAX_SYNC_LAG_SLOTS } from "./routes/healthz.js";

export interface IdentityConfig {
  policyId: string;
  /** Identity address `IA`: the enterprise address of `policyId`. */
  address: string;
  advertAddress: string;
  escrowAddress: string;
  gatewayUrl: string;
  refreshMs: number;
  loadAtStart: boolean;
}

export interface IndexerConfig {
  ogmiosUrl: string;
  dbPath: string;
  networkId: NetworkId;
  indexerPort: number;
  statusPollMs: number;
  skipBeforeSlot: number;
  ogmiosResponseTimeoutMs: number;
  /** GET /healthz reports ok: false above this lag (slots behind the chain tip). */
  maxSyncLagSlots: number;
  /**
   * Optional path to the bundled indexer-ui dist directory. When set, the
   * Express app mounts static assets + SPA catch-all so the same process
   * serves both API and dashboard. When unset, the indexer is API-only.
   * NOT validated at config-load time — directory existence is checked at
   * server startup (or implicitly by express.static / sendFile).
   */
  uiDistDir?: string;
  /** Legacy advert address; "" when not watched. */
  advertAddress: string;
  /** Legacy escrow address; "" when not watched. */
  escrowAddress: string;
  /** null: identity support off (the state before the identity deployment). */
  identity: IdentityConfig | null;
  /** Switch slot (§9.6); null: legacy adverts stay listed. */
  switchSlot: number | null;
  /** Resync point (§6.4 backfill); null: none. */
  resyncFrom: { slot: number; blockHash: string } | null;
}

const POLICY_ID_RE = /^[0-9a-f]{56}$/;
const BLOCK_HASH_RE = /^[0-9a-f]{64}$/;
const IDENTITY_KEYS = [
  "IDENTITY_ADDRESS",
  "IDENTITY_ADVERT_SCRIPT_ADDRESS",
  "IDENTITY_ESCROW_SCRIPT_ADDRESS",
  "IDENTITY_GATEWAY_URL",
  "IDENTITY_REFRESH_MS",
  "IDENTITY_LOAD_AT_START",
  "SWITCH_SLOT",
] as const;

function parseNonNegativeInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`loadConfig: ${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** A set, non-empty value; undefined for an unset or empty variable. */
function value(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

function enterpriseScriptAddress(name: string, raw: string, networkId: NetworkId): string {
  const address = raw.toLowerCase();
  let parsed: PlutusAddress;
  try {
    parsed = plutusAddressFromBech32(address);
  } catch (err) {
    throw new Error(`loadConfig: ${name} is not a bech32 address: ${(err as Error).message}`);
  }
  if (
    parsed.paymentCredential.type !== "Script" ||
    parsed.stakeCredential !== null ||
    plutusAddressToBech32(parsed, networkId) !== address
  ) {
    throw new Error(`loadConfig: ${name} must be an enterprise script address on NETWORK_ID ${networkId}`);
  }
  return address;
}

function parseBoolean(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new Error(`loadConfig: ${name} must be "1", "true", "0" or "false", got ${JSON.stringify(raw)}`);
}

function loadIdentity(env: Record<string, string | undefined>, networkId: NetworkId): IdentityConfig | null {
  const policyId = value(env, "IDENTITY_POLICY_ID");
  if (policyId === undefined) {
    const stray = IDENTITY_KEYS.find((k) => value(env, k) !== undefined);
    if (stray) throw new Error(`loadConfig: ${stray} needs IDENTITY_POLICY_ID`);
    return null;
  }
  if (!POLICY_ID_RE.test(policyId)) {
    throw new Error("loadConfig: IDENTITY_POLICY_ID must be 56 lowercase hexadecimal characters");
  }
  const required = (name: string): string => {
    const v = value(env, name);
    if (v === undefined) throw new Error(`loadConfig: ${name} is required with IDENTITY_POLICY_ID`);
    return v;
  };

  const derived = plutusAddressToBech32(
    { paymentCredential: { type: "Script", hash: policyId }, stakeCredential: null },
    networkId,
  );
  const configured = value(env, "IDENTITY_ADDRESS");
  if (configured !== undefined && configured.toLowerCase() !== derived) {
    throw new Error(`loadConfig: IDENTITY_ADDRESS must be the enterprise address of IDENTITY_POLICY_ID (${derived})`);
  }

  const gatewayUrl = required("IDENTITY_GATEWAY_URL");
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new Error(`loadConfig: IDENTITY_GATEWAY_URL is not a URL: ${JSON.stringify(gatewayUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("loadConfig: IDENTITY_GATEWAY_URL must use http or https");
  }

  const refreshRaw = value(env, "IDENTITY_REFRESH_MS");
  const refreshMs = refreshRaw === undefined ? DEFAULT_REFRESH_MS : parseNonNegativeInt("IDENTITY_REFRESH_MS", refreshRaw);
  if (refreshMs < 1_000 || refreshMs >= IDENTITY_RESULT_MAX_AGE_MS) {
    throw new Error(`loadConfig: IDENTITY_REFRESH_MS must be at least 1000 and below ${IDENTITY_RESULT_MAX_AGE_MS}`);
  }

  return {
    policyId,
    address: derived,
    advertAddress: enterpriseScriptAddress("IDENTITY_ADVERT_SCRIPT_ADDRESS", required("IDENTITY_ADVERT_SCRIPT_ADDRESS"), networkId),
    escrowAddress: enterpriseScriptAddress("IDENTITY_ESCROW_SCRIPT_ADDRESS", required("IDENTITY_ESCROW_SCRIPT_ADDRESS"), networkId),
    gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
    refreshMs,
    loadAtStart: parseBoolean("IDENTITY_LOAD_AT_START", value(env, "IDENTITY_LOAD_AT_START")),
  };
}

export function loadConfig(env: Record<string, string | undefined>): IndexerConfig {
  const ogmiosUrl = env.OGMIOS_URL;
  const dbPath = env.DB_PATH;
  const networkIdRaw = env.NETWORK_ID;

  if (!ogmiosUrl) {
    throw new Error("loadConfig: OGMIOS_URL is required");
  }
  if (!dbPath) {
    throw new Error("loadConfig: DB_PATH is required");
  }
  if (!networkIdRaw) {
    throw new Error("loadConfig: NETWORK_ID is required");
  }
  let networkId: NetworkId;
  if (networkIdRaw === "0") {
    networkId = 0;
  } else if (networkIdRaw === "1") {
    networkId = 1;
  } else {
    throw new Error(
      `loadConfig: NETWORK_ID must be "0" (Vector testnet) or "1" (Vector mainnet), ` +
      `got ${JSON.stringify(networkIdRaw)}`,
    );
  }

  const indexerPort = env.INDEXER_PORT !== undefined
    ? parseNonNegativeInt("INDEXER_PORT", env.INDEXER_PORT)
    : 8090;

  const statusPollMs = env.STATUS_POLL_MS !== undefined
    ? parseNonNegativeInt("STATUS_POLL_MS", env.STATUS_POLL_MS)
    : 20_000;

  const skipBeforeSlot = env.SKIP_BEFORE_SLOT !== undefined
    ? parseNonNegativeInt("SKIP_BEFORE_SLOT", env.SKIP_BEFORE_SLOT)
    : 0;

  const ogmiosResponseTimeoutMs = env.OGMIOS_RESPONSE_TIMEOUT_MS !== undefined
    ? parseNonNegativeInt("OGMIOS_RESPONSE_TIMEOUT_MS", env.OGMIOS_RESPONSE_TIMEOUT_MS)
    : 90_000;

  const maxSyncLagRaw = value(env, "MAX_SYNC_LAG_SLOTS");
  const maxSyncLagSlots = maxSyncLagRaw === undefined
    ? DEFAULT_MAX_SYNC_LAG_SLOTS
    : parseNonNegativeInt("MAX_SYNC_LAG_SLOTS", maxSyncLagRaw);

  // Optional INDEXER_UI_DIST: any non-empty string is accepted; directory
  // existence is checked at startup, not here. Absent → undefined (API-only).
  const uiDistDir = typeof env.INDEXER_UI_DIST === "string" && env.INDEXER_UI_DIST.length > 0
    ? env.INDEXER_UI_DIST
    : undefined;

  const advertAddress = value(env, "ADVERT_SCRIPT_ADDRESS") ?? "";
  const escrowAddress = value(env, "ESCROW_SCRIPT_ADDRESS") ?? "";
  const identity = loadIdentity(env, networkId);

  const watched = [advertAddress, escrowAddress, identity?.advertAddress, identity?.escrowAddress, identity?.address]
    .filter((a): a is string => typeof a === "string" && a.length > 0);
  if (new Set(watched).size !== watched.length) {
    throw new Error("loadConfig: the watched script addresses must all differ");
  }

  const switchRaw = value(env, "SWITCH_SLOT");
  const switchSlot = switchRaw === undefined ? null : parseNonNegativeInt("SWITCH_SLOT", switchRaw);

  const resyncSlot = value(env, "RESYNC_FROM_SLOT");
  const resyncHash = value(env, "RESYNC_FROM_BLOCK_HASH");
  let resyncFrom: IndexerConfig["resyncFrom"] = null;
  if (resyncSlot !== undefined || resyncHash !== undefined) {
    if (resyncSlot === undefined || resyncHash === undefined) {
      throw new Error("loadConfig: RESYNC_FROM_SLOT and RESYNC_FROM_BLOCK_HASH go together");
    }
    if (!BLOCK_HASH_RE.test(resyncHash)) {
      throw new Error("loadConfig: RESYNC_FROM_BLOCK_HASH must be 64 lowercase hexadecimal characters");
    }
    const slot = parseNonNegativeInt("RESYNC_FROM_SLOT", resyncSlot);
    if (slot < skipBeforeSlot) {
      throw new Error("loadConfig: RESYNC_FROM_SLOT must not be below SKIP_BEFORE_SLOT");
    }
    resyncFrom = { slot, blockHash: resyncHash };
  }

  return {
    ogmiosUrl,
    dbPath,
    networkId,
    indexerPort,
    statusPollMs,
    skipBeforeSlot,
    ogmiosResponseTimeoutMs,
    maxSyncLagSlots,
    uiDistDir,
    advertAddress,
    escrowAddress,
    identity,
    switchSlot,
    resyncFrom,
  };
}
