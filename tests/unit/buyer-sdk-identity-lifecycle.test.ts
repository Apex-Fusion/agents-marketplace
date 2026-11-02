/**
 * buyer-sdk-identity-lifecycle.test.ts — Marketplace on the new escrow and
 * advert (Part 2 §6.1–§6.5, §9.6), mock backend.
 *
 * Covers every changed buyer path: Post through the listing rule (indexer
 * listing + agent record) for Responses, TTS, OCR and chat; the switch slot;
 * the value cap; the receipt fields (agent_did against the escrow's agent_id);
 * Accept, Reclaim (no buyer key with refund set) and RefundRevoked.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { agentIdOf, decodeEscrow } from "../../buyer/src/sdk/identity.js";
import { ReceiptVerificationError, type ProgressEvent } from "../../buyer/src/sdk/types.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { decodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import type { IdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import type { IdentityDatum } from "../../packages/shared/src/cbor/IdentityDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { plutusAddressToBech32 } from "../../packages/shared/src/cbor/address.js";
import { buildReceipt, type Receipt } from "../../packages/shared/src/receipt/build.js";
import { signReceipt } from "../../packages/shared/src/receipt/sign.js";
import {
  createResponse, responseRequestCommitment, responseResultCommitment, type ResponseItem, type ResponseRequest,
} from "../../packages/shared/src/responses.js";
import {
  chatSessionPromptHash, ESCROW_VALUE_CAP_LOVELACE, ocrPromptHash, ttsPromptHash, TxConstructionError,
  type WalletKey,
} from "../../packages/shared/src/tx/index.js";
import { pkhToEnterpriseAddress } from "../../packages/shared/src/tx/internal/pkhAddress.js";
import {
  AGENT_ID, activeRecord, buyer, identityBlueprint, listingRow, newAdvert, newAdvertOutput, newEscrow, OTHER_AGENT_ID,
  recordOutput, refText, seedNewEscrow, stranger, supplier, tombstone,
} from "../fixtures/buyer-side/identity-world.js";

const TIP_SLOT = 1_745_500_000;
const NOW_MS = TIP_SLOT * 1000;
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
const ESCROW_REF: OutputReference = { txHash: "e0".repeat(32), index: 0 };
const AGENT_DID = `did:vector:${AGENT_ID}`;
const INPUT: ResponseItem[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is 2+2?" }] }];
const TTS_REQUEST = { text: "hello", voice: "alloy", format: "mp3", speed: 1 };
const OCR_REQUEST = { image_b64: "aGVsbG8=", mime: "image/png", output_format: "markdown" };

interface MockBody {
  type: string;
  inputs: OutputReference[];
  referenceInputs?: OutputReference[];
  outputs: Array<{ address: string; lovelace: bigint; datumHex: string | null }>;
  requiredSigners: string[];
  redeemer?: string;
}

/** The JSON of a synthetic (mock backend) transaction. */
function mockBody(txCborHex: string): MockBody {
  const length = parseInt(txCborHex.slice(0, 8), 16);
  const json = Buffer.from(txCborHex.slice(8, 8 + 2 * length), "hex").toString("utf8");
  return JSON.parse(json, (_key, value) => (typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value));
}

const sha256 = (value: unknown): string => createHash("sha256").update(canonicalize(value), "utf8").digest("hex");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** How the supplier sets agent_did: the escrow's DID (default for a new advert), another value, or none. */
type AgentDid = string | "absent";

function signed(fields: Omit<Receipt, "agent_did">, agentDid: AgentDid, extra: Record<string, unknown> = {}) {
  const receipt = { ...buildReceipt(fields), ...(agentDid === "absent" ? {} : { agent_did: agentDid }), ...extra } as Receipt;
  return signReceipt(receipt, supplier.privateKeyHex);
}

function capability(advert: AdvertDatum) {
  return {
    capability_id: advert.capability_id, model: advert.model, max_output_tokens: advert.max_output_tokens,
    max_processing_ms: advert.max_processing_ms, price_lovelace: advert.price_lovelace.toString(),
    advert_ref: refText(ADVERT_REF), supplier_pkh: advert.supplier_pkh, pub_key_hex: supplier.pubKeyHex,
    inference_api: "responses", upstream_api: "responses",
  };
}

