/**
 * reclaim-orphans.ts — Scan the indexer for this buyer's Open/Claimed escrows
 * and reclaim every one whose deliver_by has passed.
 *
 * Cron-friendly: exits 0 even if no orphans; logs each attempt to --log-file.
 * Generalized from buyer/scripts/reclaim-orphans.ts (which hard-coded refs).
 */

import { appendFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { LiveOgmiosProvider, type ChainProvider, type OutputReference } from "@marketplace/shared/chain";
import { buildReclaimTx, TxConstructionError } from "@marketplace/shared/tx";
import { deriveWalletKey } from "../index.js";

ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const x of m) h.update(x);
  return new Uint8Array(h.digest());
};

const HEX64_RE = /^[0-9a-f]{64}$/;
const AWAIT_TIMEOUT_MS = 120_000;

interface CliArgs {
  envPath: string;
  logFile: string | null;
  tag: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { logFile: null, tag: "" };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const val = argv[i + 1];
    switch (tok) {
      case "--env":
        if (val === undefined) throw new Error("--env requires a path");
        args.envPath = val;
        i++;
        break;
      case "--log-file":
        if (val === undefined) throw new Error("--log-file requires a path");
        args.logFile = val;
        i++;
        break;
      case "--tag":
        if (val === undefined) throw new Error("--tag requires a string");
        args.tag = val;
        i++;
        break;
      default:
        throw new Error(`unknown flag: ${tok}`);
    }
  }
  if (!args.envPath) throw new Error("--env is required");
  return { envPath: args.envPath, logFile: args.logFile ?? null, tag: args.tag ?? "" };
}

function loadDotEnv(path: string): Record<string, string> {
  const text = readFileSync(path, "utf-8");
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

interface EscrowView {
  utxo_ref: string;
  buyer_pkh: string;
  state: string;
}

function shortHex(hex: string, n = 8): string {
  return hex.length <= n ? hex : `${hex.slice(0, n)}…`;
}

function appendLog(path: string, line: string): void {
  appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`);
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const env = loadDotEnv(args.envPath);
  for (const required of ["BUYER_PRIV_KEY_HEX", "OGMIOS_URL", "INDEXER_URL", "NETWORK_ID"]) {
    if (!env[required]) {
      process.stderr.write(`error: ${args.envPath} is missing ${required}\n`);
      return 1;
    }
  }
  if (!HEX64_RE.test(env.BUYER_PRIV_KEY_HEX)) {
    process.stderr.write("error: BUYER_PRIV_KEY_HEX must be 64 lowercase hex chars\n");
    return 1;
  }
  if (env.NETWORK_ID !== "0" && env.NETWORK_ID !== "1") {
    process.stderr.write(`error: NETWORK_ID must be "0" or "1"\n`);
    return 1;
  }
  const networkId: 0 | 1 = env.NETWORK_ID === "1" ? 1 : 0;
  // Inject loaded vars into process.env so shared tx builders see them
  // (e.g. lucidContext.ts's VECTOR_ZERO_TIME_MS). See run-cycle.ts for context.
  for (const key of ["VECTOR_ZERO_TIME_MS", "OGMIOS_URL", "INDEXER_URL", "NETWORK_ID"]) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }

  const wk = deriveWalletKey(env.BUYER_PRIV_KEY_HEX, networkId);
  const chain: ChainProvider = new LiveOgmiosProvider({ ogmiosUrl: env.OGMIOS_URL });

  const ts = (): string => new Date().toISOString();
  const tagPart = args.tag ? `tag=${args.tag} ` : "";

  const resp = await fetch(`${env.INDEXER_URL}/escrows?buyer=${wk.pubKeyHash}`);
  if (!resp.ok) {
    process.stderr.write(`error: indexer GET /escrows returned ${resp.status}\n`);
    return 1;
  }
  const rows = (await resp.json()) as EscrowView[];
  const reclaimable = rows.filter((r) => r.state === "Open" || r.state === "Claimed");
  process.stderr.write(`found ${reclaimable.length} reclaimable rows (Open|Claimed) of ${rows.length} total\n`);

  let attempted = 0;
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of reclaimable) {
    const [tx, idxStr] = row.utxo_ref.split("#");
    const escrowRef: OutputReference = { txHash: tx, index: parseInt(idxStr, 10) };
    attempted++;
    try {
      const built = await buildReclaimTx({ chain, buyerKey: wk, escrowRef });
      process.stderr.write(`reclaim ${row.utxo_ref} -> tx ${built.expectedTxHash} (${row.state})\n`);
      await chain.awaitTx(built.expectedTxHash, AWAIT_TIMEOUT_MS);
      succeeded++;
      if (args.logFile) {
        appendLog(
          args.logFile,
          `${ts()} RECLAIM_OK ${tagPart}escrow=${shortHex(escrowRef.txHash)}#${escrowRef.index} state=${row.state} reclaim_tx=${built.expectedTxHash}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof TxConstructionError && err.message.includes("reclaim before deliver_by")) {
        skipped++;
        process.stderr.write(`skip ${row.utxo_ref}: not yet past deliver_by\n`);
        // Don't log not-yet-expired skips — they're noise; cron runs hourly.
      } else {
        failed++;
        process.stderr.write(`reclaim ${row.utxo_ref} FAILED: ${msg}\n`);
        if (args.logFile) {
          appendLog(
            args.logFile,
            `${ts()} RECLAIM_FAIL ${tagPart}escrow=${shortHex(escrowRef.txHash)}#${escrowRef.index} state=${row.state} error=${JSON.stringify(msg)}`,
          );
        }
      }
    }
  }

  process.stderr.write(`summary: attempted=${attempted} succeeded=${succeeded} skipped=${skipped} failed=${failed}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("reclaim-orphans.ts") || process.argv[1]?.endsWith("reclaim-orphans.js")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`reclaim-orphans: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
