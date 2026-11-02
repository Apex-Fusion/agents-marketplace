/**
 * reclaim-orphans.ts — Scan the indexer for this buyer's unfinished escrows
 * and return their funds to the buyer.
 *
 * Both escrow layouts (Part 2 §6.1, §9.6), per escrow (recoverEscrow):
 *   - a new escrow whose agent record is Revoked or Retired (Open or
 *     Claimed), or Revoked with invalid_from ≤ submitted_at (Submitted):
 *     RefundRevoked, before or after deliver_by;
 *   - else an Open or Claimed escrow whose deliver_by has passed: Reclaim.
 *
 * Cron-friendly: exits 0 even if no orphans; logs each attempt to --log-file.
 * Generalized from buyer/scripts/reclaim-orphans.ts (which hard-coded refs).
 */

import { appendFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { LiveOgmiosProvider, type ChainProvider, type OutputReference } from "@marketplace/shared/chain";
import { buildReclaimTx, buildRefundRevokedTx, TxConstructionError, type WalletKey } from "@marketplace/shared/tx";
import { deriveWalletKey } from "../index.js";
import { Marketplace } from "../sdk/Marketplace.js";
import { decodeEscrow, type BuyerIdentity } from "../sdk/identity.js";

ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const x of m) h.update(x);
  return new Uint8Array(h.digest());
};

const HEX64_RE = /^[0-9a-f]{64}$/;
const AWAIT_TIMEOUT_MS = 120_000;
/** Builder refusals that mean "not yet" or "not this way"; the next run tries again. */
const SKIP_REASONS: Record<string, true> = { "reclaim before deliver_by": true, "refund not allowed": true };

export interface RecoverEscrowParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  escrowRef: OutputReference;
  identity: BuyerIdentity;
}

/**
 * Builds and submits the transaction that returns one escrow to its buyer:
 * RefundRevoked when the escrow is new and RefundRevoked applies to its agent
 * record now, else Reclaim. Throws TxConstructionError "refund not allowed"
 * for a Submitted escrow of a live agent, and the builder's errors (for
 * example "reclaim before deliver_by").
 */
export async function recoverEscrow(
  params: RecoverEscrowParams,
): Promise<{ action: "RefundRevoked" | "Reclaim"; txHash: string }> {
  const { chain, walletKey, escrowRef, identity } = params;
  const utxo = await chain.queryUtxo(escrowRef);
  if (!utxo?.datumHex) {
    throw new TxConstructionError("escrow ref not on chain", `no escrow UTxO at ${escrowRef.txHash}#${escrowRef.index}`);
  }
  const escrow = decodeEscrow(utxo.datumHex);
  if (escrow.layout === "identity" && await identity.refundRevokedAllowed(escrow.datum)) {
    const built = await buildRefundRevokedTx({
      chain, walletKey, escrowRef, lookupRecord: identity.lookupRecord, identityBlueprint: identity.identityBlueprint,
    });
    return { action: "RefundRevoked", txHash: built.expectedTxHash };
  }
  if (escrow.datum.state === "Submitted") {
    throw new TxConstructionError(
      "refund not allowed",
      "a Submitted escrow returns to the buyer only by RefundRevoked, and its agent is not revoked",
    );
  }
  const built = await buildReclaimTx({
    chain, buyerKey: walletKey, escrowRef, identityBlueprint: identity.identityBlueprint,
  });
  return { action: "Reclaim", txHash: built.expectedTxHash };
}

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
  /** "legacy" | "identity"; absent from an indexer before identity support. */
  layout?: string;
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
  // (e.g. lucidContext.ts's VECTOR_ZERO_TIME_MS, the identity blueprint's
  // IDENTITY_POLICY_ID). See run-cycle.ts for context.
  for (const key of [
    "VECTOR_ZERO_TIME_MS", "OGMIOS_URL", "INDEXER_URL", "NETWORK_ID", "IDENTITY_POLICY_ID", "IDENTITY_ESCROW_REF_UTXO",
  ]) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }

  const wk = deriveWalletKey(env.BUYER_PRIV_KEY_HEX, networkId);
  const chain: ChainProvider = new LiveOgmiosProvider({ ogmiosUrl: env.OGMIOS_URL });
  const { identity } = new Marketplace({ chain, indexerUrl: env.INDEXER_URL, walletKey: wk, networkParams: { networkId } });

  const ts = (): string => new Date().toISOString();
  const tagPart = args.tag ? `tag=${args.tag} ` : "";

  const resp = await fetch(`${env.INDEXER_URL}/escrows?buyer=${wk.pubKeyHash}`);
  if (!resp.ok) {
    process.stderr.write(`error: indexer GET /escrows returned ${resp.status}\n`);
    return 1;
  }
  const rows = (await resp.json()) as EscrowView[];
  // A Submitted new escrow can still return by RefundRevoked (Part 2 §6.1).
  const candidates = rows.filter((r) =>
    r.state === "Open" || r.state === "Claimed" || (r.state === "Submitted" && r.layout === "identity"));
  process.stderr.write(`found ${candidates.length} candidate rows (Open|Claimed, new Submitted) of ${rows.length} total\n`);

  let attempted = 0;
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of candidates) {
    const [tx, idxStr] = row.utxo_ref.split("#");
    const escrowRef: OutputReference = { txHash: tx, index: parseInt(idxStr, 10) };
    attempted++;
    try {
      const { action, txHash } = await recoverEscrow({ chain, walletKey: wk, escrowRef, identity });
      process.stderr.write(`${action} ${row.utxo_ref} -> tx ${txHash} (${row.state})\n`);
      await chain.awaitTx(txHash, AWAIT_TIMEOUT_MS);
      succeeded++;
      if (args.logFile) {
        const result = action === "Reclaim" ? "RECLAIM_OK" : "REFUND_REVOKED_OK";
        const txField = action === "Reclaim" ? "reclaim_tx" : "refund_tx";
        appendLog(
          args.logFile,
          `${ts()} ${result} ${tagPart}escrow=${shortHex(escrowRef.txHash)}#${escrowRef.index} state=${row.state} ${txField}=${txHash}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof TxConstructionError && SKIP_REASONS[err.reason]) {
        skipped++;
        process.stderr.write(`skip ${row.utxo_ref}: ${err.reason}\n`);
        // Don't log not-yet-expired skips — they're noise; cron runs hourly.
      } else {
        failed++;
        process.stderr.write(`recover ${row.utxo_ref} FAILED: ${msg}\n`);
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

// Run only as the CLI itself: scripts (also buyer/scripts/reclaim-orphans.ts) import recoverEscrow.
if (/[\\/]cli[\\/]reclaim-orphans\.(t|j)s$/.test(process.argv[1] ?? "")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`reclaim-orphans: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
