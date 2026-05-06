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
 * Receipt verification (M1-E discipline):
 *   The SDK has no path to a 32-byte supplier public key in the test harness
 *   (Caroline's mocks return only the chat-completion body, no /capability
 *   pub-key plumbing). For M1-E we therefore verify receipts by:
 *     (a) field-equality checks against the advert datum and posted escrow:
 *         supplier_pkh, escrow_ref, prompt_hash, request_spec_hash
 *     (b) a structural signature check: 128-char hex, not the all-zero
 *         placeholder.
 *   Cryptographic Ed25519 verification is wired here as a NO-OP fallback
 *   when no pub-key is available; M1-F adds /capability pub-key fetch and
 *   replaces the structural check with a real verifyReceipt call. See
 *   ARCHITECTURE.md §5 + §9 for the broader plan.
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
  ttsPromptHash,
  buildAcceptTx,
  buildReclaimTx,
  TxConstructionError,
} from "@marketplace/shared/tx";
import { decodeAdvertDatum, decodeEscrowDatum, canonicalize } from "@marketplace/shared/cbor";
import type { AdvertDatum } from "@marketplace/shared/cbor";
import type {
  SupplierView,
  DiscoverSuppliersOptions,
  SubmitPromptOptions,
  SubmitPromptResult,
  SubmitTtsOptions,
  SubmitTtsResult,
  AcceptResultOptions,
  ReclaimOptions,
  TaskRecord,
  GetTaskHistoryOptions,
  ProgressEvent,
  ProgressEventType,
} from "./types.js";
import { IndexerError, SupplierError, ReceiptVerificationError } from "./types.js";
import type { TaskHistoryStore } from "./history.js";
import { MemoryTaskHistoryStore } from "./history.js";
import { HttpClient, HttpError } from "./httpClient.js";

const ZERO_SIGNATURE = "0".repeat(128);
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

