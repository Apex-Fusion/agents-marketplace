/**
 * buyer/src/paper2agent/model.ts — paid model calls for the Paper2Agent build
 * service.
 *
 * POST /v1/paper2agent/model/chat/completions accepts the OpenAI Chat
 * Completions subset the build agent sends and buys one marketplace call with
 * the buyer wallet:
 *   cheapest available llm.text.generate.v1 advert for `model`
 *   → wallet preflight → PostEscrow → supplier → receipt verification
 *   → Accept (confirmed)
 * Errors use the gateway's OpenAI shape. A wallet that cannot pay answers 402
 * insufficient_funds with x_vector amounts and the deposit address before any
 * transaction, as the gateway does, so the build waits instead of failing.
 *
 * The build service authenticates with a bearer token; the buyer key never
 * leaves this server. One call runs at a time: the shared transaction builder
 * cannot pin wallet inputs, so concurrent posts would select the same UTxO.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { canonicalize } from "@marketplace/shared/cbor";
import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import {
  chatMessagesToResponseInput,
  normalizeResponseRequest,
  responseOutputText,
  responseResultCommitment,
  type ResponseFunctionCallItem,
  type ResponseObject,
  type ResponseRequest,
} from "@marketplace/shared/responses";
import { escrowLockFloor, type ChatMessage, type WalletKey } from "@marketplace/shared/tx";
import { findSubmittedEscrowRef, runAccept } from "../cli/acceptFlow.js";
import type { ResponseArchive } from "../db/archive.js";
import { Mutex } from "../mutex.js";
import type { Marketplace } from "../sdk/Marketplace.js";
import type { PreparedPrompt } from "../sdk/types.js";

export const PAPER2AGENT_MODEL_PATH = "/v1/paper2agent/model/chat/completions";

const CAPABILITY_ID = "llm.text.generate.v1";
const REQUEST_FIELDS: readonly string[] = ["model", "messages", "tools", "tool_choice", "parallel_tool_calls",
  "max_completion_tokens", "max_tokens", "stream"];
const ADVERT_REF_RE = /^([0-9a-f]{64})#(\d+)$/;
/** Build-agent conversations stay below 220 kB; this leaves room for JSON overhead. */
const REQUEST_JSON_LIMIT = "1mb";
const SUBMITTED_LOOKUP_TIMEOUT_MS = 30_000;
/** The gateway preflight's reserve: Accept needs a pure-AP3X collateral UTxO and fee headroom. */
const COLLATERAL_MIN_LOVELACE = 5_000_000n;
const FEE_RESERVE_LOVELACE = 2_000_000n;

export interface Paper2AgentModelOptions {
  /** Bearer token shared with the build service. Empty disables the route. */
  token: string;
  marketplace?: Marketplace;
  chain?: ChainProvider;
  walletKey?: WalletKey;
  indexerUrl?: string;
  archive?: ResponseArchive;
  /** Settles one Submitted escrow and returns the confirmed Accept tx hash. */
  accept?: (escrowRef: OutputReference) => Promise<string>;
}

interface Advert {
  ref: OutputReference;
  priceLovelace: bigint;
  maxOutputTokens: number;
}

/** An OpenAI-shaped failure; `extra` carries top-level fields such as x_vector. */
class ModelCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refString(ref: OutputReference): string {
  return `${ref.txHash}#${ref.index}`;
}

