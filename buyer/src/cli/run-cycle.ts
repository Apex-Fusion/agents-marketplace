/**
 * run-cycle.ts — One full buyer cycle per invocation, then exit.
 *
 *   PostEscrow → wait for supplier Submit → Accept.
 *
 * Designed for cron use: each invocation reads a per-buyer .env file, sends a
 * single prompt to a hardcoded supplier (ADVERT_REF env var), and appends one
 * line to --log-file. No long-lived process, no auto-discovery, no LLM in the
 * loop. See ../../../.claude/plans/i-have-an-instance-ticklish-newt.md.
 *
 * Generalized from buyer/scripts/run-agent-a.ts. The stale-ref workaround
 * (findSubmittedEscrowRef) is lifted verbatim — submitPrompt returns the
 * original Open UTxO, which has already been spent by Claim then Submit, so
 * runAccept needs the current Submitted-state ref looked up via the indexer.
 */

import { appendFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { LiveOgmiosProvider, type ChainProvider, type OutputReference } from "@marketplace/shared/chain";
import { Marketplace, MemoryTaskHistoryStore } from "../sdk/index.js";
import { runAccept } from "./acceptFlow.js";
import { deriveWalletKey } from "../index.js";

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

const ESCROW_REF_RE = /^([0-9a-f]{64})#(\d+)$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DEFAULT_PAYMENT_LOVELACE = 5_000_000n;
const FUND_REQUIRED_LOVELACE = 7_000_000n;
const SUBMITTED_LOOKUP_TIMEOUT_MS = 30_000;

interface CliArgs {
  envPath: string;
  promptText: string;
  paymentLovelace: bigint;
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
      case "--prompt-text":
        if (val === undefined) throw new Error("--prompt-text requires a string");
        args.promptText = val;
        i++;
        break;
      case "--payment-lovelace":
        if (val === undefined) throw new Error("--payment-lovelace requires an integer");
        if (!/^\d+$/.test(val)) throw new Error(`--payment-lovelace must be a non-negative integer (got: ${val})`);
        args.paymentLovelace = BigInt(val);
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
  if (!args.promptText) throw new Error("--prompt-text is required");
  return {
    envPath: args.envPath,
    promptText: args.promptText,
    paymentLovelace: args.paymentLovelace ?? DEFAULT_PAYMENT_LOVELACE,
    logFile: args.logFile ?? null,
    tag: args.tag ?? "",
  };
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

function parseEscrowRef(raw: string): OutputReference {
  const m = ESCROW_REF_RE.exec(raw);
  if (!m) throw new Error(`ADVERT_REF must match <64-hex-txhash>#<index> (got: ${raw})`);
  return { txHash: m[1], index: parseInt(m[2], 10) };
}

interface EscrowView {
  utxo_ref: string;
  buyer_pkh: string;
  prompt_hash: string;
  state: string;
  submitted_at: number | null;
  created_slot: number;
}

async function findSubmittedEscrowRef(
  indexerUrl: string,
  buyerPkh: string,
  promptHash: string,
  timeoutMs: number,
): Promise<OutputReference> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await fetch(`${indexerUrl}/escrows?buyer=${buyerPkh}`);
    if (resp.ok) {
      const rows = (await resp.json()) as EscrowView[];
      const match = rows
        .filter((r) => r.prompt_hash === promptHash && r.state === "Submitted")
        .sort((a, b) => (b.submitted_at ?? 0) - (a.submitted_at ?? 0))[0];
      if (match) {
        const [tx, idxStr] = match.utxo_ref.split("#");
        return { txHash: tx, index: parseInt(idxStr, 10) };
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`indexer: no Submitted escrow with prompt_hash=${promptHash} within ${timeoutMs}ms`);
}

function appendLog(path: string, line: string): void {
  appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`);
}

function shortHex(hex: string, n = 8): string {
  return hex.length <= n ? hex : `${hex.slice(0, n)}…`;
}

async function walletLovelace(chain: ChainProvider, address: string): Promise<bigint> {
  const utxos = await chain.queryUtxosByAddress(address);
  return utxos.reduce((acc, u) => acc + BigInt(u.lovelace), 0n);
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
  for (const required of ["BUYER_PRIV_KEY_HEX", "OGMIOS_URL", "INDEXER_URL", "NETWORK_ID", "ADVERT_REF"]) {
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
    process.stderr.write(`error: NETWORK_ID must be "0" or "1" (got: ${env.NETWORK_ID})\n`);
    return 1;
  }
  const networkId: 0 | 1 = env.NETWORK_ID === "1" ? 1 : 0;
  // Inject loaded vars into process.env so downstream tx-building modules
  // (e.g. lucidContext.ts's VECTOR_ZERO_TIME_MS) see them. The shared tx
  // builders read these from process.env, not the CLI-local env map.
  for (const key of ["VECTOR_ZERO_TIME_MS", "OGMIOS_URL", "INDEXER_URL", "NETWORK_ID"]) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
  const advertRef = parseEscrowRef(env.ADVERT_REF);
  const wk = deriveWalletKey(env.BUYER_PRIV_KEY_HEX, networkId);
  const chain: ChainProvider = new LiveOgmiosProvider({ ogmiosUrl: env.OGMIOS_URL });
  const marketplace = new Marketplace({
    chain,
    indexerUrl: env.INDEXER_URL,
    walletKey: wk,
    networkParams: { networkId },
    historyStore: new MemoryTaskHistoryStore(),
  });

  const ts = (): string => new Date().toISOString();
  const tagPart = args.tag ? `tag=${args.tag} ` : "";
  const logLine = (status: string, extra: string): string =>
    `${ts()} ${status} ${tagPart}addr=${shortHex(wk.address, 12)} supplier_advert=${shortHex(advertRef.txHash)} ${extra}`;

  const balBefore = await walletLovelace(chain, wk.address);
  process.stderr.write(`balance_before=${balBefore} lovelace\n`);
  if (balBefore < FUND_REQUIRED_LOVELACE) {
    const msg = `insufficient funds: have ${balBefore}, need ≥ ${FUND_REQUIRED_LOVELACE}`;
    process.stderr.write(`error: ${msg}\n`);
    if (args.logFile) appendLog(args.logFile, logLine("INSUFFICIENT_FUNDS", `balance=${balBefore}`));
    return 2;
  }

  const tStart = Date.now();
  try {
    const submitResult = await marketplace.submitPrompt({
      advertRef,
      messages: [{ role: "user", content: args.promptText }],
      payment_lovelace: args.paymentLovelace,
    });
    process.stderr.write(`post_escrow_ref=${submitResult.escrowRef.txHash}#${submitResult.escrowRef.index}\n`);
    process.stderr.write(`supplier_pkh=${shortHex(submitResult.receipt.supplier_pkh)} prompt_hash=${shortHex(submitResult.receipt.prompt_hash)}\n`);

    const submittedRef = await findSubmittedEscrowRef(
      env.INDEXER_URL,
      wk.pubKeyHash,
      submitResult.receipt.prompt_hash,
      SUBMITTED_LOOKUP_TIMEOUT_MS,
    );
    process.stderr.write(`submitted_ref=${submittedRef.txHash}#${submittedRef.index}\n`);

    const acceptResult = await runAccept({
      chain,
      walletKey: wk,
      escrowRef: submittedRef,
      log: (line) => process.stderr.write(`[accept] ${line}\n`),
    });
    process.stdout.write(`${acceptResult.txHash}\n`);

    const wallclockMs = Date.now() - tStart;
    const balAfter = await walletLovelace(chain, wk.address);
    const netDelta = balAfter - balBefore;
    process.stderr.write(`balance_after=${balAfter} net_delta=${netDelta} wallclock_ms=${wallclockMs}\n`);

    if (args.logFile) {
      const promptPreview = args.promptText.length <= 60 ? args.promptText : `${args.promptText.slice(0, 60)}…`;
      appendLog(
        args.logFile,
        logLine(
          "OK",
          `accept_tx=${acceptResult.txHash} net_delta=${netDelta} wallclock_ms=${wallclockMs} prompt=${JSON.stringify(promptPreview)}`,
        ),
      );
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wallclockMs = Date.now() - tStart;
    process.stderr.write(`error: ${msg}\n`);
    if (args.logFile) {
      appendLog(args.logFile, logLine("FAIL", `error=${JSON.stringify(msg)} wallclock_ms=${wallclockMs}`));
    }
    return 4;
  }
}

if (process.argv[1]?.endsWith("run-cycle.ts") || process.argv[1]?.endsWith("run-cycle.js")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`run-cycle: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
