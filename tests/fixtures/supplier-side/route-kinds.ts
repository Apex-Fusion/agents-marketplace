/**
 * The four route kinds of a supplier: chat, tts, ocr and chat-session. For each kind, this file gives the configuration, the
 * advert, a request, and the escrows that commit to that request. A test of the supplier routes runs one table over the kinds.
 *
 * The supplier key is `identitySupplierKey()`, so that the same escrows work for the legacy layout and for the identity layout.
 */

import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { Application } from "express";
import type { ChainProvider, OutputReference, Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import { canonicalize } from "../../../packages/shared/src/cbor/canonical.js";
import { encodeAdvertDatum } from "../../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../../packages/shared/src/cbor/EscrowDatum.js";
import type { AdvertDatum, EscrowDatum } from "../../../packages/shared/src/cbor/types.js";
import { chatSessionPromptHash } from "../../../packages/shared/src/tx/escrow/postChatEscrow.js";
import { ocrPromptHash } from "../../../packages/shared/src/tx/escrow/postOcrEscrow.js";
import type { SupplierConfig } from "../../../supplier/src/config.js";
import { ChatSessionStore } from "../../../supplier/src/chatSession.js";
import type { SupplierIdentity } from "../../../supplier/src/identity/agent.js";
import { JobStore } from "../../../supplier/src/jobs.js";
import { createApp } from "../../../supplier/src/server.js";
import { SupplierState } from "../../../supplier/src/state.js";
import { buildSampleConfig, buildSampleOcrConfig, buildSampleTtsConfig, SAMPLE_ADVERT_INDEX, SAMPLE_ADVERT_TX_HASH } from "./sample-config.js";
import {
  BUYER_PKH, ESCROW_SCRIPT_ADDRESS, POSTED_AT, PROMPT_HASH, TEST_MAX_OUTPUT_TOKENS, TEST_MODEL, TEST_RESPONSE_INPUT,
} from "./sample-escrow-state.js";
import { identitySupplierKey } from "./identity.js";

export type RouteKind = "chat" | "tts" | "ocr" | "chat-session";
export const ROUTE_KINDS: readonly RouteKind[] = ["chat", "tts", "ocr", "chat-session"];

export const TTS_BODY = { text: "Hello world.", voice: "nova", format: "mp3", speed: 1 };
export const OCR_BODY = { image_b64: "aGVsbG8=", mime: "image/png", output_format: "markdown" };

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const refString = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

/** The advert that every route of this file reads. */
export const ADVERT_REF: OutputReference = { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX };

/** What one supplier route needs: its configuration, its capability, and a request that its escrows commit to. */
export interface Route {
  kind: RouteKind;
  config: SupplierConfig;
  capability: string;
  model: string;
  maxOutputTokens: number;
  path: string;
  body: Record<string, unknown>;
  promptHash: string;
}

export function routeOf(kind: RouteKind): Route {
  switch (kind) {
    case "chat":
      return {
        kind, config: buildSampleConfig(), capability: "llm.text.generate.v1", model: TEST_MODEL, maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
        path: "/v1/responses", body: { model: TEST_MODEL, input: TEST_RESPONSE_INPUT, max_output_tokens: TEST_MAX_OUTPUT_TOKENS },
        promptHash: PROMPT_HASH,
      };
    case "tts":
      return {
        kind, config: buildSampleTtsConfig(), capability: "audio.synthesize.piper.v1", model: "en_US-lessac-medium", maxOutputTokens: 0,
        path: "/v1/audio/synthesize", body: TTS_BODY, promptHash: sha256(canonicalize(TTS_BODY)),
      };
    case "ocr":
      return {
        kind, config: buildSampleOcrConfig(), capability: "ocr.page.extract.chandra-ocr-2.v1", model: "datalab-to/chandra-ocr-2",
        maxOutputTokens: 4096, path: "/v1/ocr/extract", body: OCR_BODY, promptHash: ocrPromptHash(OCR_BODY),
      };
    case "chat-session":
      return {
        kind,
        config: {
          ...buildSampleConfig(), capabilityKind: "chat-session", llmBackend: "openai", ollamaUrl: "", openaiBaseUrl: "http://openai.fake",
          chatIdleTimeoutMs: 60_000,
        },
        capability: "llm.chat.v1", model: "gpt-test", maxOutputTokens: 1024, path: "/v1/chat/start", body: { session_nonce: "nonce-1" },
        promptHash: chatSessionPromptHash({ session_nonce: "nonce-1" }),
      };
  }
}

/** The active advert of `route`, in the legacy layout. */
export function advertOf(route: Route): AdvertDatum {
  return {
    supplier_pkh: identitySupplierKey().pubKeyHash, capability_id: route.capability, model: route.model,
    max_output_tokens: route.maxOutputTokens, max_processing_ms: 60_000, price_lovelace: 2_000_000n, supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n, endpoint_url: "https://supplier.example", detail_uri: "", detail_hash: "a".repeat(64),
    advertised_at: POSTED_AT, status: "Active",
  };
}

export function advertUtxoOf(route: Route): Utxo {
  return {
    ref: ADVERT_REF, address: "addr_test1wfakeadvertaddress", lovelace: 2_000_000n, assets: {}, datumHex: encodeAdvertDatum(advertOf(route)),
    scriptRef: null,
  };
}

/** An open escrow of the legacy layout (14 fields) that commits to the request of `route`. */
export function escrowOf(route: Route, changes: Partial<EscrowDatum> = {}): EscrowDatum {
  return {
    buyer_pkh: BUYER_PKH, supplier_pkh: identitySupplierKey().pubKeyHash, advert_ref: ADVERT_REF, capability_id: route.capability,
    request_spec_hash: sha256(canonicalize({ capability_id: route.capability, max_output_tokens: route.maxOutputTokens, model: route.model })),
    prompt_hash: route.promptHash, payment_lovelace: 2_000_000n, buyer_bond_lovelace: 1_000_000n, supplier_bond_lovelace: 1_000_000n,
    deliver_by: POSTED_AT + 90_000, posted_at: POSTED_AT, submitted_at: null, result_receipt_hash: null, state: "Open", ...changes,
  };
}

export function escrowUtxoOf(route: Route, ref: OutputReference, changes: Partial<EscrowDatum> = {}): Utxo {
  return { ref, address: ESCROW_SCRIPT_ADDRESS, lovelace: 4_000_000n, assets: {}, datumHex: encodeEscrowDatum(escrowOf(route, changes)), scriptRef: null };
}

/** The supplier app over a chain, with the stores that its routes use. */
export interface Served {
  app: Application;
  state: SupplierState;
  jobs: JobStore;
  chatSessions: ChatSessionStore;
}

/** The supplier app of `route` over `chain`. */
export function serve(route: Route, chain: ChainProvider, options: { agentId?: string; identity?: SupplierIdentity } = {}): Served {
  const state = new SupplierState();
  const jobs = new JobStore();
  const chatSessions = new ChatSessionStore();
  const config: SupplierConfig = { ...route.config, advertRef: ADVERT_REF, agentId: options.agentId };
  const app = createApp({ chain, state, config, supplierKey: identitySupplierKey(), jobs, chatSessions, identity: options.identity });
  return { app, state, jobs, chatSessions };
}

/** The upstream services of the three one-shot capabilities answer at once. */
export function stubUpstreams(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const target = String(url);
    if (target.includes("/api/chat")) {
      return new Response(JSON.stringify({ message: { role: "assistant", content: "I am a test supplier." }, done: true,
        done_reason: "stop", prompt_eval_count: 12, eval_count: 7, total_duration: 1_000_000 }), { status: 200 });
    }
    if (target.includes("/v1/audio/speech")) {
      return new Response(new Uint8Array(256).fill(7), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    if (target.includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "# page" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected upstream ${target}`);
  }));
}
