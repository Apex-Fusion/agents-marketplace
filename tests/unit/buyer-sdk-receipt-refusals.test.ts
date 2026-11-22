/**
 * buyer-sdk-receipt-refusals.test.ts — the receipt refusals of Marketplace.submitPrompt.
 *
 * Covers buyer/src/sdk/Marketplace.ts:794-826 (executePrompt, the one-shot path): the checks that refuse a receipt with
 * wrong_supplier, wrong_escrow_ref, prompt_hash_mismatch, request_spec_hash_mismatch and invalid_signature.
 * - wrong_supplier checks receipt.supplier_pkh against the advert.
 * - wrong_escrow_ref checks receipt.escrow_ref against the escrow that the buyer posted.
 * - prompt_hash_mismatch checks receipt.prompt_hash against the commitment of the request.
 * - request_spec_hash_mismatch is the check of the MODEL, whatever its name says: receipt.model and the model of the Response
 *   object against the model of the advert.
 * - invalid_signature checks the SHAPE of the signature: 128 hex digits, not all zeros.
 * The SDK does not verify the Ed25519 signature (Marketplace.ts:19-26). So no row here sends a forged but well-formed signature.
 *
 * The payment is on chain before the supplier answers, so a refusal leaves a posted escrow. Each refusal must also write the
 * failure to the history of the buyer. The checks run in a fixed order (supplier, escrow ref, prompt hash, model, response hash,
 * signature). Each row changes ONE field of an otherwise valid answer, so that the check of that row is the first one to fail.
 * The response_hash_mismatch refusal has its own case in buyer-sdk-submit-prompt-reject.test.ts.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { ReceiptVerificationError } from "../../buyer/src/sdk/types.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { buildReceipt, type Receipt } from "../../packages/shared/src/receipt/build.js";
import { signReceipt } from "../../packages/shared/src/receipt/sign.js";
import {
  createResponse, responseRequestCommitment, responseResultCommitment,
  type ResponseItem, type ResponseObject, type ResponseRequest,
} from "../../packages/shared/src/responses.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ADVERT_REF: OutputReference = { txHash: "b".repeat(64), index: 0 };
const MODEL = "qwen2.5:0.5b";
const OTHER_MODEL = "other-model:7b";
const buyer = buildBuyerWalletKey();
const supplier = buildSupplierWalletKey();

const INPUT: ResponseItem[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is 2+2?" }] }];
const OTHER_INPUT: ResponseItem[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is 3+3?" }] }];

const advert: AdvertDatum = {
  supplier_pkh: supplier.pubKeyHash,
  capability_id: "llm.text.generate.v1",
  model: MODEL,
  max_output_tokens: 512,
  max_processing_ms: 60_000,
  price_lovelace: 2_000_000n,
  supplier_bond_lovelace: 1_000_000n,
  buyer_bond_lovelace: 1_000_000n,
  endpoint_url: "https://supplier.example.com",
  detail_uri: "ipfs://Qm000",
  detail_hash: "a".repeat(64),
  advertised_at: 1_745_500_000_000,
  status: "Active",
};

/** What the supplier gives back at /capability. It matches the advert. */
const capability = {
  capability_id: advert.capability_id,
  model: advert.model,
  max_output_tokens: advert.max_output_tokens,
  max_processing_ms: advert.max_processing_ms,
  price_lovelace: advert.price_lovelace.toString(),
  advert_ref: `${ADVERT_REF.txHash}#${ADVERT_REF.index}`,
  supplier_pkh: advert.supplier_pkh,
  pub_key_hex: supplier.pubKeyHex,
  inference_api: "responses",
  upstream_api: "responses",
};

/** What the supplier sends back for one request: the terminal Response, its receipt, and the signature of the receipt. */
interface Answer {
  result: ResponseObject;
  receipt: Receipt;
  signature: string;
}

const sha256 = (value: unknown): string => createHash("sha256").update(canonicalize(value), "utf8").digest("hex");

/** The valid answer to `request` for the escrow `escrowRef`. */
function validAnswer(request: ResponseRequest, escrowRef: string): Answer {
  const result = createResponse({
    id: "resp_test",
    model: MODEL,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "4", annotations: [] }] }],
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  });
  const receipt = buildReceipt({
    prompt_hash: sha256(responseRequestCommitment(request)),
    response_hash: sha256(responseResultCommitment(result)),
    model: MODEL,
    prompt_tokens: 12,
    completion_tokens: 4,
    wallclock_ms: 800,
    supplier_pkh: supplier.pubKeyHash,
    escrow_ref: escrowRef,
  });
  return { result, receipt, signature: signReceipt(receipt, supplier.privateKeyHex).signature };
}