function sendError(res: Response, error: ModelCallError): void {
  res.status(error.status).json({
    error: {
      message: error.message,
      type: error.status >= 500 ? "server_error" : "invalid_request_error",
      code: error.code,
      param: null,
    },
    ...error.extra,
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelCallError(400, "invalid_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Chat Completions messages as the shared conversion's input; tool-only assistant turns carry "". */
function chatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ModelCallError(400, "invalid_request", "messages must be a non-empty array");
  }
  return value.map((raw, index) => {
    const message = record(raw, `messages[${index}]`);
    const role = message.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      throw new ModelCallError(400, "invalid_request", `messages[${index}].role is not supported`);
    }
    const content = message.content ?? "";
    if (typeof content !== "string") {
      throw new ModelCallError(400, "invalid_request", `messages[${index}].content must be a string or null`);
    }
    const chat: ChatMessage = { role, content };
    if (message.tool_call_id !== undefined) {
      if (typeof message.tool_call_id !== "string") {
        throw new ModelCallError(400, "invalid_request", `messages[${index}].tool_call_id must be a string`);
      }
      chat.tool_call_id = message.tool_call_id;
    }
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls)) {
        throw new ModelCallError(400, "invalid_request", `messages[${index}].tool_calls must be an array`);
      }
      chat.tool_calls = message.tool_calls.map((rawCall, callIndex) => {
        const call = record(rawCall, `messages[${index}].tool_calls[${callIndex}]`);
        const fn = record(call.function, `messages[${index}].tool_calls[${callIndex}].function`);
        if (call.type !== "function" || typeof call.id !== "string" || typeof fn.name !== "string" ||
            typeof fn.arguments !== "string") {
          throw new ModelCallError(400, "invalid_request", `messages[${index}].tool_calls[${callIndex}] is invalid`);
        }
        return { id: call.id, type: "function", function: { name: fn.name, arguments: fn.arguments } };
      });
    }
    return chat;
  });
}

/** The Responses request for one Chat Completions body. System turns become developer turns. */
function responseRequest(body: Record<string, unknown>): ResponseRequest {
  if (body.stream !== undefined && body.stream !== false) {
    throw new ModelCallError(400, "invalid_request", "stream must be false");
  }
  const raw: Record<string, unknown> = {
    input: chatMessagesToResponseInput(chatMessages(body.messages)).map((item) =>
      item.type === "message" && item.role === "system" ? { ...item, role: "developer" } : item),
  };
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new ModelCallError(400, "invalid_request", "tools must be an array");
    raw.tools = body.tools.map((rawTool, index) => {
      const tool = record(rawTool, `tools[${index}]`);
      const fn = record(tool.function, `tools[${index}].function`);
      if (tool.type !== "function") throw new ModelCallError(400, "invalid_request", "only function tools are supported");
      return { type: "function", name: fn.name, description: fn.description, parameters: fn.parameters };
    });
  }
  if (body.tool_choice !== undefined) {
    raw.tool_choice = typeof body.tool_choice === "string"
      ? body.tool_choice
      : { type: "function", name: record(record(body.tool_choice, "tool_choice").function, "tool_choice.function").name };
  }
  if (body.parallel_tool_calls !== undefined) raw.parallel_tool_calls = body.parallel_tool_calls;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && maxTokens !== null) raw.max_output_tokens = maxTokens;
  try {
    return normalizeResponseRequest(raw);
  } catch (error) {
    throw new ModelCallError(400, "invalid_request", errorMessage(error));
  }
}

/** Cheapest Active advert for `model` whose supplier is neither offline nor working. */
async function selectAdvert(marketplace: Marketplace, model: string): Promise<Advert> {
  const views = await marketplace.discoverSuppliers({ capability_id: CAPABILITY_ID });
  const adverts: Advert[] = [];
  for (const view of views) {
    const ref = ADVERT_REF_RE.exec(view.utxo_ref);
    if (!ref || view.capability_id !== CAPABILITY_ID || view.model !== model || view.advert_status !== "Active" ||
        view.status === "offline" || view.status === "working") continue;
    let priceLovelace: bigint;
    try {
      priceLovelace = BigInt(view.price_lovelace);
    } catch {
      continue;
    }
    adverts.push({ ref: { txHash: ref[1], index: Number(ref[2]) }, priceLovelace, maxOutputTokens: view.max_output_tokens });
  }
  adverts.sort((a, b) => (a.priceLovelace < b.priceLovelace ? -1 : a.priceLovelace > b.priceLovelace ? 1 : 0));
  if (adverts.length === 0) {
    throw new ModelCallError(503, "model_unavailable", `No available ${CAPABILITY_ID} supplier offers ${model}.`);
  }
  return adverts[0];
}