interface WorldOptions {
  advert?: IdentityAdvertDatum | AdvertDatum;
  /** The agent record at the identity address; null: none. */
  record?: IdentityDatum | null;
  /** agent_id of the indexer listing row; "absent": no row. Default: the advert's agent_id. */
  listedAgent?: string | null | "absent";
  switchSlot?: number | null;
  /** agent_did of the supplier's receipt. Default: the escrow's DID for a new advert, none for a legacy one. */
  agentDid?: AgentDid;
  /** Extra receipt fields. */
  extra?: Record<string, unknown>;
  walletKey?: WalletKey;
}

function world(options: WorldOptions = {}) {
  const chain = new MockChainProvider();
  chain.advanceSlot(TIP_SLOT);
  const advert = options.advert ?? newAdvert();
  const agentId = agentIdOf(advert);
  chain.seed("agent_id" in advert
    ? newAdvertOutput(advert as IdentityAdvertDatum, ADVERT_REF)
    : { ...newAdvertOutput(newAdvert(), ADVERT_REF), address: "addr_test1wfakeadvert", datumHex: encodeAdvertDatum(advert) });
  if (options.record !== null) chain.seed(recordOutput(options.record ?? activeRecord(advert.capability_id)));
  const listedAgent = options.listedAgent === undefined ? agentId : options.listedAgent;
  const rows = listedAgent === "absent" ? [] : [listingRow(ADVERT_REF, advert, listedAgent)];
  const agentDid = options.agentDid ?? (agentId === null ? "absent" : `did:vector:${agentId}`);
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    urls.push(target);
    const escrowRef = new Headers(init?.headers).get("X-Escrow-Ref") ?? "";
    if (target.includes("/suppliers")) return json(rows);
    if (target.endsWith("/capability")) return json(capability(advert));
    if (target.endsWith("/status")) return json({ status: "free" });
    if (target.endsWith("/v1/responses")) {
      const request = JSON.parse(String(init?.body)) as ResponseRequest;
      const result = createResponse({
        id: "resp_test", model: advert.model, status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "4", annotations: [] }] }],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      });
      const receipt = signed({
        prompt_hash: sha256(responseRequestCommitment(request)), response_hash: sha256(responseResultCommitment(result)),
        model: advert.model, prompt_tokens: 12, completion_tokens: 4, wallclock_ms: 800,
        supplier_pkh: supplier.pubKeyHash, escrow_ref: escrowRef,
      }, agentDid, options.extra);
      return json({ ...result, receipt: receipt.receipt, receipt_signature: receipt.signature });
    }
    if (target.endsWith("/v1/audio/synthesize")) {
      const receipt = signed({
        prompt_hash: ttsPromptHash(TTS_REQUEST), response_hash: "f1".repeat(32), model: advert.model,
        prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 10, supplier_pkh: supplier.pubKeyHash, escrow_ref: escrowRef,
      }, agentDid, options.extra);
      return json({ audio_b64: "AAAA", format: "mp3", content_type: "audio/mpeg", byte_length: 3, receipt: receipt.receipt, receipt_signature: receipt.signature });
    }
    if (target.endsWith("/v1/ocr/extract")) {
      const content = "# Page 1";
      const receipt = signed({
        prompt_hash: ocrPromptHash(OCR_REQUEST), response_hash: sha256({ content, output_format: "markdown" }),
        model: advert.model, prompt_tokens: 9, completion_tokens: 3, wallclock_ms: 10,
        supplier_pkh: supplier.pubKeyHash, escrow_ref: escrowRef,
      }, agentDid, options.extra);
      return json({ output_format: "markdown", content, usage: {}, receipt: receipt.receipt, receipt_signature: receipt.signature });
    }
    if (target.endsWith("/v1/chat/start")) return json({ escrow_ref: escrowRef, status: "claimed" });
    throw new Error(`unexpected URL ${target}`);
  });
  const marketplace = new Marketplace({
    chain, indexerUrl: "http://indexer.test", walletKey: options.walletKey ?? buyer, networkParams: { networkId: 0 },
    _fetch: fetchImpl as typeof fetch, identityBlueprint, switchSlot: options.switchSlot,
  });
  const submitSpy = vi.spyOn(chain, "submitTx");
  return { chain, marketplace, fetchImpl, urls, submitSpy };
}

