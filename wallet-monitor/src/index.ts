/**
 * wallet-monitor/src/index.ts — one-shot wallet-balance Slack alerter.
 *
 * Runs once and exits (invoked hourly by cron via `docker compose run --rm`).
 * For each wallet in wallets.json: query its on-chain balance via Ogmios, and
 * if it's below threshold post a combined Slack alert. A persisted state file
 * dedups so a still-low wallet only re-alerts every `reminder_hours`, and a
 * recovery message fires when a wallet climbs back above its threshold.
 *
 * Reuses ReadOnlyOgmiosProvider from @marketplace/shared/chain — the same
 * client behind the buyer's /v1/wallet/balance and buyer/scripts/monitor-wallets.ts.
 */
/* eslint-disable no-console */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { ReadOnlyOgmiosProvider } from "@marketplace/shared/chain";
import { loadConfig, parseWalletsFile, type WalletEntry } from "./config.js";
import { postSlack } from "./slack.js";

const LOVELACE_PER_AP3X = 1_000_000;
const MS_PER_HOUR = 3_600_000;

type Status = "ok" | "low";

interface WalletState {
  status: Status;
  /** Epoch ms of the last alert we successfully posted for this wallet. */
  lastAlertMs: number;
}

type StateFile = Record<string, WalletState>;

interface CheckedWallet {
  name: string;
  address: string;
  minLovelace: bigint;
  /** null when the balance query failed. */
  lovelace: bigint | null;
  error: string | null;
}

// ── helpers ───────────────────────────────────────────────────────────────

function ap3xToLovelace(ap3x: number): bigint {
  return BigInt(Math.round(ap3x * LOVELACE_PER_AP3X));
}

function fmtAp3x(lovelace: bigint): string {
  return (Number(lovelace) / LOVELACE_PER_AP3X).toFixed(2);
}

function shortAddr(a: string): string {
  return a.length <= 18 ? a : `${a.slice(0, 10)}…${a.slice(-6)}`;
}

function loadState(path: string): StateFile {
  try {
    const obj: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as StateFile;
    }
    return {};
  } catch {
    // Missing / unreadable / malformed state → start clean.
    return {};
  }
}

function saveState(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path); // atomic replace
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);

  // TEST mode: confirm the webhook works, then exit.
  if (cfg.testMode) {
    const r = await postSlack(
      cfg.slackWebhookUrl,
      "✅ *wallet-monitor configured* — test message from the vector-marketplace box.",
    );
    if (!r.ok) {
      console.error(`[wallet-monitor] test Slack post failed: ${r.error}`);
      process.exitCode = 1;
      return;
    }
    console.log("[wallet-monitor] test Slack post ok");
    return;
  }

  const walletsFile = parseWalletsFile(
    JSON.parse(readFileSync(cfg.walletsPath, "utf-8")) as unknown,
  );
  const defaultMinAp3x = cfg.defaultMinAp3xOverride ?? walletsFile.defaultMinAp3x;
  const reminderMs = (cfg.reminderHoursOverride ?? walletsFile.reminderHours) * MS_PER_HOUR;

  const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: cfg.ogmiosUrl });

  const checked: CheckedWallet[] = await Promise.all(
    walletsFile.wallets.map(async (w: WalletEntry): Promise<CheckedWallet> => {
      const minLovelace = ap3xToLovelace(w.minAp3x ?? defaultMinAp3x);
      try {
        const utxos = await provider.queryUtxosByAddress(w.address);
        const lovelace = utxos.reduce((a, u) => a + BigInt(u.lovelace), 0n);
        return { name: w.name, address: w.address, minLovelace, lovelace, error: null };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[wallet-monitor] query failed for ${w.name} (${w.address}): ${error}`);
        return { name: w.name, address: w.address, minLovelace, lovelace: null, error };
      }
    }),
  );

  const anyQueryFailed = checked.some((c) => c.error !== null);

  const prevState = loadState(cfg.statePath);
  const now = Date.now();
  const nextState: StateFile = { ...prevState };

  const lowLines: string[] = [];
  const recoveredLines: string[] = [];

  for (const c of checked) {
    // Skip wallets we couldn't query — leave their state untouched so we don't
    // mistake an Ogmios blip for a recovery.
    if (c.error !== null || c.lovelace === null) continue;

    const prev = prevState[c.name];
    const isLow = c.lovelace < c.minLovelace;

    if (isLow) {
      const wasLow = prev?.status === "low";
      const due = !wasLow || now - (prev?.lastAlertMs ?? 0) >= reminderMs;
      if (due) {
        lowLines.push(
          `🔴 ${c.name}  ${fmtAp3x(c.lovelace)} / ${fmtAp3x(c.minLovelace)} APEX  ${shortAddr(c.address)}`,
        );
        nextState[c.name] = { status: "low", lastAlertMs: now };
      } else {
        // Still low but the reminder window hasn't elapsed — keep prev as-is.
        nextState[c.name] = prev ?? { status: "low", lastAlertMs: now };
      }
    } else {
      if (prev?.status === "low") {
        recoveredLines.push(`✅ ${c.name}  ${fmtAp3x(c.lovelace)} APEX (recovered)`);
      }
      nextState[c.name] = { status: "ok", lastAlertMs: prev?.lastAlertMs ?? 0 };
    }
  }

  const needPost = lowLines.length > 0 || recoveredLines.length > 0;

  if (needPost) {
    const title =
      lowLines.length > 0
        ? "⚠️ *Wallet balance alert* — vector-marketplace"
        : "✅ *Wallet balance recovered* — vector-marketplace";
    const text = [title, ...lowLines, ...recoveredLines].join("\n");

    const r = await postSlack(cfg.slackWebhookUrl, text);
    if (!r.ok) {
      // Leave state untouched so the alert retries next run.
      console.error(`[wallet-monitor] Slack post failed (state unchanged): ${r.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[wallet-monitor] posted: ${lowLines.length} low, ${recoveredLines.length} recovered`);
  } else {
    console.log("[wallet-monitor] all wallets healthy — no Slack post");
  }

  // Persist the new state (records ok/low statuses + advanced reminder stamps).
  // Only reached when there was nothing to post or the post succeeded.
  saveState(cfg.statePath, nextState);

  if (anyQueryFailed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[wallet-monitor] fatal:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
