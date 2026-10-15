/**
 * buyer-paper2agent-model.test.ts — the buyer's paid model endpoint for the
 * Paper2Agent build service: authentication before spending, the gateway's
 * insufficient-funds contract, advert choice, Chat Completions translation,
 * Accept, and one wallet transaction sequence at a time.
 */

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { ChainProvider, OutputReference, Utxo } from "@marketplace/shared/chain";
import type { AdvertDatum } from "@marketplace/shared/cbor";
import type { ResponseObject } from "@marketplace/shared/responses";
import { TxConstructionError, type WalletKey } from "@marketplace/shared/tx";
import { PAPER2AGENT_MODEL_PATH, registerPaper2AgentModelRoute } from "../../buyer/src/paper2agent/model.js";
import type { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import type { PostedPrompt, PreparedPrompt, SubmitPromptOptions, SubmitPromptResult, SupplierView } from "../../buyer/src/sdk/types.js";

const TOKEN = "build-model-token-".repeat(3);
const MODEL = "gpt-5.6-sol";
const SUBMITTED: OutputReference = { txHash: "dd".repeat(32), index: 0 };
const ACCEPT_TX = "ee".repeat(32);
const WALLET: WalletKey = {
  pubKeyHash: "ab".repeat(28),
  pubKeyHex: "cd".repeat(32),
  privateKeyHex: "0".repeat(64),
  address: "addr1vxbuyerwalletaddressforthetests0000000000000000000",
};

function view(utxoByte: string, overrides: Partial<SupplierView>): SupplierView {
  return {
    utxo_ref: `${utxoByte.repeat(32)}#0`,
    supplier_pkh: "12".repeat(28),
    capability_id: "llm.text.generate.v1",
    model: MODEL,
    max_output_tokens: 4096,
    max_processing_ms: 600_000,
    price_lovelace: "200000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "https://supplier.example",
    detail_uri: "",
    detail_hash: "00".repeat(32),
    advertised_at: 0,
    status: "free",
    advert_status: "Active",
    current_escrow_ref: null,
    last_seen_iso: null,
    created_slot: 1,
    ...overrides,
  };
}

function advertDatum(price: bigint): AdvertDatum {
  return {
    supplier_pkh: "12".repeat(28),
    capability_id: "llm.text.generate.v1",
    model: MODEL,
    max_output_tokens: 4096,
    max_processing_ms: 600_000,
    price_lovelace: price,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example",
    detail_uri: "",
    detail_hash: "00".repeat(32),
    advertised_at: 0,
    status: "Active",
  };
}

function utxo(lovelace: bigint, index: number): Utxo {
  return { ref: { txHash: "99".repeat(32), index }, address: WALLET.address, lovelace, assets: {} } as Utxo;
}

/** Node 20 has no Promise.withResolvers. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

function setup(options: {
  views?: SupplierView[]; walletUtxos?: Utxo[]; beforeExecute?: () => Promise<void>; accept?: () => Promise<string>;
  /** Live /status per endpoint URL; unlisted endpoints answer free. */
  liveStatus?: Record<string, string>;
  /** Advert byte whose supplier preflight refuses the request. */
  incompatible?: string;
  autoExcludedModels?: string[];
} = {}) {
  const events: string[] = [];
  const views = options.views ?? [view("11", {})];
  const discoverSuppliers = vi.fn(async () => views);
  const preparePrompt = vi.fn(async (opts: SubmitPromptOptions): Promise<PreparedPrompt> => {
    const { advertRef, payment_lovelace, public_preview, ...requestOptions } = opts;
    events.push("prepare");
    if (options.incompatible !== undefined && advertRef.txHash === options.incompatible.repeat(32)) {
      throw new TxConstructionError("supplier_preflight_failed", "supplier capability does not advertise Responses inference");
    }
    return { request: requestOptions, advertRef, advert: advertDatum(payment_lovelace), publicPreview: public_preview === true };
  });
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const endpoint = String(url).replace(/\/status$/, "");
    return new Response(JSON.stringify({ status: options.liveStatus?.[endpoint] ?? "free" }));
  });
  const postPrompt = vi.fn(async (prepared: PreparedPrompt): Promise<PostedPrompt> => {
    events.push("post");
    return { ...prepared, escrowRef: { txHash: "cc".repeat(32), index: 0 }, postedAt: 1, deliverBy: 2 };
  });
  const executePrompt = vi.fn(async (posted: PostedPrompt): Promise<SubmitPromptResult> => {
    await options.beforeExecute?.();
    events.push("execute");
    const result: ResponseObject = {
      id: "resp_1", object: "response", created_at: 1_791_800_000, model: MODEL, status: "completed",
      output: [{ type: "function_call", call_id: "call_2", name: "finish", arguments: "{\"done\":true}" }],
      usage: { input_tokens: 120, output_tokens: 7, total_tokens: 127 }, error: null, incomplete_details: null,
    };
    return {
      response: "", result, request: posted.request,
      receipt: { prompt_hash: "aa".repeat(32), supplier_pkh: "12".repeat(28), model: MODEL } as SubmitPromptResult["receipt"],
      receiptSignature: "ff".repeat(64), escrowRef: posted.escrowRef, submittedRef: SUBMITTED,
    };
  });
  const accept = vi.fn(options.accept ?? (async () => {
    events.push("accept");
    return ACCEPT_TX;
  }));
  const queryUtxosByAddress = vi.fn(async () => options.walletUtxos ?? [utxo(100_000_000n, 0), utxo(6_000_000n, 1)]);
  const app = express();
  registerPaper2AgentModelRoute(app, {
    token: TOKEN,
    marketplace: { discoverSuppliers, preparePrompt, postPrompt, executePrompt } as unknown as Marketplace,
    chain: { queryUtxosByAddress } as unknown as ChainProvider,
    walletKey: WALLET,
    indexerUrl: "http://indexer.invalid",
    accept,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    autoExcludedModels: options.autoExcludedModels,
  });
  return { app, events, discoverSuppliers, preparePrompt, postPrompt, executePrompt, accept, queryUtxosByAddress };
}