async function rejection(promise: Promise<unknown>): Promise<{ kind: string; reason: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TxConstructionError) return { kind: "tx", reason: error.reason };
    if (error instanceof ReceiptVerificationError) return { kind: "receipt", reason: error.reason };
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("Marketplace Post on a new advert (Part 2 §6.1, §6.2, §6.5)", () => {
  it("posts a new escrow with agent_id and the buyer's refund address, and accepts the 9-field receipt", async () => {
    const { chain, marketplace, urls } = world();
    const result = await marketplace.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n });
    expect(result.response).toBe("4");
    expect(result.receipt.agent_did).toBe(AGENT_DID);
    const escrow = (await chain.queryUtxo(result.escrowRef))!;
    expect(escrow.address).toBe(identityBlueprint.escrowScriptAddress(0));
    const datum = decodeIdentityEscrowDatum(escrow.datumHex!);
    expect(datum.agent_id).toBe(AGENT_ID);
    expect(datum.refund).toEqual({ address: newEscrow().refund!.address, datum: null });
    // The listing rule read the indexer listing.
    expect(urls.some((url) => url.includes("/suppliers"))).toBe(true);
  });

  it("returns agent_id in the supplier view", async () => {
    const { marketplace } = world();
    expect((await marketplace.discoverSuppliers()).map((row) => row.agent_id)).toEqual([AGENT_ID]);
  });

  it("refuses an advert that the indexer does not list, before any transaction", async () => {
    for (const listedAgent of ["absent", null, OTHER_AGENT_ID] as const) {
      const { marketplace, submitSpy } = world({ listedAgent });
      expect(await rejection(marketplace.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n })))
        .toEqual({ kind: "tx", reason: "advert not listed" });
      expect(submitSpy).not.toHaveBeenCalled();
    }
  });

  it("refuses an agent whose record fails the listing rule, before any transaction", async () => {
    const revoked = tombstone(activeRecord(), {
      type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: NOW_MS - 1, invalidFrom: null, successor: null,
    });
    const cases: Array<[IdentityDatum | null, string]> = [
      [null, "agent record not found"],
      [revoked, "agent not active"],
      [{ ...activeRecord(), keys: [] }, "supplier key not listed"],
      [activeRecord("llm.chat.v1"), "capability not listed"],
    ];
    for (const [record, reason] of cases) {
      const { marketplace, submitSpy } = world({ record });
      expect(await rejection(marketplace.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n })))
        .toEqual({ kind: "tx", reason });
      expect(submitSpy).not.toHaveBeenCalled();
    }
  });

  it("refuses an advert above the value cap before the supplier preflight", async () => {
    const advert = newAdvert({ price_lovelace: ESCROW_VALUE_CAP_LOVELACE });
    const { marketplace, urls, submitSpy } = world({ advert });
    expect(await rejection(marketplace.preparePrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: advert.price_lovelace })))
      .toEqual({ kind: "tx", reason: "escrow above value cap" });
    expect(urls).toEqual([]);
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe("Marketplace switch slot (Part 2 §9.6)", () => {
  const { agent_id: _agent, ...legacy } = newAdvert();

  it("refuses a legacy advert from the switch slot on, before the supplier preflight", async () => {
    const { marketplace, urls, submitSpy } = world({ advert: legacy, switchSlot: TIP_SLOT });
    expect(await rejection(marketplace.preparePrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n })))
      .toEqual({ kind: "tx", reason: "advert layout mismatch" });
    expect(urls).toEqual([]);
    expect(await rejection(marketplace.startChat({ advertRef: ADVERT_REF, payment_lovelace: 2_000_000n })))
      .toEqual({ kind: "tx", reason: "advert layout mismatch" });
    expect(await rejection(marketplace.submitTts({ advertRef: ADVERT_REF, ...TTS_REQUEST, payment_lovelace: 2_000_000n })))
      .toEqual({ kind: "tx", reason: "advert layout mismatch" });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("still posts a legacy escrow before the switch slot (drain)", async () => {
    const { chain, marketplace } = world({ advert: legacy, switchSlot: TIP_SLOT + 1 });
    const result = await marketplace.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n });
    expect(result.receipt).not.toHaveProperty("agent_did");
    expect(decodeEscrow((await chain.queryUtxo(result.escrowRef))!.datumHex!).layout).toBe("legacy");
  });

  it("posts a new escrow on a new advert after the switch slot", async () => {
    const { chain, marketplace } = world({ switchSlot: TIP_SLOT });
    const result = await marketplace.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n });
    expect(decodeIdentityEscrowDatum((await chain.queryUtxo(result.escrowRef))!.datumHex!).agent_id).toBe(AGENT_ID);
  });
});


