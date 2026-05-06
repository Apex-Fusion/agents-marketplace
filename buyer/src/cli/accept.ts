/**
 * accept.ts — CLI entry point for `pnpm --filter @marketplace/buyer tx:accept`.
 *
 * Closes the M1-F demoable lifecycle: posts an Accept tx (Submitted → Accepted,
 * terminal) for an on-chain escrow that the supplier has already submitted a
 * receipt for. Distributes payment + supplier_bond to the supplier and returns
 * buyer_bond to the buyer.
 *
 * Exports:
 *   parseCliArgs(argv, env) — pure argument parser, testable without spawning.
 *   main(argv, env)         — wires LiveOgmiosProvider, calls runAccept,
 *                             writes tx hash to stdout / progress to stderr.
 *
 * Argument parsing uses Node stdlib only (no commander / yargs). Unknown
 * flags throw. Mirrors supplier/src/cli/post-advert.ts so the operational
 * surface is symmetric.
 */

import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import {
  LiveOgmiosProvider,
  MockChainProvider,
  type ChainProvider,
  type OutputReference,
} from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import { runAccept } from "./acceptFlow.js";

// Wire ed25519 sha512 hook (idempotent — matches buyer/src/index.ts).
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

// ─── Types ───────────────────────────────────────────────────────────────

export type NetworkId = 0 | 1;

export interface CliConfig {
  ogmiosUrl: string;
  privKeyHex: string;
  networkId: NetworkId;
  escrowRef: OutputReference;
  awaitTimeoutMs: number;
  dryRun: boolean;
  useMock: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────

const HEX64_RE = /^[0-9a-f]{64}$/;
const ESCROW_REF_RE = /^([0-9a-f]{64})#(\d+)$/;
const TESTNET_OGMIOS_DEFAULT = "https://ogmios.vector.testnet.apexfusion.org";
const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;

const VALUE_FLAGS = new Set<string>([
  "--ogmios-url",
  "--priv-key",
  "--escrow-ref",
  "--await-timeout-ms",
]);
const BOOL_FLAGS = new Set<string>(["--dry-run", "--mock"]);

// ─── Helpers ─────────────────────────────────────────────────────────────

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function parseIntStrict(name: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer (got: ${raw})`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer (got: ${raw})`);
  }
  return n;
}

function parseEscrowRef(raw: string): OutputReference {
  const m = ESCROW_REF_RE.exec(raw);
  if (!m) {
    throw new Error(
      `--escrow-ref / ESCROW_REF must match <64-hex-txhash>#<index> (got: ${raw})`,
    );
  }
  const idx = Number(m[2]);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`--escrow-ref index must be a non-negative integer (got: ${m[2]})`);
  }
  return { txHash: m[1], index: idx };
}

interface RawFlags {
  ogmiosUrl?: string;
  privKey?: string;
  escrowRef?: string;
  awaitTimeoutMs?: string;
  dryRun: boolean;
  useMock: boolean;
}

function parseRawArgv(argv: string[]): RawFlags {
  const out: RawFlags = { dryRun: false, useMock: false };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (BOOL_FLAGS.has(tok)) {
      if (tok === "--dry-run") out.dryRun = true;
      else if (tok === "--mock") out.useMock = true;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error(`flag ${tok} requires a value`);
      }
      switch (tok) {
        case "--ogmios-url":
          out.ogmiosUrl = val;
          break;
        case "--priv-key":
          out.privKey = val;
          break;
        case "--escrow-ref":
          out.escrowRef = val;
          break;
        case "--await-timeout-ms":
          out.awaitTimeoutMs = val;
          break;
      }
      i++;
      continue;
    }
    throw new Error(`unknown flag: ${tok}`);
  }

  return out;
}

// ─── parseCliArgs ────────────────────────────────────────────────────────

/**
 * parseCliArgs — pure: argv (process.argv.slice(2)) + env map → CliConfig.
 *
 * Rules (mirror post-advert.ts where possible):
 *   - Unknown flags throw Error("unknown flag: <flag>").
 *   - Missing required env vars throw Error naming the missing var.
 *   - --priv-key / BUYER_PRIV_KEY_HEX must be 64 hex chars.
 *   - --escrow-ref / ESCROW_REF must match <64-hex>#<int>.
 *   - NETWORK_ID not "0" or "1" → throws.
 *   - OGMIOS_URL absent with NETWORK_ID="0" → defaults to public Vector
 *     testnet Ogmios. Absent with NETWORK_ID="1" → throws.
 */
