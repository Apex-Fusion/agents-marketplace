/**
 * wallet-monitor/src/index.ts — one-shot wallet-balance Slack alerter.
 *
 * Runs once and exits (invoked hourly by cron via `docker compose run --rm`).
 * For each wallet in wallets.json: query its on-chain balance via Ogmios, and
 * post a combined Slack alert ONLY when something changed since the last run —
 * a wallet newly dropped below threshold, or climbed back above it. A wallet
 * that merely stays low never re-posts (state persisted across runs).
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

  // Classify each successfully-queried wallet. The decision to POST is driven
  // only by state CHANGES (a wallet newly dropping low, or recovering) — a
  // wallet that stays low never re-posts. But when we DO post, the message
  // lists EVERY monitored wallet for full context (built below).
  let anyNewlyLow = false;
  let anyRecovered = false;
  const recoveredNames = new Set<string>();

  for (const c of checked) {
    // Skip wallets we couldn't query — leave their state untouched so we don't
    // mistake an Ogmios blip for a recovery.
    if (c.error !== null || c.lovelace === null) continue;

    const prev = prevState[c.name];
    const isLow = c.lovelace < c.minLovelace;

    if (isLow) {
      if (prev?.status === "low") {
        // Still low — already alerted when it dropped; stay silent.
        nextState[c.name] = prev;
      } else {
        anyNewlyLow = true;
        nextState[c.name] = { status: "low", lastAlertMs: now };
      }
    } else {
      if (prev?.status === "low") {
        anyRecovered = true;
        recoveredNames.add(c.name);
      }
      nextState[c.name] = { status: "ok", lastAlertMs: prev?.lastAlertMs ?? 0 };
    }
  }

  const needPost = anyNewlyLow || anyRecovered;

  if (needPost) {
    const anyLow = checked.some(
      (c) => c.error === null && c.lovelace !== null && c.lovelace < c.minLovelace,
    );
    const title = anyLow
      ? "⚠️ *Wallet balance alert* — vector-marketplace"
      : "✅ *Wallet balance recovered* — vector-marketplace";

    // Full roster — every monitored wallet (low first, then healthy, then any
    // that failed to query), each with its FULL address backticked so it's
    // copy-pasteable in Slack.
    const low: string[] = [];
    const ok: string[] = [];
    const failed: string[] = [];
    for (const c of checked) {
      if (c.error !== null || c.lovelace === null) {
        failed.push(`⚠️ ${c.name}  query failed\n   \`${c.address}\``);
      } else if (c.lovelace < c.minLovelace) {
        low.push(
          `🔴 ${c.name}  ${fmtAp3x(c.lovelace)} / ${fmtAp3x(c.minLovelace)} APEX\n   \`${c.address}\``,
        );
      } else {
        const tag = recoveredNames.has(c.name) ? " (recovered)" : "";
        ok.push(`🟢 ${c.name}  ${fmtAp3x(c.lovelace)} APEX${tag}\n   \`${c.address}\``);
      }
    }
    const text = [title, ...low, ...ok, ...failed].join("\n");

    const r = await postSlack(cfg.slackWebhookUrl, text);
    if (!r.ok) {
      // Leave state untouched so the alert retries next run.
      console.error(`[wallet-monitor] Slack post failed (state unchanged): ${r.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `[wallet-monitor] posted roster: ${low.length} low, ${ok.length} ok, ${failed.length} failed`,
    );
  } else {
    const lowCount = checked.filter(
      (c) => c.error === null && c.lovelace !== null && c.lovelace < c.minLovelace,
    ).length;
    console.log(
      lowCount > 0
        ? `[wallet-monitor] ${lowCount} wallet(s) still low (already alerted) — no change, no Slack post`
        : "[wallet-monitor] all wallets healthy — no Slack post",
    );
  }

  // Persist the new state (records ok/low statuses + alert stamps).
  // Only reached when there was nothing to post or the post succeeded.
  saveState(cfg.statePath, nextState);

  if (anyQueryFailed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[wallet-monitor] fatal:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