describe("Marketplace receipt fields (Part 2 §6.3)", () => {
  it("refuses a new-escrow receipt without agent_did or with another agent", async () => {
    for (const agentDid of ["absent", `did:vector:${OTHER_AGENT_ID}`]) {
      const { marketplace } = world({ agentDid });
      expect(await rejection(marketplace.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n })))
        .toEqual({ kind: "receipt", reason: "agent_did_mismatch" });
      expect(marketplace.getTaskHistory()[0]).toMatchObject({ status: "failed", failure_reason: "agent_did_mismatch" });
    }
  });

  it("refuses agent_did on a legacy escrow and an extra field on a new escrow", async () => {
    const { agent_id: _agent, ...legacy } = newAdvert();
    const legacyWorld = world({ advert: legacy, agentDid: AGENT_DID });
    expect(await rejection(legacyWorld.marketplace.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n })))
      .toEqual({ kind: "receipt", reason: "agent_did_mismatch" });
    const extra = world({ extra: { note: "x" } });
    expect(await rejection(extra.marketplace.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: 2_000_000n })))
      .toEqual({ kind: "receipt", reason: "malformed_receipt" });
  });

  it("checks agent_did on the TTS path", async () => {
    const advert = newAdvert({ capability_id: "audio.synthesize.piper.v1", model: "piper", max_output_tokens: 0 });
    const ok = world({ advert });
    const result = await ok.marketplace.submitTts({ advertRef: ADVERT_REF, ...TTS_REQUEST, payment_lovelace: 2_000_000n });
    expect(result.receipt.agent_did).toBe(AGENT_DID);
    expect(decodeIdentityEscrowDatum((await ok.chain.queryUtxo(result.escrowRef))!.datumHex!).agent_id).toBe(AGENT_ID);
    const bad = world({ advert, agentDid: "absent" });
    expect(await rejection(bad.marketplace.submitTts({ advertRef: ADVERT_REF, ...TTS_REQUEST, payment_lovelace: 2_000_000n })))
      .toEqual({ kind: "receipt", reason: "agent_did_mismatch" });
  });

  it("checks agent_did on the OCR path", async () => {
    const advert = newAdvert({ capability_id: "ocr.page.extract.chandra-ocr-2.v1", model: "historical-records-ocr-v1" });
    const ok = world({ advert });
    const result = await ok.marketplace.submitOcr({ advertRef: ADVERT_REF, ...OCR_REQUEST, payment_lovelace: 2_000_000n });
    expect(result.receipt.agent_did).toBe(AGENT_DID);
    const bad = world({ advert, agentDid: `did:vector:${OTHER_AGENT_ID}` });
    expect(await rejection(bad.marketplace.submitOcr({ advertRef: ADVERT_REF, ...OCR_REQUEST, payment_lovelace: 2_000_000n })))
      .toEqual({ kind: "receipt", reason: "agent_did_mismatch" });
  });
});

