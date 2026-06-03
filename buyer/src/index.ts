/**
 * buyer/src/index.ts — buyer-app entry point.
 *
 * Wires config → WalletKey derivation → Marketplace SDK → Express server.
 * Boot is wrapped in `runMain()` so importing this module (e.g. for tests)
 * does NOT trigger network calls or process.exit.
 */

import { resolve } from "path";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { buildChainProvider } from "./chain.js";
import { Marketplace, MemoryTaskHistoryStore } from "./sdk/index.js";
import { ResponseArchive } from "./db/archive.js";
import { JobStore } from "./pdf/summarize-job.js";
import { PdfJobDb } from "./pdf/job-db.js";
import { loadPdfCaps } from "./pdf/caps.js";
import type { WalletKey } from "@marketplace/shared/tx";

// Wire ed25519 sha512 hook (idempotent — same as receipt/sign.ts).
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

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

export function deriveWalletKey(privHex: string, networkId: 0 | 1): WalletKey {
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

export async function runMain(env: Record<string, string | undefined>): Promise<void> {
  const config = loadConfig(env);
  const walletKey = deriveWalletKey(config.privKeyHex, config.networkId);

  const chain = buildChainProvider(config);

  const marketplace = new Marketplace({
    chain,
    indexerUrl: config.indexerUrl,
    walletKey,
    networkParams: { networkId: config.networkId },
    historyStore: new MemoryTaskHistoryStore(),
  });

  const distPath = resolve(process.cwd(), "buyer/dist");

  // Open the response archive (SQLite + filesystem under ARCHIVE_DIR).
  // Boot is non-fatal: if the archive can't be opened (e.g. permissions),
  // log + continue without it — /v1/responses* will respond 503 but the
  // lifecycle endpoints still work.
  let archive: ResponseArchive | undefined;
  try {
    archive = new ResponseArchive(config.archiveDir);
    console.log(`[buyer] response archive at ${config.archiveDir}`);
  } catch (err) {
    console.error(
      `[buyer] failed to open response archive at ${config.archiveDir}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // PDF book summarizer: one job registry, sharing the live marketplace SDK,
  // chain, wallet, and (optional) archive. Caps come from PDF_* env vars.
  const pdfCaps = loadPdfCaps(env);
  // Durable job store (SQLite under ARCHIVE_DIR) so past summaries survive
  // restarts and navigation. Best-effort: if it can't open, jobs fall back to
  // in-memory only (lost on restart) but the feature still works.
  let pdfJobDb: PdfJobDb | undefined;
  try {
    pdfJobDb = new PdfJobDb(config.archiveDir);
    console.log(`[buyer] pdf job store at ${config.archiveDir}/pdf-jobs.db`);
  } catch (err) {
    console.error(
      `[buyer] failed to open pdf job store at ${config.archiveDir}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  const jobStore = new JobStore({
    marketplace,
    chain,
    walletKey,
    indexerUrl: config.indexerUrl,
    archive,
    caps: pdfCaps,
    db: pdfJobDb,
  });

  const app = createApp({
    distPath,
    chain,
    walletKey,
    indexerUrl: config.indexerUrl,
    marketplace,
    ttsPiperBaseUrl: config.ttsPiperBaseUrl,
    archive,
    password: config.password,
    sessionSecret: config.sessionSecret,
    cookieSecure: config.cookieSecure,
    jobStore,
    pdfCaps,
  });

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[buyer] listening on :${config.port}, indexer=${config.indexerUrl}`);
  });

  const shutdown = (): void => {
    // eslint-disable-next-line no-console
    console.log("[buyer] shutting down...");
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// Boot only when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv?.[1] !== undefined &&
  /buyer\/(src|dist)\/index\.(t|j)s$/.test(process.argv[1]);

if (invokedDirectly) {
  runMain(process.env).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[buyer] boot failed:", err);
    process.exit(1);
  });
}
