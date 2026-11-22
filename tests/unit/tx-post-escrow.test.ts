/**
 * Tests buildPostEscrowTx() (chat) on the mock chain. The builder reads the Active advert, checks the buyer and the payment,
 * and locks payment + both bonds in an Open escrow datum (ARCHITECTURE.md §4.2; escrow.ak: advert_ref is SPEC-LOCK).
 * The last table checks a precomputed prompt_hash on the chat, OCR and TTS builders.
 * Each builder has its own code for these checks, so each builder has its own rows.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildPostEscrowTx, type PostEscrowParams } from "../../packages/shared/src/tx/escrow/postEscrow.js";
import { buildPostOcrEscrowTx, type OcrRequest } from "../../packages/shared/src/tx/escrow/postOcrEscrow.js";
import { buildPostTtsEscrowTx, type TtsRequest } from "../../packages/shared/src/tx/escrow/postTtsEscrow.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import type { ChatMessage, PostEscrowBuildResult } from "../../packages/shared/src/tx/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { activeAdvertDatum, seedAdvertUtxo } from "../fixtures/onchain-tx/legacy-advert.js";

const ADVERT_REF: OutputReference = { txHash: "b".repeat(64), index: 0 };
const ADVERT = activeAdvertDatum();
const SAMPLE_MESSAGES: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }];
const PAYMENT = 2_000_000n;
/** A synthetic tip. The mock chain reads slot x 1000 as the time. */
const TIP_SLOT = 1_745_500_000;

const buyer = buildBuyerWalletKey();

/** A mock chain with `advert` at ADVERT_REF. */
function chainWith(advert: AdvertDatum): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(TIP_SLOT);
  seedAdvertUtxo(chain, advert, ADVERT_REF);
  return chain;
}

/** Posts a chat escrow. A test changes a parameter with `overrides`. */
function postChat(chain: MockChainProvider, overrides: Partial<PostEscrowParams> = {}): Promise<PostEscrowBuildResult> {
  return buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, messages: SAMPLE_MESSAGES, payment_lovelace: PAYMENT, ...overrides });
}

/** Posts a chat escrow on the default advert. Returns the result, the escrow output and its decoded datum. */
async function postOnDefaultAdvert(): Promise<{ result: PostEscrowBuildResult; escrow: Utxo; datum: EscrowDatum }> {
  const chain = chainWith(ADVERT);
  const result = await postChat(chain);
  const escrow = await chain.queryUtxo(result.escrowOutputRef);
  if (escrow === null) throw new Error("PostEscrow wrote no escrow output");
  return { result, escrow, datum: decodeEscrowDatum(escrow.datumHex!) };
}

describe("buildPostEscrowTx()", () => {
  it("returns the transaction hash and the reference of output 0", async () => {
    const { result } = await postOnDefaultAdvert();
    expect(result.expectedTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.escrowOutputRef).toEqual({ txHash: result.expectedTxHash, index: 0 });
  });

  it("posts an Open datum with no submission time and no receipt hash", async () => {
    const { datum } = await postOnDefaultAdvert();
    expect(datum).toMatchObject({ state: "Open", submitted_at: null, result_receipt_hash: null });
  });

  it("binds the datum to the advert ref", async () => {
    const { datum } = await postOnDefaultAdvert();
    expect(datum.advert_ref).toEqual(ADVERT_REF);
  });

  it("copies capability_id from the advert", async () => {
    const { datum } = await postOnDefaultAdvert();
    expect(datum.capability_id).toBe(ADVERT.capability_id);
  });

  it("sets prompt_hash to sha256 of canonical(messages) — ARCHITECTURE §4.2", async () => {
    const { datum } = await postOnDefaultAdvert();
    expect(datum.prompt_hash).toBe(createHash("sha256").update(canonicalize(SAMPLE_MESSAGES), "utf8").digest("hex"));
  });

  it("sets request_spec_hash to sha256 of canonical {capability_id, model, max_output_tokens}", async () => {
    const { datum } = await postOnDefaultAdvert();
    // Canonical: sorted keys, no whitespace (RFC-8785 subset).
    const canonicalSpec = JSON.stringify({
      capability_id: ADVERT.capability_id,
      max_output_tokens: ADVERT.max_output_tokens,
      model: ADVERT.model,
    });
    expect(datum.request_spec_hash).toBe(createHash("sha256").update(canonicalSpec, "utf8").digest("hex"));
  });

  it("sets deliver_by to posted_at + max_processing_ms + 30_000", async () => {
    const { datum } = await postOnDefaultAdvert();
    expect(datum.deliver_by).toBe(datum.posted_at + ADVERT.max_processing_ms + 30_000);
  });

  it("locks price + buyer_bond + supplier_bond", async () => {
    const { escrow } = await postOnDefaultAdvert();
    expect(escrow.lovelace).toBe(ADVERT.price_lovelace + ADVERT.buyer_bond_lovelace + ADVERT.supplier_bond_lovelace);
  });

  it("refuses an advert ref that is not on chain", async () => {
    await expect(postChat(new MockChainProvider())).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "advert ref not on chain",
    });
  });

  it("refuses a Retired advert", async () => {
    await expect(postChat(chainWith({ ...ADVERT, status: "Retired" }))).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "advert is retired",
    });
  });

  it("refuses a payment that is not the advertised price", async () => {
    await expect(postChat(chainWith(ADVERT), { payment_lovelace: 1_000_000n })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "payment must equal advertised price",
    });
  });

  it("refuses a buyer that is the supplier", async () => {
    await expect(postChat(chainWith(ADVERT), { buyerKey: buildSupplierWalletKey() })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "buyer cannot be supplier",
    });
  });

  it("refuses an empty messages array", async () => {
    await expect(postChat(chainWith(ADVERT), { messages: [] })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "messages required",
    });
  });
});

