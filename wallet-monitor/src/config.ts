/**
 * wallet-monitor/src/config.ts — env + wallets-file loading.
 *
 * Env vars:
 *   SLACK_WEBHOOK_URL  — (required) Slack Incoming Webhook URL to post alerts to.
 *   OGMIOS_URL         — Ogmios HTTP endpoint. Default mainnet public endpoint.
 *   WALLETS_PATH       — path to wallets.json. Default /repo/wallet-monitor/wallets.json.
 *   STATE_PATH         — path to the dedup state file (read/written each run).
 *                        Default /repo/wallet-monitor/data/state.json.
 *   DEFAULT_MIN_AP3X   — (optional) overrides wallets.json default_min_ap3x.
 *   REMINDER_HOURS     — (optional) overrides wallets.json reminder_hours.
 *   TEST               — "1" posts a one-line "configured" message to Slack and exits.
 *
 * wallets.json owns the wallet list + the default threshold / reminder cadence;
 * the env overrides exist only so an operator can retune without editing the
 * mounted wallets file.
 */

const DEFAULT_OGMIOS_URL = "https://ogmios.vector.mainnet.apexfusion.org";
const DEFAULT_WALLETS_PATH = "/repo/wallet-monitor/wallets.json";
const DEFAULT_STATE_PATH = "/repo/wallet-monitor/data/state.json";

const FALLBACK_DEFAULT_MIN_AP3X = 10;
const FALLBACK_REMINDER_HOURS = 6;

export interface EnvConfig {
  slackWebhookUrl: string;
  ogmiosUrl: string;
  walletsPath: string;
  statePath: string;
  /** When set, overrides the wallets-file default_min_ap3x. */
  defaultMinAp3xOverride: number | null;
  /** When set, overrides the wallets-file reminder_hours. */
  reminderHoursOverride: number | null;
  testMode: boolean;
}

export interface WalletEntry {
  name: string;
  address: string;
  /** Per-wallet threshold override (APEX). Falls back to the file default. */
  minAp3x?: number;
}

export interface WalletsFile {
  defaultMinAp3x: number;
  reminderHours: number;
  wallets: WalletEntry[];
}

function requireField(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`loadConfig: missing required env var ${name}`);
  }
  return v;
}

function nonEmpty(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const v = env[name];
  return v !== undefined && v !== "" ? v : fallback;
}

function parseOptionalPositiveNumber(
  raw: string | undefined,
  name: string,
): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`loadConfig: ${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): EnvConfig {
  const slackWebhookUrl = requireField(env, "SLACK_WEBHOOK_URL");
  return {
    slackWebhookUrl,
    ogmiosUrl: nonEmpty(env, "OGMIOS_URL", DEFAULT_OGMIOS_URL),
    walletsPath: nonEmpty(env, "WALLETS_PATH", DEFAULT_WALLETS_PATH),
    statePath: nonEmpty(env, "STATE_PATH", DEFAULT_STATE_PATH),
    defaultMinAp3xOverride: parseOptionalPositiveNumber(env.DEFAULT_MIN_AP3X, "DEFAULT_MIN_AP3X"),
    reminderHoursOverride: parseOptionalPositiveNumber(env.REMINDER_HOURS, "REMINDER_HOURS"),
    testMode: env.TEST === "1",
  };
}

// ── wallets.json parsing ─────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePositiveNumberField(raw: unknown, label: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`wallets.json: ${label} must be a positive number`);
  }
  return raw;
}

/**
 * Validate + normalise the parsed wallets.json. Pure (takes already-parsed
 * JSON) so it's easy to unit-test. Snake_case JSON keys → camelCase fields.
 */
export function parseWalletsFile(raw: unknown): WalletsFile {
  if (!isObject(raw)) {
    throw new Error("wallets.json: top-level value must be an object");
  }
  const defaultMinAp3x = parsePositiveNumberField(
    raw.default_min_ap3x,
    "default_min_ap3x",
    FALLBACK_DEFAULT_MIN_AP3X,
  );
  const reminderHours = parsePositiveNumberField(
    raw.reminder_hours,
    "reminder_hours",
    FALLBACK_REMINDER_HOURS,
  );

  const walletsRaw = raw.wallets;
  if (!Array.isArray(walletsRaw) || walletsRaw.length === 0) {
    throw new Error("wallets.json: 'wallets' must be a non-empty array");
  }

  const seen = new Set<string>();
  const wallets: WalletEntry[] = walletsRaw.map((w, i) => {
    if (!isObject(w)) {
      throw new Error(`wallets.json: wallets[${i}] must be an object`);
    }
    const name = w.name;
    const address = w.address;
    if (typeof name !== "string" || name === "") {
      throw new Error(`wallets.json: wallets[${i}].name must be a non-empty string`);
    }
    if (typeof address !== "string" || !address.startsWith("addr")) {
      throw new Error(`wallets.json: wallets[${i}].address must be a bech32 address (addr…)`);
    }
    if (seen.has(name)) {
      throw new Error(`wallets.json: duplicate wallet name "${name}"`);
    }
    seen.add(name);

    const entry: WalletEntry = { name, address };
    if (w.min_ap3x !== undefined) {
      if (typeof w.min_ap3x !== "number" || !Number.isFinite(w.min_ap3x) || w.min_ap3x <= 0) {
        throw new Error(`wallets.json: wallets[${i}].min_ap3x must be a positive number`);
      }
      entry.minAp3x = w.min_ap3x;
    }
    return entry;
  });

  return { defaultMinAp3x, reminderHours, wallets };
}
