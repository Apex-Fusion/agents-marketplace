/**
 * buyer/src/pdf/caps.ts — resolve PdfCaps (safety + sizing knobs) from env.
 *
 * Every knob is optional with a sane default, so the PDF summarizer works out
 * of the box; operators tune spend/abuse limits via PDF_* env vars. See
 * pdf/types.ts for field docs.
 */

import type { PdfCaps } from "./types.js";

function intEnv(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const v = env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`loadPdfCaps: ${name} must be a non-negative number (got: ${v})`);
  }
  return Math.floor(n);
}

function bigintEnv(env: Record<string, string | undefined>, name: string, dflt: bigint): bigint {
  const v = env[name];
  if (v === undefined || v === "") return dflt;
  if (!/^\d+$/.test(v)) {
    throw new Error(`loadPdfCaps: ${name} must be a non-negative integer (got: ${v})`);
  }
  return BigInt(v);
}

function listEnv(env: Record<string, string | undefined>, name: string, dflt: string[]): string[] {
  const v = env[name];
  if (v === undefined) return dflt;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Built-in defaults — used as the fallback when createApp gets no pdfCaps. */
export function defaultPdfCaps(): PdfCaps {
  return loadPdfCaps({});
}

export function loadPdfCaps(env: Record<string, string | undefined>): PdfCaps {
  return {
    maxPages: intEnv(env, "PDF_MAX_PAGES", 400),
    maxChunks: intEnv(env, "PDF_MAX_CHUNKS", 200),
    walletFloorLovelace: bigintEnv(env, "PDF_WALLET_FLOOR_LOVELACE", 50_000_000n),
    laneCount: Math.max(1, intEnv(env, "PDF_LANE_COUNT", 1)),
    chunkTargetTokens: intEnv(env, "PDF_CHUNK_TARGET_TOKENS", 2200),
    chunkMaxTokens: intEnv(env, "PDF_CHUNK_MAX_TOKENS", 3000),
    reduceFanin: Math.max(2, intEnv(env, "PDF_REDUCE_FANIN", 8)),
    retryK: intEnv(env, "PDF_RETRY_K", 2),
    modelAllowlist: listEnv(env, "PDF_MODEL_ALLOWLIST", ["kimi", "deepseek", "gpt"]),
    modelDenylist: listEnv(env, "PDF_MODEL_DENYLIST", ["qwen2.5:0.5b", "qwen2.5-0.5b"]),
    maxPdfBytes: intEnv(env, "PDF_MAX_PDF_BYTES", 25_000_000),
  };
}