describe("Marketplace chat on a new advert", () => {
  const SUBMITTED_REF: OutputReference = { txHash: "5b".repeat(32), index: 0 };
  const advert = newAdvert({ capability_id: "llm.chat.v1" });
  const transcript: ResponseItem[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

  function endWorld(agentDid: AgentDid) {
    const w = world({ advert });
    const submitted = newEscrow({
      capability_id: "llm.chat.v1", state: "Submitted", submitted_at: NOW_MS - 5_000, result_receipt_hash: "d4".repeat(32),
      deliver_by: NOW_MS + 60_000,
    });
    seedNewEscrow(w.chain, submitted, SUBMITTED_REF);
    w.fetchImpl.mockImplementation(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.endsWith("/capability")) return json(capability(advert));
      if (target.endsWith("/v1/chat/end")) {
        const receipt = signed({
          prompt_hash: chatSessionPromptHash({ session_nonce: "nonce" }), response_hash: sha256(transcript), model: advert.model,
          prompt_tokens: 1, completion_tokens: 1, wallclock_ms: 1, supplier_pkh: supplier.pubKeyHash, escrow_ref: refText(ESCROW_REF),
        }, agentDid);
        return json({
          status: "submitted", escrow_ref: refText(ESCROW_REF), receipt: receipt.receipt, receipt_signature: receipt.signature,
          submitted_ref: refText(SUBMITTED_REF),
        });
      }
      throw new Error(`unexpected URL ${target}`);
    });
    return w;
  }

  it("starts a session on a new escrow and returns its agent_id", async () => {
    const { chain, marketplace } = world({ advert });
    const started = await marketplace.startChat({ advertRef: ADVERT_REF, payment_lovelace: 2_000_000n });
    expect(started.agentId).toBe(AGENT_ID);
    expect(decodeIdentityEscrowDatum((await chain.queryUtxo(started.escrowRef))!.datumHex!).agent_id).toBe(AGENT_ID);
  });

  it("returns a null agentId for a legacy advert", async () => {
    const { agent_id: _agent, ...legacy } = advert;
    const { marketplace } = world({ advert: legacy });
    expect((await marketplace.startChat({ advertRef: ADVERT_REF, payment_lovelace: 2_000_000n })).agentId).toBeNull();
  });

  it("checks agent_did at End, then accepts the new escrow with the buyer bond to the refund address", async () => {
    const bad = endWorld("absent");
    expect(await rejection(bad.marketplace.endChat({
      escrowRef: ESCROW_REF, sessionNonce: "nonce", supplierBaseUrl: "https://supplier.example.com", agentId: AGENT_ID, transcript,
    }))).toEqual({ kind: "receipt", reason: "agent_did_mismatch" });
    expect(bad.submitSpy).not.toHaveBeenCalled();

    const ok = endWorld(AGENT_DID);
    const ended = await ok.marketplace.endChat({
      escrowRef: ESCROW_REF, sessionNonce: "nonce", supplierBaseUrl: "https://supplier.example.com", agentId: AGENT_ID, transcript,
    });
    expect(ended).toMatchObject({ settleMode: "full", acceptedRef: SUBMITTED_REF });
    const body = mockBody(ok.submitSpy.mock.calls[0]![0]);
    expect(body.redeemer).toBe("Accept");
    // The 1 AP3X buyer bond is raised to the 2 AP3X min-UTxO floor of the builder.
    expect(body.outputs[1]).toMatchObject({ address: plutusAddressToBech32(newEscrow().refund!.address, 0), lovelace: 2_000_000n });
  });
});

