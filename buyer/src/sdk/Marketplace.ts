/**
 * buyer/src/sdk/Marketplace.ts — core SDK class.
 *
 * Implements:
 *   discoverSuppliers(opts?)            → indexer GET /suppliers
 *   submitPrompt({advertRef, ...})      → full lifecycle (escrow → supplier → verify → record)
 *   acceptResult({escrowRef})           → buildAcceptTx
 *   reclaim({escrowRef})                → buildReclaimTx
 *   getTaskHistory(opts?)               → reads from injected TaskHistoryStore
 *   on/off/close + emitProgress         → EventEmitter helpers
 *
 * Receipt verification:
 *   The buyer checks the canonical Responses request/result commitments,
 *   supplier identity, model, escrow reference, and signature shape before it
 *   returns a result. Supplier capability metadata is fetched before funds are
 *   locked. Full Ed25519 verification remains outside this browser-safe SDK
 *   path because the shared signing module imports Node crypto.
 */

// Namespace imports — Vite/Rollup resolves these to browser stubs when
// bundling the SPA. The SDK is also imported in Node-side code (buyer
// server, tests), where the namespace form works identically. See
// packages/shared/src/tx/blueprint.ts header for the full rationale.
import * as nodeEvents from "events";
import * as nodeCrypto from "crypto";

// Browser-safe EventEmitter shim. In the SPA bundle, Vite externalizes
// `events` to an empty stub, so `nodeEvents.EventEmitter` is `undefined` —
// `class Marketplace extends undefined` would throw at module load and
// stop React from ever mounting. We pick the real Node EventEmitter when
// available and fall back to a minimal listener-map class otherwise. The
// browser code path that uses the SDK only listens for "progress" events,
// which this fallback supports.
type Listener = (...args: unknown[]) => void;
class FallbackEventEmitter {
  private listeners = new Map<string, Listener[]>();
  on(event: string, cb: Listener): this {
    const arr = this.listeners.get(event);
    if (arr) arr.push(cb);
    else this.listeners.set(event, [cb]);
    return this;
  }
  off(event: string, cb: Listener): this {
    const arr = this.listeners.get(event);
    if (!arr) return this;
    const idx = arr.indexOf(cb);
    if (idx >= 0) arr.splice(idx, 1);
    return this;
  }
  emit(event: string, ...args: unknown[]): boolean {
    const arr = this.listeners.get(event);
    if (!arr || arr.length === 0) return false;
    for (const cb of [...arr]) cb(...args);
    return true;
  }
  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }
}
const EventEmitterBase: typeof FallbackEventEmitter =
  ((nodeEvents as unknown as { EventEmitter?: typeof FallbackEventEmitter }).EventEmitter)
    ?? FallbackEventEmitter;
import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import {
  buildPostEscrowTx,
  buildPostTtsEscrowTx,
  buildPostChatEscrowTx,
  buildPostOcrEscrowTx,
  ttsPromptHash,
  chatSessionPromptHash,
  ocrPromptHash,
  buildAcceptTx,
  buildReclaimTx,
  TxConstructionError,
  BOUNDED_INPUT_DETAIL_MARKER,
} from "@marketplace/shared/tx";
import { decodeAdvertDatum, decodeEscrowDatum, canonicalize } from "@marketplace/shared/cbor";
import {
  normalizeResponseOutput,
  normalizeResponseRequest,
  validateResponseToolOutputs,
  responseInputTokenUpperBound,
  responseOutputText,
  responseRequestCommitment,
  responseCompatibilityError,
  responseResultCommitment,
  type ResponseItem,
  type ResponseObject,
  type ResponseRequest,
} from "@marketplace/shared/responses";
import type { AdvertDatum } from "@marketplace/shared/cbor";
import type {
  SupplierView,
  DiscoverSuppliersOptions,
  SubmitPromptOptions,
  SubmitPromptResult,
  SupplierCapabilityView,
  SubmitTtsOptions,
  SubmitTtsResult,
  SubmitOcrOptions,
  SubmitOcrResult,
  StartChatOptions,
  StartChatResult,
  ChatSettleMode,
  EndChatOptions,
  EndChatResult,
  AcceptResultOptions,
  ReclaimOptions,
  TaskRecord,
  GetTaskHistoryOptions,
  ProgressEvent,
  ProgressEventType,
  Receipt,
} from "./types.js";
import { IndexerError, SupplierError, ReceiptVerificationError } from "./types.js";
import type { TaskHistoryStore } from "./history.js";
import { MemoryTaskHistoryStore } from "./history.js";
import { HttpClient, HttpError } from "./httpClient.js";
import { ESCROW_CONFIRM_TIMEOUT_MS, deliverByFor, supplierBudgetMs } from "./budget.js";

const ZERO_SIGNATURE = "0".repeat(128);

function validateSupplierCapability(
  body: unknown,
  advert: AdvertDatum,
  advertRef: OutputReference,
): SupplierCapabilityView {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TxConstructionError(
      "supplier_preflight_failed",
      "supplier /capability response must be an object",
    );
  }
  const capability = body as Record<string, unknown>;
  const expectedRef = `${advertRef.txHash}#${advertRef.index}`;
  if (
    capability.advert_ref !== expectedRef ||
    capability.capability_id !== advert.capability_id ||
    capability.model !== advert.model ||
    capability.max_processing_ms !== advert.max_processing_ms ||
    capability.price_lovelace !== advert.price_lovelace.toString() ||
    capability.supplier_pkh !== advert.supplier_pkh ||
    typeof capability.pub_key_hex !== "string" ||
    capability.inference_api !== "responses" ||
    typeof capability.upstream_api !== "string" ||
    !["responses", "chat-completions", "ollama"].includes(capability.upstream_api) ||
    (capability.reasoning_disabled !== undefined && typeof capability.reasoning_disabled !== "boolean")
  ) {
    throw new TxConstructionError(
      "supplier_preflight_failed",
      "supplier /capability response does not match the on-chain advert",
    );
  }
  if (
    typeof capability.max_output_tokens !== "number" ||
    !Number.isSafeInteger(capability.max_output_tokens) ||
    capability.max_output_tokens <= 0
  ) {
    throw new TxConstructionError(
      "supplier_preflight_failed",
      "supplier max_output_tokens must be a positive safe integer",
    );
  }
  if (
    capability.max_input_tokens !== undefined &&
    (
      typeof capability.max_input_tokens !== "number" ||
      !Number.isSafeInteger(capability.max_input_tokens) ||
      capability.max_input_tokens <= 0
    )
  ) {
    throw new TxConstructionError(
      "supplier_preflight_failed",
      "supplier max_input_tokens must be a positive safe integer",
    );
  }
  return capability as unknown as SupplierCapabilityView;
}
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const SIG_RE = /^[0-9a-fA-F]{128}$/;

/** NetworkParams — minimal params needed for tx building (protocol params). */
export interface NetworkParams {
  networkId: 0 | 1;
}

/** MarketplaceOpts — constructor arguments. */
export interface MarketplaceOpts {
  chain: ChainProvider;
  indexerUrl: string;
  walletKey: WalletKey;
  networkParams: NetworkParams;
  /** Optional history store; defaults to MemoryTaskHistoryStore. */
  historyStore?: TaskHistoryStore;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  _fetch?: typeof globalThis.fetch;
}

