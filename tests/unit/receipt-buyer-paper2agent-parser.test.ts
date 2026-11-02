/**
 * The buyer SDK's Paper2Agent receipt parser accepts the 8 legacy fields and
 * the 9 fields of a new escrow (Part 2 §6.3). The parser is private, so the
 * test reads a result through Paper2AgentClient.recover(). The buyer still
 * posts legacy escrows, so the shared verifier then refuses a 9-field receipt
 * with its own error: that shows the parser accepted the receipt.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Paper2AgentClient, type PostedPaper2Agent } from "../../buyer/src/sdk/paper2agent.js";
import { ReceiptVerificationError } from "../../buyer/src/sdk/types.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { vectorDid } from "../../packages/shared/src/identity/index.js";
import {
  PAPER2AGENT_CAPABILITY_ID, paper2AgentManifestHash, paper2AgentModel, paper2AgentRequestHash, paper2AgentResultHash,
  type Paper2AgentManifest,
} from "../../packages/shared/src/paper2agent/index.js";
import { buildReceipt, type Receipt } from "../../packages/shared/src/receipt/build.js";
import { signReceipt } from "../../packages/shared/src/receipt/sign.js";
import { loadBlueprint, type WalletKey } from "../../packages/shared/src/tx/index.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

const ADVERT_REF = { txHash: "b".repeat(64), index: 0 };
const AGENT_ID = "4c2047697c7aa8b3399c5fecf20f2bd19ff276aaffbd0496acfd7b3e1a52545e";
const buyer = buildBuyerWalletKey();
// Throwaway supplier key for this test only.
const seed = "37".repeat(32);
const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed}`, "hex"), format: "der", type: "pkcs8" }))
  .export({ type: "spki", format: "der" }).subarray(-32);
const pkh = Buffer.from(blake2b(publicKey, { dkLen: 28 })).toString("hex");
const supplier: WalletKey = {
  privateKeyHex: seed, pubKeyHex: publicKey.toString("hex"), pubKeyHash: pkh,
  address: bech32.encode("addr_test", bech32.toWords(Buffer.concat([Buffer.from([0x60]), Buffer.from(pkh, "hex")])), 1023),
};
const tool: Paper2AgentManifest = {
  schema_version: 1, name: "reviewed_tool", description: "A configured JSON tool.", package_sha256: "c".repeat(64),
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  limits: { max_input_bytes: 4096, max_output_bytes: 4096, max_runtime_ms: 10_000 },
};
const manifestHash = paper2AgentManifestHash(tool);
const refString = (ref: OutputReference) => `${ref.txHash}#${ref.index}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function postedPurchase(result: (posted: PostedPaper2Agent) => Record<string, unknown>) {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor(Date.now() / 1000));
  const advert: AdvertDatum = {
    supplier_pkh: pkh, capability_id: PAPER2AGENT_CAPABILITY_ID, model: paper2AgentModel(tool), max_output_tokens: 0,
    max_processing_ms: 120_000, price_lovelace: 2_000_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.test", detail_uri: "https://supplier.test/capability", detail_hash: "a".repeat(64),
    advertised_at: Date.now(), status: "Active",
  };
  chain.seed({
    ref: ADVERT_REF, address: loadBlueprint().advertScriptAddress(0), lovelace: 2_000_000n, assets: {},
    datumHex: encodeAdvertDatum(advert), scriptRef: null,
  });
  const metadata = {
    advert_ref: refString(ADVERT_REF), supplier_pkh: pkh, pub_key_hex: supplier.pubKeyHex, capability_id: advert.capability_id,
    model: advert.model, max_output_tokens: 0, max_processing_ms: advert.max_processing_ms,
    price_lovelace: advert.price_lovelace.toString(), paper2agent: { manifest: tool, manifest_hash: manifestHash },
  };
  let posted: PostedPaper2Agent | undefined;
  const fetchFn = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
    const path = String(url);
    if (path.endsWith("/capability")) return json(metadata);
    if (path.endsWith("/v1/paper2agent/run/job_1")) return json(result(posted!));
    throw new Error(`unexpected URL: ${path}`);
  });
  const client = new Paper2AgentClient({ chain, walletKey: buyer, indexerUrl: "https://indexer.test", fetchFn });
  posted = await client.post(await client.prepare({
    advertRef: ADVERT_REF, manifestHash, input: { text: "hello" }, expectedSupplierPkh: pkh, maxPriceLovelace: advert.price_lovelace,
  }));
  return { client, posted };
}

/** A supplier result body whose receipt `change` edits after the genuine 8 fields are built. */
function resultBody(change: (receipt: Record<string, unknown>) => Record<string, unknown>) {
  return (posted: PostedPaper2Agent): Record<string, unknown> => {
    const result = { value: "hello" };
    const escrowRef = refString(posted.escrowRef);
    const receipt = change({
      ...buildReceipt({
        prompt_hash: paper2AgentRequestHash(manifestHash, posted.input),
        response_hash: paper2AgentResultHash(manifestHash, paper2AgentRequestHash(manifestHash, posted.input), result),
        model: posted.advert.model, prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 10, supplier_pkh: pkh, escrow_ref: escrowRef,
      }),
    });
    return {
      manifest_hash: manifestHash, escrow_ref: escrowRef, pub_key_hex: supplier.pubKeyHex, result, receipt,
      // Deliberately malformed receipts are signed too, so only their layout differs.
      receipt_signature: signReceipt(receipt as unknown as Receipt, supplier.privateKeyHex).signature, submitted_ref: `${"e".repeat(64)}#0`,
    };
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("buyer Paper2Agent receipt parser", () => {
  it("accepts a 9-field receipt with agent_did; the legacy escrow binding then refuses it", async () => {
    const { client, posted } = await postedPurchase(resultBody((receipt) => ({ ...receipt, agent_did: vectorDid(AGENT_ID) })));
    const failure = await client.recover(posted, { jobId: "job_1", timeoutMs: 5_000 }).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(ReceiptVerificationError);
    expect(String(failure)).toMatch(/Paper2Agent: receipt has missing or unknown fields/);
  });

  it.each([
    ["10 fields", (receipt: Record<string, unknown>) => ({ ...receipt, agent_did: vectorDid(AGENT_ID), extra: 1 })],
    ["a 9th field that is not agent_did", (receipt: Record<string, unknown>) => ({ ...receipt, extra: "x" })],
    ["an agent_did that is not a string", (receipt: Record<string, unknown>) => ({ ...receipt, agent_did: 7 })],
    ["8 fields with agent_did in place of escrow_ref", ({ escrow_ref: _ref, ...receipt }: Record<string, unknown>) => ({ ...receipt, agent_did: vectorDid(AGENT_ID) })],
    ["7 fields", ({ model: _model, ...receipt }: Record<string, unknown>) => receipt],
  ])("rejects %s as malformed_receipt", async (_name, change) => {
    const { client, posted } = await postedPurchase(resultBody(change));
    const failure = await client.recover(posted, { jobId: "job_1", timeoutMs: 5_000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReceiptVerificationError);
    expect(failure instanceof ReceiptVerificationError && failure.reason).toBe("malformed_receipt");
  });

  it("checks the agent_did value through buildReceipt", async () => {
    const { client, posted } = await postedPurchase(resultBody((receipt) => ({ ...receipt, agent_did: `did:vector:${AGENT_ID.toUpperCase()}` })));
    await expect(client.recover(posted, { jobId: "job_1", timeoutMs: 5_000 })).rejects.toThrow(/buildReceipt: agent_did must be/);
  });
});