describe("Marketplace Accept, Reclaim and RefundRevoked on a new escrow", () => {
  function spendWorld(escrow: IdentityEscrowDatum, record: IdentityDatum | null, walletKey: WalletKey = buyer) {
    const w = world({ record, walletKey });
    seedNewEscrow(w.chain, escrow, ESCROW_REF);
    return w;
  }

  it("accepts a Submitted new escrow and pays the buyer bond to the refund address", async () => {
    const { marketplace, submitSpy } = spendWorld(
      newEscrow({ state: "Submitted", submitted_at: NOW_MS - 5_000, result_receipt_hash: "d4".repeat(32), deliver_by: NOW_MS + 60_000 }),
      activeRecord(),
    );
    const events: ProgressEvent[] = [];
    marketplace.on("progress", (event) => { events.push(event as ProgressEvent); });
    await marketplace.acceptResult({ escrowRef: ESCROW_REF });
    const body = mockBody(submitSpy.mock.calls[0]![0]);
    expect(body).toMatchObject({ redeemer: "Accept", requiredSigners: [buyer.pubKeyHash] });
    expect(body.outputs[0]).toMatchObject({ address: pkhToEnterpriseAddress(supplier.pubKeyHash, 0), lovelace: 3_000_000n });
    // The 1 AP3X buyer bond is raised to the 2 AP3X min-UTxO floor of the builder.
    expect(body.outputs[1]).toMatchObject({ address: plutusAddressToBech32(newEscrow().refund!.address, 0), lovelace: 2_000_000n });
    expect(events.map((event) => event.type)).toEqual(["accept_submitted"]);
  });

  it("reclaims a new escrow with refund set from another wallet, with no buyer signature", async () => {
    const { marketplace, submitSpy } = spendWorld(newEscrow({ deliver_by: NOW_MS - 1_000 }), activeRecord(), stranger);
    await marketplace.reclaim({ escrowRef: ESCROW_REF });
    const body = mockBody(submitSpy.mock.calls[0]![0]);
    expect(body).toMatchObject({ redeemer: "Reclaim", requiredSigners: [] });
    expect(body.outputs).toEqual([expect.objectContaining({
      address: plutusAddressToBech32(newEscrow().refund!.address, 0), lovelace: 4_500_000n,
    })]);
  });

  it("refuses Reclaim before deliver_by", async () => {
    const { marketplace } = spendWorld(newEscrow({ deliver_by: NOW_MS + 60_000 }), activeRecord());
    expect(await rejection(marketplace.reclaim({ escrowRef: ESCROW_REF }))).toEqual({ kind: "tx", reason: "reclaim before deliver_by" });
  });

  it("refunds a new escrow of a revoked agent before deliver_by, with the record as a reference input", async () => {
    const revoked = tombstone(activeRecord(), {
      type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: NOW_MS - 1, invalidFrom: null, successor: null,
    });
    const { marketplace, submitSpy } = spendWorld(newEscrow({ deliver_by: NOW_MS + 60_000 }), revoked);
    const events: ProgressEvent[] = [];
    marketplace.on("progress", (event) => { events.push(event as ProgressEvent); });
    await marketplace.refundRevoked({ escrowRef: ESCROW_REF });
    const body = mockBody(submitSpy.mock.calls[0]![0]);
    expect(body).toMatchObject({ redeemer: "RefundRevoked", requiredSigners: [], referenceInputs: [recordOutput(revoked).ref] });
    expect(body.outputs).toEqual([expect.objectContaining({
      address: plutusAddressToBech32(newEscrow().refund!.address, 0), lovelace: 4_500_000n,
    })]);
    expect(events.map((event) => event.type)).toEqual(["refund_revoked_submitted"]);
  });

  it("refuses RefundRevoked for a live agent and for a legacy escrow", async () => {
    const live = spendWorld(newEscrow(), activeRecord());
    expect(await rejection(live.marketplace.refundRevoked({ escrowRef: ESCROW_REF }))).toEqual({ kind: "tx", reason: "refund not allowed" });
    const legacyWorld = world();
    const { agent_id: _agent, refund: _refund, ...legacy } = newEscrow();
    legacyWorld.chain.seed({
      ref: ESCROW_REF, address: "addr_test1wfakeescrow", lovelace: 4_500_000n, assets: {}, datumHex: encodeEscrowDatum(legacy), scriptRef: null,
    });
    expect(await rejection(legacyWorld.marketplace.refundRevoked({ escrowRef: ESCROW_REF })))
      .toEqual({ kind: "tx", reason: "escrow layout mismatch" });
  });
});