export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): CliConfig {
  const flags = parseRawArgv(argv);

  const networkIdRaw = requireEnv(env, "NETWORK_ID");
  if (networkIdRaw !== "0" && networkIdRaw !== "1") {
    throw new Error(
      `NETWORK_ID must be "0" (testnet) or "1" (mainnet), got: ${networkIdRaw}`,
    );
  }
  const networkId: NetworkId = networkIdRaw === "1" ? 1 : 0;

  const privKeyHex = flags.privKey ?? requireEnv(env, "BUYER_PRIV_KEY_HEX");
  if (!HEX64_RE.test(privKeyHex)) {
    throw new Error(
      "BUYER_PRIV_KEY_HEX (or --priv-key) must be 64 lowercase hex chars",
    );
  }

  let ogmiosUrl: string;
  if (flags.ogmiosUrl !== undefined) {
    ogmiosUrl = flags.ogmiosUrl;
  } else if (env.OGMIOS_URL !== undefined && env.OGMIOS_URL !== "") {
    ogmiosUrl = env.OGMIOS_URL;
  } else if (networkId === 0) {
    ogmiosUrl = TESTNET_OGMIOS_DEFAULT;
  } else {
    throw new Error(
      "OGMIOS_URL is required when NETWORK_ID=1 (no public mainnet default)",
    );
  }

  const escrowRefRaw = flags.escrowRef ?? requireEnv(env, "ESCROW_REF");
  const escrowRef = parseEscrowRef(escrowRefRaw);

  const awaitTimeoutMs =
    flags.awaitTimeoutMs === undefined
      ? DEFAULT_AWAIT_TIMEOUT_MS
      : parseIntStrict("--await-timeout-ms", flags.awaitTimeoutMs);

  return {
    ogmiosUrl,
    privKeyHex,
    networkId,
    escrowRef,
    awaitTimeoutMs,
    dryRun: flags.dryRun,
    useMock: flags.useMock,
  };
}

// ─── Wallet derivation (matches buyer/src/index.ts) ──────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function deriveWalletKey(privHex: string, networkId: NetworkId): WalletKey {
  const priv = hexToBytes(privHex);
  const pub = ed.getPublicKey(priv);
  const pubHex = bytesToHex(pub);
  const pkh = blake2b(pub, { dkLen: 28 });
  const pkhHex = bytesToHex(pkh);
  const header = networkId === 0 ? 0x60 : 0x61;
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(pkh, 1);
  const words = bech32.toWords(payload);
  const hrp = networkId === 0 ? "addr_test" : "addr";
  const addr = bech32.encode(hrp, words, 1023);
  return {
    pubKeyHash: pkhHex,
    pubKeyHex: pubHex,
    privateKeyHex: privHex,
    address: addr,
  };
}

// ─── main ────────────────────────────────────────────────────────────────

/**
 * main — CLI entry point.
 *
 * Success: prints "<txHash>\n" to stdout. All progress lines go to stderr.
 * Failure: prints "error: <message>\n" to stderr; the caller decides exit code.
 */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  let cfg: CliConfig;
  try {
    cfg = parseCliArgs(argv, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }

  let walletKey: WalletKey;
  try {
    walletKey = deriveWalletKey(cfg.privKeyHex, cfg.networkId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: wallet derivation failed: ${msg}\n`);
    return 1;
  }

  const chain: ChainProvider = cfg.useMock
    ? new MockChainProvider()
    : new LiveOgmiosProvider({ ogmiosUrl: cfg.ogmiosUrl });

  if (cfg.dryRun) {
    process.stdout.write(
      `dry-run: escrowRef=${cfg.escrowRef.txHash}#${cfg.escrowRef.index} buyer=${walletKey.address}\n`,
    );
    return 0;
  }

  try {
    const result = await runAccept({
      chain,
      walletKey,
      escrowRef: cfg.escrowRef,
      awaitTimeoutMs: cfg.awaitTimeoutMs,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${result.txHash}\n`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

// Auto-invoke when run directly (tsx src/cli/accept.ts).
if (
  process.argv[1]?.endsWith("accept.ts") ||
  process.argv[1]?.endsWith("accept.js")
) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`accept: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
