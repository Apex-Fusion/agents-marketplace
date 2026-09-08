/**
 * tx/escrow/postOcrEscrow.ts — PostEscrow tx builder for model-scoped OCR
 * capabilities (`ocr.page.extract.<model-slug>.v1`, one page per job).
 *
 * Accepts either the OCR request envelope or a precomputed prompt_hash. The
 * request path hashes canonical `{image_b64, mime, output_format}`, the same
 * object the supplier hashes when validating POST /v1/ocr/extract.
 *
 * The image travels off-chain (buyer → supplier HTTP body); the chain only
 * ever carries prompt_hash. Never place image bytes or extracted text in a
 * datum.
 *
 * Off-chain invariants (mirror TTS's, with OCR-shaped body validation):
 *   1. advert UTxO exists at advertRef
 *   2. advert datum.status === "Active"
 *   3. payment_lovelace === advert.price_lovelace
 *   4. buyerKey.pubKeyHash !== advert.supplier_pkh
 *   5. exactly one of request or prompt_hash is provided
 *   6. a supplied prompt_hash is 32-byte hex, or request passes OCR validation
 */

import * as nodeCrypto from "crypto";
import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { EscrowDatum } from "../../cbor/types.js";
import { decodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import { canonicalize } from "../../cbor/canonical.js";
import type { WalletKey, PostEscrowBuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { loadBlueprint } from "../blueprint.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { mockSlotToWallclockMs, NETWORK_BUFFER_MS } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { escrowLockFloor } from "../internal/minAdaFloor.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

/** OCR request envelope. The buyer-side hash and the supplier-side hash
 * MUST agree on this exact set of keys, in this exact JCS-canonical
 * encoding, or the supplier will reject with `prompt_mismatch`. */
export interface OcrRequest {
  /** Plain base64 of the page image bytes. No `data:` prefix. */
  image_b64: string;
  /** Image content type. */
  mime: string;
  /** Requested extraction output shape. */
  output_format: string;
}

export const ALLOWED_OCR_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp",
]);
export const ALLOWED_OCR_OUTPUT_FORMATS = new Set(["markdown", "html", "json"]);

/**
 * Upper bound on the base64 payload, in characters (~9 MB of image bytes).
 * A 300-DPI page scan lands around 0.5–3 MB binary; this cap protects the
 * supplier's JSON body parser and the off-chain transport, not the chain
 * (the chain only sees the 32-byte hash).
 */
export const MAX_OCR_IMAGE_B64_CHARS = 12_000_000;

/** Plain base64 (standard alphabet, optional padding). Rejects data URLs,
 * whitespace and base64url — one canonical encoding, one hash. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface PostOcrEscrowParams {
  chain: ChainProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  request?: OcrRequest;
  /** Precomputed prompt commitment: 32-byte hex, sha256 over whatever canonical
   * envelope the caller and supplier agreed on. When provided, the builder uses
   * it verbatim and does not require or hash request. */
  prompt_hash?: string;
  payment_lovelace: bigint;
}