/**
 * The gateway's one-shot preflight: the escrow lock floor plus the collateral and
 * fee reserve, and one pure-AP3X UTxO for Accept collateral. Refuses before any
 * transaction is built.
 */
async function assertFunds(chain: ChainProvider, walletKey: WalletKey, prepared: PreparedPrompt): Promise<void> {
  const utxos = await chain.queryUtxosByAddress(walletKey.address);
  const available = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  const collateralOk = utxos.some((utxo) => utxo.lovelace >= COLLATERAL_MIN_LOVELACE && Object.keys(utxo.assets).length === 0);
  const { advert } = prepared;
  const now = Date.now();
  const floor = escrowLockFloor({
    buyer_pkh: walletKey.pubKeyHash,
    supplier_pkh: advert.supplier_pkh,
    advert_ref: prepared.advertRef,
    capability_id: advert.capability_id,
    request_spec_hash: "00".repeat(32),
    prompt_hash: "00".repeat(32),
    payment_lovelace: advert.price_lovelace,
    buyer_bond_lovelace: advert.buyer_bond_lovelace,
    supplier_bond_lovelace: advert.supplier_bond_lovelace,
    deliver_by: now + advert.max_processing_ms,
    posted_at: now,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  }, advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace);
  const required = floor + COLLATERAL_MIN_LOVELACE + FEE_RESERVE_LOVELACE;
  if (available >= required && collateralOk) return;
  throw new ModelCallError(402, "insufficient_funds",
    collateralOk ? "insufficient balance for this request"
      : "wallet has no pure-AP3X UTxO ≥ 5 AP3X for collateral; deposit a little more AP3X",
    { x_vector: {
      required_lovelace: required.toString(),
      available_lovelace: available.toString(),
      collateral_ok: collateralOk,
      deposit_address: walletKey.address,
    } });
}

/** The verified Responses result as a Chat Completions object; marketplace references sit in x_vector. */
function chatCompletion(model: string, result: ResponseObject, vector: Record<string, unknown>): Record<string, unknown> {
  const calls = result.output.filter((item): item is ResponseFunctionCallItem => item.type === "function_call");
  const text = responseOutputText(result.output);
  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text === "" && calls.length > 0 ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls.map((call) => ({
          id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments },
        })) } : {}),
      },
      finish_reason: calls.length > 0 ? "tool_calls" : result.status === "incomplete" ? "length" : "stop",
    }],
    ...(result.usage ? { usage: {
      prompt_tokens: result.usage.input_tokens,
      completion_tokens: result.usage.output_tokens,
      total_tokens: result.usage.total_tokens,
    } } : {}),
    x_vector: vector,
  };
}

