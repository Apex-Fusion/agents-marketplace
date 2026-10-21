/**
 * buyer/src/paper2agent/model.ts — paid model calls for the Paper2Agent build
 * service.
 *
 * POST /v1/paper2agent/model/chat/completions accepts the OpenAI Chat
 * Completions subset the build agent sends and buys one marketplace call with
 * the buyer wallet:
 *   cheapest live-free llm.text.generate.v1 advert for `model` ("auto": any
 *   model whose supplier accepts the request) → wallet preflight → PostEscrow
 *   (confirmed) → supplier → receipt verification → answer
 * Accept runs in the background after the answer, so the build does not wait
 * for its block.
 * Errors use the gateway's OpenAI shape. A wallet that cannot pay answers 402
 * insufficient_funds with x_vector amounts and the deposit address before any
 * transaction, as the gateway does, so the build waits instead of failing. A
 * chain or indexer outage before the Post is sent answers 503 chain_unavailable,
 * so the build waits for it too.
 *
 * The build service authenticates with a bearer token; the buyer key never
 * leaves this server. The shared transaction builder does not track pending
 * transactions, so a lock serializes building and submitting wallet
 * transactions, and every build excludes the outputs that a submitted,
 * unconfirmed Accept spends.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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
import { buildAcceptTx, escrowLockFloor, TxConstructionError, type ChatMessage, type WalletKey } from "@marketplace/shared/tx";
import { inspectSignedTransactionFinancials } from "@marketplace/shared/tx/server";
import { findSubmittedEscrowRef } from "../cli/acceptFlow.js";
import type { ResponseArchive } from "../db/archive.js";
import { Mutex } from "../mutex.js";
import type { Marketplace } from "../sdk/Marketplace.js";
import { IndexerError, type PostedPrompt, type PreparedPrompt, type SubmitPromptResult } from "../sdk/types.js";

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
/** Request model that buys from every model whose supplier accepts the request. */
export const AUTO_MODEL = "auto";
/** "auto" skips adverts too small to write one source file per tool call. */
const AUTO_MIN_OUTPUT_TOKENS = 4096;
const STATUS_PROBE_TIMEOUT_MS = 2_000;
/** A supplier whose paid call failed is not chosen again for this long. */
const FAILED_SUPPLIER_COOLDOWN_MS = 15 * 60_000;
/** The supplier answers result polls from memory; 500 ms adds at most half a second. */
const RESULT_POLL_MS = 500;
/** Background Accept: attempts per Submitted escrow, default wait between them, confirmation budget. */
const ACCEPT_ATTEMPTS = 3;
const ACCEPT_RETRY_MS = 10_000;
const ACCEPT_CONFIRM_TIMEOUT_MS = 120_000;
/** Accept build refusals that no retry can change. */
const FINAL_ACCEPT_REASONS: Record<string, true> = {
  "escrow ref not on chain": true, "wrong state": true, "accept window expired": true,
};
/** Socket and DNS failures of Node's fetch that a later resend can pass. */
const TRANSPORT_ERROR_CODES: Record<string, true> = {
  ECONNRESET: true, ECONNREFUSED: true, ETIMEDOUT: true, EAI_AGAIN: true, EPIPE: true, ENOTFOUND: true,
};
/** The Ogmios providers' HTTP failure, "Ogmios HTTP error: <status> <statusText>[ :: body]", for 5xx or 429. */
const OGMIOS_UNAVAILABLE_RE = /^Ogmios HTTP error: (?:5\d\d|429)\b/;
/** lucid's complete() reports a provider failure as "{ Complete: <name>: <message> }";
 * the Post builder wraps that text in a TxConstructionError and drops the cause. */
