import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CML } from "@lucid-evolution/lucid";
import { Paper2AgentClient, type Paper2AgentResult, type PostedPaper2Agent } from "@marketplace/buyer/sdk/paper2agent";
import { MockChainProvider, type OutputReference, type Utxo } from "@marketplace/shared/chain";
import { encodeEscrowDatum, type AdvertDatum, type EscrowDatum } from "@marketplace/shared/cbor";
import { signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
import { inspectSignedTransaction } from "@marketplace/shared/tx/server";
import { PAPER2AGENT_CAPABILITY_ID, paper2AgentManifestHash, paper2AgentModel, paper2AgentRequestHash, paper2AgentRequestSpecHash, paper2AgentResultHash, type Paper2AgentManifest } from "@marketplace/shared/paper2agent";
import { GatewayStore, type ApiKeyRow } from "../src/db/store.js";
import { approvePaper2Agent, executePaper2AgentCall } from "../src/paper2agent/service.js";
import { savePaper2AgentTransaction } from "../src/paper2agent/financial.js";
import { recoverOneShotJobs } from "../src/oneShotJobs.js";
import { runSweepOnce } from "../src/sweeper.js";
import { Mutex, type KeyContext, type SdkRegistry } from "../src/sdk/registry.js";
import { deriveWalletKey } from "../src/wallet.js";
import { loadConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";
import type { EscrowLineage } from "../src/onchain/settle.js";

const directories: string[] = [];
const stores: GatewayStore[] = [];
const manifest: Paper2AgentManifest = {
  schema_version: 1, name: "echo", description: "A local test tool", package_sha256: "aa".repeat(32),
  input_schema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false },
  output_schema: { type: "object", properties: { y: { type: "integer" } }, required: ["y"], additionalProperties: false },
  limits: { max_input_bytes: 1024, max_output_bytes: 1024, max_runtime_ms: 1000 },
};
const input = { x: 2 };
const result = { y: 4 };
const manifestHash = paper2AgentManifestHash(manifest);
const buyer = deriveWalletKey("11".repeat(32), 0);
const supplier = deriveWalletKey("22".repeat(32), 0);

class ObservedChain extends MockChainProvider {
  readonly submissions: string[] = [];
  loseSubmitResponse = false;
  loseConfirmation = false;
  override async submitTx(cbor: string): Promise<string> {
    this.submissions.push(cbor);
    const hash = await super.submitTx(cbor);
    if (this.loseSubmitResponse) throw new Error("lost broadcast response");
    return hash;
  }
  override async awaitTx(hash: string, timeout: number): Promise<void> {
    if (this.loseConfirmation) throw new Error("confirmation unavailable");
    await super.awaitTx(hash, timeout);
  }
}

/** A signed-shape Reclaim whose large collateral input is mostly returned to the wallet. */
function reclaimWithCollateral(escrow: OutputReference, collateral: OutputReference, totalCollateral: bigint): string {
  const owned: { free(): void }[] = [];
  const keep = <T extends { free(): void }>(value: T): T => {
    owned.push(value);
    return value;
  };
  const inputs = (ref: OutputReference) => {
    const list = keep(CML.TransactionInputList.new());
    list.add(keep(CML.TransactionInput.new(keep(CML.TransactionHash.from_hex(ref.txHash)), BigInt(ref.index))));
    return list;
  };
  try {
    const outputs = keep(CML.TransactionOutputList.new());
    outputs.add(keep(CML.TransactionOutput.new(keep(CML.Address.from_bech32(buyer.address)), keep(CML.Value.from_coin(5_800_000n)))));
    const body = keep(CML.TransactionBody.new(inputs(escrow), outputs, 200_000n));
    body.set_collateral_inputs(inputs(collateral));
    body.set_total_collateral(totalCollateral);
    return keep(CML.Transaction.new(body, keep(CML.TransactionWitnessSet.new()), true)).to_cbor_hex();
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) owned[i]!.free();
  }
}

