/**
 * gateway/src/ocr/extract.ts — POST /v1/ocr/extract.
 *
 * One escrow per page against a model-scoped `ocr.page.extract.<model>.v1`
 * supplier (config.ocrCapabilityId). Lifecycle mirrors the one-shot chat
 * path, all inside the per-key mutex: parse → select supplier → preflight →
 * submitOcr (escrow → supplier call → receipt verify) → resolve Submitted
 * ref → Accept (awaited) → record usage → wallet-health → respond.
 *
 * Response (200):
 *   {
 *     output_format, content,
 *     usage: { prompt_tokens, completion_tokens, total_tokens },
 *     x_vector: {
 *       receipt, receipt_signature, escrow_ref,
 *       receipt_labels: ["first-party-brokered"]
 *     }
 *   }
 *
 * Venue attribution: the caller MAY send
 *   X-Venue:          venue slug (e.g. "apify"), ≤ 32 chars
 *   X-Run-User-Hash:  sha256 of the venue-side runner id, 64 hex
 * Both are logged on a structured line per settled job. The wedge-ledger
 * emitter consumes these lines; a usage-table venue
 * column is deliberately deferred to later work so this route stays
 * schema-additive. payer_class is derived at ledger time from the hash
 * (known first-party hashes vs the rest), never asserted here.
 *
 * Demo keys are rejected: the demo executor is chat-session-shaped and its
 * wallet holds one escrow per session; OCR needs a funded per-key wallet.
 */

import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { TxConstructionError } from "@marketplace/shared/tx";
import {
  ALLOWED_OCR_MIMES,
  ALLOWED_OCR_OUTPUT_FORMATS,
  MAX_OCR_IMAGE_B64_CHARS,
} from "@marketplace/shared/tx";
import type { GatewayDeps } from "../deps.js";
import type { GatewayStore } from "../db/store.js";
import { requireKey } from "../middleware/apiKeyAuth.js";
import { asyncHandler } from "../middleware/http.js";
import { selectCandidates, type SupplierCandidate } from "../routing/selectSupplier.js";
import { preflight } from "../onchain/preflight.js";
import { resolveSubmittedRef, acceptAndConfirm } from "../onchain/settle.js";
import { ensureWalletHealthy } from "../walletHealth.js";
import { badRequest, forbidden, notFound, paymentRequired, toGatewayError } from "../openai/errors.js";

/** Operator-model v0: HAL8 operates both the custodial buyer and the
 * supplier fleet, so every receipt this route returns is first-party
 * brokered. Becomes per-supplier metadata when
 * control-independent supply exists. */
const RECEIPT_LABELS_V0 = ["first-party-brokered"] as const;

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const VENUE_RE = /^[a-z0-9-]{1,32}$/;

interface ParsedOcrRequest {
  image_b64: string;
  mime: string;
  output_format: string;
  /** "" = any model under the capability (single-model ids). */
  model: string;
}

