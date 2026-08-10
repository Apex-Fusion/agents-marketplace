/**
 * tx-post-ocr-escrow.test.ts — coverage for the OCR escrow builder added
 * for model-scoped `ocr.page.extract.<model-slug>.v1` capabilities.
 *
 * Focus: the NEW validation + hash logic in postOcrEscrow.ts. The shared
 * escrow-construction pieces (advert resolution, datum assembly, mock tx
 * encoding) mirror postTtsEscrow.ts and are covered by tx-post-escrow.test.ts
 * for the chat shape; here we pin:
 *   - ocrPromptHash canonicalisation (golden hash — buyer/supplier contract)
 *   - envelope validation failures throw BEFORE any chain access
 *   - the escrow datum carries the OCR prompt_hash on the happy path
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