const LUCID_UNAVAILABLE_RE = /^\{ Complete: (?:Error: Ogmios HTTP error: (?:5\d\d|429)\b|TypeError: fetch failed\b|(?:AbortError|TimeoutError): )/;
/** Error causes nest one or two deep; the bound only stops a cyclic chain. */
const CAUSE_CHAIN_LIMIT = 8;

/** One submitted Accept: its hash and every output it spends. */
export interface SubmittedAccept {
  txHash: string;
  spentInputs: OutputReference[];
}

export interface Paper2AgentModelOptions {
  /** Bearer token shared with the build service. Empty disables the route. */
  token: string;
  marketplace?: Marketplace;
  chain?: ChainProvider;
  walletKey?: WalletKey;
  indexerUrl?: string;
  archive?: ResponseArchive;
  /** Builds and submits one Accept without waiting for its block. Defaults to the live builder. */
  submitAccept?: (escrowRef: OutputReference, excludeInputs: readonly OutputReference[]) => Promise<SubmittedAccept>;
  /** Wait between background Accept attempts. Default 10 s. */
  acceptRetryMs?: number;
  /** Background Accepts are added here while they run, so shutdown can wait for them. */
  backgroundTasks?: Set<Promise<unknown>>;
  /** Reads supplier /status before each purchase; defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Models that "auto" never buys from. An explicit request for one still buys it. */
  autoExcludedModels?: readonly string[];
}

interface Advert {
  ref: OutputReference;
  model: string;
  endpointUrl: string;
  priceLovelace: bigint;
  maxOutputTokens: number;
  /** The indexer's cached status, polled every 20 s, was neither working nor offline. */
  cachedFree: boolean;
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

/**
 * A chain or indexer outage that a later resend of the same call can pass:
 * - Ogmios HTTP 5xx or 429, also as lucid's "{ Complete: Error: Ogmios HTTP error: ... }";
 * - the indexer client's HTTP 5xx or 429, its timeout, and its "fetch failed" network error;
 * - Node fetch failures: TypeError "fetch failed" (also lucid-wrapped), or a code in
 *   TRANSPORT_ERROR_CODES or UND_ERR_* anywhere in the cause chain;
 * - AbortError or TimeoutError: no fetch before the Post carries the client's signal, so these are timeouts.
 * Ogmios RPC errors, construction refusals, and bugs are not outages: no resend can pass them.
 */
function isChainAvailabilityError(error: unknown): boolean {
  if (error instanceof IndexerError) {
    return error.reason === "timeout" || error.message === "network error: fetch failed" ||
      (error.reason === "indexer_error" && error.status !== undefined &&
        (error.status === 429 || (error.status >= 500 && error.status <= 599)));
  }
  let link: unknown = error;
  for (let depth = 0; depth < CAUSE_CHAIN_LIMIT && typeof link === "object" && link !== null; depth += 1) {
    const name = "name" in link ? String(link.name) : "";
    const message = "message" in link ? String(link.message) : "";
    const code = "code" in link ? String(link.code) : "";
    if (name === "AbortError" || name === "TimeoutError" || (name === "TypeError" && message === "fetch failed") ||
        TRANSPORT_ERROR_CODES[code] === true || code.startsWith("UND_ERR_") ||
        OGMIOS_UNAVAILABLE_RE.test(message) || LUCID_UNAVAILABLE_RE.test(message)) return true;
    link = "cause" in link ? link.cause : undefined;
  }
  return false;
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

/**
 * Active adverts for `model` (AUTO_MODEL: every model with at least AUTO_MIN_OUTPUT_TOKENS
 * that is not in `autoExcluded`), cached-free first, then cheapest; equal prices in random
 * order so calls spread across suppliers. Cached working/offline adverts stay last: the
 * cache lags up to one poll.
 */
async function candidateAdverts(marketplace: Marketplace, model: string, autoExcluded: ReadonlySet<string>): Promise<Advert[]> {
  const views = await marketplace.discoverSuppliers({ capability_id: CAPABILITY_ID });
  const adverts: Advert[] = [];
  for (const view of views) {
    const ref = ADVERT_REF_RE.exec(view.utxo_ref);
    if (!ref || view.capability_id !== CAPABILITY_ID || view.advert_status !== "Active") continue;
    if (model === AUTO_MODEL
      ? view.max_output_tokens < AUTO_MIN_OUTPUT_TOKENS || autoExcluded.has(view.model)
      : view.model !== model) continue;
    let priceLovelace: bigint;
    try {
      priceLovelace = BigInt(view.price_lovelace);
    } catch {
      continue;
    }
    adverts.push({
      ref: { txHash: ref[1], index: Number(ref[2]) },
      model: view.model,
      endpointUrl: view.endpoint_url,
      priceLovelace,
      maxOutputTokens: view.max_output_tokens,
      cachedFree: view.status !== "offline" && view.status !== "working",
    });
  }
  for (let i = adverts.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [adverts[i], adverts[j]] = [adverts[j], adverts[i]];
  }
  return adverts.sort((a, b) => Number(b.cachedFree) - Number(a.cachedFree) ||
    (a.priceLovelace < b.priceLovelace ? -1 : a.priceLovelace > b.priceLovelace ? 1 : 0));
}

/** The supplier's own /status says free; the indexer's copy can be one poll old. */
async function liveFree(endpointUrl: string, fetchImpl: typeof globalThis.fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${endpointUrl.replace(/\/+$/, "")}/status`, {
      signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = await response.json() as unknown;
    return body !== null && typeof body === "object" && "status" in body && body.status === "free";
  } catch {
    return false;
  }
}

/**
 * The gateway's one-shot preflight: the escrow lock floor plus the collateral and
 * fee reserve, and one pure-AP3X UTxO for Accept collateral. Outputs that a pending
 * Accept spends do not count. Refuses before any transaction is built.
 */
async function assertFunds(chain: ChainProvider, walletKey: WalletKey, prepared: PreparedPrompt,
  reserved: readonly OutputReference[]): Promise<void> {
  const spent = new Set(reserved.map(refString));
  const utxos = (await chain.queryUtxosByAddress(walletKey.address)).filter((utxo) => !spent.has(refString(utxo.ref)));
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
  const { token, marketplace, chain, walletKey, indexerUrl, archive, fetchImpl = globalThis.fetch } = options;
  const expected = createHash("sha256").update(token).digest();
  /** Serializes building and submitting wallet transactions; block confirmations wait outside it. */
  const wallet = new Mutex();
  /** Supplier endpoint → time until which it is skipped after a failed paid call. */
  const failedUntil = new Map<string, number>();
  /** Supplier endpoints with a paid call between Post and result; never chosen for a second call. */
  const busyEndpoints = new Set<string>();
  const autoExcluded = new Set(options.autoExcludedModels ?? []);
  /** Submitted Accepts that are not in a block yet: tx hash → spent outputs and confirmation. */
  const pendingAccepts = new Map<string, { inputs: OutputReference[]; confirmed: Promise<void> }>();
  const acceptRetryMs = options.acceptRetryMs ?? ACCEPT_RETRY_MS;
  const submitAccept = options.submitAccept ?? (async (escrowRef: OutputReference,
    excludeInputs: readonly OutputReference[]): Promise<SubmittedAccept> => {
    const built = await buildAcceptTx({ chain: chain!, buyerKey: walletKey!, escrowRef, excludeInputs });
    // Collateral must also stay unspent until the Accept is in a block.
    const { inputs, collateralInputs } = inspectSignedTransactionFinancials(built.txCborHex);
    return { txHash: built.expectedTxHash, spentInputs: [...inputs, ...collateralInputs] };
  });
  const reservedInputs = (): OutputReference[] => [...pendingAccepts.values()].flatMap((accept) => accept.inputs);

  /** Accepts one Submitted escrow; retries a failed attempt and stops when no retry can succeed. */
  const settle = async (submittedRef: OutputReference, escrowRef: string): Promise<void> => {
    const submitted = refString(submittedRef);
    for (let attempt = 1; attempt <= ACCEPT_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(acceptRetryMs);
      let accept: { txHash: string; confirmed: Promise<void> };
      try {
        accept = await wallet.run(async () => {
          const sent = await submitAccept(submittedRef, reservedInputs());
          const confirmed = chain!.awaitTx(sent.txHash, ACCEPT_CONFIRM_TIMEOUT_MS);
          confirmed.catch(() => undefined); // awaited below; this only marks the rejection handled
          pendingAccepts.set(sent.txHash, { inputs: sent.spentInputs, confirmed });
          return { txHash: sent.txHash, confirmed };
        });
      } catch (error) {
        if (error instanceof TxConstructionError && FINAL_ACCEPT_REASONS[error.reason]) {
          console.warn(`[paper2agent-model] accept of ${submitted} not sent: ${error.reason}`);
          return;
        }
        console.error(`[paper2agent-model] accept of ${submitted} attempt ${attempt} failed: ${errorMessage(error)}`);
        continue;
      }
      try {
        await accept.confirmed;
        console.log(`[paper2agent-model] accepted escrow=${escrowRef} accept=${accept.txHash}`);
        return;
      } catch (error) {
        console.error(`[paper2agent-model] accept ${accept.txHash} of ${submitted} not confirmed: ${errorMessage(error)}`);
      } finally {
        pendingAccepts.delete(accept.txHash);
      }
    }
    console.error(`[paper2agent-model] accept_failed ${submitted}: accept it with POST /v1/accept within 10 minutes of its submission`);
  };

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
      let busyEndpoint: string | undefined;
      /** A Post reached its beforeSubmit hook: it may be on chain, so a failure is no longer free to resend. */
      let postSent = false;
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
        // Busy, unreachable, or incompatible suppliers are skipped before any funds move.
        // The lock ends with the confirmed Post; the supplier call and the Accept run outside it.
        const { advert, posted } = await wallet.run(async () => {
          let selected: { advert: Advert; prepared: PreparedPrompt } | undefined;
          for (const advert of await candidateAdverts(marketplace!, model, autoExcluded)) {
            if (busyEndpoints.has(advert.endpointUrl) || (failedUntil.get(advert.endpointUrl) ?? 0) > Date.now() ||
                !await liveFree(advert.endpointUrl, fetchImpl)) continue;
            try {
              selected = { advert, prepared: await marketplace!.preparePrompt({
                advertRef: advert.ref,
                payment_lovelace: advert.priceLovelace,
                ...request,
                ...(request.max_output_tokens === undefined ? {} : {
                  max_output_tokens: Math.min(request.max_output_tokens, advert.maxOutputTokens),
                }),
              }) };
              break;
            } catch (error) {
              if (!(error instanceof TxConstructionError) || error.reason === "invalid_response_request") throw error;
              console.warn(`[paper2agent-model] skip ${advert.model} ${refString(advert.ref)}: ${error.reason}`);
            }
          }
          if (!selected) {
            throw new ModelCallError(503, "model_unavailable", model === AUTO_MODEL
              ? `No free ${CAPABILITY_ID} supplier accepts this request.`
              : `No free ${CAPABILITY_ID} supplier offers ${model}.`);
          }
          const { advert, prepared } = selected;
          busyEndpoint = advert.endpointUrl;
          busyEndpoints.add(busyEndpoint);
          const fundAndPost = async (): Promise<PostedPrompt> => {
            const reserved = reservedInputs();
            await assertFunds(chain!, walletKey!, prepared, reserved);
            return marketplace!.postPrompt(prepared, async () => { postSent = true; }, { excludeInputs: reserved });
          };
          try {
            return { advert, posted: await fundAndPost() };
          } catch (error) {
            // Outputs of pending Accepts stay reserved. If the rest cannot pay, wait for those blocks once.
            // Both errors come before any broadcast, so the second Post cannot duplicate the first.
            const reservedShortfall = pendingAccepts.size > 0 &&
              (error instanceof TxConstructionError || (error instanceof ModelCallError && error.status === 402));
            if (!reservedShortfall) throw error;
            await Promise.allSettled([...pendingAccepts.values()].map((accept) => accept.confirmed));
            return { advert, posted: await fundAndPost() };
          }
        });

        let submit: SubmitPromptResult;
        try {
          submit = await marketplace!.executePrompt(posted, undefined, { pollIntervalMs: RESULT_POLL_MS });
        } catch (error) {
          failedUntil.set(advert.endpointUrl, Date.now() + FAILED_SUPPLIER_COOLDOWN_MS);
          console.error(`[paper2agent-model] ${advert.model} ${advert.endpointUrl} failed; skipped for 15 min`);
          throw error;
        }
        const submittedRef = submit.submittedRef ?? await findSubmittedEscrowRef(
          indexerUrl!, walletKey!.pubKeyHash, submit.receipt.prompt_hash, SUBMITTED_LOOKUP_TIMEOUT_MS);
        const escrowRef = refString(submit.escrowRef);
        // The build continues while the Accept waits for its block.
        const settlement = settle(submittedRef, escrowRef);
        options.backgroundTasks?.add(settlement);
        void settlement.finally(() => options.backgroundTasks?.delete(settlement));
        if (archive) {
          try {
            archive.persistChat({
              escrow_ref: escrowRef,
              posted_at: started,
              capability_id: CAPABILITY_ID,
              supplier_pkh: submit.receipt.supplier_pkh,
              model: submit.receipt.model,
              payment_lovelace: advert.priceLovelace.toString(),
              request_envelope: submit.request,
              response_canonical: canonicalize(responseResultCommitment(submit.result)),
              receipt: submit.receipt as unknown as Record<string, unknown>,
              receipt_signature: submit.receiptSignature,
            });
          } catch (error) {
            console.error(`[paper2agent-model] archive.persistChat failed for ${escrowRef}: ${errorMessage(error)}`);
          }
        }
        console.log(`[paper2agent-model] ${model}→${advert.model} escrow=${escrowRef} ` +
          `seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
        res.status(200).json(chatCompletion(advert.model, submit.result, {
          escrow_ref: escrowRef,
          submitted_ref: refString(submittedRef),
          accept: "pending",
          receipt: submit.receipt,
          receipt_signature: submit.receiptSignature,
        }));
      } catch (error) {
        if (error instanceof ModelCallError) {
          if (error.status >= 500) console.error(`[paper2agent-model] ${model} ${error.code}: ${error.message}`);
          sendError(res, error);
          return;
        }
        if (!postSent && isChainAvailabilityError(error)) {
          const detail = errorMessage(error).slice(0, 4000);
          console.error(`[paper2agent-model] ${model} chain_unavailable: ${detail}`);
          sendError(res, new ModelCallError(503, "chain_unavailable",
            `The chain or indexer is unavailable (${detail}). No payment was made; the call can be retried.`));
          return;
        }
        const reason = error instanceof Error && "reason" in error ? String(error.reason) : "paid_call_failed";
        console.error(`[paper2agent-model] ${model} failed reason=${reason}: ${errorMessage(error)}`);
        sendError(res, new ModelCallError(502, reason.slice(0, 100), errorMessage(error).slice(0, 4000)));
      } finally {
        if (busyEndpoint) busyEndpoints.delete(busyEndpoint);
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
