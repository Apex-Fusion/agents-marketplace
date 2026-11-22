/**
 * The legacy chat route of a supplier over a MockChainProvider: the sample advert, the request that the sample escrows commit to,
 * the Ollama stand-ins, and the supplier app with the stores that its routes use. The tests of POST /v1/responses, of its job
 * route, of GET /capability and of the deadline use it. The sample escrows are in `sample-escrow-state.ts`.
 */

import { vi } from "vitest";
import request from "supertest";
import type { Application } from "express";
import type { ChainProvider, Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import { MockChainProvider } from "../../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../../packages/shared/src/cbor/types.js";
import type { SupplierConfig } from "../../../supplier/src/config.js";
import { JobStore } from "../../../supplier/src/jobs.js";
import { createApp } from "../../../supplier/src/server.js";
import { SupplierState } from "../../../supplier/src/state.js";
import { buildSampleConfig, SAMPLE_ADVERT_INDEX, SAMPLE_ADVERT_TX_HASH } from "./sample-config.js";
import { CAPABILITY_ID, OPEN_ESCROW_REF, TEST_MAX_OUTPUT_TOKENS, TEST_MODEL, TEST_RESPONSE_INPUT } from "./sample-escrow-state.js";
import { buildSupplierWalletKey, SUPPLIER_PKH } from "./wallet-keys.js";

/** The request body that the sample escrows commit to (`PROMPT_HASH`). */
export function validChatBody() {
  return { model: TEST_MODEL, input: TEST_RESPONSE_INPUT, max_output_tokens: TEST_MAX_OUTPUT_TOKENS };
}

/** The Active advert that the sample escrows and the sample config point at. */
export function buildActiveAdvertDatum(): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER_PKH,
    capability_id: CAPABILITY_ID,
    model: TEST_MODEL,
    max_output_tokens: TEST_MAX_OUTPUT_TOKENS,
    max_processing_ms: 60_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "http://supplier.example:8080",
    detail_uri: "ipfs://QmTest",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

/** Put an advert at the advert ref of the sample config. */
export function seedAdvertUtxo(chain: MockChainProvider, datum: AdvertDatum = buildActiveAdvertDatum()): void {
  chain.seed({
    ref: { txHash: SAMPLE_ADVERT_TX_HASH, index: SAMPLE_ADVERT_INDEX },
    address: "addr_test1wfakeadvertaddress",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(datum),
    scriptRef: null,
  });
}

/** A chain with the advert and `escrows`. The tip is far below every deliver_by of the sample escrows. */
export function chainWith(...escrows: Utxo[]): MockChainProvider {
  const chain = new MockChainProvider();
  seedAdvertUtxo(chain);
  for (const escrow of escrows) chain.seed(escrow);
  chain.advanceSlot(1_000);
  return chain;
}

export interface ChatApp {
  app: Application;
  state: SupplierState;
  jobs: JobStore;
}

/** The supplier app over `chain`. Pass a store to keep a handle on it; `config` overrides the sample config. */
export function makeApp(
  chain: ChainProvider,
  options: { state?: SupplierState; jobs?: JobStore; config?: Partial<SupplierConfig> } = {},
): ChatApp {
  const state = options.state ?? new SupplierState();
  const jobs = options.jobs ?? new JobStore();
  const app = createApp({ chain, state, jobs, config: { ...buildSampleConfig(), ...options.config }, supplierKey: buildSupplierWalletKey() });
  return { app, state, jobs };
}

/** POST /v1/responses. `ref: null` sends no X-Escrow-Ref header. */
export function postChat(app: Application, body: unknown = validChatBody(), ref: string | null = OPEN_ESCROW_REF) {
  const post = request(app).post("/v1/responses");
  return (ref === null ? post : post.set("X-Escrow-Ref", ref)).send(body as object);
}

/** Wait for the background runner: it frees the supplier slot in its `finally` block, whether the job worked or not. */
export async function drainRunner(state: SupplierState, timeoutMs = 1_000): Promise<void> {
  await vi.waitFor(() => {
    if (state.snapshot().status !== "free") throw new Error("runner not yet done");
  }, { timeout: timeoutMs, interval: 5 });
}

/** Ollama answers at once with `content` (12 prompt tokens, 48 completion tokens, 3,200 ms). */
export function mockOllamaOk(content = "I am a helpful assistant."): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      message: { role: "assistant", content },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 12,
      eval_count: 48,
      total_duration: 3_200_000_000,
    }),
  }));
}

/** Ollama answers 500. */
export function mockOllamaFailure(): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "Internal Server Error" }));
}

/** Ollama never answers: the job stays running. */
export function mockOllamaDeferred(): void {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })));
}