/** `answer` with other fields in its receipt. The receipt is signed again, so that the signature fits it. */
function withReceipt(answer: Answer, changes: Partial<Receipt>): Answer {
  const receipt = { ...answer.receipt, ...changes };
  return { ...answer, receipt, signature: signReceipt(receipt, supplier.privateKeyHex).signature };
}

type Tamper = (answer: Answer, escrowRef: string) => Answer;

const refusals: Array<[reason: string, what: string, tamper: Tamper]> = [
  ["wrong_supplier", "the receipt names another supplier", (answer) => withReceipt(answer, { supplier_pkh: buyer.pubKeyHash })],
  [
    "wrong_escrow_ref",
    "the receipt names another output of the escrow transaction",
    (answer, escrowRef) => {
      const [txHash, index] = escrowRef.split("#");
      return withReceipt(answer, { escrow_ref: `${txHash}#${Number(index) + 1}` });
    },
  ],
  [
    "prompt_hash_mismatch",
    "the receipt commits to another request",
    (answer) => withReceipt(answer, { prompt_hash: sha256(responseRequestCommitment({ input: OTHER_INPUT })) }),
  ],
  ["request_spec_hash_mismatch", "the receipt names another model", (answer) => withReceipt(answer, { model: OTHER_MODEL })],
  [
    "request_spec_hash_mismatch",
    "the Response object names another model",
    (answer) => ({ ...answer, result: { ...answer.result, model: OTHER_MODEL } }),
  ],
  ["invalid_signature", "the signature has 127 hex digits", (answer) => ({ ...answer, signature: "f".repeat(127) })],
  ["invalid_signature", "the signature has 129 hex digits", (answer) => ({ ...answer, signature: "f".repeat(129) })],
  ["invalid_signature", "the signature has 128 characters and one is not hex", (answer) => ({ ...answer, signature: `g${"f".repeat(127)}` })],
  ["invalid_signature", "the signature is 128 zeros", (answer) => ({ ...answer, signature: "0".repeat(128) })],
];

/**
 * A buyer that posts the escrow on a mock chain and calls a fake supplier. The supplier answers with the valid answer, changed by
 * `tamper`. `escrowRef()` is the escrow that the buyer posted, as the supplier saw it in the header X-Escrow-Ref.
 */
function startSubmit(tamper: Tamper = (answer) => answer) {
  const chain = new MockChainProvider();
  chain.advanceSlot(1_745_500_000);
  chain.seed({
    ref: ADVERT_REF, address: "addr_test1wfakeadvert", lovelace: 2_000_000n, assets: {},
    datumHex: encodeAdvertDatum(advert), scriptRef: null,
  });
  let escrowRef = "";
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/capability")) return Response.json(capability);
    const request: ResponseRequest = JSON.parse(String(init?.body));
    escrowRef = new Headers(init?.headers).get("X-Escrow-Ref") ?? "";
    const { result, receipt, signature } = tamper(validAnswer(request, escrowRef), escrowRef);
    return Response.json({ ...result, receipt, receipt_signature: signature });
  });
  const sdk = new Marketplace({
    chain, indexerUrl: "http://indexer.test", walletKey: buyer, networkParams: { networkId: 0 }, _fetch: fetchImpl,
  });
  const outcome = sdk.submitPrompt({ advertRef: ADVERT_REF, input: INPUT, payment_lovelace: advert.price_lovelace });
  return { sdk, outcome, escrowRef: () => escrowRef };
}

describe("Marketplace.submitPrompt receipt check", () => {
  it("accepts the valid answer and records the task as completed (control)", async () => {
    const { sdk, outcome, escrowRef } = startSubmit();

    expect((await outcome).response).toBe("4");

    expect(sdk.getTaskHistory()).toEqual([expect.objectContaining({ escrow_ref: escrowRef(), status: "completed" })]);
  });

  it.each(refusals)("refuses with %s when %s, and records the failure", async (reason, _what, tamper) => {
    const { sdk, outcome, escrowRef } = startSubmit(tamper);

    await expect(outcome).rejects.toBeInstanceOf(ReceiptVerificationError);
    await expect(outcome).rejects.toMatchObject({ reason });

    expect(sdk.getTaskHistory()).toEqual([
      expect.objectContaining({
        escrow_ref: escrowRef(), supplier_pkh: supplier.pubKeyHash, capability_id: advert.capability_id,
        status: "failed", failure_reason: reason,
      }),
    ]);
  });
});