// ─── Precomputed prompt_hash: chat, OCR and TTS ──────────────────────────────

interface PromptBuilder {
  name: string;
  /** The input that carries the prompt content: `messages` (chat) or `request` (OCR and TTS). */
  field: string;
  advert: AdvertDatum;
  /** Posts with the valid prompt content when `withContent` is true, and with `prompt_hash` when it is given. */
  post: (chain: MockChainProvider, options: { withContent: boolean; prompt_hash?: string }) => Promise<PostEscrowBuildResult>;
  /** The reason when the builder gets neither the prompt content nor a prompt_hash. */
  missingReason: string;
}

const OCR_REQUEST: OcrRequest = { image_b64: "aGVsbG8=", mime: "image/png", output_format: "markdown" };
const TTS_REQUEST: TtsRequest = { text: "Hello world.", voice: "nova", format: "mp3", speed: 1 };

const PROMPT_BUILDERS: PromptBuilder[] = [
  {
    name: "chat",
    field: "messages",
    advert: ADVERT,
    missingReason: "prompt required",
    post: (chain, { withContent, prompt_hash }) =>
      buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, payment_lovelace: PAYMENT, prompt_hash, messages: withContent ? SAMPLE_MESSAGES : undefined }),
  },
  {
    name: "OCR",
    field: "request",
    advert: activeAdvertDatum({ capability_id: "ocr.page.extract.chandra-ocr-2.v1", model: "chandra-ocr-2", max_output_tokens: 4096 }),
    missingReason: "request required",
    post: (chain, { withContent, prompt_hash }) =>
      buildPostOcrEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, payment_lovelace: PAYMENT, prompt_hash, request: withContent ? OCR_REQUEST : undefined }),
  },
  {
    name: "TTS",
    field: "request",
    advert: activeAdvertDatum({ capability_id: "audio.synthesize.piper.v1", model: "piper", max_output_tokens: 4096 }),
    missingReason: "request required",
    post: (chain, { withContent, prompt_hash }) =>
      buildPostTtsEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, payment_lovelace: PAYMENT, prompt_hash, request: withContent ? TTS_REQUEST : undefined }),
  },
];

describe.each(PROMPT_BUILDERS)("$name builder: precomputed prompt_hash", ({ field, advert, post, missingReason }) => {
  it(`stores a precomputed hash in lowercase without ${field}`, async () => {
    const chain = chainWith(advert);
    const result = await post(chain, { withContent: false, prompt_hash: "AB".repeat(32) });
    const escrow = await chain.queryUtxo(result.escrowOutputRef);
    expect(decodeEscrowDatum(escrow!.datumHex!).prompt_hash).toBe("ab".repeat(32));
  });

  it(`refuses when neither ${field} nor prompt_hash is given`, async () => {
    await expect(post(new MockChainProvider(), { withContent: false })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: missingReason,
    });
  });

  it(`refuses when both ${field} and prompt_hash are given`, async () => {
    await expect(post(new MockChainProvider(), { withContent: true, prompt_hash: "ab".repeat(32) })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "ambiguous prompt commitment",
    });
  });

  it("refuses a malformed prompt_hash", async () => {
    await expect(post(new MockChainProvider(), { withContent: false, prompt_hash: "not-32-byte-hex" })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "prompt_hash malformed",
    });
  });
});