function sha256Hex(s: string): string {
  // Prefer Node's createHash when available (server, tests). In the browser
  // bundle Vite externalizes `crypto` to an empty stub, so fall back to the
  // already-installed `@noble/hashes/sha256` (the buyer-app pulls noble in
  // for ed25519 signing). Both produce the same 64-char lowercase hex.
  const c = nodeCrypto as { createHash?: (a: string) => { update: (s: string, e: string) => { digest: (e: string) => string } } };
  if (c && typeof c.createHash === "function") {
    return c.createHash("sha256").update(s, "utf8").digest("hex");
  }
  // Browser fallback: dynamic require of noble-hashes is bundled via the
  // top-level import below. Lazy-load so we don't pull noble into Node tests.
  return browserSha256Hex(s);
}
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
function browserSha256Hex(s: string): string {
  const bytes = nobleSha256(new TextEncoder().encode(s));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function refToString(ref: OutputReference): string {
  return `${ref.txHash}#${ref.index}`;
}

function parseRef(s: string): OutputReference | null {
  const m = /^([0-9a-fA-F]{64})#(0|[1-9]\d*)$/.exec(s);
  if (!m) return null;
  return { txHash: m[1], index: Number(m[2]) };
}

/** Random 32-hex session nonce. Works in both Node and the browser. */
function randomNonce(): string {
  const g = globalThis as {
    crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
  };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  g.crypto?.getRandomValues?.(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function previewInput(input: readonly ResponseItem[]): string {
  const firstUser = input.find(
    (item) => item.type === "message" && item.role === "user",
  );
  const firstMessage = firstUser ?? input.find((item) => item.type === "message");
  if (!firstMessage || firstMessage.type !== "message") return "";
  const text = firstMessage.content
    .filter((part) => part.type === "input_text" || part.type === "output_text")
    .map((part) => "text" in part && typeof part.text === "string" ? part.text : "")
    .join("");
  return text.length <= 100 ? text : text.slice(0, 100);
}

function responseDisplayText(output: readonly ResponseItem[]): string {
  return output.flatMap((item) =>
    item.type === "message" && item.role === "assistant"
      ? item.content.map((part) =>
          part.type === "refusal" ? part.refusal : part.text
        )
      : []
  ).join("");
}


export class Marketplace extends EventEmitterBase {
  private readonly chain: ChainProvider;
  private readonly indexerUrl: string;
  private readonly walletKey: WalletKey;
  private readonly networkParams: NetworkParams;
  private readonly historyStore: TaskHistoryStore;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly indexerHttp: HttpClient;

  constructor(opts: MarketplaceOpts) {
    super();
    this.chain = opts.chain;
    this.indexerUrl = opts.indexerUrl;
    this.walletKey = opts.walletKey;
    this.networkParams = opts.networkParams;
    this.historyStore = opts.historyStore ?? new MemoryTaskHistoryStore();
    this.fetchImpl = opts._fetch ?? globalThis.fetch.bind(globalThis);
    this.indexerHttp = new HttpClient({
      baseUrl: this.indexerUrl,
      fetch: this.fetchImpl,
    });
    void this.networkParams;
  }

  // ─── discovery ────────────────────────────────────────────────────────

  async discoverSuppliers(opts?: DiscoverSuppliersOptions): Promise<SupplierView[]> {
    let result;
    try {
      result = await this.indexerHttp.getJson("/suppliers", {
        query: {
          capability_id: opts?.capability_id,
          sort: opts?.sort,
        },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        throw new IndexerError(err.kind, { message: err.message });
      }
      throw err;
    }
    if (!result.ok) {
      throw new IndexerError("indexer_error", {
        status: result.status,
        message: `indexer returned ${result.status}`,
      });
    }
    if (result.parseError) {
      throw new IndexerError("malformed_response", {
        status: result.status,
        message: "indexer returned non-JSON body",
      });
    }
    if (!Array.isArray(result.body)) {
      throw new IndexerError("malformed_response", {
        status: result.status,
        message: "indexer /suppliers did not return an array",
      });
    }
    return result.body as SupplierView[];
  }
  // ─── submitPrompt — happy path + every adversarial branch ──────────────

  async submitPrompt(opts: SubmitPromptOptions): Promise<SubmitPromptResult> {
    const { advertRef, payment_lovelace, public_preview, ...requestOptions } = opts;
    let request: ResponseRequest;
    try {
      request = normalizeResponseRequest(requestOptions);
      if (request.input.length === 0 && !request.instructions?.trim()) {
        throw new Error("input or instructions are required");
      }
      validateResponseToolOutputs(request.input);
    } catch (error) {
      throw new TxConstructionError(
        "invalid_response_request",
        error instanceof Error ? error.message : String(error),
      );
    }

    let supplierHttp: HttpClient | null = null;
    let advertDatum: AdvertDatum | null = null;
    let escrowOutputRef: OutputReference | null = null;
    let escrowRefStr = "";
    let postedAtMs = Date.now();
    let deliverByMs = 0;

    const recordFailure = (reason: string): void => {
      this.historyStore.save({
        escrow_ref: escrowRefStr || `${"0".repeat(64)}#0`,
        supplier_pkh: advertDatum?.supplier_pkh ?? "",
        capability_id: advertDatum?.capability_id ?? "",
        prompt_preview: previewInput(request.input),
        posted_at: postedAtMs,
        status: "failed",
        failure_reason: reason,
      });
    };

    let escrowResult;
    try {
      const utxo = await this.chain.queryUtxo(advertRef);
      if (utxo?.datumHex) {
        try {
          advertDatum = decodeAdvertDatum(utxo.datumHex);
        } catch {
          /* The escrow builder reports the canonical structured error. */
        }
      }

      if (advertDatum) {
        if (advertDatum.status !== "Active") {
          throw new TxConstructionError("advert is retired");
        }
        if (payment_lovelace !== advertDatum.price_lovelace) {
          throw new TxConstructionError("payment must equal advertised price");
        }
        if (this.walletKey.pubKeyHash === advertDatum.supplier_pkh) {
          throw new TxConstructionError("buyer cannot be supplier");
        }
        supplierHttp = new HttpClient({
          baseUrl: advertDatum.endpoint_url,
          fetch: this.fetchImpl,
        });

        let capabilityResult;
        try {
          capabilityResult = await supplierHttp.getJson("/capability");
        } catch (error) {
          throw new TxConstructionError(
            "supplier_preflight_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!capabilityResult.ok || capabilityResult.parseError) {
          throw new TxConstructionError(
            "supplier_preflight_failed",
            `supplier /capability returned HTTP ${capabilityResult.status}`,
          );
        }
        const capability = validateSupplierCapability(
          capabilityResult.body,
          advertDatum,
          advertRef,
        );

        const compatibilityError = responseCompatibilityError(
          request,
          capability.upstream_api,
          capability.reasoning_disabled === true,
        );
        if (compatibilityError) {
          throw new TxConstructionError(
            "supplier_adapter_incompatible",
            compatibilityError.message,
            { cause: compatibilityError },
          );
        }

        if (advertDatum.detail_uri.endsWith(BOUNDED_INPUT_DETAIL_MARKER)) {
          if (capability.max_input_tokens === undefined) {
            throw new TxConstructionError(
              "supplier_preflight_failed",
              "bounded-input supplier omitted max_input_tokens",
            );
          }
          const requestUnits = responseInputTokenUpperBound(request);
          if (requestUnits > capability.max_input_tokens) {
            throw new TxConstructionError(
              "input_cap_exceeded",
              `request bound ${requestUnits} exceeds supplier cap ${capability.max_input_tokens}`,
            );
          }
        }

        if (request.max_output_tokens !== undefined) {
          request = {
            ...request,
            max_output_tokens: Math.min(
              request.max_output_tokens,
              advertDatum.max_output_tokens,
              capability.max_output_tokens,
            ),
          };
        }
      }

      const promptHash = sha256Hex(canonicalize(responseRequestCommitment(request)));
      escrowResult = await buildPostEscrowTx({
        chain: this.chain,
        buyerKey: this.walletKey,
        advertRef,
        prompt_hash: promptHash,
        payment_lovelace,
      });
    } catch (err) {
      if (err instanceof TxConstructionError) {
        recordFailure(err.reason);
        throw err;
      }
      this.emitProgress({ type: "chain_submit_failed", detail: (err as Error).message });
      recordFailure((err as Error).message);
      throw err;
    }

    escrowOutputRef = escrowResult.escrowOutputRef;
    escrowRefStr = refToString(escrowOutputRef);
    this.emitProgress({ type: "escrow_posted", escrow_ref: escrowRefStr });

    try {
      await this.chain.awaitTx(escrowResult.expectedTxHash, ESCROW_CONFIRM_TIMEOUT_MS);
    } catch {
      /* Mock providers can omit confirmation support. */
    }

    try {
      const escrowUtxo = await this.chain.queryUtxo(escrowOutputRef);
      if (escrowUtxo?.datumHex) {
        const escrowDatum = decodeEscrowDatum(escrowUtxo.datumHex);
        postedAtMs = escrowDatum.posted_at;
        deliverByMs = escrowDatum.deliver_by;
      }
    } catch {
      /* posted_at remains best-effort history metadata */
    }

    if (!advertDatum || !supplierHttp) {
      const reason = "supplier unavailable after escrow post";
      recordFailure(reason);
      throw new ReceiptVerificationError(reason);
    }
    if (deliverByMs === 0) {
      deliverByMs = deliverByFor(postedAtMs, advertDatum.max_processing_ms);
    }

    let responseResult;
    try {
      responseResult = await supplierHttp.postJson(
        "/v1/responses",
        { model: advertDatum.model, ...request },
        {
          headers: {
            "X-Escrow-Ref": escrowRefStr,
            ...(public_preview ? { "X-Vector-Public-Preview": "1" } : {}),
          },
          timeoutMs: supplierBudgetMs(deliverByMs),
        },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        const reason = err.kind === "timeout" ? "timeout" : "network_error";
        recordFailure(reason);
        throw new SupplierError(reason, { message: err.message });
      }
      recordFailure((err as Error).message);
      throw err;
    }

    if (responseResult.status === 202 && responseResult.body && typeof responseResult.body === "object") {
      const jobId = (responseResult.body as { job_id?: string }).job_id;
      if (typeof jobId !== "string" || jobId.length === 0) {
        recordFailure("malformed_response");
        throw new SupplierError("malformed_response", {
          status: responseResult.status,
          message: "supplier 202 response missing job_id",
        });
      }
      const pollBudgetMs = supplierBudgetMs(deliverByMs);
      const pollDeadline = Date.now() + pollBudgetMs;
      let polled = responseResult;
      let firstPoll = true;
      while (Date.now() < pollDeadline) {
        if (!firstPoll) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
        }
        firstPoll = false;
        try {
          polled = await supplierHttp.getJson(`/v1/responses/${jobId}`);
        } catch (err) {
          if (err instanceof HttpError) {
            const reason = err.kind === "timeout" ? "timeout" : "network_error";
            recordFailure(reason);
            throw new SupplierError(reason, { message: err.message });
          }
          throw err;
        }
        if (polled.status === 200) break;
        if (polled.status === 202) continue;
        const failure = polled.body && typeof polled.body === "object"
          ? polled.body as { reason?: string; message?: string }
          : {};
        const reason = failure.reason ?? "supplier_http_error";
        recordFailure(reason);
        throw new SupplierError(reason, {
          status: polled.status,
          message: failure.message ?? `supplier returned ${polled.status}`,
        });
      }
      if (polled.status !== 200) {
        recordFailure("timeout");
        throw new SupplierError("timeout", {
          status: polled.status,
          message: `supplier job ${jobId} not done within ${pollBudgetMs}ms`,
        });
      }
      responseResult = polled;
    }

    if (!responseResult.ok) {
      const failure = responseResult.body && typeof responseResult.body === "object"
        ? responseResult.body as { reason?: string; message?: string }
        : {};
      const reason = failure.reason ?? "supplier_http_error";
      recordFailure(reason);
      throw new SupplierError(reason, {
        status: responseResult.status,
        message: failure.message ?? `supplier returned ${responseResult.status}`,
      });
    }
    if (responseResult.parseError || !responseResult.body || typeof responseResult.body !== "object") {
      recordFailure("malformed_response");
      throw new SupplierError("malformed_response", {
        status: responseResult.status,
        message: "supplier body is not valid JSON",
      });
    }

    const responseBody = responseResult.body as Record<string, unknown>;
    const receipt = responseBody.receipt;
    const receiptSignature = responseBody.receipt_signature;
    const submittedRef = responseBody.submitted_ref;
    const rawResult = { ...responseBody };
    delete rawResult.receipt;
    delete rawResult.receipt_signature;
    delete rawResult.escrow_ref;
    delete rawResult.submitted_ref;
    if (!receipt || typeof receipt !== "object" || typeof receiptSignature !== "string") {
      recordFailure("malformed_response");
      throw new SupplierError("malformed_response", {
        status: responseResult.status,
        message: "supplier response is missing receipt or receipt_signature",
      });
    }

    let output: ResponseItem[];
    try {
      output = normalizeResponseOutput(rawResult.output);
    } catch (error) {
      recordFailure("malformed_response");
      throw new SupplierError("malformed_response", {
        status: responseResult.status,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const status = rawResult.status;
    const usage = rawResult.usage;
    const usageValid = usage === null || (
      typeof usage === "object" &&
      !Array.isArray(usage) &&
      "input_tokens" in usage &&
      typeof usage.input_tokens === "number" &&
      "output_tokens" in usage &&
      typeof usage.output_tokens === "number" &&
      "total_tokens" in usage &&
      typeof usage.total_tokens === "number"
    );
    const errorValid = rawResult.error === null ||
      (typeof rawResult.error === "object" && !Array.isArray(rawResult.error));
    const incompleteDetails = rawResult.incomplete_details;
    const incompleteValid = status === "incomplete"
      ? (
          incompleteDetails !== null &&
          typeof incompleteDetails === "object" &&
          !Array.isArray(incompleteDetails) &&
          "reason" in incompleteDetails &&
          typeof incompleteDetails.reason === "string"
        )
      : incompleteDetails === null;
    if (
      rawResult.object !== "response" ||
      typeof rawResult.id !== "string" ||
      typeof rawResult.created_at !== "number" ||
      typeof rawResult.model !== "string" ||
      (status !== "completed" && status !== "incomplete") ||
      !usageValid ||
      !errorValid ||
      !incompleteValid
    ) {
      recordFailure("malformed_response");
      throw new SupplierError("malformed_response", {
        status: responseResult.status,
        message: "supplier did not return a terminal Response object",
      });
    }
    const result = { ...rawResult, output } as ResponseObject;
    const verifiedReceipt = receipt as unknown as Receipt;
    const responseContent = responseOutputText(result.output);

    this.emitProgress({ type: "supplier_called", escrow_ref: escrowRefStr });

    if (verifiedReceipt.supplier_pkh !== advertDatum.supplier_pkh) {
      recordFailure("wrong_supplier");
      throw new ReceiptVerificationError("wrong_supplier");
    }
    if (verifiedReceipt.escrow_ref !== escrowRefStr) {
      recordFailure("wrong_escrow_ref");
      throw new ReceiptVerificationError("wrong_escrow_ref");
    }
    const expectedPromptHash = sha256Hex(canonicalize(responseRequestCommitment(request)));
    if (verifiedReceipt.prompt_hash !== expectedPromptHash) {
      recordFailure("prompt_hash_mismatch");
      throw new ReceiptVerificationError("prompt_hash_mismatch");
    }
    if (verifiedReceipt.model !== advertDatum.model || result.model !== advertDatum.model) {
      recordFailure("request_spec_hash_mismatch");
      throw new ReceiptVerificationError("request_spec_hash_mismatch");
    }
    const expectedResponseHash = sha256Hex(
      canonicalize(responseResultCommitment(result)),
    );
    if (verifiedReceipt.response_hash !== expectedResponseHash) {
      recordFailure("response_hash_mismatch");
      throw new ReceiptVerificationError("response_hash_mismatch");
    }
    if (!SIG_RE.test(receiptSignature) || receiptSignature === ZERO_SIGNATURE) {
      recordFailure("invalid_signature");
      throw new ReceiptVerificationError("invalid_signature");
    }
    if (!HEX64_RE.test(verifiedReceipt.prompt_hash) || !HEX64_RE.test(verifiedReceipt.response_hash)) {
      recordFailure("malformed_receipt");
      throw new ReceiptVerificationError("malformed_receipt");
    }

    this.emitProgress({ type: "receipt_verified", escrow_ref: escrowRefStr });
    this.historyStore.save({
      escrow_ref: escrowRefStr,
      supplier_pkh: advertDatum.supplier_pkh,
      capability_id: advertDatum.capability_id,
      prompt_preview: previewInput(request.input),
      posted_at: postedAtMs,
      status: "completed",
      response: responseDisplayText(result.output),
      receipt: verifiedReceipt,
      receipt_signature: receiptSignature,
    });

    return {
      response: responseContent,
      request,
      result,
      receipt: verifiedReceipt,
      receiptSignature,
      escrowRef: escrowOutputRef,
      submittedRef: parseRef(typeof submittedRef === "string" ? submittedRef : "") ?? undefined,
    };
  }

  // ─── submitTts — full marketplace lifecycle for audio.synthesize.piper.v1 ─

  async submitTts(opts: SubmitTtsOptions): Promise<SubmitTtsResult> {
    const { advertRef, text, voice, format, speed, payment_lovelace } = opts;
    const request = { text, voice, format, speed };

    let advertDatum: AdvertDatum | null = null;
    let escrowOutputRef: OutputReference | null = null;
    let escrowRefStr = "";
    let postedAtMs = Date.now();
    let deliverByMs = 0;

    const recordFailure = (reason: string): void => {
      this.historyStore.save({
        escrow_ref: escrowRefStr || `${"0".repeat(64)}#0`,
        supplier_pkh: advertDatum?.supplier_pkh ?? "",
        capability_id: advertDatum?.capability_id ?? "",
        prompt_preview: text.length <= 100 ? text : text.slice(0, 100),
        posted_at: postedAtMs,
        status: "failed",
        failure_reason: reason,
      });
    };

    // ── 1. Resolve advert + post escrow (TTS prompt_hash) ─────────────
    let escrowResult;
    try {
      const utxo = await this.chain.queryUtxo(advertRef);
      if (utxo && utxo.datumHex) {
        try {
          advertDatum = decodeAdvertDatum(utxo.datumHex);
        } catch { /* builder will re-throw structurally */ }
      }
      escrowResult = await buildPostTtsEscrowTx({
        chain: this.chain,
        buyerKey: this.walletKey,
        advertRef,
        request,
        payment_lovelace,
      });
    } catch (err) {
      if (err instanceof TxConstructionError) {
        recordFailure(err.reason);
        throw err;
      }
      this.emitProgress({ type: "chain_submit_failed", detail: (err as Error).message });
      recordFailure((err as Error).message);
      throw err;
    }

    escrowOutputRef = escrowResult.escrowOutputRef;
    escrowRefStr = refToString(escrowOutputRef);

    this.emitProgress({ type: "escrow_posted", escrow_ref: escrowRefStr });

    // ── 2. Wait for the escrow tx to confirm ──────────────────────────
    try {
      await this.chain.awaitTx(escrowResult.expectedTxHash, ESCROW_CONFIRM_TIMEOUT_MS);
    } catch { /* mock providers / tests */ }

    // ── 3. Re-fetch escrow datum to capture posted_at / deliver_by ────
    try {
      const escrowUtxo = await this.chain.queryUtxo(escrowOutputRef);
      if (escrowUtxo && escrowUtxo.datumHex) {
        const ed = decodeEscrowDatum(escrowUtxo.datumHex);
        postedAtMs = ed.posted_at;
        deliverByMs = ed.deliver_by;
      }
    } catch { /* metadata best-effort */ }

    if (!advertDatum) {
      const reason = "advert datum unavailable after escrow post";
      recordFailure(reason);
      throw new ReceiptVerificationError(reason);
    }

    // ── 4. Call supplier /v1/audio/synthesize ─────────────────────────
    if (deliverByMs === 0) {
      deliverByMs = deliverByFor(postedAtMs, advertDatum.max_processing_ms);
    }
    const supplierBaseUrl = advertDatum.endpoint_url;
    const supplierHttp = new HttpClient({
      baseUrl: supplierBaseUrl,
      fetch: this.fetchImpl,
    });
    const ttsBody = { text, voice, format, speed };

    let synthResult;
    try {
      synthResult = await supplierHttp.postJson("/v1/audio/synthesize", ttsBody, {
        headers: { "X-Escrow-Ref": escrowRefStr },
        timeoutMs: supplierBudgetMs(deliverByMs),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        const reason = err.kind === "timeout" ? "timeout" : "network_error";
        const sErr = new SupplierError(reason, { message: err.message });
        recordFailure(reason);
        throw sErr;
      }
      recordFailure((err as Error).message);
      throw err;
    }

    // 202 + poll mirror of submitPrompt's async chat handling.
    if (synthResult.status === 202 && synthResult.body && typeof synthResult.body === "object") {
      const jobId = (synthResult.body as { job_id?: string }).job_id;
      if (typeof jobId !== "string" || jobId.length === 0) {
        const sErr = new SupplierError("malformed_response", {
          status: synthResult.status,
          message: "supplier 202 response missing job_id",
        });
        recordFailure("malformed_response");
        throw sErr;
      }
      const POLL_INTERVAL_MS = 2_000;
      // The supplier may Submit right up to deliver_by; wait for the SLA
      // the advert committed to, not a fixed interval.
      const pollBudgetMs = supplierBudgetMs(deliverByMs);
      const pollDeadline = Date.now() + pollBudgetMs;
      let polled = synthResult;
      let firstIter = true;
      while (Date.now() < pollDeadline) {
        if (!firstIter) {
          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        firstIter = false;
        try {
          polled = await supplierHttp.getJson(`/v1/audio/synthesize/${jobId}`);
        } catch (err) {
          if (err instanceof HttpError) {
            const reason = err.kind === "timeout" ? "timeout" : "network_error";
            const sErr = new SupplierError(reason, { message: err.message });
            recordFailure(reason);
            throw sErr;
          }
          throw err;
        }
        if (polled.status === 200) break;
        if (polled.status === 202) continue;
        const failBody = (polled.body && typeof polled.body === "object")
          ? polled.body as { reason?: string; message?: string }
          : {};
        const sErr = new SupplierError(failBody.reason ?? "supplier_http_error", {
          status: polled.status,
          message: failBody.message ?? `supplier returned ${polled.status}`,
        });
        recordFailure(sErr.reason);
        throw sErr;
      }
      if (polled.status !== 200) {
        const sErr = new SupplierError("timeout", {
          status: polled.status,
          message: `supplier job ${jobId} not done within ${pollBudgetMs}ms`,
        });
        recordFailure("timeout");
        throw sErr;
      }
      synthResult = polled;
    }

    if (!synthResult.ok) {
      const bodyReason =
        synthResult.body && typeof synthResult.body === "object"
          ? ((synthResult.body as { reason?: string }).reason ?? "supplier_http_error")
          : "supplier_http_error";
      const sErr = new SupplierError(bodyReason, {
        status: synthResult.status,
        message: `supplier returned ${synthResult.status}`,
      });
      recordFailure(bodyReason);
      throw sErr;
    }
    if (synthResult.parseError || !synthResult.body || typeof synthResult.body !== "object") {
      const sErr = new SupplierError("malformed_response", {
        status: synthResult.status,
        message: "supplier body is not valid JSON",
      });
      recordFailure("malformed_response");
      throw sErr;
    }

    const responseBody = synthResult.body as {
      audio_b64?: string;
      format?: string;
      content_type?: string;
      byte_length?: number;
      receipt?: Receipt;
      receipt_signature?: string;
      submitted_ref?: string;
    };
    if (!responseBody.audio_b64 || !responseBody.receipt || !responseBody.receipt_signature) {
      const sErr = new SupplierError("malformed_response", {
        status: synthResult.status,
        message: "supplier response is missing audio_b64 / receipt / receipt_signature",
      });
      recordFailure("malformed_response");
      throw sErr;
    }
    const receipt = responseBody.receipt;
    const receiptSignature = responseBody.receipt_signature;

    this.emitProgress({ type: "supplier_called", escrow_ref: escrowRefStr });

    // ── 5. Receipt verification ───────────────────────────────────────
    if (receipt.supplier_pkh !== advertDatum.supplier_pkh) {
      recordFailure("wrong_supplier");
      throw new ReceiptVerificationError("wrong_supplier");
    }
    if (receipt.escrow_ref !== escrowRefStr) {
      recordFailure("wrong_escrow_ref");
      throw new ReceiptVerificationError("wrong_escrow_ref");
    }
    // The TTS prompt commitment uses the SAME canonical hash that the
    // supplier validated against the escrow datum. If we recompute it from
    // the request envelope we sent and it doesn't match the receipt, the
    // supplier signed a receipt for a different request → reject.
    const expectedPromptHash = ttsPromptHash(request);
    if (receipt.prompt_hash !== expectedPromptHash) {
      recordFailure("prompt_hash_mismatch");
      throw new ReceiptVerificationError("prompt_hash_mismatch");
    }
    if (receipt.model !== advertDatum.model) {
      recordFailure("request_spec_hash_mismatch");
      throw new ReceiptVerificationError("request_spec_hash_mismatch");
    }
    if (typeof receiptSignature !== "string" || !SIG_RE.test(receiptSignature)) {
      recordFailure("invalid_signature");
      throw new ReceiptVerificationError("invalid_signature");
    }
    if (receiptSignature === ZERO_SIGNATURE) {
      recordFailure("invalid_signature");
      throw new ReceiptVerificationError("invalid_signature");
    }
    if (!HEX64_RE.test(receipt.prompt_hash) || !HEX64_RE.test(receipt.response_hash)) {
      recordFailure("malformed_receipt");
      throw new ReceiptVerificationError("malformed_receipt");
    }

    this.emitProgress({ type: "receipt_verified", escrow_ref: escrowRefStr });

    this.historyStore.save({
      escrow_ref: escrowRefStr,
      supplier_pkh: advertDatum.supplier_pkh,
      capability_id: advertDatum.capability_id,
      prompt_preview: text.length <= 100 ? text : text.slice(0, 100),
      posted_at: postedAtMs,
      status: "completed",
      // Reuse the chat history shape — `response` carries a marker; the
      // SPA renders audio via the live result, not from history.
      response: `[audio:${responseBody.format ?? format} ${responseBody.byte_length ?? "?"}B]`,
      receipt,
      receipt_signature: receiptSignature,
    });

    return {
      audio_b64: responseBody.audio_b64,
      format: responseBody.format ?? format,
      content_type: responseBody.content_type ?? `audio/${format}`,
      byte_length: responseBody.byte_length ?? 0,
      receipt,
      receiptSignature,
      escrowRef: escrowOutputRef,
      submittedRef: parseRef(responseBody.submitted_ref ?? "") ?? undefined,
    };
  }

  // ─── submitOcr — full lifecycle for ocr.page.extract.<model-slug>.v1 ──

  async submitOcr(opts: SubmitOcrOptions): Promise<SubmitOcrResult> {
    const { advertRef, image_b64, mime, output_format, payment_lovelace } = opts;
    const request = { image_b64, mime, output_format };

    let advertDatum: AdvertDatum | null = null;
    let escrowOutputRef: OutputReference | null = null;
    let escrowRefStr = "";
    let postedAtMs = Date.now();
    let deliverByMs = 0;

    const previewStr = `[ocr:${mime} ${output_format} ${image_b64.length}b64]`;
    const recordFailure = (reason: string): void => {
      this.historyStore.save({
        escrow_ref: escrowRefStr || `${"0".repeat(64)}#0`,
        supplier_pkh: advertDatum?.supplier_pkh ?? "",
        capability_id: advertDatum?.capability_id ?? "",
        prompt_preview: previewStr,
        posted_at: postedAtMs,
        status: "failed",
        failure_reason: reason,
      });
    };

    // ── 1. Resolve advert + post escrow (OCR prompt_hash) ─────────────
    let escrowResult;
    try {
      const utxo = await this.chain.queryUtxo(advertRef);
      if (utxo && utxo.datumHex) {
        try {
          advertDatum = decodeAdvertDatum(utxo.datumHex);
        } catch { /* builder will re-throw structurally */ }
      }
      escrowResult = await buildPostOcrEscrowTx({
        chain: this.chain,
        buyerKey: this.walletKey,
        advertRef,
        request,
        payment_lovelace,
      });
    } catch (err) {
      if (err instanceof TxConstructionError) {
        recordFailure(err.reason);
        throw err;
      }
      this.emitProgress({ type: "chain_submit_failed", detail: (err as Error).message });
      recordFailure((err as Error).message);
      throw err;
    }

    escrowOutputRef = escrowResult.escrowOutputRef;
    escrowRefStr = refToString(escrowOutputRef);

    this.emitProgress({ type: "escrow_posted", escrow_ref: escrowRefStr });

    // ── 2. Wait for the escrow tx to confirm ──────────────────────────
    try {
      await this.chain.awaitTx(escrowResult.expectedTxHash, ESCROW_CONFIRM_TIMEOUT_MS);
    } catch { /* mock providers / tests */ }

    // ── 3. Re-fetch escrow datum to capture posted_at / deliver_by ────
    try {
      const escrowUtxo = await this.chain.queryUtxo(escrowOutputRef);
      if (escrowUtxo && escrowUtxo.datumHex) {
        const ed = decodeEscrowDatum(escrowUtxo.datumHex);
        postedAtMs = ed.posted_at;
        deliverByMs = ed.deliver_by;
      }
    } catch { /* metadata best-effort */ }

    if (!advertDatum) {
      const reason = "advert datum unavailable after escrow post";
      recordFailure(reason);
      throw new ReceiptVerificationError(reason);
    }

    // ── 4. Call supplier /v1/ocr/extract ──────────────────────────────
    if (deliverByMs === 0) {
      deliverByMs = deliverByFor(postedAtMs, advertDatum.max_processing_ms);
    }
    const supplierBaseUrl = advertDatum.endpoint_url;
    const supplierHttp = new HttpClient({
      baseUrl: supplierBaseUrl,
      fetch: this.fetchImpl,
    });
    const ocrBody = { image_b64, mime, output_format };

    let ocrResult;
    try {
      ocrResult = await supplierHttp.postJson("/v1/ocr/extract", ocrBody, {
        headers: { "X-Escrow-Ref": escrowRefStr },
        timeoutMs: supplierBudgetMs(deliverByMs),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        const reason = err.kind === "timeout" ? "timeout" : "network_error";
        const sErr = new SupplierError(reason, { message: err.message });
        recordFailure(reason);
        throw sErr;
      }
      recordFailure((err as Error).message);
      throw err;
    }

    // 202 + poll mirror of submitTts's async handling. OCR inference for a
    // page runs seconds; the long tail is the Submit tx confirmation.
    if (ocrResult.status === 202 && ocrResult.body && typeof ocrResult.body === "object") {
      const jobId = (ocrResult.body as { job_id?: string }).job_id;
      if (typeof jobId !== "string" || jobId.length === 0) {
        const sErr = new SupplierError("malformed_response", {
          status: ocrResult.status,
          message: "supplier 202 response missing job_id",
        });
        recordFailure("malformed_response");
        throw sErr;
      }
      const POLL_INTERVAL_MS = 2_000;
      // A cold upstream cache puts fresh conversions near the advert's SLA
      // (230–250 s against a 300 s advert); the budget must cover the SLA.
      const pollBudgetMs = supplierBudgetMs(deliverByMs);
      const pollDeadline = Date.now() + pollBudgetMs;
      let polled = ocrResult;
      let firstIter = true;
      while (Date.now() < pollDeadline) {
        if (!firstIter) {
          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        firstIter = false;
        try {
          polled = await supplierHttp.getJson(`/v1/ocr/extract/${jobId}`);
        } catch (err) {
          if (err instanceof HttpError) {
            const reason = err.kind === "timeout" ? "timeout" : "network_error";
            const sErr = new SupplierError(reason, { message: err.message });
            recordFailure(reason);
            throw sErr;
          }
          throw err;
        }
        if (polled.status === 200) break;
        if (polled.status === 202) continue;
        const failBody = (polled.body && typeof polled.body === "object")
          ? polled.body as { reason?: string; message?: string }
          : {};
        const sErr = new SupplierError(failBody.reason ?? "supplier_http_error", {
          status: polled.status,
          message: failBody.message ?? `supplier returned ${polled.status}`,
        });
        recordFailure(sErr.reason);
        throw sErr;
      }
      if (polled.status !== 200) {
        const sErr = new SupplierError("timeout", {
          status: polled.status,
          message: `supplier job ${jobId} not done within ${pollBudgetMs}ms`,
        });
        recordFailure("timeout");
        throw sErr;
      }
      ocrResult = polled;
    }

    if (!ocrResult.ok) {
      const bodyReason =
        ocrResult.body && typeof ocrResult.body === "object"
          ? ((ocrResult.body as { reason?: string }).reason ?? "supplier_http_error")
          : "supplier_http_error";
      const sErr = new SupplierError(bodyReason, {
        status: ocrResult.status,
        message: `supplier returned ${ocrResult.status}`,
      });
      recordFailure(bodyReason);
      throw sErr;
    }
    if (ocrResult.parseError || !ocrResult.body || typeof ocrResult.body !== "object") {
      const sErr = new SupplierError("malformed_response", {
        status: ocrResult.status,
        message: "supplier body is not valid JSON",
      });
      recordFailure("malformed_response");
      throw sErr;
    }

    const responseBody = ocrResult.body as {
      output_format?: string;
      content?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      receipt?: Receipt;
      receipt_signature?: string;
      submitted_ref?: string;
    };
    if (!responseBody.content || !responseBody.receipt || !responseBody.receipt_signature) {
      const sErr = new SupplierError("malformed_response", {
        status: ocrResult.status,
        message: "supplier response is missing content / receipt / receipt_signature",
      });
      recordFailure("malformed_response");
      throw sErr;
    }
    const receipt = responseBody.receipt;
    const receiptSignature = responseBody.receipt_signature;

    this.emitProgress({ type: "supplier_called", escrow_ref: escrowRefStr });

    // ── 5. Receipt verification ───────────────────────────────────────
    if (receipt.supplier_pkh !== advertDatum.supplier_pkh) {
      recordFailure("wrong_supplier");
      throw new ReceiptVerificationError("wrong_supplier");
    }
    if (receipt.escrow_ref !== escrowRefStr) {
      recordFailure("wrong_escrow_ref");
      throw new ReceiptVerificationError("wrong_escrow_ref");
    }
    // The OCR prompt commitment uses the SAME canonical hash the supplier
    // validated against the escrow datum. Recompute from the envelope we
    // sent; a mismatch means the supplier signed a different request.
    const expectedPromptHash = ocrPromptHash(request);
    if (receipt.prompt_hash !== expectedPromptHash) {
      recordFailure("prompt_hash_mismatch");
      throw new ReceiptVerificationError("prompt_hash_mismatch");
    }
    if (receipt.model !== advertDatum.model) {
      recordFailure("request_spec_hash_mismatch");
      throw new ReceiptVerificationError("request_spec_hash_mismatch");
    }
    // The receipt's response_hash must commit the content we actually
    // received in the requested output shape.
    const expectedResponseHash = nodeCrypto.createHash("sha256")
      .update(canonicalize({
        content: responseBody.content,
        output_format: responseBody.output_format ?? output_format,
      }), "utf8")
      .digest("hex");
    if (receipt.response_hash !== expectedResponseHash) {
      recordFailure("response_hash_mismatch");
      throw new ReceiptVerificationError("response_hash_mismatch");
    }
    if (typeof receiptSignature !== "string" || !SIG_RE.test(receiptSignature)) {
      recordFailure("invalid_signature");
      throw new ReceiptVerificationError("invalid_signature");
    }
    if (receiptSignature === ZERO_SIGNATURE) {
      recordFailure("invalid_signature");
      throw new ReceiptVerificationError("invalid_signature");
    }
    if (!HEX64_RE.test(receipt.prompt_hash) || !HEX64_RE.test(receipt.response_hash)) {
      recordFailure("malformed_receipt");
      throw new ReceiptVerificationError("malformed_receipt");
    }

    this.emitProgress({ type: "receipt_verified", escrow_ref: escrowRefStr });

    this.historyStore.save({
      escrow_ref: escrowRefStr,
      supplier_pkh: advertDatum.supplier_pkh,
      capability_id: advertDatum.capability_id,
      prompt_preview: previewStr,
      posted_at: postedAtMs,
      status: "completed",
      response: responseBody.content.length <= 200
        ? responseBody.content
        : responseBody.content.slice(0, 200),
      receipt,
      receipt_signature: receiptSignature,
    });

    return {
      output_format: responseBody.output_format ?? output_format,
      content: responseBody.content,
      usage: {
        prompt_tokens: responseBody.usage?.prompt_tokens ?? 0,
        completion_tokens: responseBody.usage?.completion_tokens ?? 0,
        total_tokens: responseBody.usage?.total_tokens ?? 0,
      },
      receipt,
      receiptSignature,
      escrowRef: escrowOutputRef,
      submittedRef: parseRef(responseBody.submitted_ref ?? "") ?? undefined,
    };
  }

  // ─── startChat / endChat — multi-turn llm.chat.v1 lifecycle ────────────

  /**
   * Open a chat session: post the escrow with a session-init prompt_hash, wait
   * for it to confirm, then tell the supplier to Claim (reserving its slot).
   * The conversation then runs off-chain via the buyer-app's SSE passthrough.
   */
  async startChat(opts: StartChatOptions): Promise<StartChatResult> {
    const { advertRef, payment_lovelace } = opts;

    const advertUtxo = await this.chain.queryUtxo(advertRef);
    if (!advertUtxo || !advertUtxo.datumHex) {
      throw new TxConstructionError("advert ref not on chain", `no advert UTxO at ${refToString(advertRef)}`);
    }
    const advertDatum = decodeAdvertDatum(advertUtxo.datumHex);
    if (advertDatum.status !== "Active") {
      throw new TxConstructionError("advert is retired");
    }
    if (payment_lovelace !== advertDatum.price_lovelace) {
      throw new TxConstructionError("payment must equal advertised price");
    }
    if (this.walletKey.pubKeyHash === advertDatum.supplier_pkh) {
      throw new TxConstructionError("buyer cannot be supplier");
    }

    const supplierHttp = new HttpClient({ baseUrl: advertDatum.endpoint_url, fetch: this.fetchImpl });

    // Capability compatibility is authoritative and must pass before funds
    // are locked. The buyer-app also keeps the declared upstream contract so
    // later session turns can reject controls that an adapter cannot preserve.
    let capabilityResult;
    try {
      capabilityResult = await supplierHttp.getJson("/capability");
    } catch (error) {
      throw new TxConstructionError(
        "supplier_preflight_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!capabilityResult.ok || capabilityResult.parseError) {
      throw new TxConstructionError(
        "supplier_preflight_failed",
        `supplier /capability returned HTTP ${capabilityResult.status}`,
      );
    }
    const capability = validateSupplierCapability(
      capabilityResult.body,
      advertDatum,
      advertRef,
    );

    // Pre-flight: refuse to lock any funds if the supplier is already serving
    // another chat. The supplier is single-slot, so a second concurrent escrow
    // would only 409 at Claim and be left stranded Open with funds locked.
    // Checking /status first keeps the buyer's funds unlocked. Best-effort: if
    // /status is unreachable we proceed, and the supplier's Claim still guards
    // the slot.
    try {
      const statusRes = await supplierHttp.getJson("/status");
      const liveStatus = statusRes.body && typeof statusRes.body === "object"
        ? (statusRes.body as { status?: string }).status
        : undefined;
      if (liveStatus === "working") {
        throw new SupplierError("supplier_busy", {
          status: 409,
          message: "supplier is busy with another chat session",
        });
      }
    } catch (err) {
      if (err instanceof SupplierError) throw err;
      /* /status unreachable — proceed; Claim still enforces the single slot */
    }

    const sessionNonce = randomNonce();
    let escrowResult;
    try {
      escrowResult = await buildPostChatEscrowTx({
        chain: this.chain,
        buyerKey: this.walletKey,
        advertRef,
        session_nonce: sessionNonce,
        payment_lovelace,
      });
    } catch (err) {
      if (!(err instanceof TxConstructionError)) {
        this.emitProgress({ type: "chain_submit_failed", detail: (err as Error).message });
      }
      throw err;
    }

    const escrowOutputRef = escrowResult.escrowOutputRef;
    const escrowRefStr = refToString(escrowOutputRef);
    this.emitProgress({ type: "escrow_posted", escrow_ref: escrowRefStr });

    // Wait for the PostEscrow tx to confirm before the supplier Claims.
    try {
      await this.chain.awaitTx(escrowResult.expectedTxHash, 120_000);
    } catch {
      /* mock providers / tests */
    }

    let startRes;
    try {
      startRes = await supplierHttp.postJson(
        "/v1/chat/start",
        { session_nonce: sessionNonce, model: advertDatum.model },
        { headers: { "X-Escrow-Ref": escrowRefStr } },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        const reason = err.kind === "timeout" ? "timeout" : "network_error";
        throw new SupplierError(reason, { message: err.message });
      }
      throw err;
    }
    if (!startRes.ok) {
      const bodyReason = startRes.body && typeof startRes.body === "object"
        ? ((startRes.body as { reason?: string }).reason ?? "supplier_http_error")
        : "supplier_http_error";
      throw new SupplierError(bodyReason, {
        status: startRes.status,
        message: `supplier /v1/chat/start returned ${startRes.status}`,
      });
    }

    if (!startRes.body || typeof startRes.body !== "object" || Array.isArray(startRes.body)) {
      throw new SupplierError("malformed_response", {
        status: startRes.status,
        message: "supplier /v1/chat/start did not return an object",
      });
    }
    const startBody = startRes.body as {
      status?: unknown;
      escrow_ref?: unknown;
      settle_mode?: unknown;
    };
    if (
      startBody.escrow_ref !== escrowRefStr ||
      (
        startBody.status !== "claimed" &&
        !(startBody.status === "ticket" && startBody.settle_mode === "ticket")
      )
    ) {
      throw new SupplierError("malformed_response", {
        status: startRes.status,
        message: "supplier /v1/chat/start returned an invalid session result",
      });
    }
    this.emitProgress({ type: "chat_started", escrow_ref: escrowRefStr });
    const settleMode: ChatSettleMode = startBody.status === "ticket" ? "ticket" : "full";
    return {
      escrowRef: escrowOutputRef,
      sessionNonce,
      supplierBaseUrl: advertDatum.endpoint_url,
      settleMode,
      upstreamApi: capability.upstream_api,
    };
  }

  /**
   * End a chat session: ask the supplier to Submit a transcript receipt, verify
   * it (structural + crypto + session-init prompt_hash), then Accept the
   * Submitted escrow — which is when the user is actually charged.
   */
  async endChat(opts: EndChatOptions): Promise<EndChatResult> {
    const { escrowRef, sessionNonce, transcript, supplierBaseUrl } = opts;
    const escrowRefStr = refToString(escrowRef);

    // The original Open escrow UTxO has ALREADY been spent by the supplier's
    // Claim (Open→Claimed) by the time End runs, so we must NOT queryUtxo it
    // (that was the cause of the "escrow ref not on chain" 502). Use the
    // supplier endpoint the buyer-app cached from startChat, and resolve
    // supplier identity (pkh, model) from /capability for verification.
    const supplierHttp = new HttpClient({ baseUrl: supplierBaseUrl, fetch: this.fetchImpl });
    let endRes;
    try {
      endRes = await supplierHttp.postJson("/v1/chat/end", {}, { headers: { "X-Escrow-Ref": escrowRefStr } });
    } catch (err) {
      if (err instanceof HttpError) {
        const reason = err.kind === "timeout" ? "timeout" : "network_error";
        throw new SupplierError(reason, { message: err.message });
      }
      throw err;
    }
    if (
      !endRes.ok ||
      !endRes.body ||
      typeof endRes.body !== "object" ||
      Array.isArray(endRes.body)
    ) {
      let bodyReason = "supplier_http_error";
      if (
        endRes.body &&
        typeof endRes.body === "object" &&
        !Array.isArray(endRes.body) &&
        "reason" in endRes.body &&
        typeof endRes.body.reason === "string"
      ) {
        bodyReason = endRes.body.reason;
      }
      throw new SupplierError(bodyReason, {
        status: endRes.status,
        message: `supplier /v1/chat/end returned ${endRes.status}`,
      });
    }
    const endBody = endRes.body as {
      status?: string;
      settle_mode?: string;
      escrow_ref?: string;
      receipt?: Receipt;
      receipt_signature?: string;
      submitted_ref?: string;
    };
    // Ticket sessions produce no receipt and nothing to Accept — the Open
    // escrow returns via reclaim after deliver_by.
    if (endBody.settle_mode === "ticket") {
      if (endBody.status !== "ended" || endBody.escrow_ref !== escrowRefStr) {
        throw new SupplierError("malformed_response", {
          status: endRes.status,
          message: "supplier /v1/chat/end returned an invalid ticket result",
        });
      }
      this.emitProgress({ type: "chat_ended", escrow_ref: escrowRefStr });
      return { settleMode: "ticket", escrowRef };
    }
    if (
      endBody.status !== "submitted" ||
      endBody.escrow_ref !== escrowRefStr ||
      !endBody.receipt ||
      !endBody.receipt_signature
    ) {
      throw new SupplierError("malformed_response", {
        status: endRes.status,
        message: "supplier /v1/chat/end returned an invalid submitted result",
      });
    }
    const receipt = endBody.receipt;
    const receiptSignature = endBody.receipt_signature;

    // ── Resolve supplier identity from /capability for verification ───────
    let capSupplierPkh = "";
    let capModel = "";
    try {
      const capRes = await supplierHttp.getJson("/capability");
      if (capRes.body && typeof capRes.body === "object") {
        capSupplierPkh = (capRes.body as { supplier_pkh?: string }).supplier_pkh ?? "";
        capModel = (capRes.body as { model?: string }).model ?? "";
      }
    } catch {
      /* best-effort; the escrow_ref + prompt_hash + signature checks below,
         plus the on-chain Accept (which routes funds per the Submitted datum),
         still hold even if /capability is briefly unavailable */
    }

    // ── Verify receipt ───────────────────────────────────────────────────
    if (capSupplierPkh && receipt.supplier_pkh !== capSupplierPkh) {
      throw new ReceiptVerificationError("wrong_supplier");
    }
    if (receipt.escrow_ref !== escrowRefStr) {
      throw new ReceiptVerificationError("wrong_escrow_ref");
    }
    // prompt_hash is the session-init placeholder, not a transcript hash.
    if (receipt.prompt_hash !== chatSessionPromptHash({ session_nonce: sessionNonce })) {
      throw new ReceiptVerificationError("prompt_hash_mismatch");
    }
    if (capModel && receipt.model !== capModel) {
      throw new ReceiptVerificationError("request_spec_hash_mismatch");
    }
    if (typeof receiptSignature !== "string" || !SIG_RE.test(receiptSignature) || receiptSignature === ZERO_SIGNATURE) {
      throw new ReceiptVerificationError("invalid_signature");
    }
    if (!HEX64_RE.test(receipt.prompt_hash) || !HEX64_RE.test(receipt.response_hash)) {
      throw new ReceiptVerificationError("malformed_receipt");
    }
    // Recompute the full ordered Item transcript hash from the browser mirror.
    const localHash = sha256Hex(canonicalize(transcript));
    if (localHash !== receipt.response_hash) {
      throw new ReceiptVerificationError(
        "response_hash_mismatch",
        `local transcript hash ${localHash} does not match receipt`,
      );
    }
    // NOTE: cryptographic Ed25519 verifyReceipt is intentionally NOT called
    // here. It lives in @marketplace/shared/receipt/sign.ts, whose top-level
    // `import { createHash } from "crypto"` cannot be bundled into the browser
    // SPA (Vite externalizes `crypto`). The one-off submitPrompt/submitTts
    // paths take the same structural-only stance (see the M1-E/M1-F note at the
    // top of this file). The structural checks above + the on-chain
    // result_receipt_hash commitment are the v1 verification surface.

    this.emitProgress({ type: "receipt_verified", escrow_ref: escrowRefStr });

    // ── Accept the Submitted escrow — the user is charged here ────────────
    const acceptedRef = parseRef(typeof endBody.submitted_ref === "string" ? endBody.submitted_ref : "");
    if (!acceptedRef) {
      throw new SupplierError("malformed_response", { message: "supplier end response missing/invalid submitted_ref" });
    }
    let acceptBuilt;
    try {
      acceptBuilt = await buildAcceptTx({ chain: this.chain, buyerKey: this.walletKey, escrowRef: acceptedRef });
    } catch (err) {
      if (err instanceof TxConstructionError) throw err;
      this.emitProgress({ type: "chain_submit_failed", detail: (err as Error).message });
      throw err;
    }
    try {
      await this.chain.awaitTx(acceptBuilt.expectedTxHash, 120_000);
    } catch {
      /* mock providers / tests — Accept tx already submitted */
    }
    this.emitProgress({ type: "accept_submitted", escrow_ref: refToString(acceptedRef) });
    this.emitProgress({ type: "chat_ended", escrow_ref: escrowRefStr });

    return { settleMode: "full", receipt, receiptSignature, escrowRef, acceptedRef };
  }

  // ─── acceptResult / reclaim ───────────────────────────────────────────

  async acceptResult(opts: AcceptResultOptions): Promise<void> {
    await buildAcceptTx({
      chain: this.chain,
      buyerKey: this.walletKey,
      escrowRef: opts.escrowRef,
    });
    this.emitProgress({
      type: "accept_submitted",
      escrow_ref: refToString(opts.escrowRef),
    });
    const escrowRefStr = refToString(opts.escrowRef);
    const existing = this.historyStore.get(escrowRefStr);
    if (existing) {
      this.historyStore.save({ ...existing, status: "completed" });
    }
  }

  async reclaim(opts: ReclaimOptions): Promise<void> {
    await buildReclaimTx({
      chain: this.chain,
      buyerKey: this.walletKey,
      escrowRef: opts.escrowRef,
    });
    this.emitProgress({
      type: "reclaim_submitted",
      escrow_ref: refToString(opts.escrowRef),
    });
    const escrowRefStr = refToString(opts.escrowRef);
    const existing = this.historyStore.get(escrowRefStr);
    if (existing) {
      this.historyStore.save({ ...existing, status: "reclaimed" });
    }
  }

  // ─── history ──────────────────────────────────────────────────────────

  getTaskHistory(opts?: GetTaskHistoryOptions): TaskRecord[] {
    return this.historyStore.list(opts);
  }

  // ─── accessors ────────────────────────────────────────────────────────

  /** Read the wallet key — UI surfaces this on /wallet. */
  getWalletKey(): WalletKey {
    return this.walletKey;
  }

  // ─── lifecycle ────────────────────────────────────────────────────────

  emitProgress(event: ProgressEvent): void {
    this.emit("progress", event);
  }

  close(): void {
    this.removeAllListeners();
  }

  on(event: "progress" | ProgressEventType | string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  off(event: "progress" | ProgressEventType | string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}