function parseOcrRequest(body: unknown): ParsedOcrRequest {
  if (typeof body !== "object" || body === null) {
    throw badRequest("invalid_body", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const image = b.image_b64;
  if (typeof image !== "string" || image.length === 0) {
    throw badRequest("invalid_image", "`image_b64` is required and must be a non-empty base64 string");
  }
  if (image.length > MAX_OCR_IMAGE_B64_CHARS) {
    throw badRequest("image_too_large", `\`image_b64\` exceeds ${MAX_OCR_IMAGE_B64_CHARS} characters`);
  }
  if (!B64_RE.test(image)) {
    throw badRequest("invalid_image", "`image_b64` must be plain base64 (no data: prefix, no whitespace)");
  }

  const mime = b.mime;
  if (typeof mime !== "string" || !ALLOWED_OCR_MIMES.has(mime)) {
    throw badRequest("invalid_mime", `\`mime\` must be one of: ${[...ALLOWED_OCR_MIMES].join(", ")}`);
  }

  const rawFormat = b.output_format ?? "markdown";
  if (typeof rawFormat !== "string" || !ALLOWED_OCR_OUTPUT_FORMATS.has(rawFormat)) {
    throw badRequest(
      "invalid_output_format",
      `\`output_format\` must be one of: ${[...ALLOWED_OCR_OUTPUT_FORMATS].join(", ")}`,
    );
  }

  let model = "";
  if (b.model !== undefined && b.model !== null) {
    if (typeof b.model !== "string" || b.model === "") {
      throw badRequest("invalid_model", "`model` must be a non-empty string when provided");
    }
    model = b.model;
  }

  return { image_b64: image, mime, output_format: rawFormat, model };
}

/** Sanitized venue-attribution headers. Invalid values drop to "".
 * Exported for direct unit testing (I3 review finding) — it is the only
 * gate on what lands in the ocr_settled/ocr_failed structured log lines the
 * wedge-ledger emitter reads, so it needs coverage independent of the HTTP
 * route. */
export function venueAttribution(req: Request): { venue: string; runUserHash: string } {
  const venueRaw = req.header("X-Venue") ?? "";
  const hashRaw = req.header("X-Run-User-Hash") ?? "";
  return {
    venue: VENUE_RE.test(venueRaw) ? venueRaw : "",
    runUserHash: HEX64_RE.test(hashRaw) ? hashRaw.toLowerCase() : "",
  };
}

function recordOcrUsage(
  store: GatewayStore,
  p: {
    keyId: string;
    capabilityId: string;
    model: string;
    supplierPkh: string | null;
    escrowRef: string | null;
    costLovelace: bigint | null;
    promptTokens: number;
    completionTokens: number;
    status: "completed" | "failed";
    failureReason?: string;
  },
): void {
  store.insertUsage({
    id: randomUUID(),
    key_id: p.keyId,
    created_at: Date.now(),
    kind: "ocr",
    model: p.model,
    capability_id: p.capabilityId,
    supplier_pkh: p.supplierPkh,
    escrow_ref: p.escrowRef,
    cost_lovelace: p.costLovelace !== null ? p.costLovelace.toString() : null,
    prompt_tokens: p.promptTokens,
    completion_tokens: p.completionTokens,
    status: p.status,
    failure_reason: p.failureReason ?? null,
  });
}

export function makeOcrExtractHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    if (keyRow.demo) {
      throw forbidden("demo_key_unsupported", "demo keys cannot use /v1/ocr/extract; create a funded API key");
    }
    const ctx = deps.registry.getContext(keyRow);
    const parsed = parseOcrRequest(req.body);
    const attribution = venueAttribution(req);
    await ctx.mutex.run(() => runOcrOneShot(deps, keyRow.id, ctx, parsed, attribution, res));
  });
}