async function fixture(state: "Open" | "Submitted" = "Submitted", receipt: "valid" | "missing" | "forged" = "valid",
  options: { job?: boolean; posted?: boolean } = {}) {
  const directory = join(tmpdir(), `paper2agent-recovery-${randomUUID()}`);
  directories.push(directory);
  const store = new GatewayStore(directory);
  stores.push(store);
  const key: ApiKeyRow = { id: "buyer", key_hash: "hash", key_prefix: "vk_test", label: null,
    wallet_pkh: buyer.pubKeyHash, deposit_address: buyer.address, enc_priv_nonce: "unused", enc_priv_ct: "unused",
    enc_priv_tag: "unused", master_key_version: 1, created_at: 1, disabled: 0, demo: 0 };
  store.insertKey(key);
  approvePaper2Agent(store, { keyId: key.id, manifestHash, supplierPkh: supplier.pubKeyHash,
    maxPriceLovelace: 2_000_000n, maxTotalSpendLovelace: 30_000_000n, maxCalls: 1 });
  const advertRef = { txHash: "44".repeat(32), index: 0 };
  const original: EscrowDatum = { buyer_pkh: buyer.pubKeyHash, supplier_pkh: supplier.pubKeyHash, advert_ref: advertRef,
    capability_id: PAPER2AGENT_CAPABILITY_ID, request_spec_hash: paper2AgentRequestSpecHash(manifest),
    prompt_hash: paper2AgentRequestHash(manifestHash, input), payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 2_000_000n, supplier_bond_lovelace: 2_000_000n,
    posted_at: 1000, deliver_by: state === "Open" ? 2000 : Date.now() + 60_000,
    submitted_at: null, result_receipt_hash: null, state: "Open" };
  const chain = new ObservedChain();
  chain.advanceSlot(10);
  const funding: Utxo = { ref: { txHash: "55".repeat(32), index: 0 }, address: buyer.address, lovelace: 10_000_000n,
    assets: {}, datumHex: null, scriptRef: null };
  chain.seed(funding);
  const output = { ref: { txHash: "$self", index: 0 }, address: "escrow-script", lovelace: 6_000_000n,
    datumHex: encodeEscrowDatum(original), assets: {}, scriptRef: null };
  const json = Buffer.from(JSON.stringify({ type: "post", inputs: [funding.ref], outputs: [output,
    { ...funding, ref: { txHash: "$self", index: 1 }, lovelace: 4_000_000n }], validityRange: { upperBoundMs: 100_000 } },
  (_key, value: unknown) => typeof value === "bigint" ? `${value}n` : value));
  const cbor = json.byteLength.toString(16).padStart(8, "0") + json.toString("hex");
  const postHash = inspectSignedTransaction(cbor).txHash;
  const originalRef = `${postHash}#0`;
  const submittedRef = { txHash: "66".repeat(32), index: 0 };
  const submittedRefString = `${submittedRef.txHash}#0`;
  const signed = signReceipt({ prompt_hash: original.prompt_hash, response_hash: paper2AgentResultHash(manifestHash, original.prompt_hash, result),
    model: paper2AgentModel(manifest), prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 1, supplier_pkh: supplier.pubKeyHash,
    escrow_ref: originalRef }, supplier.privateKeyHex);
  if (receipt === "forged") signed.signature = "ab".repeat(64);
  const receiptHash = receiptResultHash(signed);
  const current: EscrowDatum = state === "Submitted" ? { ...original, state, submitted_at: 5000, result_receipt_hash: receiptHash } : original;
  const liveRef = state === "Submitted" ? submittedRef : { txHash: postHash, index: 0 };
  chain.seed({ ...output, ref: liveRef, datumHex: encodeEscrowDatum(current) });
  let lineage: EscrowLineage | null = { original_ref: originalRef,
    rows: state === "Submitted" ? [
      { utxo_ref: originalRef, state: "Open", posted_at: 1000, spent_tx: "77".repeat(32) },
      { utxo_ref: `${"77".repeat(32)}#0`, state: "Claimed", posted_at: 1000, spent_tx: submittedRef.txHash },
      { utxo_ref: submittedRefString, state, posted_at: 1000, spent_tx: null },
    ] : [{ utxo_ref: originalRef, state, posted_at: 1000, spent_tx: null }], terminal: null };
  const advert: AdvertDatum = { supplier_pkh: supplier.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID,
    model: paper2AgentModel(manifest), max_output_tokens: 0, max_processing_ms: 120_000, price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 2_000_000n, buyer_bond_lovelace: 2_000_000n, endpoint_url: "http://supplier.test",
    detail_uri: "http://supplier.test/capability", detail_hash: "aa".repeat(32), advertised_at: 1, status: "Active" };
  const prepared = { advertRef, advert, manifest, manifestHash, supplierPublicKeyHex: supplier.pubKeyHex,
    endpointUrl: "http://supplier.test", input, requestHash: original.prompt_hash };
  const posted: PostedPaper2Agent = { ...prepared, escrowRef: { txHash: postHash, index: 0 }, postedAt: original.posted_at,
    deliverBy: original.deliver_by, escrowDatum: original, escrowUtxo: { ...output, ref: { txHash: postHash, index: 0 } } };
  const paid: Paper2AgentResult = { manifest_hash: manifestHash, result, receipt: signed.receipt,
    receipt_signature: signed.signature, pub_key_hex: supplier.pubKeyHex, escrow_ref: originalRef, submitted_ref: submittedRefString };
  const offer = { utxo_ref: `${advertRef.txHash}#0`, supplier_pkh: supplier.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID,
    model: advert.model, max_output_tokens: 0, max_processing_ms: advert.max_processing_ms, price_lovelace: "2000000",
    supplier_bond_lovelace: "2000000", buyer_bond_lovelace: "2000000", endpoint_url: "http://supplier.test",
    advert_status: "Active", status: "free" };
  const fetchFn = vi.fn(async (url: string) => url.includes("/suppliers") ? Response.json([offer])
    : lineage ? Response.json(lineage) : new Response("not found", { status: 404 }));
  const context: KeyContext = { sdk: {} as KeyContext["sdk"], mutex: new Mutex(), walletKey: buyer,
    chain: chain as unknown as KeyContext["chain"], reconcilePendingWalletTransaction: async () => undefined };
  const deps: GatewayDeps = { config: loadConfig({ LIVE_CHAIN: "1", GATEWAY_MASTER_KEY: "aa".repeat(32), INDEXER_URL: "http://indexer.test", OGMIOS_URL: "http://ogmios.test", GATEWAY_DB_DIR: directory }),
    store, chain: chain as unknown as GatewayDeps["chain"], registry: { getContext: () => context } as unknown as SdkRegistry,
    fetchFn: fetchFn as unknown as typeof fetch };
  if (options.job !== false) {
    store.insertOneShotJob({ id: "job", key_id: key.id, owner_id: "old", model: paper2AgentModel(manifest), created_at: 1 }, 64,
      () => store.paper2agent.reserve("job", key.id, manifestHash));
    store.updateOneShotJob("job", "old", { supplier_pkh: supplier.pubKeyHash, advert_ref: `${advertRef.txHash}#0`,
      price_lovelace: "2000000", endpoint_url: "http://supplier.test", heartbeat_at: 0 });
    store.paper2agent.update("job", { prepared_json: JSON.stringify(prepared, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value) });
    await savePaper2AgentTransaction(deps, key, store.getOneShotJob("job")!, "post", { txCborHex: cbor, expectedTxHash: postHash }, { txHash: postHash, index: 0 });
    if (options.posted) {
      store.paper2agent.update("job", { posted_json: JSON.stringify(posted, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value) });
    }
    if (receipt !== "missing") store.paper2agent.saveResult("job", "old", JSON.stringify(paid), receiptHash, submittedRefString);
  }
  return { deps, store, key, chain, context, directory, original, current, originalRef, liveRef, postHash, cbor,
    receiptHash, prepared, posted, paid,
    get lineage() { return lineage; }, set lineage(value: EscrowLineage | null) { lineage = value; } };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) if (store["db"].open) store["db"].close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Paper2Agent receipt-gated recovery", () => {
  it.each(["missing", "forged"] as const)("never accepts a %s receipt through recovery or the legacy sweep", async (receipt) => {
    const f = await fixture("Submitted", receipt);
    const recover = vi.spyOn(Paper2AgentClient.prototype, "recover");
    const accept = vi.fn();
    const reclaim = vi.fn();
    await runSweepOnce(f.deps, { accept, reclaim });
    expect(f.chain.submissions).toEqual([]);
    expect(accept).not.toHaveBeenCalled();
    expect(reclaim).not.toHaveBeenCalled();
    // Without a Post snapshot, an old row has no read-only path to a new result.
    expect(recover).not.toHaveBeenCalled();
    expect(f.store.paper2agent.call("job")!.actual_cost_lovelace).toBeNull();
    expect(f.store.paper2agent.call("job")!.result_status).toBe("failed");
    expect(f.store.paper2agent.approval(f.key.id)!.reserved_lovelace).toBe("30000000");
  });

  it("requires the original immutable datum even with a valid signed receipt", async () => {
    const f = await fixture();
    f.chain.seed({ ref: f.liveRef, address: "escrow-script", lovelace: 6_000_000n, assets: {}, scriptRef: null,
      datumHex: encodeEscrowDatum({ ...f.current, supplier_bond_lovelace: 1n }) });
    await recoverOneShotJobs(f.deps);
    expect(f.chain.submissions).toEqual([]);
    expect(f.store.getOneShotJob("job")!.error).toBe("paper2agent_escrow_identity_mismatch");
  });

  it("confirms Accept before completing and retains exact pre-spend transaction facts", async () => {
    const f = await fixture();
    f.chain.loseConfirmation = true;
    await recoverOneShotJobs(f.deps);
    expect(f.store.getOneShotJob("job")!.state).toBe("recovering");
    expect(f.store.paper2agent.call("job")!.actual_cost_lovelace).toBeNull();
    const accept = f.store.paper2agent.transactions("job").find((tx) => tx.phase === "accept")!;
    expect(accept.confirmed).toBe(0);
    expect(JSON.parse(accept.facts_json).inputs[0].lovelace).toBe("6000000");
    f.chain.loseConfirmation = false;
    f.lineage!.rows.at(-1)!.spent_tx = accept.tx_hash;
    f.lineage!.terminal = { type: "AcceptEscrow", tx_hash: accept.tx_hash };
    await recoverOneShotJobs(f.deps);
    expect(f.store.paper2agent.call("job")).toMatchObject({ financial_status: "accepted", actual_cost_lovelace: "4000000", result_status: "verified" });
    expect(f.store.getOneShotJob("job")!.state).toBe("completed");
    expect(f.chain.submissions).toHaveLength(1);
    expect(f.store.listUsage(f.key.id, 10)).toHaveLength(1);
  });

  it("recovers an Open failure through confirmed Reclaim without changing result success", async () => {
    const f = await fixture("Open", "missing");
    await recoverOneShotJobs(f.deps);
    expect(f.store.paper2agent.call("job")).toMatchObject({ result_status: "failed", financial_status: "reclaimed", actual_cost_lovelace: "0" });
    expect(f.store.getOneShotJob("job")!.state).toBe("reclaimed");
    expect(f.store.paper2agent.transactions("job").map((tx) => tx.phase)).toEqual(["post", "reclaim"]);
    expect(f.chain.submissions).toHaveLength(1);
  });

  it.each(["ReleaseEscrow", "AcceptEscrow"] as const)("retains unknown debit for external %s without trusting indexer labels", async (type) => {
    const f = await fixture("Submitted", "missing");
    f.lineage!.rows.at(-1)!.spent_tx = "88".repeat(32);
    f.lineage!.terminal = { type, tx_hash: "88".repeat(32) };
    await recoverOneShotJobs(f.deps);
    expect(f.store.paper2agent.call("job")).toMatchObject({ result_status: "failed", financial_status: "unknown", actual_cost_lovelace: null, accounted: 0 });
    expect(f.store.paper2agent.approval(f.key.id)!.reserved_lovelace).toBe("30000000");
    expect(f.store.getOneShotJob("job")!.state).toBe("failed");
    expect(f.chain.submissions).toEqual([]);
  });

  it("replays only original signed Post bytes across an ambiguous broadcast and restart", async () => {
    const f = await fixture("Open", "missing");
    f.lineage = null;
    f.chain.loseSubmitResponse = true;
    await recoverOneShotJobs(f.deps);
    expect(f.chain.submissions).toEqual([f.cbor]);
    expect(f.store.paper2agent.call("job")!.actual_cost_lovelace).toBeNull();
    const job = f.store.getOneShotJob("job")!;
    f.store.updateOneShotJob("job", job.owner_id, { heartbeat_at: 0 });
    f.store["db"].close();
    const restarted = new GatewayStore(f.directory);
    stores.push(restarted);
    f.deps.store = restarted;
    f.chain.loseSubmitResponse = false;
    await recoverOneShotJobs(f.deps);
    expect(f.chain.submissions).toEqual([f.cbor, f.cbor]);
    expect(restarted.listOneShotJobs()).toHaveLength(1);
    expect(restarted.paper2agent.transactions("job")).toHaveLength(1);
    expect(restarted.paper2agent.approval(f.key.id)!.calls).toBe(1);
  });

  it("protects a tool-only key whose result journal is missing from legacy acceptance", async () => {
    const f = await fixture("Submitted", "missing");
    f.store["db"].prepare("DELETE FROM paper2agent_calls WHERE job_id = ?").run("job");
    const accept = vi.fn();
    await runSweepOnce(f.deps, { accept, reclaim: vi.fn() });
    expect(accept).not.toHaveBeenCalled();
    expect(f.chain.submissions).toEqual([]);
    expect(f.store.getOneShotJob("job")!.error).toBe("paper2agent_journal_missing");
  });

  it("charges the signed total collateral, not a returned collateral input, against exposure", async () => {
    const f = await fixture("Open", "missing");
    const collateral: Utxo = { ref: { txHash: "99".repeat(32), index: 0 }, address: buyer.address, lovelace: 25_000_000n,
      assets: {}, datumHex: null, scriptRef: null };
    f.chain.seed(collateral);
    f.store.updateOneShotJob("job", "old", { submitted_ref: f.originalRef });
    const save = (total: bigint) => {
      const cbor = reclaimWithCollateral(f.liveRef, collateral.ref, total);
      return savePaper2AgentTransaction(f.deps, f.key, f.store.getOneShotJob("job")!, "reclaim",
        { txCborHex: cbor, expectedTxHash: inspectSignedTransaction(cbor).txHash });
    };
    await expect(save(25_000_001n)).rejects.toThrow("paper2agent_collateral_mismatch");
    // The Post already risks 6,000,000 of 30,000,000. The whole 25,000,000 input would exceed it.
    await save(1_000_000n);
    const reclaim = f.store.paper2agent.transactions("job").find((tx) => tx.phase === "reclaim")!;
    expect(reclaim.collateral_lovelace).toBe("1000000");
    expect(JSON.parse(reclaim.facts_json)).toMatchObject({ collateralInputLovelace: "25000000", totalCollateralLovelace: "1000000" });
  });

  it("keeps the Post snapshot and verified receipt across slow chain catch-up and settles without another execution", async () => {
    const f = await fixture("Submitted", "valid", { job: false });
    f.chain.seed({ ref: { txHash: "57".repeat(32), index: 0 }, address: buyer.address, lovelace: 20_000_000n,
      assets: {}, datumHex: null, scriptRef: null });
    vi.spyOn(Paper2AgentClient.prototype, "prepare").mockResolvedValue(f.prepared);
    vi.spyOn(Paper2AgentClient.prototype, "post").mockImplementation(async (_prepared, beforeSubmit) => {
      await beforeSubmit!({ txCborHex: f.cbor, expectedTxHash: f.postHash, escrowOutputRef: { txHash: f.postHash, index: 0 } });
      return f.posted;
    });
    let snapshot: string | null = null;
    const execute = vi.spyOn(Paper2AgentClient.prototype, "execute").mockImplementation(async (_posted, options) => {
      snapshot = f.store.paper2agent.call(f.store.listOneShotJobs()[0]!.id)!.posted_json;
      await options!.onJobAccepted!("supplier-job");
      await options!.onReceiptVerified!(f.paid);
      throw new Error("Submitted lineage is not indexed yet");
    });
    const recover = vi.spyOn(Paper2AgentClient.prototype, "recover");
    await expect(executePaper2AgentCall(f.deps, f.key, { manifestHash, input })).rejects.toMatchObject({ code: "paper2agent_call_failed" });
    const [job] = f.store.listOneShotJobs();
    // Both were durable before supplier admission and before chain catch-up.
    expect(JSON.parse(snapshot!)).toMatchObject({ escrowRef: { txHash: f.postHash, index: 0 },
      advert: { price_lovelace: "2000000" }, escrowUtxo: { lovelace: "6000000" } });
    expect(job).toMatchObject({ state: "recovering", supplier_job_id: "supplier-job", receipt_hash: f.receiptHash });
    expect(f.store.paper2agent.call(job!.id)!.result_status).toBe("verified");
    await recoverOneShotJobs(f.deps);
    expect(f.store.getOneShotJob(job!.id)!.state).toBe("completed");
    expect(f.store.paper2agent.call(job!.id)).toMatchObject({ result_status: "verified", financial_status: "accepted" });
    expect(execute).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(f.chain.submissions).toHaveLength(1);
  });

  it("reads an unseen signed result read-only from the Post snapshot and settles without another execution", async () => {
    const f = await fixture("Submitted", "missing", { posted: true });
    const execute = vi.spyOn(Paper2AgentClient.prototype, "execute");
    const recover = vi.spyOn(Paper2AgentClient.prototype, "recover").mockImplementation(async (_posted, options) => {
      await options!.onJobAccepted!("supplier-job");
      await options!.onReceiptVerified!(f.paid);
      return f.paid;
    });
    await recoverOneShotJobs(f.deps);
    const [posted, options] = recover.mock.calls[0]!;
    // Exact bigint amounts and the decoded original datum return from storage.
    expect(posted).toMatchObject({ escrowRef: f.posted.escrowRef, advert: { price_lovelace: 2_000_000n },
      escrowUtxo: { lovelace: 6_000_000n }, escrowDatum: f.original });
    expect(options?.jobId).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(f.store.getOneShotJob("job")).toMatchObject({ state: "completed", supplier_job_id: "supplier-job", receipt_hash: f.receiptHash });
    expect(f.store.paper2agent.call("job")).toMatchObject({ result_status: "verified", financial_status: "accepted", error: null });
    expect(f.chain.submissions).toHaveLength(1);
  });

  it("frees the supplier lease after an expired Accept once another spend ends the lineage", async () => {
    const f = await fixture();
    f.chain.loseConfirmation = true;
    await recoverOneShotJobs(f.deps);
    const accept = f.store.paper2agent.transactions("job").find((tx) => tx.phase === "accept")!;
    expect(f.store.putPendingWalletTransaction({ key_id: f.key.id, tx_hash: accept.tx_hash, tx_cbor: accept.tx_cbor,
      created_at: 1, valid_until_slot: null })).toBe(true);
    expect(f.store.resolvePendingWalletTransaction(f.key.id, accept.tx_hash, "expired")).toBe(true);
    f.chain.loseConfirmation = false;
    await recoverOneShotJobs(f.deps);
    // The escrow can still settle, so the expired label alone keeps the job.
    expect(f.store.getOneShotJob("job")!.state).toBe("recovering");
    f.lineage!.rows.at(-1)!.spent_tx = "88".repeat(32);
    f.lineage!.terminal = { type: "ReleaseEscrow", tx_hash: "88".repeat(32) };
    await recoverOneShotJobs(f.deps);
    expect(f.store.getOneShotJob("job")).toMatchObject({ state: "failed", settle_tx_hash: "88".repeat(32) });
    expect(f.store.paper2agent.call("job")).toMatchObject({ financial_status: "unknown", actual_cost_lovelace: null, accounted: 0 });
    expect(f.store.paper2agent.approval(f.key.id)!.reserved_lovelace).toBe("30000000");
    expect(f.chain.submissions).toHaveLength(1);
  });

  it.each([["rejected", "failed"], ["expired", "funding"]] as const)("after the %s first Post the job is %s and its unknown cost stays reserved", async (outcome, state) => {
    const f = await fixture("Open", "missing");
    f.lineage = null;
    expect(f.store.putPendingWalletTransaction({ key_id: f.key.id, tx_hash: f.postHash, tx_cbor: f.cbor,
      created_at: 1, valid_until_slot: 100 })).toBe(true);
    expect(f.store.resolvePendingWalletTransaction(f.key.id, f.postHash, outcome)).toBe(true);
    await recoverOneShotJobs(f.deps);
    // Only a definitive rejection proves that no escrow exists to occupy the supplier.
    expect(f.store.getOneShotJob("job")!.state).toBe(state);
    expect(f.store.paper2agent.call("job")).toMatchObject({ financial_status: "unknown", actual_cost_lovelace: null, accounted: 0 });
    expect(f.store.paper2agent.approval(f.key.id)!.reserved_lovelace).toBe("30000000");
    expect(f.chain.submissions).toEqual([]);
  });
});