function sha256Utf8Hex(s: string): string {
  return nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Hash function shared between buyer (here) and supplier (server.ts).
 * Exported so unit tests on either side can pin the canonicalisation. */
export function ocrPromptHash(req: OcrRequest): string {
  return sha256Utf8Hex(canonicalize({
    image_b64: req.image_b64,
    mime: req.mime,
    output_format: req.output_format,
  }));
}

/** Body validation shared conceptually with the supplier route. Throws
 * TxConstructionError with a machine-readable reason. */
export function validateOcrRequest(request: OcrRequest): void {
  if (typeof request?.image_b64 !== "string" || request.image_b64.length === 0) {
    throw new TxConstructionError("image required",
      "request.image_b64 must be a non-empty base64 string");
  }
  if (request.image_b64.length > MAX_OCR_IMAGE_B64_CHARS) {
    throw new TxConstructionError("image too large",
      `request.image_b64 exceeds ${MAX_OCR_IMAGE_B64_CHARS} chars`);
  }
  if (!BASE64_RE.test(request.image_b64)) {
    throw new TxConstructionError("image not base64",
      "request.image_b64 must be plain base64 (no data: prefix, no whitespace)");
  }
  if (!ALLOWED_OCR_MIMES.has(request.mime)) {
    throw new TxConstructionError("mime invalid",
      `mime must be one of: ${[...ALLOWED_OCR_MIMES].join(", ")}`);
  }
  if (!ALLOWED_OCR_OUTPUT_FORMATS.has(request.output_format)) {
    throw new TxConstructionError("output_format invalid",
      `output_format must be one of: ${[...ALLOWED_OCR_OUTPUT_FORMATS].join(", ")}`);
  }
}

export async function buildPostOcrEscrowTx(
  params: PostOcrEscrowParams,
): Promise<PostEscrowBuildResult> {
  const { chain, buyerKey, advertRef, request, prompt_hash, payment_lovelace } = params;

  if (request !== undefined && prompt_hash !== undefined) {
    throw new TxConstructionError(
      "ambiguous prompt commitment",
      "provide either request or prompt_hash, not both",
    );
  }

  let promptHash: string;
  if (prompt_hash !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(prompt_hash)) {
      throw new TxConstructionError(
        "prompt_hash malformed",
        "prompt_hash must be 32-byte hex",
      );
    }
    promptHash = prompt_hash.toLowerCase();
  } else if (request !== undefined) {
    validateOcrRequest(request);
    promptHash = ocrPromptHash(request);
  } else {
    throw new TxConstructionError(
      "request required",
      "provide request or a precomputed prompt_hash",
    );
  }

  // 1. Advert UTxO must exist.
  const advertUtxo = await chain.queryUtxo(advertRef);
  if (advertUtxo === null) {
    throw new TxConstructionError(
      "advert ref not on chain",
      `no UTxO at ${advertRef.txHash}#${advertRef.index}`,
    );
  }
  if (!advertUtxo.datumHex) {
    throw new TxConstructionError(
      "advert datum missing",
      `UTxO ${advertRef.txHash}#${advertRef.index} has no inline datum`,
    );
  }

  const advertDatum = decodeAdvertDatum(advertUtxo.datumHex);

  // 2. Advert must be Active.
  if (advertDatum.status !== "Active") {
    throw new TxConstructionError(
      "advert is retired",
      `advert.status is ${advertDatum.status}, expected Active`,
    );
  }

  // 3. Payment must equal advertised price.
  if (payment_lovelace !== advertDatum.price_lovelace) {
    throw new TxConstructionError(
      "payment must equal advertised price",
      `payment ${payment_lovelace} != advert.price ${advertDatum.price_lovelace}`,
    );
  }

  // 4. Buyer cannot be supplier.
  if (buyerKey.pubKeyHash === advertDatum.supplier_pkh) {
    throw new TxConstructionError(
      "buyer cannot be supplier",
      `buyerKey pkh ${buyerKey.pubKeyHash} equals advert.supplier_pkh`,
    );
  }

  // Time source: same convention as chat/TTS.
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const postedAt = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  const deliverBy = postedAt + advertDatum.max_processing_ms + NETWORK_BUFFER_MS;

  const requestSpecCanonical = canonicalize({
    capability_id: advertDatum.capability_id,
    max_output_tokens: advertDatum.max_output_tokens,
    model: advertDatum.model,
  });
  const requestSpecHash = sha256Utf8Hex(requestSpecCanonical);

  const economicTotal =
    advertDatum.price_lovelace +
    advertDatum.buyer_bond_lovelace +
    advertDatum.supplier_bond_lovelace;

  const escrowDatum: EscrowDatum = {
    buyer_pkh: buyerKey.pubKeyHash,
    supplier_pkh: advertDatum.supplier_pkh,
    advert_ref: advertRef,
    capability_id: advertDatum.capability_id,
    request_spec_hash: requestSpecHash,
    prompt_hash: promptHash,
    payment_lovelace: advertDatum.price_lovelace,
    buyer_bond_lovelace: advertDatum.buyer_bond_lovelace,
    supplier_bond_lovelace: advertDatum.supplier_bond_lovelace,
    deliver_by: deliverBy,
    posted_at: postedAt,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };

  // Lock enough that the escrow output satisfies min-ada in its LARGEST
  // future state (Submitted) - value_equal on Claim/Submit forbids any
  // later bump (2026-08-07 min-ada incident).
  const totalLocked = escrowLockFloor(escrowDatum, economicTotal);

  // Live path: reuse the capability-agnostic live builder (messages is
  // void-marked there; the on-chain commitment is the escrowDatum, which
  // carries our OCR prompt_hash).
  if (isLive) {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForEscrow } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForEscrow({
      chain: chain as LiveOgmiosProvider,
      buyerKey,
      advertRef,
      messages: [],
      escrowDatum,
      totalLocked,
      deliverBy,
      postedAt,
    });
  }

  // Mock backend path (synthetic JSON-in-hex tx body).
  const blueprint = loadBlueprint();
  const escrowAddress = blueprint.escrowScriptAddress(0);

  const body = {
    type: "post-escrow",
    inputs: [],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: escrowAddress,
        lovelace: totalLocked,
        assets: {},
        datumHex: encodeEscrowDatum(escrowDatum),
        scriptRef: null,
      },
    ],
    requiredSigners: [buyerKey.pubKeyHash],
    validityRange: { lowerBoundMs: postedAt, upperBoundMs: deliverBy },
    meta: { script_hash: blueprint.escrowScriptHash, advert_ref: advertRef },
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return {
    txCborHex,
    expectedTxHash,
    escrowOutputRef: { txHash: expectedTxHash, index: 0 },
  };
}
