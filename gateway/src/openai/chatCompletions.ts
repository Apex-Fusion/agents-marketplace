/**
 * gateway/src/openai/chatCompletions.ts — POST /openai/v1/chat/completions.
 *
 * One escrow per call against an llm.text.generate.v1 supplier. Lifecycle (all
 * inside the per-key mutex): route → preflight → submitPrompt → resolve the
 * Submitted ref + Accept (awaited) → record usage → wallet-health → respond.
 * stream:true returns the completion as a buffered pseudo-stream (one delta +
 * final usage chunk + [DONE]) with keepalive comments during the escrow wait.
 */

import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { TxConstructionError } from "@marketplace/shared/tx";
import type { GatewayDeps } from "../deps.js";
import type { ApiKeyRow, GatewayStore } from "../db/store.js";
import type { KeyContext } from "../sdk/registry.js";
import { requireKey } from "../middleware/apiKeyAuth.js";
import { asyncHandler } from "../middleware/http.js";
import { selectCandidates } from "../routing/selectSupplier.js";
import { preflight } from "../onchain/preflight.js";
import { resolveSubmittedRef, acceptAndConfirm } from "../onchain/settle.js";
import { ensureWalletHealthy } from "../walletHealth.js";
import { parseChatRequest, type ParsedChatRequest } from "./validate.js";
import {
  genId,
  buildChatCompletion,
  buildChunk,
  usageFromReceipt,
  sseData,
  SSE_DONE,
  type Usage,
} from "./shapes.js";
import { notFound, paymentRequired, toGatewayError, toErrorBody } from "./errors.js";

const CAPABILITY = "llm.text.generate.v1";

function recordUsage(
  store: GatewayStore,
  p: {
    keyId: string;
    model: string;
    supplierPkh: string | null;
    escrowRef: string | null;
    costLovelace: bigint | null;
    usage: Usage | null;
    status: "completed" | "failed";
    failureReason?: string;
  },
): void {
  store.insertUsage({
    id: randomUUID(),
    key_id: p.keyId,
    created_at: Date.now(),
    kind: "completion",
    model: p.model,
    capability_id: CAPABILITY,
    supplier_pkh: p.supplierPkh,
    escrow_ref: p.escrowRef,
    cost_lovelace: p.costLovelace !== null ? p.costLovelace.toString() : null,
    prompt_tokens: p.usage?.prompt_tokens ?? 0,
    completion_tokens: p.usage?.completion_tokens ?? 0,
    status: p.status,
    failure_reason: p.failureReason ?? null,
  });
}

export function makeChatCompletionsHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const parsed = parseChatRequest(req.body);
    const ctx = deps.registry.getContext(keyRow);
    await ctx.mutex.run(() => runOneShot(deps, keyRow, ctx, parsed, res));
  });
}

async function runOneShot(
  deps: GatewayDeps,
  keyRow: ApiKeyRow,
  ctx: KeyContext,
  parsed: ParsedChatRequest,
  res: Response,
): Promise<void> {
  const { config, store, chain, fetchFn } = deps;

  const candidates = await selectCandidates({
    indexerUrl: config.indexerUrl,
    model: parsed.model,
    capabilityId: CAPABILITY,
    fetchFn,
  });
  if (candidates.length === 0) {
    throw notFound("model_not_found", `no available supplier for model "${parsed.model}"`);
  }

  const primary = candidates[0];
  const pf = await preflight(chain, ctx.walletKey.address, primary);
  if (!pf.ok) {
    throw paymentRequired(
      pf.collateralOk
        ? "insufficient balance for this request"
        : "wallet has no pure-ADA UTxO ≥ 5 ADA for collateral; deposit a little more ADA",
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

  const id = genId();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  if (parsed.stream) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(": connected\n\n");
    keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        /* client gone */
      }
    }, 10_000);
  }

  try {
    // Submit. Fall back to the next supplier ONLY on a pre-post
    // TxConstructionError (no escrow was posted). A SupplierError means the
    // escrow is already posted — do not retry (the sweeper recovers it).
    let result: Awaited<ReturnType<typeof ctx.sdk.submitPrompt>> | undefined;
    let used: (typeof candidates)[number] | undefined;
    let lastErr: unknown;
    for (const cand of candidates) {
      try {
        result = await ctx.sdk.submitPrompt({
          advertRef: cand.advertRef,
          messages: parsed.messages,
          payment_lovelace: cand.priceLovelace,
          max_output_tokens: parsed.maxTokens,
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
    const originalRefStr = `${result.escrowRef.txHash}#${result.escrowRef.index}`;
    const submittedRef = await resolveSubmittedRef({
      indexerUrl: config.indexerUrl,
      buyerPkh: ctx.walletKey.pubKeyHash,
      originalRefStr,
      fetchFn,
    });
    await acceptAndConfirm(chain, ctx.walletKey, submittedRef);

    const usage = usageFromReceipt(result.receipt);
    const vector = {
      receipt: result.receipt,
      receipt_signature: result.receiptSignature,
      escrow_ref: originalRefStr,
    };
    recordUsage(store, {
      keyId: keyRow.id,
      model: parsed.model,
      supplierPkh: used.supplierPkh,
      escrowRef: originalRefStr,
      costLovelace: used.priceLovelace,
      usage,
      status: "completed",
    });

    // Re-shape the wallet ({collateral, working}) so the next request keeps a
    // valid collateral UTxO. Best-effort; serialized by the mutex.
    await ensureWalletHealthy(chain, ctx.walletKey).catch((e) =>
      // eslint-disable-next-line no-console
      console.error("[gateway] wallet-health after completion:", e instanceof Error ? e.message : e),
    );

    if (parsed.stream) {
      if (keepalive) clearInterval(keepalive);
      res.write(sseData(buildChunk({ id, model: parsed.model, delta: { role: "assistant", content: result.response }, finishReason: null })));
      res.write(sseData(buildChunk({ id, model: parsed.model, delta: {}, finishReason: "stop", usage, vector })));
      res.write(SSE_DONE);
      res.end();
    } else {
      res.status(200).json(buildChatCompletion({ id, model: parsed.model, content: result.response, usage, vector }));
    }
  } catch (err) {
    if (keepalive) clearInterval(keepalive);
    recordUsage(store, {
      keyId: keyRow.id,
      model: parsed.model,
      supplierPkh: null,
      escrowRef: null,
      costLovelace: null,
      usage: null,
      status: "failed",
      failureReason: err instanceof Error ? err.message : String(err),
    });
    if (parsed.stream && res.headersSent) {
      try {
        res.write(sseData(toErrorBody(toGatewayError(err))));
      } catch {
        /* client gone */
      }
      res.end();
      return;
    }
    throw err;
  }
}