async function runOcrOneShot(
  deps: GatewayDeps,
  keyId: string,
  ctx: ReturnType<GatewayDeps["registry"]["getContext"]>,
  parsed: ParsedOcrRequest,
  attribution: { venue: string; runUserHash: string },
  res: Response,
): Promise<void> {
  const { config, store, chain, fetchFn } = deps;
  const capabilityId = config.ocrCapabilityId;

  // Hoisted above the try so the catch block can report whatever is known
  // even when the failure happens AFTER an escrow was posted (e.g. the
  // supplier call or settle step fails) — these fields are the
  // reconciliation spine that joins on-chain settlement to platform
  // billing, and losing them makes paid-but-failed jobs unreconcilable
  // (I2 review finding).
  let result: Awaited<ReturnType<typeof ctx.sdk.submitOcr>> | undefined;
  let used: SupplierCandidate | undefined;
  let escrowRefStr: string | null = null;

  try {
    const candidates = await selectCandidates({
      indexerUrl: config.indexerUrl,
      model: parsed.model,
      capabilityId,
      fetchFn,
    });
    if (candidates.length === 0) {
      throw notFound(
        "model_not_found",
        parsed.model === ""
          ? `no available supplier for capability "${capabilityId}"`
          : `no available supplier for model "${parsed.model}" under "${capabilityId}"`,
      );
    }

    const primary = candidates[0];
    const pf = await preflight(chain, ctx.walletKey.address, primary);
    if (!pf.ok) {
      throw paymentRequired(
        pf.collateralOk
          ? "insufficient balance for this request"
          : "wallet has no pure-AP3X UTxO ≥ 5 AP3X for collateral; deposit a little more AP3X",
        {
          x_vector: {
            required_lovelace: pf.requiredLovelace.toString(),
            available_lovelace: pf.availableLovelace.toString(),
            collateral_ok: pf.collateralOk,
            deposit_address: ctx.walletKey.address,
          },
        },
      );
    }

    // Submit. Fall back to the next supplier ONLY on a pre-post
    // TxConstructionError (no escrow was posted). A SupplierError means the
    // escrow is already posted — do not retry (the sweeper recovers it).
    let lastErr: unknown;
    for (const cand of candidates) {
      try {
        result = await ctx.sdk.submitOcr({
          advertRef: cand.advertRef,
          image_b64: parsed.image_b64,
          mime: parsed.mime,
          output_format: parsed.output_format,
          payment_lovelace: cand.priceLovelace,
        });
        used = cand;
        break;
      } catch (err) {
        lastErr = err;
        if (err instanceof TxConstructionError) continue;
        throw err;
      }
    }
    if (!result || !used) {
      throw toGatewayError(lastErr ?? new Error("no supplier could be engaged"));
    }

    // Settle: resolve the live Submitted ref, Accept, await confirmation.
    escrowRefStr = `${result.escrowRef.txHash}#${result.escrowRef.index}`;
    const submittedRef = await resolveSubmittedRef({
      indexerUrl: config.indexerUrl,
      buyerPkh: ctx.walletKey.pubKeyHash,
      originalRefStr: escrowRefStr,
      fetchFn,
    });
    await acceptAndConfirm(chain, ctx.walletKey, submittedRef);

    recordOcrUsage(store, {
      keyId,
      capabilityId,
      model: used.model,
      supplierPkh: used.supplierPkh,
      escrowRef: escrowRefStr,
      costLovelace: used.priceLovelace,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      status: "completed",
    });

    // Structured settle line for the wedge-ledger emitter. One line per
    // settled job; venue/run_user_hash empty when the
    // caller sent none.
    console.log(JSON.stringify({
      evt: "ocr_settled",
      escrow_ref: escrowRefStr,
      capability_id: capabilityId,
      model: used.model,
      supplier_pkh: used.supplierPkh,
      cost_lovelace: used.priceLovelace.toString(),
      receipt_labels: RECEIPT_LABELS_V0,
      venue: attribution.venue,
      run_user_hash: attribution.runUserHash,
      ts: new Date().toISOString(),
    }));

    // Re-shape the wallet ({collateral, working}) so the next request keeps
    // a valid collateral UTxO. Best-effort; serialized by the mutex.
    await ensureWalletHealthy(chain, ctx.walletKey).catch((e) =>
      // eslint-disable-next-line no-console
      console.error("[gateway] wallet-health after ocr:", e instanceof Error ? e.message : e),
    );

    res.status(200).json({
      output_format: result.output_format,
      content: result.content,
      usage: result.usage,
      x_vector: {
        receipt: result.receipt,
        receipt_signature: result.receiptSignature,
        escrow_ref: escrowRefStr,
        receipt_labels: RECEIPT_LABELS_V0,
      },
    });
  } catch (err) {
    recordOcrUsage(store, {
      keyId,
      capabilityId,
      model: used?.model ?? parsed.model,
      supplierPkh: used?.supplierPkh ?? null,
      escrowRef: escrowRefStr,
      costLovelace: used?.priceLovelace ?? null,
      promptTokens: result?.usage.prompt_tokens ?? 0,
      completionTokens: result?.usage.completion_tokens ?? 0,
      status: "failed",
      failureReason: err instanceof Error ? err.message : String(err),
    });

    // Structured failure line mirroring ocr_settled's shape (same venue /
    // run_user_hash / escrow_ref fields) so paid-but-failed jobs — an
    // escrow posted on-chain, then a later step (supplier call, settle)
    // failed — can still be reconciled against on-chain state instead of
    // vanishing from the wedge-ledger emitter's input (I2 review finding).
    console.log(JSON.stringify({
      evt: "ocr_failed",
      escrow_ref: escrowRefStr,
      capability_id: capabilityId,
      model: used?.model ?? parsed.model,
      supplier_pkh: used?.supplierPkh ?? null,
      venue: attribution.venue,
      run_user_hash: attribution.runUserHash,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    }));

    throw err;
  }
}
