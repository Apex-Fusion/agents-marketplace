/**
 * Tests the OCR escrow builder (postOcrEscrow.ts) for the model-scoped `ocr.page.extract.<model-slug>.v1` capabilities.
 * The shared escrow steps (advert lookup, datum assembly, mock transaction) are tested in tx-post-escrow.test.ts,
 * together with the table of the precomputed prompt_hash for the chat, OCR and TTS builders. This file tests:
 *   - the golden ocrPromptHash (the buyer and the supplier must agree on it),
 *   - the request checks, which run before any chain access,
 *   - the min-ada floor of the locked amount (C1 regression: the 2026-08-07 mainnet incident).
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";

import {
  ocrPromptHash,
  validateOcrRequest,
  buildPostOcrEscrowTx,
  MAX_OCR_IMAGE_B64_CHARS,
  TxConstructionError,
  type OcrRequest,
} from "../../packages/shared/src/tx/index.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { escrowLockFloor } from "../../packages/shared/src/tx/internal/minAdaFloor.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { activeAdvertDatum, seedAdvertUtxo } from "../fixtures/onchain-tx/legacy-advert.js";

const IMG = Buffer.from("not really a png but bytes are bytes").toString("base64");

function validRequest(): OcrRequest {
  return { image_b64: IMG, mime: "image/png", output_format: "markdown" };
}

describe("ocrPromptHash — canonicalisation contract", () => {
  it("equals sha256(canonicalize({image_b64, mime, output_format}))", () => {
    const req = validRequest();
    const expected = createHash("sha256")
      .update(canonicalize({
        image_b64: req.image_b64,
        mime: req.mime,
        output_format: req.output_format,
      }), "utf8")
      .digest("hex");
    expect(ocrPromptHash(req)).toBe(expected);
  });

  it("is key-order independent (JCS canonicalisation)", () => {
    const a = ocrPromptHash({ image_b64: IMG, mime: "image/png", output_format: "json" });
    const b = ocrPromptHash({ output_format: "json", mime: "image/png", image_b64: IMG } as OcrRequest);
    expect(a).toBe(b);
  });

  it("changes when any field changes", () => {
    const base = ocrPromptHash(validRequest());
    expect(ocrPromptHash({ ...validRequest(), mime: "image/jpeg" })).not.toBe(base);
    expect(ocrPromptHash({ ...validRequest(), output_format: "html" })).not.toBe(base);
    expect(ocrPromptHash({ ...validRequest(), image_b64: IMG + "AA" })).not.toBe(base);
  });
});

describe("validateOcrRequest — envelope gates", () => {
  it("rejects empty image", () => {
    expect(() => validateOcrRequest({ ...validRequest(), image_b64: "" }))
      .toThrowError(TxConstructionError);
  });

  it("rejects oversized image", () => {
    const big = "A".repeat(MAX_OCR_IMAGE_B64_CHARS + 4);
    expect(() => validateOcrRequest({ ...validRequest(), image_b64: big }))
      .toThrow(/exceeds/);
  });

  it("rejects data-URL prefixes and whitespace (plain base64 only)", () => {
    for (const bad of [`data:image/png;base64,${IMG}`, `${IMG} `, "with space AA"]) {
      expect(() => validateOcrRequest({ ...validRequest(), image_b64: bad }))
        .toThrow(/base64/);
    }
  });

  it("rejects unknown mime and output_format", () => {
    expect(() => validateOcrRequest({ ...validRequest(), mime: "image/tiff" }))
      .toThrow(/mime/);
    expect(() => validateOcrRequest({ ...validRequest(), output_format: "yaml" }))
      .toThrow(/output_format/);
  });
});

describe("buildPostOcrEscrowTx — validation precedes chain access", () => {
  it("throws the envelope error against an unseeded chain (no advert query first)", async () => {
    const chain = new MockChainProvider();
    const buyerKey = {
      pubKeyHash: "ab".repeat(28),
      pubKeyHex: "cd".repeat(32),
      privateKeyHex: "ef".repeat(32),
      address: "addr_test1fake",
    };
    await expect(buildPostOcrEscrowTx({
      chain,
      buyerKey,
      advertRef: { txHash: "b".repeat(64), index: 0 },
      request: { ...validRequest(), mime: "image/gif" },
      payment_lovelace: 200000n,
    })).rejects.toThrow(/mime/);
  });

  it("unseeded advert ref → 'advert ref not on chain' after a valid envelope", async () => {
    const chain = new MockChainProvider();
    const buyerKey = {
      pubKeyHash: "ab".repeat(28),
      pubKeyHex: "cd".repeat(32),
      privateKeyHex: "ef".repeat(32),
      address: "addr_test1fake",
    };
    await expect(buildPostOcrEscrowTx({
      chain,
      buyerKey,
      advertRef: { txHash: "b".repeat(64), index: 0 },
      request: validRequest(),
      payment_lovelace: 200000n,
    })).rejects.toMatchObject({ reason: "advert ref not on chain" });
  });
});

describe("buildPostOcrEscrowTx — happy path locks the min-ada floor (C1 regression)", () => {
  // Guards the `escrowLockFloor(datum, economicTotal)` call in postFromAdvert.ts, the part that every Post builder shares
  // (commit 2b2295b added this test when the call was still in postOcrEscrow.ts). Without that call the escrow locks only
  // the raw economic total, the Submit continuing output gets bumped to min-ada, value_equal fails, and the validator
  // errors with an empty trace — the 2026-08-07 mainnet incident. Both validation tests above throw before the lock,
  // so this is the only test of the OCR builder that asserts the locked amount.
  const ADVERT_REF: OutputReference = { txHash: "c".repeat(64), index: 0 };
  const PRICE = 200_000n;
  const BUYER_BOND = 1_000_000n;
  const SUPPLIER_BOND = 1_000_000n;
  const ECONOMIC_TOTAL = PRICE + BUYER_BOND + SUPPLIER_BOND; // 2_200_000n

  const OCR_ADVERT = activeAdvertDatum({
    capability_id: "ocr.page.extract.chandra-ocr-2.v1",
    model: "chandra-ocr-2",
    max_output_tokens: 4096,
    price_lovelace: PRICE,
    supplier_bond_lovelace: SUPPLIER_BOND,
    buyer_bond_lovelace: BUYER_BOND,
  });

  it("locks escrowLockFloor(datum, economicTotal), strictly above the raw economic total", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedAdvertUtxo(chain, OCR_ADVERT, ADVERT_REF);

    const buyer = buildBuyerWalletKey();
    const result = await buildPostOcrEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: ADVERT_REF,
      request: validRequest(),
      payment_lovelace: PRICE,
    });

    const escrowUtxo = await chain.queryUtxo(result.escrowOutputRef);
    expect(escrowUtxo).not.toBeNull();
    const datum = decodeEscrowDatum(escrowUtxo!.datumHex!);

    const expectedFloor = escrowLockFloor(datum, ECONOMIC_TOTAL);
    expect(escrowUtxo!.lovelace).toBe(expectedFloor);
    expect(escrowUtxo!.lovelace).toBeGreaterThan(ECONOMIC_TOTAL);
  });
});