function previewMessages(messages: { role: string; content: string }[]): string {
  const firstUser = messages.find((m) => m.role === "user") ?? messages[0];
  const text = firstUser?.content ?? "";
  return text.length <= 100 ? text : text.slice(0, 100);
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
    const { advertRef, messages, payment_lovelace, max_output_tokens } = opts;

    let advertDatum: AdvertDatum | null = null;
    let escrowOutputRef: OutputReference | null = null;
    let escrowRefStr = "";
    let postedAtMs = Date.now();

    const recordFailure = (reason: string): void => {
      this.historyStore.save({
        escrow_ref: escrowRefStr || `${"0".repeat(64)}#0`,
        supplier_pkh: advertDatum?.supplier_pkh ?? "",
        capability_id: advertDatum?.capability_id ?? "",
        prompt_preview: previewMessages(messages ?? []),
        posted_at: postedAtMs,
        status: "failed",
        failure_reason: reason,
      });
    };

    // ── 1. Resolve advert + post escrow tx via shared builder ────────
    let escrowResult;
    try {
      // Pre-fetch advert datum for response/history bookkeeping. The shared
      // builder repeats this query and enforces all invariants — we only peek
      // here so failure paths can populate the history record with metadata.
      const utxo = await this.chain.queryUtxo(advertRef);
      if (utxo && utxo.datumHex) {
        try {
          advertDatum = decodeAdvertDatum(utxo.datumHex);
        } catch {
          /* swallow — builder will throw a structured error */
        }
      }

      escrowResult = await buildPostEscrowTx({
        chain: this.chain,
        buyerKey: this.walletKey,
        advertRef,
        messages,
        payment_lovelace,
      });
    } catch (err) {
      if (err instanceof TxConstructionError) {
        recordFailure(err.reason);
        throw err;
      }
      // Chain submission failures bubble through here too.
      this.emitProgress({ type: "chain_submit_failed", detail: (err as Error).message });
      recordFailure((err as Error).message);
      throw err;
    }

    escrowOutputRef = escrowResult.escrowOutputRef;
    escrowRefStr = refToString(escrowOutputRef);

    // ── 2. progress: escrow_posted ────────────────────────────────────
    this.emitProgress({ type: "escrow_posted", escrow_ref: escrowRefStr });

    // ── 2.5. Wait for the escrow UTxO to confirm on chain before calling
    // the supplier. Without this, supplier.queryUtxo runs against a chain
    // tip that doesn't yet contain the PostEscrow tx and the supplier 404s
    // with escrow_not_found. Best-effort: if the chain provider doesn't
    // implement awaitTx (mock paths in tests), swallow and proceed —
    // queryUtxo retries on the next step provide adequate coverage there.
    try {
      await this.chain.awaitTx(escrowResult.expectedTxHash, 120_000);
    } catch {
      /* mock providers / test harnesses */
    }

    // ── 3. Re-fetch escrow datum to capture posted_at for history ────
    try {
      const escrowUtxo = await this.chain.queryUtxo(escrowOutputRef);
      if (escrowUtxo && escrowUtxo.datumHex) {
        const ed = decodeEscrowDatum(escrowUtxo.datumHex);
        postedAtMs = ed.posted_at;
      }
    } catch {
      /* posted_at is best-effort metadata */
    }

    if (!advertDatum) {
      // Should never happen — buildPostEscrowTx throws before this on missing/bad advert.
      const reason = "advert datum unavailable after escrow post";
      recordFailure(reason);
      throw new ReceiptVerificationError(reason);
    }

    // ── 4. Call supplier /v1/chat/completions ─────────────────────────
    const supplierBaseUrl = advertDatum.endpoint_url;
    const supplierHttp = new HttpClient({
      baseUrl: supplierBaseUrl,
      fetch: this.fetchImpl,
    });

    const requestedMax = max_output_tokens ?? advertDatum.max_output_tokens;
    const cappedMax = Math.min(requestedMax, advertDatum.max_output_tokens);
    const chatBody = {
      model: advertDatum.model,
      messages,
      max_tokens: cappedMax,
    };

    let chatResult;
    try {
      chatResult = await supplierHttp.postJson("/v1/chat/completions", chatBody, {
        headers: { "X-Escrow-Ref": escrowRefStr },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        // ARCH §9 #10 (resolved 2026-04-27, M1-F-1): the previous
        // `isSyncThrow` sentinel branch has been removed. All HttpError
        // paths — including fetch implementations that throw synchronously —
        // now propagate normally as SupplierError to the caller.
        const reason = err.kind === "timeout" ? "timeout" : "network_error";
        const sErr = new SupplierError(reason, { message: err.message });
        recordFailure(reason);
        throw sErr;
      }
      recordFailure((err as Error).message);
      throw err;
    }

    // Supplier shipped 202 + poll in M1-F-async-chat: the initial POST
    // returns `{job_id, status: "accepted"}` and clients poll
    // `GET /v1/chat/completions/:jobId` until the status becomes "done"
    // (200 with receipt) or terminal-failed (4xx/5xx). Older synchronous
    // suppliers still return 200 with the receipt immediately, so we
    // dispatch on `chatResult.status === 202` to keep both supported.
    if (chatResult.status === 202 && chatResult.body && typeof chatResult.body === "object") {
      const jobId = (chatResult.body as { job_id?: string }).job_id;
      if (typeof jobId !== "string" || jobId.length === 0) {
        const sErr = new SupplierError("malformed_response", {
          status: chatResult.status,
          message: "supplier 202 response missing job_id",
        });
        recordFailure("malformed_response");
        throw sErr;
      }
      const POLL_INTERVAL_MS = 2_000;
      const POLL_TIMEOUT_MS = 180_000;
      const pollDeadline = Date.now() + POLL_TIMEOUT_MS;
      let polled = chatResult;
      // First poll runs immediately so a quickly-completed job doesn't pay
      // the leading delay; subsequent polls wait POLL_INTERVAL_MS.
      let firstIter = true;
      while (Date.now() < pollDeadline) {
        if (!firstIter) {
          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        firstIter = false;
        try {
          polled = await supplierHttp.getJson(`/v1/chat/completions/${jobId}`);
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
        // 4xx/5xx on poll → terminal failure from supplier.
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
          message: `supplier job ${jobId} not done within ${POLL_TIMEOUT_MS}ms`,
        });
        recordFailure("timeout");
        throw sErr;
      }
      chatResult = polled;
    }

    if (!chatResult.ok) {
      const bodyReason =
        chatResult.body && typeof chatResult.body === "object"
          ? ((chatResult.body as { reason?: string }).reason ?? "supplier_http_error")
          : "supplier_http_error";
      const sErr = new SupplierError(bodyReason, {
        status: chatResult.status,
        message: `supplier returned ${chatResult.status}`,
      });
      recordFailure(bodyReason);
      throw sErr;
    }

    if (chatResult.parseError || !chatResult.body || typeof chatResult.body !== "object") {
      const sErr = new SupplierError("malformed_response", {
        status: chatResult.status,
        message: "supplier body is not valid JSON",
      });
      recordFailure("malformed_response");
      throw sErr;
    }

    const responseBody = chatResult.body as {
      choices?: Array<{ message?: { role?: string; content?: string } }>;
      receipt?: import("@marketplace/shared/receipt").Receipt;
      receipt_signature?: string;
    };

    if (!responseBody.receipt || !responseBody.receipt_signature) {
      const sErr = new SupplierError("malformed_response", {
        status: chatResult.status,
        message: "supplier response is missing receipt or receipt_signature",
      });
      recordFailure("malformed_response");
      throw sErr;
    }

    const receipt = responseBody.receipt;
    const receiptSignature = responseBody.receipt_signature;

    const responseContent = responseBody.choices?.[0]?.message?.content;
    if (typeof responseContent !== "string") {
      const sErr = new SupplierError("malformed_response", {
        status: chatResult.status,
        message: "supplier response missing choices[0].message.content",
      });
      recordFailure("malformed_response");
      throw sErr;
    }

    // ── 5. progress: supplier_called ──────────────────────────────────
    this.emitProgress({ type: "supplier_called", escrow_ref: escrowRefStr });

    // ── 6. Receipt verification (field equality + signature shape) ───
    if (receipt.supplier_pkh !== advertDatum.supplier_pkh) {
      recordFailure("wrong_supplier");
      throw new ReceiptVerificationError("wrong_supplier");
    }
    if (receipt.escrow_ref !== escrowRefStr) {
      recordFailure("wrong_escrow_ref");
      throw new ReceiptVerificationError("wrong_escrow_ref");
    }

    const expectedPromptHash = sha256Hex(canonicalize(messages));
    if (receipt.prompt_hash !== expectedPromptHash) {
      recordFailure("prompt_hash_mismatch");
      throw new ReceiptVerificationError("prompt_hash_mismatch");
    }

    // Receipt does not carry the full request_spec_hash — only `model`. Other
    // request_spec components (capability_id, max_output_tokens) are bound on
    // chain via the escrow datum, which the supplier already validated against
    // the advert. So the SDK only needs to assert the receipt's model matches
    // the advert it referenced.
    if (receipt.model !== advertDatum.model) {
      recordFailure("request_spec_hash_mismatch");
      throw new ReceiptVerificationError("request_spec_hash_mismatch");
    }

    if (typeof receiptSignature !== "string" || !SIG_RE.test(receiptSignature)) {
      recordFailure("invalid_signature");
      throw new ReceiptVerificationError("invalid_signature");
    }
    if (receiptSignature === ZERO_SIGNATURE) {
      // Structurally well-formed but cryptographically void. M1-F replaces
      // this with a real verifyReceipt() call once pub-key plumbing is wired.
      recordFailure("invalid_signature");
      throw new ReceiptVerificationError("invalid_signature");
    }

    // Defensive: receipt fields should be 32-byte hex.
    if (!HEX64_RE.test(receipt.prompt_hash) || !HEX64_RE.test(receipt.response_hash)) {
      recordFailure("malformed_receipt");
      throw new ReceiptVerificationError("malformed_receipt");
    }

    // ── 7. progress: receipt_verified ─────────────────────────────────
    this.emitProgress({ type: "receipt_verified", escrow_ref: escrowRefStr });

    // ── 8. Persist completed task ─────────────────────────────────────
    this.historyStore.save({
      escrow_ref: escrowRefStr,
      supplier_pkh: advertDatum.supplier_pkh,
      capability_id: advertDatum.capability_id,
      prompt_preview: previewMessages(messages),
      posted_at: postedAtMs,
      status: "completed",
      response: responseContent,
      receipt,
      receipt_signature: receiptSignature,
    });

    return {
      response: responseContent,
      receipt,
      receiptSignature,
      escrowRef: escrowOutputRef,
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
      await this.chain.awaitTx(escrowResult.expectedTxHash, 120_000);
    } catch { /* mock providers / tests */ }

    // ── 3. Re-fetch escrow datum to capture posted_at ─────────────────
    try {
      const escrowUtxo = await this.chain.queryUtxo(escrowOutputRef);
      if (escrowUtxo && escrowUtxo.datumHex) {
        const ed = decodeEscrowDatum(escrowUtxo.datumHex);
        postedAtMs = ed.posted_at;
      }
    } catch { /* metadata best-effort */ }

    if (!advertDatum) {
      const reason = "advert datum unavailable after escrow post";
      recordFailure(reason);
      throw new ReceiptVerificationError(reason);
    }

    // ── 4. Call supplier /v1/audio/synthesize ─────────────────────────
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
      // TTS jobs run on CPU and finish in 1–3s for short text; the long
      // tail is dominated by the Submit tx confirmation (slot rate). 180s
      // mirrors the chat path so polled.status hits 200 cleanly.
      const POLL_TIMEOUT_MS = 180_000;
      const pollDeadline = Date.now() + POLL_TIMEOUT_MS;
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
          message: `supplier job ${jobId} not done within ${POLL_TIMEOUT_MS}ms`,
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
      receipt?: import("@marketplace/shared/receipt").Receipt;
      receipt_signature?: string;
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
    };
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