export function registerPaper2AgentModelRoute(app: Express, options: Paper2AgentModelOptions): void {
  const { token, marketplace, chain, walletKey, indexerUrl, archive } = options;
  const expected = createHash("sha256").update(token).digest();
  const wallet = new Mutex();
  const accept = options.accept ?? (async (escrowRef: OutputReference): Promise<string> => {
    const result = await runAccept({
      chain: chain!, walletKey: walletKey!, escrowRef,
      log: (line) => console.log(`[paper2agent-model] ${line}`),
    });
    return result.txHash;
  });

  // Authenticate before reading the body or touching the wallet.
  const authorize = (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", "no-store");
    if (token === "" || !marketplace || !chain || !walletKey || !indexerUrl) {
      sendError(res, new ModelCallError(503, "paper2agent_model_unconfigured",
        "Paid model calls are not configured on this buyer. Set PAPER2AGENT_MODEL_TOKEN and restart the buyer."));
      return;
    }
    const header = req.get("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!timingSafeEqual(createHash("sha256").update(bearer).digest(), expected) || bearer === "") {
      sendError(res, new ModelCallError(401, "invalid_api_key", "A valid bearer token is required."));
      return;
    }
    next();
  };

  app.post(PAPER2AGENT_MODEL_PATH, authorize, express.json({ limit: REQUEST_JSON_LIMIT }),
    async (req: Request, res: Response) => {
      const started = Date.now();
      let model = "";
      try {
        const body = record(req.body, "request body");
        const extra = Object.keys(body).find((field) => !REQUEST_FIELDS.includes(field));
        if (extra !== undefined) {
          throw new ModelCallError(400, "unsupported_parameter", `unsupported field: ${extra.slice(0, 100)}`);
        }
        if (typeof body.model !== "string" || body.model.length === 0 || body.model.length > 256) {
          throw new ModelCallError(400, "invalid_request", "model must be a non-empty string of at most 256 characters");
        }
        model = body.model;
        const request = responseRequest(body);

        // Discovery runs inside the lock so the chosen advert is current when its escrow posts.
        const call = await wallet.run(async () => {
          const advert = await selectAdvert(marketplace!, model);
          const prepared = await marketplace!.preparePrompt({
            advertRef: advert.ref,
            payment_lovelace: advert.priceLovelace,
            ...request,
            ...(request.max_output_tokens === undefined ? {} : {
              max_output_tokens: Math.min(request.max_output_tokens, advert.maxOutputTokens),
            }),
          });
          await assertFunds(chain!, walletKey!, prepared);
          const submit = await marketplace!.executePrompt(await marketplace!.postPrompt(prepared));
          const submittedRef = submit.submittedRef ?? await findSubmittedEscrowRef(
            indexerUrl!, walletKey!.pubKeyHash, submit.receipt.prompt_hash, SUBMITTED_LOOKUP_TIMEOUT_MS);
          let acceptTxHash: string;
          try {
            acceptTxHash = await accept(submittedRef);
          } catch (error) {
            throw new ModelCallError(502, "accept_failed",
              `The paid call succeeded, but Accept of ${refString(submittedRef)} failed: ${errorMessage(error)}. ` +
              "Accept it with POST /v1/accept within 10 minutes of its submission.");
          }
          return { advert, submit, submittedRef, acceptTxHash };
        });

        const escrowRef = refString(call.submit.escrowRef);
        if (archive) {
          try {
            archive.persistChat({
              escrow_ref: escrowRef,
              posted_at: started,
              capability_id: CAPABILITY_ID,
              supplier_pkh: call.submit.receipt.supplier_pkh,
              model: call.submit.receipt.model,
              payment_lovelace: call.advert.priceLovelace.toString(),
              request_envelope: call.submit.request,
              response_canonical: canonicalize(responseResultCommitment(call.submit.result)),
              receipt: call.submit.receipt as unknown as Record<string, unknown>,
              receipt_signature: call.submit.receiptSignature,
            });
          } catch (error) {
            console.error(`[paper2agent-model] archive.persistChat failed for ${escrowRef}: ${errorMessage(error)}`);
          }
        }
        console.log(`[paper2agent-model] ${model} escrow=${escrowRef} accept=${call.acceptTxHash} ` +
          `seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
        res.status(200).json(chatCompletion(model, call.submit.result, {
          escrow_ref: escrowRef,
          submitted_ref: refString(call.submittedRef),
          accept_tx_hash: call.acceptTxHash,
          receipt: call.submit.receipt,
          receipt_signature: call.submit.receiptSignature,
        }));
      } catch (error) {
        if (error instanceof ModelCallError) {
          if (error.status >= 500) console.error(`[paper2agent-model] ${model} ${error.code}: ${error.message}`);
          sendError(res, error);
          return;
        }
        const reason = error instanceof Error && "reason" in error ? String(error.reason) : "paid_call_failed";
        console.error(`[paper2agent-model] ${model} failed reason=${reason}: ${errorMessage(error)}`);
        sendError(res, new ModelCallError(502, reason.slice(0, 100), errorMessage(error).slice(0, 4000)));
      }
    });

  // express.json failures for this route answer in the same OpenAI error shape.
  app.use(PAPER2AGENT_MODEL_PATH, (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const tooLarge = typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large";
    sendError(res, tooLarge
      ? new ModelCallError(413, "request_too_large", "The request body is too large.")
      : new ModelCallError(400, "invalid_json", "The request body must be valid JSON."));
  });
}