/** The request shape the Paper2Agent build agent sends after one tool round. */
const AGENT_BODY = {
  model: MODEL,
  messages: [
    { role: "system", content: "Build the tool." },
    { role: "user", content: "Paper text" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "{\"cmd\":\"ls\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"stdout\":\"server.py\"}" },
  ],
  tools: [{ type: "function", function: { name: "exec", description: "Run a command", parameters: { type: "object" } } }],
  tool_choice: "auto",
  parallel_tool_calls: false,
  max_completion_tokens: 4096,
  stream: false,
};

const post = (app: express.Express, body: object = AGENT_BODY) =>
  request(app).post(PAPER2AGENT_MODEL_PATH).set("Authorization", `Bearer ${TOKEN}`).send(body);

describe("buyer Paper2Agent paid model endpoint", () => {
  it("authenticates before discovery, wallet reads, or payment", async () => {
    const f = setup();
    for (const authorization of [undefined, "Bearer wrong-token", `Basic ${TOKEN}`, "Bearer "]) {
      const call = request(f.app).post(PAPER2AGENT_MODEL_PATH).send(AGENT_BODY);
      const response = await (authorization === undefined ? call : call.set("Authorization", authorization));
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("invalid_api_key");
    }
    expect(f.discoverSuppliers).not.toHaveBeenCalled();
    expect(f.queryUtxosByAddress).not.toHaveBeenCalled();
    expect(f.postPrompt).not.toHaveBeenCalled();
  });

  it("buys one call from the cheapest available advert and answers as a chat completion", async () => {
    const f = setup({ views: [
      view("21", { model: "other-model", price_lovelace: "100000" }),
      view("22", { capability_id: "llm.chat.v1", price_lovelace: "50000" }),
      view("23", { status: "offline", price_lovelace: "100000" }),
      view("24", { status: "working", price_lovelace: "100000" }),
      view("25", { advert_status: "Retired", price_lovelace: "100000" }),
      view("26", { price_lovelace: "300000" }),
      view("27", { price_lovelace: "200000", max_output_tokens: 1024, status: "unknown" }),
    ] });

    const response = await post(f.app);

    expect(response.status).toBe(200);
    expect(f.preparePrompt).toHaveBeenCalledTimes(1);
    const options = f.preparePrompt.mock.calls[0][0];
    expect(options.advertRef).toEqual({ txHash: "27".repeat(32), index: 0 });
    expect(options.payment_lovelace).toBe(200_000n);
    expect(options.max_output_tokens).toBe(1024);
    expect(options.input).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Build the tool." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Paper text" }] },
      { type: "function_call", call_id: "call_1", name: "exec", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"stdout\":\"server.py\"}" },
    ]);
    expect(options.tools).toEqual([{ type: "function", name: "exec", description: "Run a command", parameters: { type: "object" } }]);
    expect(f.accept).toHaveBeenCalledWith(SUBMITTED);
    expect(f.events).toEqual(["prepare", "post", "execute", "accept"]);
    expect(response.body.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "finish", arguments: "{\"done\":true}" } }] },
      finish_reason: "tool_calls",
    });
    expect(response.body.usage).toEqual({ prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 });
    expect(response.body.x_vector.accept_tx_hash).toBe(ACCEPT_TX);
    expect(response.body.x_vector.submitted_ref).toBe(`${SUBMITTED.txHash}#0`);
  });

  it("answers the gateway's 402 with the deposit address before posting when the wallet cannot pay", async () => {
    const f = setup({ walletUtxos: [utxo(3_000_000n, 0)] });

    const response = await post(f.app);

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe("insufficient_funds");
    expect(response.body.x_vector.deposit_address).toBe(WALLET.address);
    expect(response.body.x_vector.available_lovelace).toBe("3000000");
    expect(BigInt(response.body.x_vector.required_lovelace)).toBeGreaterThan(9_000_000n);
    expect(f.postPrompt).not.toHaveBeenCalled();
  });

  it("runs one wallet transaction sequence at a time", async () => {
    const first = gate();
    let calls = 0;
    const f = setup({ beforeExecute: async () => { if (++calls === 1) await first.wait; } });

    const one = post(f.app).then((response) => response);
    await vi.waitFor(() => expect(f.postPrompt).toHaveBeenCalledTimes(1));
    const two = post(f.app).then((response) => response);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.preparePrompt).toHaveBeenCalledTimes(1);

    first.open();
    const [a, b] = await Promise.all([one, two]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(f.events).toEqual(["prepare", "post", "execute", "accept", "prepare", "post", "execute", "accept"]);
  });

  it("reports a failed Accept with the Submitted reference to accept by hand", async () => {
    const f = setup({ accept: async () => { throw new Error("awaitTx timed out"); } });

    const response = await post(f.app);

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("accept_failed");
    expect(response.body.error.message).toContain(`${SUBMITTED.txHash}#0`);
  });

  it("answers 503 without spending when no supplier of the model is free", async () => {
    const f = setup({
      views: [view("31", { model: "other-model" }), view("32", { status: "offline" }), view("33", { endpoint_url: "https://busy.example" })],
      liveStatus: { "https://supplier.example": "offline", "https://busy.example": "working" },
    });

    const response = await post(f.app);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("model_unavailable");
    expect(f.preparePrompt).not.toHaveBeenCalled();
    expect(f.postPrompt).not.toHaveBeenCalled();
  });

  it("buys from a supplier the indexer still lists as working once its live status is free", async () => {
    const f = setup({ views: [view("41", { status: "working" })] });

    const response = await post(f.app);

    expect(response.status).toBe(200);
    expect(f.preparePrompt.mock.calls[0][0].advertRef).toEqual({ txHash: "41".repeat(32), index: 0 });
  });

  it("auto buys from any model, skipping small adverts and suppliers that refuse the request", async () => {
    const f = setup({
      views: [
        view("51", { model: "tiny", max_output_tokens: 512, price_lovelace: "100000" }),
        view("52", { model: "ocr", price_lovelace: "150000" }),
        view("53", { model: "deepseek", price_lovelace: "200000" }),
      ],
      incompatible: "52",
    });

    const response = await post(f.app, { ...AGENT_BODY, model: "auto" });

    expect(response.status).toBe(200);
    expect(f.preparePrompt.mock.calls.map(([options]) => options.advertRef.txHash)).toEqual(["52".repeat(32), "53".repeat(32)]);
    expect(f.events).toEqual(["prepare", "prepare", "post", "execute", "accept"]);
    expect(response.body.model).toBe("deepseek");
  });

  it("auto never buys an excluded model, but an explicit request for it still does", async () => {
    const f = setup({
      views: [view("61", { model: "swarm", price_lovelace: "100000" }), view("62", { model: "deepseek", price_lovelace: "200000" })],
      autoExcludedModels: ["swarm"],
    });

    const auto = await post(f.app, { ...AGENT_BODY, model: "auto" });
    const explicit = await post(f.app, { ...AGENT_BODY, model: "swarm" });

    expect(auto.status).toBe(200);
    expect(auto.body.model).toBe("deepseek");
    expect(explicit.status).toBe(200);
    expect(f.preparePrompt.mock.calls.map(([options]) => options.advertRef.txHash)).toEqual(["62".repeat(32), "61".repeat(32)]);
  });
});
