import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { EventEmitter, once } from "node:events";
import { bech32 } from "bech32";
import {
  Paper2AgentClient, type Paper2AgentResult,
} from "../../buyer/src/sdk/paper2agent.js";
import {
  PAPER2AGENT_CAPABILITY_ID, MAX_TOOL_MANIFEST_BYTES, MAX_TOOL_OUTPUT_BYTES,
  paper2AgentManifestHash, paper2AgentModel, paper2AgentRequestHash, paper2AgentResultHash,
  paper2AgentSupplierPkh, type Paper2AgentManifest,
} from "../../packages/shared/src/paper2agent/index.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum, decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { buildClaimTx, buildSubmitTx, loadBlueprint, type WalletKey } from "../../packages/shared/src/tx/index.js";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import { signReceipt, receiptResultHash } from "../../packages/shared/src/receipt/sign.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

const ADVERT_REF = { txHash: "b".repeat(64), index: 0 };
const blueprint = loadBlueprint();
const buyer = buildBuyerWalletKey();
// Derive the public key and Blake2b-224 PKH independently of the SDK verifier.
const seed = "35".repeat(32);
const privateKey = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed}`, "hex"), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
const pkh = Buffer.from(blake2b(publicKey, { dkLen: 28 })).toString("hex");
const supplier: WalletKey = {
  privateKeyHex: seed, pubKeyHex: publicKey.toString("hex"), pubKeyHash: pkh,
  address: bech32.encode("addr_test", bech32.toWords(Buffer.concat([Buffer.from([0x60]), Buffer.from(pkh, "hex")])), 1023),
};
function refString(ref: OutputReference): string { return `${ref.txHash}#${ref.index}`; }
function ref(value: string): OutputReference {
  const [txHash, index] = value.split("#");
  return { txHash: txHash!, index: Number(index) };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function lineageRow(utxo: Utxo, spentTx: string | null): Record<string, unknown> {
  const datum = decodeEscrowDatum(utxo.datumHex!);
  return {
    ...datum, advert_ref: refString(datum.advert_ref), utxo_ref: refString(utxo.ref),
    payment_lovelace: datum.payment_lovelace.toString(), buyer_bond_lovelace: datum.buyer_bond_lovelace.toString(),
    supplier_bond_lovelace: datum.supplier_bond_lovelace.toString(), created_slot: 1, spent_tx: spentTx,
  };
}

function fixture() {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor(Date.now() / 1000));
  const tool: Paper2AgentManifest = {
    schema_version: 1, name: "reviewed_tool", description: "A configured JSON tool.", package_sha256: "c".repeat(64),
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    limits: { max_input_bytes: 4096, max_output_bytes: 4096, max_runtime_ms: 10_000 },
  };
  const manifestHash = paper2AgentManifestHash(tool);
  const advert: AdvertDatum = {
    supplier_pkh: supplier.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID, model: paper2AgentModel(tool),
    max_output_tokens: 0, max_processing_ms: 120_000, price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.test", detail_uri: "https://supplier.test/capability", detail_hash: "a".repeat(64),
    advertised_at: Date.now(), status: "Active",
  };
  const advertUtxo: Utxo = {
    ref: ADVERT_REF, address: blueprint.advertScriptAddress(0), lovelace: 2_000_000n, assets: {},
    datumHex: encodeAdvertDatum(advert), scriptRef: null,
  };
  chain.seed(advertUtxo);
  const metadata: Record<string, unknown> = {
    advert_ref: refString(ADVERT_REF), supplier_pkh: supplier.pubKeyHash, pub_key_hex: supplier.pubKeyHex,
    capability_id: advert.capability_id, model: advert.model, max_output_tokens: 0,
    max_processing_ms: advert.max_processing_ms, price_lovelace: advert.price_lovelace.toString(),
    paper2agent: { manifest: tool, manifest_hash: manifestHash },
  };
  let success: Paper2AgentResult;
  let lineage: Record<string, unknown>;
  const hooks: {
    capability?: () => Response | Promise<Response>;
    suppliers?: () => Response;
    admission?: () => Response;
    accepted?: (body: Record<string, unknown>) => Response | Promise<Response>;
    result?: (body: Paper2AgentResult) => Response | Promise<Response>;
    lineage?: (body: Record<string, unknown>) => Response;
    call?: (body: { manifest_hash: string; input: { text: string } }, init: RequestInit) => Response | Promise<Response>;
  } = {};
  const indexerRow = {
    utxo_ref: refString(ADVERT_REF), advert_status: "Active", status: "free", capability_id: PAPER2AGENT_CAPABILITY_ID,
    // These hints must never override the chain's endpoint or signing identity.
    endpoint_url: "https://attacker.test", supplier_pkh: "f".repeat(56), model: advert.model,
  };
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(url);
    if (path.includes("/suppliers?")) return hooks.suppliers?.() ?? json([indexerRow]);
    if (path.endsWith("/capability")) return hooks.capability?.() ?? json(metadata);
    if (path.endsWith("/lineage")) return hooks.lineage?.(lineage) ?? json(lineage);
    if (path.endsWith("/lookup")) {
      const body = JSON.parse(String(init?.body));
      const escrow = new Headers(init?.headers).get("X-Escrow-Ref");
      if (!success || success.escrow_ref !== escrow || body.manifest_hash !== manifestHash ||
          paper2AgentRequestHash(body.manifest_hash, body.input) !== success.receipt.prompt_hash) return json({ error: "not_found" }, 404);
      return json({ job_id: "job_1", escrow_ref: escrow, manifest_hash: manifestHash, status: "done" });
    }
    if (path.endsWith("/v1/paper2agent/call")) {
      const body = JSON.parse(String(init!.body)) as { manifest_hash: string; input: { text: string } };
      return hooks.call?.(body, init!) ?? json({ manifest_hash: body.manifest_hash, result: { value: body.input.text }, wallclock_ms: 3 });
    }
    if (init?.method === "POST") {
      if (hooks.admission) return hooks.admission();
      const escrowRef = new Headers(init.headers).get("X-Escrow-Ref")!;
      const originalRef = ref(escrowRef);
      const original = (await chain.queryUtxo(originalRef))!;
      const body = JSON.parse(String(init.body)) as { manifest_hash: string; input: { text: string } };
      const result = { value: body.input.text };
      const receipt = buildReceipt({
        prompt_hash: paper2AgentRequestHash(body.manifest_hash, body.input),
        response_hash: paper2AgentResultHash(body.manifest_hash, paper2AgentRequestHash(body.manifest_hash, body.input), result),
        model: advert.model, prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 10,
        supplier_pkh: supplier.pubKeyHash, escrow_ref: escrowRef,
      });
      const signed = signReceipt(receipt, supplier.privateKeyHex);
      const claimedTx = await buildClaimTx({ chain, supplierKey: supplier, escrowRef: originalRef });
      const claimedRef = { txHash: claimedTx.expectedTxHash, index: 0 };
      const claimed = (await chain.queryUtxo(claimedRef))!;
      const submittedTx = await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: claimedRef, receiptHash: receiptResultHash(signed) });
      const submittedRef = { txHash: submittedTx.expectedTxHash, index: 0 };
      const submitted = (await chain.queryUtxo(submittedRef))!;
      success = {
        manifest_hash: manifestHash, result, receipt, receipt_signature: signed.signature,
        pub_key_hex: supplier.pubKeyHex, escrow_ref: escrowRef, submitted_ref: refString(submittedRef),
      };
      lineage = {
        original_ref: escrowRef, terminal: null,
        rows: [lineageRow(original, claimedTx.expectedTxHash), lineageRow(claimed, submittedTx.expectedTxHash), lineageRow(submitted, null)],
      };
      const accepted = { status: "accepted", job_id: "job_1", escrow_ref: escrowRef };
      return hooks.accepted?.(accepted) ?? json(accepted, 202);
    }
    if (path.endsWith("/run/job_1")) return hooks.result?.(success) ?? json(success);
    throw new Error(`unexpected URL: ${path}`);
  });
  const client = new Paper2AgentClient({ chain, walletKey: buyer, indexerUrl: "https://indexer.test", fetchFn });
  const prepare = (input: unknown = { text: "hello" }) => client.prepare({
    advertRef: ADVERT_REF, manifestHash, input, expectedSupplierPkh: supplier.pubKeyHash, maxPriceLovelace: advert.price_lovelace,
  });
  return { chain, client, fetchFn, prepare, hooks, metadata, tool, advert, advertUtxo, manifestHash, indexerRow };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Paper2Agent Node buyer", () => {
  it("discovers on-chain tool identity, then verifies real signatures and the complete paid lineage", async () => {
    const f = fixture();
    expect(paper2AgentSupplierPkh(supplier.pubKeyHex)).toBe(pkh);
    const [offer] = await f.client.discover();
    expect(offer).toMatchObject({ endpointUrl: "https://supplier.test", manifestHash: f.manifestHash, supplierPublicKeyHex: supplier.pubKeyHex });
    const prepared = await f.prepare({ text: "e\u0301" });
    expect(prepared.input).toEqual({ text: "é" });
    const posted = await f.client.post(prepared);
    expect(posted.escrowDatum.prompt_hash).toBe(prepared.requestHash);
    const accepted = vi.fn(async (jobId: string) => { expect(jobId).toBe("job_1"); });
    const result = await f.client.execute(posted, { onJobAccepted: accepted });
    expect(accepted).toHaveBeenCalledOnce();
    expect(result.result).toEqual({ value: "é" });
    expect(result.receipt.prompt_tokens).toBe(0);
    expect(result.receipt.completion_tokens).toBe(0);
    const paid = f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(paid).toHaveLength(1);
    const init = paid[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ manifest_hash: f.manifestHash, input: { text: "é" } });
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(new Headers(init.headers).has("x-api-key")).toBe(false);
    expect(JSON.stringify(paid)).not.toContain(buyer.privateKeyHex);
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
  });

  it.each(["manifest", "key", "price", "supplier"])("rejects changed %s metadata before any payment", async (field) => {
    const f = fixture();
    const submit = vi.spyOn(f.chain, "submitTx");
    if (field === "manifest") f.metadata.paper2agent = { manifest: f.tool, manifest_hash: "d".repeat(64) };
    if (field === "key") f.metadata.pub_key_hex = buyer.pubKeyHex;
    if (field === "price") f.metadata.price_lovelace = "1";
    if (field === "supplier") f.metadata.supplier_pkh = buyer.pubKeyHash;
    await expect(f.prepare()).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a changed package or schema even when the supplier updates its manifest hash", async () => {
    const f = fixture();
    const changed = { ...f.tool, package_sha256: "e".repeat(64) };
    f.metadata.paper2agent = { manifest: changed, manifest_hash: paper2AgentManifestHash(changed) };
    await expect(f.prepare()).rejects.toThrow(/does not match/);
  });

  it("requires explicit supplier and price limits before spending", async () => {
    const f = fixture();
    await expect(f.client.prepare({ advertRef: ADVERT_REF, manifestHash: f.manifestHash, input: { text: "x" },
      expectedSupplierPkh: supplier.pubKeyHash, maxPriceLovelace: 1n })).rejects.toThrow(/price limit/);
    await expect(f.client.prepare({ advertRef: ADVERT_REF, manifestHash: f.manifestHash, input: { text: "x" },
      expectedSupplierPkh: buyer.pubKeyHash, maxPriceLovelace: 3_000_000n })).rejects.toThrow(/supplier/);
  });

  it("rejects advert datums outside the actual advert validator", async () => {
    const f = fixture();
    f.chain.seed({ ...f.advertUtxo, address: buyer.address });
    await expect(f.prepare()).rejects.toThrow(/advert script UTxO/);
  });

  it("revalidates metadata and commitments between prepare and post", async () => {
    const f = fixture();
    const prepared = await f.prepare();
    f.metadata.pub_key_hex = buyer.pubKeyHex;
    const submit = vi.spyOn(f.chain, "submitTx");
    await expect(f.client.post(prepared)).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["requestHash", "input", "manifest"])("rejects a changed prepared %s before payment", async (field) => {
    const f = fixture();
    const prepared = await f.prepare();
    if (field === "requestHash") prepared.requestHash = "f".repeat(64);
    if (field === "input") prepared.input.text = "tampered";
    if (field === "manifest") prepared.manifest.package_sha256 = "f".repeat(64);
    const submit = vi.spyOn(f.chain, "submitTx");
    await expect(f.client.post(prepared)).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });

  it("awaits the journal hook before broadcast and blocks broadcast if it rejects", async () => {
    const f = fixture();
    const prepared = await f.prepare();
    const submit = vi.spyOn(f.chain, "submitTx");
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const hook = vi.fn(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
    const posting = f.client.post(prepared, hook);
    await enteredPromise;
    expect(submit).not.toHaveBeenCalled();
    release();
    await posting;
    expect(submit).toHaveBeenCalledOnce();
    submit.mockClear();
    await expect(f.client.post(prepared, async () => { throw new Error("journal failed"); })).rejects.toThrow("journal failed");
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not return Posted or call the supplier when confirmation fails", async () => {
    const f = fixture();
    vi.spyOn(f.chain, "awaitTx").mockRejectedValue(new Error("confirmation failed"));
    const submit = vi.spyOn(f.chain, "submitTx");
    await expect(f.client.post(await f.prepare())).rejects.toThrow("confirmation failed");
    expect(submit).toHaveBeenCalledOnce();
    expect(f.fetchFn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("requires the confirmed Open datum rather than falling back to local timestamps", async () => {
    const f = fixture();
    const query = f.chain.queryUtxo.bind(f.chain);
    vi.spyOn(f.chain, "queryUtxo").mockImplementation(async (ref) => refString(ref) === refString(ADVERT_REF) ? query(ref) : null);
    await expect(f.client.post(await f.prepare())).rejects.toThrow(/escrow script UTxO/);
  });

  it.each(["signature", "publicKey", "requestHash", "resultHash", "escrow", "manifest", "model", "tokens"])("rejects result %s tampering with no paid retry", async (field) => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    f.hooks.result = (body) => {
      const changed = structuredClone(body);
      if (field === "signature") changed.receipt_signature = signReceipt(changed.receipt, "46".repeat(32)).signature;
      if (field === "publicKey") changed.pub_key_hex = buyer.pubKeyHex;
      if (field === "requestHash") changed.receipt.prompt_hash = "f".repeat(64);
      if (field === "resultHash") changed.result.value = "uncommitted";
      if (field === "escrow") changed.escrow_ref = `${"d".repeat(64)}#0`;
      if (field === "manifest") changed.manifest_hash = "f".repeat(64);
      if (field === "model") changed.receipt.model = "different";
      if (field === "tokens") changed.receipt.completion_tokens = 1;
      return json(changed);
    };
    const saved = vi.fn();
    await expect(f.client.execute(posted, { onReceiptVerified: saved })).rejects.toThrow();
    expect(saved).not.toHaveBeenCalled();
    expect(f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["buyer_pkh", "supplier_pkh", "prompt_hash", "request_spec_hash", "payment_lovelace", "buyer_bond_lovelace", "supplier_bond_lovelace", "posted_at", "deliver_by", "advert_ref", "result_receipt_hash", "state"])("rejects Submitted datum substitution in %s", async (field) => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    f.hooks.result = async (body) => {
      const utxo = (await f.chain.queryUtxo(ref(body.submitted_ref)))!;
      const datum = decodeEscrowDatum(utxo.datumHex!);
      const changed = { ...datum };
      if (field === "buyer_pkh" || field === "supplier_pkh") changed[field] = "a".repeat(56);
      else if (field === "prompt_hash" || field === "request_spec_hash" || field === "result_receipt_hash") changed[field] = "a".repeat(64);
      else if (field === "payment_lovelace" || field === "buyer_bond_lovelace" || field === "supplier_bond_lovelace") changed[field] += 1n;
      else if (field === "posted_at" || field === "deliver_by") changed[field] += 1;
      else if (field === "advert_ref") changed.advert_ref = { ...ADVERT_REF, index: 1 };
      else changed.state = "Claimed";
      f.chain.seed({ ...utxo, datumHex: encodeEscrowDatum(changed) });
      return json(body);
    };
    await expect(f.client.execute(posted)).rejects.toThrow("submitted_escrow_mismatch");
  });

  it("rejects a copied Submitted datum at an unrelated output even with the valid receipt", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    f.hooks.result = async (body) => {
      const utxo = (await f.chain.queryUtxo(ref(body.submitted_ref)))!;
      const unrelated = { txHash: "f".repeat(64), index: 0 };
      f.chain.seed({ ...utxo, ref: unrelated });
      return json({ ...body, submitted_ref: refString(unrelated) });
    };
    await expect(f.client.execute(posted)).rejects.toThrow("escrow_lineage_mismatch");
  });

  it("rejects broken spend links despite matching immutable fields", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    f.hooks.lineage = (body) => {
      const changed = structuredClone(body);
      if (!Array.isArray(changed.rows)) throw new Error("missing fixture rows");
      changed.rows[0].spent_tx = "e".repeat(64);
      return json(changed);
    };
    await expect(f.client.execute(posted)).rejects.toThrow("escrow_lineage_mismatch");
  });

  it("polls the same lineage through indexer lag without repeating paid admission", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    let queries = 0;
    f.hooks.lineage = (body) => {
      if (!Array.isArray(body.rows)) throw new Error("missing fixture rows");
      return ++queries === 1 ? json({ ...body, rows: body.rows.slice(0, 1) }) : json(body);
    };
    const result = await f.client.execute(posted);
    expect(result.result).toEqual({ value: "hello" });
    expect(queries).toBe(2);
    expect(f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not retry an ambiguous supplier POST", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    f.hooks.admission = () => { throw new Error("connection lost after admission"); };
    await expect(f.client.execute(posted)).rejects.toThrow("connection lost");
    expect(f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("bounds perpetual pending-job polling without another admission", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    vi.useFakeTimers();
    f.hooks.result = (body) => json({ status: "running", escrow_ref: body.escrow_ref }, 202);
    const rejection = expect(f.client.execute(posted)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(480_001);
    await rejection;
    expect(f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rechecks the live Submitted output after indexer reads", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    let submittedUtxo: Utxo | undefined;
    f.hooks.result = async (body) => {
      submittedUtxo = (await f.chain.queryUtxo(ref(body.submitted_ref)))!;
      return json(body);
    };
    f.hooks.lineage = (body) => {
      if (!submittedUtxo) throw new Error("missing fixture output");
      f.chain.seed({ ...submittedUtxo, lovelace: submittedUtxo.lovelace + 1n });
      return json(body);
    };
    await expect(f.client.execute(posted)).rejects.toThrow("submitted_escrow_mismatch");
  });

  it("blocks polling when the accepted-job journal hook fails", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    await expect(f.client.execute(posted, { onJobAccepted: async () => { throw new Error("job journal failed"); } })).rejects.toThrow("job journal failed");
    expect(f.fetchFn.mock.calls.some(([url]) => String(url).endsWith("/run/job_1"))).toBe(false);
  });

  it("rejects oversized streamed metadata without trusting content-length", async () => {
    const f = fixture();
    const cancel = vi.fn();
    f.hooks.capability = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_TOOL_MANIFEST_BYTES + 8193)); }, cancel,
    }), { headers: { "content-length": "2" } });
    await expect(f.prepare()).rejects.toThrow(/byte limit/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects oversized result envelopes after payment without retrying execution", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    f.hooks.result = () => json({ ignored: "x".repeat(MAX_TOOL_OUTPUT_BYTES + 16_384) });
    await expect(f.client.execute(posted)).rejects.toThrow(/byte limit/);
    expect(f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("keeps the timeout active while reading an unfinished response body", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const cancelled = vi.fn();
    f.hooks.capability = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel: cancelled }));
    const request = f.prepare();
    const rejection = expect(request).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(15_001);
    await rejection;
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("does not count non-tool adverts against tool discovery", async () => {
    const f = fixture();
    f.hooks.suppliers = () => json([
      ...Array.from({ length: 129 }, (_, index) => ({ ...f.indexerRow, capability_id: "text-generation", utxo_ref: `${index.toString(16).padStart(64, "0")}#0` })),
      f.indexerRow,
    ]);
    const offers = await f.client.discover();
    expect(offers.map((offer) => offer.manifestHash)).toEqual([f.manifestHash]);
  });

  it("keeps a healthy tool when preceding metadata endpoints stall", async () => {
    const f = fixture();
    const stalled = Array.from({ length: 4 }, (_, index) => {
      const ref = { txHash: (index + 1).toString(16).padStart(64, "0"), index: 0 };
      f.chain.seed({ ...f.advertUtxo, ref, datumHex: encodeAdvertDatum({ ...f.advert, endpoint_url: `https://stalled-${index}.test` }) });
      return { ...f.indexerRow, utxo_ref: refString(ref) };
    });
    f.hooks.suppliers = () => json([...stalled, f.indexerRow]);
    const fetch = f.fetchFn.getMockImplementation()!;
    f.fetchFn.mockImplementation(async (url, init) => {
      if (!String(url).includes("stalled-")) return fetch(url, init);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      } }));
    });
    vi.useFakeTimers();
    const discovery = f.client.discover();
    await vi.advanceTimersByTimeAsync(3001);
    expect((await discovery).map((offer) => offer.manifestHash)).toEqual([f.manifestHash]);
  });

  it("finds a pinned offer without probing unrelated tool adverts", async () => {
    const f = fixture();
    f.indexerRow.supplier_pkh = supplier.pubKeyHash;
    f.hooks.suppliers = () => json([
      ...Array.from({ length: 129 }, (_, index) => ({
        ...f.indexerRow, supplier_pkh: "f".repeat(56), utxo_ref: `${index.toString(16).padStart(64, "0")}#0`,
      })),
      f.indexerRow,
    ]);
    const offers = await f.client.discover({ manifestHash: f.manifestHash, supplierPkh: supplier.pubKeyHash });
    expect(offers.map((offer) => offer.advert.supplier_pkh)).toEqual([supplier.pubKeyHash]);
    expect(f.fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/capability"))).toHaveLength(1);
  });

  it("waits for slow admission confirmation instead of losing the job after fifteen seconds", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    const confirmation = new EventEmitter();
    f.hooks.accepted = async (body) => {
      await once(confirmation, "confirmed");
      return json(body, 202);
    };
    vi.useFakeTimers();
    const execution = expect(f.client.execute(posted)).resolves.toMatchObject({ result: { value: "hello" } });
    await vi.advanceTimersByTimeAsync(20_001);
    confirmation.emit("confirmed");
    await execution;
    expect(f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("retries failed read-only polls but never repeats paid admission", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    let reads = 0;
    f.hooks.result = (body) => {
      if (++reads === 1) throw new TypeError("connection reset");
      if (reads === 2) return new Response("<html>unavailable</html>", { status: 503 });
      if (reads === 3) return new Response(null, { status: 503 });
      return json(body);
    };
    vi.useFakeTimers();
    const execution = expect(f.client.execute(posted)).resolves.toMatchObject({ result: { value: "hello" } });
    await vi.advanceTimersByTimeAsync(3001);
    await execution;
    expect(reads).toBe(4);
    expect(f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("saves signed evidence from a failed confirmation before waiting for buyer node visibility", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    let submitted: string | undefined;
    let missing = 2;
    const events: string[] = [];
    const query = f.chain.queryUtxo.bind(f.chain);
    vi.spyOn(f.chain, "queryUtxo").mockImplementation(async (ref) => {
      if (refString(ref) === submitted && missing-- > 0) {
        events.push("not_visible");
        return null;
      }
      return query(ref);
    });
    f.hooks.result = (body) => {
      submitted = body.submitted_ref;
      return json({ ...body, status: "failed", error: "Submit confirmation timed out" }, 502);
    };
    let saved: Paper2AgentResult | undefined;
    vi.useFakeTimers();
    const execution = f.client.execute(posted, { onReceiptVerified: async (result) => {
      saved = result;
      events.push("verified");
    } });
    await vi.advanceTimersByTimeAsync(2001);
    expect((await execution).result).toEqual({ value: "hello" });
    expect(saved?.receipt.prompt_hash).toBe(posted.requestHash);
    expect(events).toEqual(["verified", "not_visible", "not_visible"]);
  });

  it("recovers a lost admission response after the original output is spent and its deadline passes", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    f.hooks.accepted = () => { throw new TypeError("admission response lost"); };
    await expect(f.client.execute(posted)).rejects.toThrow("admission response lost");
    expect(await f.chain.queryUtxo(posted.escrowRef)).toBeNull();
    vi.useFakeTimers({ now: posted.deliverBy + 1 });
    const recovered = await f.client.recover(posted);
    expect(recovered.result).toEqual({ value: "hello" });
    expect(recovered.escrow_ref).toBe(refString(posted.escrowRef));
    expect(f.fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/v1/paper2agent/run"))).toHaveLength(1);
    expect(f.fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/lookup"))).toHaveLength(1);
  });

  it("recovers the known job after a receipt journal interrupts execution", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    let signed: Paper2AgentResult | undefined;
    await expect(f.client.execute(posted, { onReceiptVerified: async (result) => {
      signed = result;
      throw new Error("process stops after saving evidence");
    } })).rejects.toThrow("process stops");
    const recovered = await f.client.recover(posted, { jobId: "job_1" });
    expect(recovered.receipt_signature).toBe(signed?.receipt_signature);
    expect(recovered.result).toEqual({ value: "hello" });
    expect(f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rejects a substituted recovery snapshot without contacting the supplier", async () => {
    const f = fixture();
    const posted = await f.client.post(await f.prepare());
    posted.escrowUtxo = { ...posted.escrowUtxo, datumHex: encodeEscrowDatum({ ...posted.escrowDatum, buyer_pkh: supplier.pubKeyHash }) };
    f.fetchFn.mockClear();
    await expect(f.client.recover(posted)).rejects.toThrow("snapshot is invalid");
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
});

describe("Paper2Agent free calls and walletless discovery", () => {
  const TOKEN = "k".repeat(40);

  it("discovers and calls a tool without a wallet, an escrow, or a receipt", async () => {
    const f = fixture();
    const submit = vi.spyOn(f.chain, "submitTx");
    const client = new Paper2AgentClient({ chain: f.chain, indexerUrl: "https://indexer.test", fetchFn: f.fetchFn });
    const [offer] = await client.discover();
    expect(offer).toMatchObject({ endpointUrl: "https://supplier.test", manifestHash: f.manifestHash });
    const called = await client.call(offer!, { text: "e\u0301" }, { token: TOKEN });
    expect(called).toEqual({ manifest_hash: f.manifestHash, result: { value: "é" }, wallclock_ms: 3 });
    const posts = f.fetchFn.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0]!;
    expect(String(url)).toBe("https://supplier.test/v1/paper2agent/call");
    const headers = new Headers(init!.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.has("x-escrow-ref")).toBe(false);
    expect(JSON.parse(String(init!.body))).toEqual({ manifest_hash: f.manifestHash, input: { text: "é" } });
    expect(init!.redirect).toBe("error");
    expect(init!.credentials).toBe("omit");
    expect(submit).not.toHaveBeenCalled();
    // Paid stages still need the wallet.
    await expect(client.prepare({ advertRef: ADVERT_REF, manifestHash: f.manifestHash, input: { text: "x" },
      expectedSupplierPkh: supplier.pubKeyHash, maxPriceLovelace: f.advert.price_lovelace })).rejects.toThrow(/wallet key is required/);
  });

  it.each([
    ["free", 1, 1],
    ["working", 0, 1],
    ["unknown", 0, 1],
    ["offline", 0, 0],
  ])("lists a %s tool by default %i times and with includeBusy %i times", async (status, byDefault, withBusy) => {
    const f = fixture();
    f.indexerRow.status = status;
    expect(await f.client.discover()).toHaveLength(byDefault);
    expect(await f.client.discover({ includeBusy: true })).toHaveLength(withBusy);
  });

  it("checks the token and input before any request", async () => {
    const f = fixture();
    const [offer] = await f.client.discover();
    f.fetchFn.mockClear();
    await expect(f.client.call(offer!, { text: "x" }, { token: "short" })).rejects.toThrow(/at least 32 characters/);
    await expect(f.client.call(offer!, { text: 1 }, { token: TOKEN })).rejects.toThrow();
    await expect(f.client.call({ ...offer!, manifestHash: "d".repeat(64) }, { text: "x" }, { token: TOKEN })).rejects.toThrow(/does not match its hash/);
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it.each<[string, (hash: string) => Response, Record<string, unknown>]>([
    ["a route error", () => json({ reason: "supplier_busy", message: "supplier_busy" }, 409), { reason: "supplier_busy", status: 409 }],
    ["an unknown error body", () => json({ reason: "Not A Code" }, 400), { reason: "call_failed", status: 400 }],
    ["an HTML proxy error", () => new Response("<html>bad gateway</html>", { status: 502 }), { reason: "call_failed", status: 502 }],
    ["output outside the schema", (hash) => json({ manifest_hash: hash, result: { value: 1 }, wallclock_ms: 1 }), { reason: "invalid_tool_output" }],
    ["another manifest", () => json({ manifest_hash: "d".repeat(64), result: { value: "x" }, wallclock_ms: 1 }), { reason: "malformed_response" }],
    ["a negative wallclock", (hash) => json({ manifest_hash: hash, result: { value: "x" }, wallclock_ms: -1 }), { reason: "malformed_response" }],
    ["a network failure", () => { throw new TypeError("fetch failed"); }, { reason: "unreachable" }],
  ])("reports %s as a SupplierError without a retry", async (_label, respond, expected) => {
    const f = fixture();
    const [offer] = await f.client.discover();
    f.hooks.call = (body) => respond(body.manifest_hash);
    await expect(f.client.call(offer!, { text: "x" }, { token: TOKEN })).rejects.toMatchObject({ name: "SupplierError", ...expected });
    expect(f.fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/v1/paper2agent/call"))).toHaveLength(1);
  });

  it("bounds a stalled call by the tool runtime plus the call overhead", async () => {
    const f = fixture();
    const [offer] = await f.client.discover();
    vi.useFakeTimers();
    f.hooks.call = (_body, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const pending = expect(f.client.call(offer!, { text: "x" }, { token: TOKEN })).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(f.tool.limits.max_runtime_ms + 60_000);
    await pending;
  });
});
