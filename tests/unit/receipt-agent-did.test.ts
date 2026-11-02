/**
 * Receipts with agent_did (Part 2 §6.3): 9 fields for a new escrow, the 8
 * legacy fields for a legacy escrow. Signing and hashing do not change.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { keyHash, vectorDid } from "../../packages/shared/src/identity/index.js";
import {
  paper2AgentManifestHash, paper2AgentModel, paper2AgentRequestHash, paper2AgentResultHash, verifyPaper2AgentReceipt,
  type Paper2AgentManifest,
} from "../../packages/shared/src/paper2agent/index.js";
import {
  AGENT_RECEIPT_FIELDS, buildReceipt, RECEIPT_FIELDS, receiptResultHash, signReceipt, verifyEscrowReceipt, verifyReceipt,
  type BuildReceiptParams, type Receipt,
} from "../../packages/shared/src/receipt/index.js";
import { BUYER_PRIVATE_KEY_HEX, BUYER_PUB_KEY_HEX } from "../fixtures/buyer-side/wallet-keys.js";
import { SUPPLIER_PRIVATE_KEY_HEX, SUPPLIER_PUB_KEY_HEX } from "../fixtures/supplier-side/wallet-keys.js";

const AGENT_ID = "4c2047697c7aa8b3399c5fecf20f2bd19ff276aaffbd0496acfd7b3e1a52545e";
const OTHER_AGENT = "a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9";
const ESCROW_REF = `${"f".repeat(64)}#0`;
const SUPPLIER = keyHash(SUPPLIER_PUB_KEY_HEX);

function params(agentDid?: string): BuildReceiptParams {
  return {
    prompt_hash: "a".repeat(64), response_hash: "b".repeat(64), model: "qwen2.5:0.5b", prompt_tokens: 12,
    completion_tokens: 48, wallclock_ms: 3200, supplier_pkh: SUPPLIER, escrow_ref: ESCROW_REF,
    ...(agentDid === undefined ? {} : { agent_did: agentDid }),
  };
}

describe("buildReceipt with agent_did", () => {
  it("builds 8 fields for a legacy escrow and 9 fields for a new escrow", () => {
    expect(Object.keys(buildReceipt(params()))).toEqual([...RECEIPT_FIELDS]);
    expect(Object.keys(buildReceipt({ ...params(), agent_did: undefined }))).toEqual([...RECEIPT_FIELDS]);
    const receipt = buildReceipt(params(vectorDid(AGENT_ID)));
    expect(Object.keys(receipt)).toEqual([...AGENT_RECEIPT_FIELDS]);
    expect(receipt.agent_did).toBe(`did:vector:${AGENT_ID}`);
  });

  it.each([
    [`did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:${AGENT_ID}`],
    [`did:vector:testnet:${AGENT_ID}`],
    [`did:vector:${AGENT_ID.toUpperCase()}`],
    [`did:vector:${AGENT_ID.slice(1)}`],
    [AGENT_ID],
    [""],
    [42],
  ])("refuses agent_did %s", (agentDid) => {
    expect(() => buildReceipt({ ...params(), agent_did: agentDid as string })).toThrow(/buildReceipt: agent_did must be "did:vector:/);
  });
});

describe("signing and hashing a 9-field receipt", () => {
  const receipt = buildReceipt(params(vectorDid(AGENT_ID)));
  const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);

  it("signs canonical(receipt), which includes agent_did", () => {
    expect(canonicalize(receipt).startsWith(`{"agent_did":"did:vector:${AGENT_ID}","completion_tokens":48,`)).toBe(true);
    expect(signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX).signature).toBe(signed.signature);
    expect(verifyReceipt(signed, SUPPLIER_PUB_KEY_HEX)).toBe(true);
    expect(verifyReceipt({ ...signed, receipt: { ...receipt, agent_did: vectorDid(OTHER_AGENT) } }, SUPPLIER_PUB_KEY_HEX)).toBe(false);
    const { agent_did: _dropped, ...eight } = receipt;
    expect(verifyReceipt({ ...signed, receipt: eight }, SUPPLIER_PUB_KEY_HEX)).toBe(false);
  });

  it("hashes { receipt, signature } as before", () => {
    const expected = createHash("sha256").update(canonicalize({ receipt, signature: signed.signature })).digest("hex");
    expect(receiptResultHash(signed)).toBe(expected);
    const legacy = signReceipt(buildReceipt(params()), SUPPLIER_PRIVATE_KEY_HEX);
    expect(receiptResultHash(legacy)).not.toBe(expected);
  });
});

describe("verifyEscrowReceipt (Part 2 §6.3)", () => {
  const newReceipt = signReceipt(buildReceipt(params(vectorDid(AGENT_ID))), SUPPLIER_PRIVATE_KEY_HEX);
  const legacyReceipt = signReceipt(buildReceipt(params()), SUPPLIER_PRIVATE_KEY_HEX);
  const newEscrow = { escrow_ref: ESCROW_REF, supplier_pkh: SUPPLIER, agent_id: AGENT_ID };
  const legacyEscrow = { escrow_ref: ESCROW_REF, supplier_pkh: SUPPLIER };

  it("accepts 9 fields for a new escrow and 8 fields for a legacy escrow", () => {
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, newEscrow)).toBe(true);
    expect(verifyEscrowReceipt(legacyReceipt, SUPPLIER_PUB_KEY_HEX, legacyEscrow)).toBe(true);
    expect(verifyEscrowReceipt(legacyReceipt, SUPPLIER_PUB_KEY_HEX, { ...legacyEscrow, agent_id: null })).toBe(true);
  });

  it("binds the field layout to the escrow layout", () => {
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, legacyEscrow)).toBe(false);
    expect(verifyEscrowReceipt(legacyReceipt, SUPPLIER_PUB_KEY_HEX, newEscrow)).toBe(false);
  });

  it("checks agent_did against the escrow's agent_id", () => {
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, { ...newEscrow, agent_id: OTHER_AGENT })).toBe(false);
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, { ...newEscrow, agent_id: AGENT_ID.toUpperCase() })).toBe(false);
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, { ...newEscrow, agent_id: "00" })).toBe(false);
  });

  it("checks the key hash, supplier_pkh and escrow_ref against the escrow", () => {
    const otherSigner = signReceipt(buildReceipt(params(vectorDid(AGENT_ID))), BUYER_PRIVATE_KEY_HEX);
    expect(verifyReceipt(otherSigner, BUYER_PUB_KEY_HEX)).toBe(true);
    expect(verifyEscrowReceipt(otherSigner, BUYER_PUB_KEY_HEX, newEscrow)).toBe(false);
    const otherSupplier = keyHash(BUYER_PUB_KEY_HEX);
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, { ...newEscrow, supplier_pkh: otherSupplier })).toBe(false);
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, { ...newEscrow, escrow_ref: `${"f".repeat(64)}#1` })).toBe(false);
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, { ...newEscrow, supplier_pkh: SUPPLIER.toUpperCase() })).toBe(false);
  });

  it("rejects extra fields, tampered fields and bad signatures without throwing", () => {
    const extra = { ...legacyReceipt, receipt: { ...legacyReceipt.receipt, extra: 1 } as unknown as Receipt };
    expect(verifyEscrowReceipt(extra, SUPPLIER_PUB_KEY_HEX, legacyEscrow)).toBe(false);
    const tampered = { ...newReceipt, receipt: { ...newReceipt.receipt, wallclock_ms: 1 } };
    expect(verifyEscrowReceipt(tampered, SUPPLIER_PUB_KEY_HEX, newEscrow)).toBe(false);
    expect(verifyEscrowReceipt({ ...newReceipt, signature: "00".repeat(64) }, SUPPLIER_PUB_KEY_HEX, newEscrow)).toBe(false);
    expect(verifyEscrowReceipt(newReceipt, "zz", newEscrow)).toBe(false);
    expect(verifyEscrowReceipt(null as unknown as typeof newReceipt, SUPPLIER_PUB_KEY_HEX, newEscrow)).toBe(false);
    expect(verifyEscrowReceipt(newReceipt, SUPPLIER_PUB_KEY_HEX, null as unknown as typeof newEscrow)).toBe(false);
  });
});

describe("verifyPaper2AgentReceipt with an escrow agent", () => {
  const manifest: Paper2AgentManifest = {
    schema_version: 1, name: "reviewed.tool", description: "Supplier-configured tool", package_sha256: "ab".repeat(32),
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
    limits: { max_input_bytes: 1024, max_output_bytes: 2048, max_runtime_ms: 5000 },
  };
  const input = { text: "test" };
  const result = { value: 7 };
  const manifestHash = paper2AgentManifestHash(manifest);
  const requestHash = paper2AgentRequestHash(manifestHash, input);

  function args(agentDid: string | undefined, agentId: string | null | undefined) {
    const receipt = buildReceipt({
      prompt_hash: requestHash, response_hash: paper2AgentResultHash(manifestHash, requestHash, result),
      model: paper2AgentModel(manifest), prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 21,
      supplier_pkh: SUPPLIER, escrow_ref: ESCROW_REF, ...(agentDid === undefined ? {} : { agent_did: agentDid }),
    });
    return {
      manifest, input, result, receipt, signature: signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX).signature,
      publicKeyHex: SUPPLIER_PUB_KEY_HEX, supplierPkh: SUPPLIER, escrowRef: ESCROW_REF, agentId,
    };
  }

  it("accepts a 9-field receipt that names the escrow agent", () => {
    expect(() => verifyPaper2AgentReceipt(args(vectorDid(AGENT_ID), AGENT_ID))).not.toThrow();
  });

  it("keeps accepting 8-field receipts for legacy escrows", () => {
    expect(() => verifyPaper2AgentReceipt(args(undefined, undefined))).not.toThrow();
    expect(() => verifyPaper2AgentReceipt(args(undefined, null))).not.toThrow();
  });

  it("rejects a layout that does not match the escrow", () => {
    expect(() => verifyPaper2AgentReceipt(args(vectorDid(AGENT_ID), null))).toThrow(/receipt has missing or unknown fields/);
    expect(() => verifyPaper2AgentReceipt(args(undefined, AGENT_ID))).toThrow(/receipt has missing or unknown fields/);
  });

  it("rejects another agent, an invalid agent identifier and an invalid agent_did", () => {
    expect(() => verifyPaper2AgentReceipt(args(vectorDid(OTHER_AGENT), AGENT_ID))).toThrow(/receipt agent DID does not match the escrow agent/);
    expect(() => verifyPaper2AgentReceipt(args(vectorDid(AGENT_ID), AGENT_ID.toUpperCase()))).toThrow(/invalid escrow agent identifier/);
    const bad = args(vectorDid(AGENT_ID), AGENT_ID);
    const receipt = { ...bad.receipt, agent_did: `did:vector:testnet:${AGENT_ID}` };
    expect(() => verifyPaper2AgentReceipt({ ...bad, receipt, signature: signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX).signature }))
      .toThrow(/agent_did must be/);
  });
});
