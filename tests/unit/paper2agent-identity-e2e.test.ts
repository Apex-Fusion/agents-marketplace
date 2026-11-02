/**
 * paper2agent-identity-e2e.test.ts — one paid Paper2Agent tool call on a new
 * advert, from the buyer SDK to the supplier runtime and back (Part 2 §6.1,
 * §6.2, §6.3, §6.5, §9.6).
 *
 * - Buyer: Paper2AgentClient (buyer/src/sdk/paper2agent.ts) with the test
 *   identity blueprint, network 1 and a switch slot in the past.
 * - Supplier: Paper2AgentRuntime and the supplier HTTP app (createApp) on
 *   127.0.0.1. A stand-in tool session replaces the tool process.
 * - Chain: one fake Ogmios for both sides. It keeps a ledger: a submitted
 *   transaction spends its inputs and adds its outputs under its ID. When a
 *   builder evaluates a draft, the fake runs the committed escrow script with
 *   `aiken tx simulate` (tests/identity-builders/evaluate.ts).
 * - Indexer: a fake. GET /suppliers lists the advert with its agent_id, and
 *   GET /escrows/:ref/lineage reads the escrow history from the ledger.
 *
 * Needs `aiken` v1.1.21 on PATH. Nothing goes to a network. Every key comes
 * from a public label and controls nothing on any network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CML } from "@lucid-evolution/lucid";
import { Paper2AgentClient, type PreparedPaper2Agent } from "../../buyer/src/sdk/paper2agent.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { plutusAddressFromBech32 } from "../../packages/shared/src/cbor/address.js";
import type { IdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import {
  decodeIdentityEscrowDatum, encodeIdentityEscrowDatum, type IdentityEscrowDatum,
} from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { utf8ToHex, vectorIdFromSeed } from "../../packages/shared/src/identity/id.js";
import { transactionId } from "../../packages/shared/src/identity/tx/witness.js";
import {
  PAPER2AGENT_CAPABILITY_ID, PAPER2AGENT_SUPPLIER_OVERHEAD_MS, paper2AgentManifestHash, paper2AgentModel,
  parsePaper2AgentManifest, verifyPaper2AgentReceipt,
} from "../../packages/shared/src/paper2agent/index.js";
import {
  AGENT_RECEIPT_FIELDS, buildReceipt, receiptResultHash, signReceipt, verifyReceipt, type Receipt, type SignedReceipt,
} from "../../packages/shared/src/receipt/index.js";
import { buildAcceptTx } from "../../packages/shared/src/tx/index.js";
import { inspectSignedTransactionFinancials } from "../../packages/shared/src/tx/internal/signedTransaction.js";
import type { Paper2AgentConfig } from "../../supplier/src/config.js";
import { supplierIdentity } from "../../supplier/src/identity/agent.js";
import type { ToolSession } from "../../supplier/src/paper2agent/local.js";
import { Paper2AgentRuntime } from "../../supplier/src/paper2agent/runtime.js";
import { createApp } from "../../supplier/src/server.js";
import { SupplierState } from "../../supplier/src/state.js";
import { aikenVersion, describeSimulation, type Simulation } from "../legacy-registry/harness/index.js";
import { evaluateBuiltTx } from "../identity-builders/evaluate.js";
import { escrowView, listingRow, refText } from "../fixtures/buyer-side/identity-world.js";
import { testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";
import {
  advertUtxo, AGENT_ID, agentRecord, AP3X, FakeOgmios, outputOf, recordUtxo, testWallet, VECTOR_MAINNET_ZERO_TIME_MS,
} from "../fixtures/identity-builders/world.js";
import { buildSampleConfig } from "../fixtures/supplier-side/sample-config.js";

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0, 500);
const INDEXER_URL = "https://indexer.test";
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
/** The output reference of recordUtxo (the agent record at the identity address). */
const RECORD_REF = `${"7e".repeat(32)}#0`;
const OTHER_AGENT_ID = vectorIdFromSeed("b2".repeat(32), 1);
/** One purchase: lucid builds, aiken runs and the result polls of the buyer (1 s each). */
const TIMEOUT_MS = 60_000;

const buyer = testWallet("paper2agent e2e buyer");
const supplierKey = testWallet("paper2agent e2e supplier");
const controller = testWallet("paper2agent e2e controller");
const blueprint = testIdentityBlueprint();
const ESCROW_ADDRESS = blueprint.escrowScriptAddress(1);

const schema = {
  type: "object" as const, properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
};
const PACKAGE_BYTES = "reviewed local package";
const manifest = parsePaper2AgentManifest({
  schema_version: 1, name: "upper_case", description: "Test-only tool",
  package_sha256: createHash("sha256").update(PACKAGE_BYTES).digest("hex"), input_schema: schema, output_schema: schema,
  limits: { max_input_bytes: 4096, max_output_bytes: 4096, max_runtime_ms: 1000 },
});
const manifestHash = paper2AgentManifestHash(manifest);
const input = { value: "hello" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The validity interval [invalid_before, invalid_hereafter) in slots and the reference inputs of a transaction. */
function txFacts(tx: string): { from: bigint | undefined; until: bigint | undefined; referenceInputs: string[] } {
  const body = CML.Transaction.from_cbor_hex(tx).body();
  const references = body.reference_inputs();
  return {
    from: body.validity_interval_start(),
    until: body.ttl(),
    referenceInputs: references === undefined ? [] : Array.from({ length: references.len() }, (_, i) => {
      const reference = references.get(i);
      return `${reference.transaction_id().to_hex()}#${reference.index()}`;
    }),
  };
}

/**
 * FakeOgmios with a ledger. submitTransaction applies the transaction with
 * the ledger rules that these tests rely on:
 * - the current slot is in the validity interval: invalid_before <= slot <
 *   invalid_hereafter (cardano-ledger-allegra 1.10.2.1,
 *   Cardano.Ledger.Allegra.Scripts.inInterval,
 *   https://cardano-ledger.cardano.intersectmbo.org/cardano-ledger-allegra/Cardano-Ledger-Allegra-Scripts.html);
 * - every input is unspent.
 * The inputs are spent and the outputs added under the transaction ID. The
 * reply has the shape of Ogmios v6 submitTransaction (https://ogmios.dev/api/).
 */
class LedgerOgmios extends FakeOgmios {
  /** Every output that the ledger held, spent or not: resolved inputs for aiken, rows of the lineage. */
  readonly history = new Map<string, Utxo>();
  /** Spent output → ID of the transaction that spent it. */
  readonly spentBy = new Map<string, string>();
  /** Applied transactions (CBOR hex) by ID. */
  readonly transactions = new Map<string, string>();

  override add(...utxos: Utxo[]): void {
    super.add(...utxos);
    for (const utxo of utxos) this.history.set(refText(utxo.ref), utxo);
  }

  /** The FakeOgmios methods, except that submitTransaction applies the transaction. */
  private readonly ledgerFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as { method: string; params?: { transaction?: { cbor?: string } } };
    if (request.method !== "submitTransaction") return this.fetch(url, init);
    const id = this.applyTransaction(request.params?.transaction?.cbor ?? "");
    return json({ jsonrpc: "2.0", result: { transaction: { id } } });
  };

  override chain(): LiveOgmiosProvider {
    return new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios.invalid", fetch: this.ledgerFetch });
  }

  private applyTransaction(tx: string): string {
    const id = transactionId(tx);
    // The slot of queryNetwork/tip in FakeOgmios.
    const slot = BigInt(Math.floor((Date.now() - VECTOR_MAINNET_ZERO_TIME_MS) / 1000));
    const { from, until } = txFacts(tx);
    if ((from !== undefined && slot < from) || (until !== undefined && slot >= until)) {
      throw new Error(`ledger: transaction ${id} is not valid in slot ${slot} (interval [${from}, ${until}))`);
    }
    const { inputs, outputs } = inspectSignedTransactionFinancials(tx);
    const spends = inputs.map(refText);
    const unknown = spends.filter((ref) => !this.utxos.has(ref));
    if (unknown.length > 0) throw new Error(`ledger: transaction ${id} spends outputs that the ledger does not hold: ${unknown.join(", ")}`);
    for (const ref of spends) {
      this.utxos.delete(ref);
      this.spentBy.set(ref, id);
    }
    outputs.forEach((_, index) => this.add(outputOf(tx, id, index)));
    this.submitted.push(tx);
    this.transactions.set(id, tx);
    return id;
  }
}

/** GET /escrows/:ref/lineage of the indexer (W2-IDX). */
interface Lineage {
  original_ref: string;
  rows: Array<Record<string, unknown>>;
  terminal: null;
}

/**
 * The lineage of `originalRef`, read from the ledger. Each row is the escrow
 * output that the spend of the row before continued (Claim and Submit write
 * it as output 0). `terminal` stays null: the buyer reads the lineage before
 * any terminal spend.
 */
function lineageOf(ledger: LedgerOgmios, originalRef: string): Lineage | null {
  const rows: Array<Record<string, unknown>> = [];
  let ref: string | null = originalRef;
  while (ref !== null) {
    const utxo = ledger.history.get(ref);
    if (utxo === undefined || utxo.address !== ESCROW_ADDRESS || utxo.datumHex === null) break;
    const spentTx: string | null = ledger.spentBy.get(ref) ?? null;
    rows.push(escrowView(utxo, decodeIdentityEscrowDatum(utxo.datumHex), spentTx));
    ref = spentTx === null ? null : `${spentTx}#0`;
  }
  return rows.length === 0 ? null : { original_ref: originalRef, rows, terminal: null };
}

/** A tool session that returns the input value in upper case. */
function toolSession(): ToolSession {
  return {
    discover: async () => [{ name: manifest.name, inputSchema: schema, outputSchema: schema }],
    execute: async (_name, toolInput) => ({ value: String(toolInput.value).toUpperCase() }),
    close: async () => undefined,
  };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

interface World {
  ledger: LedgerOgmios;
  /** The buyer's own chain provider over the same ledger. */
  buyerChain: LiveOgmiosProvider;
  client: Paper2AgentClient;
  /** "METHOD path" of each buyer request to the supplier server. */
  supplierRequests: string[];
  /** Each lineage that the fake indexer sent. */
  lineages: Lineage[];
  /** Each aiken run of a draft that a builder sent to evaluateTransaction. */
  evaluations: Simulation[];
  /** Changes that the buyer receives instead: a done job of the supplier (HTTP 200), or a lineage of the indexer. */
  hooks: { result?: (body: Record<string, unknown>) => Record<string, unknown>; lineage?: (lineage: Lineage) => Lineage };
  prepare(): Promise<PreparedPaper2Agent>;
}

const cleanups: Array<() => unknown> = [];

/**
 * The ledger with the agent record, the funded wallets and the new advert;
 * the supplier server; and the buyer client.
 */
async function world(): Promise<World> {
  const ledger = new LedgerOgmios();
  const evaluations: Simulation[] = [];
  // As Ogmios evaluateTransaction: run the scripts of the draft, give the budgets or the failure.
  ledger.evaluate = (tx) => {
    const simulation = evaluateBuiltTx(tx, ledger.utxos.values(), "escrow");
    evaluations.push(simulation);
    if (!simulation.passed) return { code: 3010, message: describeSimulation(simulation) };
    return simulation.verdicts.map((verdict) => ({
      validator: { purpose: "spend" as const, index: Number(/\[(\d+)\]/.exec(verdict.purpose)![1]) },
      budget: { memory: verdict.mem!, cpu: verdict.cpu! },
    }));
  };
  for (const wallet of [buyer, supplierKey]) ledger.fund(wallet, 100n * AP3X, 6n * AP3X);
  // A record without a parent: the supplier key (authentication + transaction) and the Paper2Agent capability.
  ledger.add(recordUtxo(blueprint, agentRecord(controller, supplierKey, { capabilities: [utf8ToHex(PAPER2AGENT_CAPABILITY_ID)] })));

  const server = createServer();
  cleanups.push(() => closeServer(server));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const advert: IdentityAdvertDatum = {
    supplier_pkh: supplierKey.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID, model: paper2AgentModel(manifest),
    max_output_tokens: 0, max_processing_ms: manifest.limits.max_runtime_ms + PAPER2AGENT_SUPPLIER_OVERHEAD_MS,
    price_lovelace: 2n * AP3X, supplier_bond_lovelace: AP3X, buyer_bond_lovelace: AP3X,
    endpoint_url: endpoint, detail_uri: "", detail_hash: manifestHash, advertised_at: NOW_MS - 3_600_000, status: "Active",
    agent_id: AGENT_ID,
  };
  ledger.add(advertUtxo(blueprint, advert, ADVERT_REF));

  const directory = mkdtempSync(join(tmpdir(), "p2a-identity-e2e-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const config: Paper2AgentConfig = {
    executable: process.execPath, argv: [], cwd: directory, packagePath: join(directory, "package.bin"),
    manifestPath: join(directory, "manifest.json"), journalDir: join(directory, "journal"),
  };
  writeFileSync(config.packagePath, PACKAGE_BYTES);
  writeFileSync(config.manifestPath, JSON.stringify(manifest));
  const chain = ledger.chain();
  const state = new SupplierState();
  const identity = supplierIdentity(chain, 1, { blueprint });
  const runtime = await Paper2AgentRuntime.create({
    chain, state, supplierKey, networkId: 1, advertRef: ADVERT_REF, config, sessionFactory: toolSession, identity, agentId: AGENT_ID,
  });
  cleanups.push(() => runtime.close());
  server.on("request", createApp({
    chain, state, supplierKey, identity, paper2agent: runtime,
    config: {
      ...buildSampleConfig(), supplierPrivKeyHex: supplierKey.privateKeyHex, networkId: 1, liveChain: true,
      capabilityKind: "paper2agent", advertRef: ADVERT_REF, paper2agent: config, agentId: AGENT_ID,
    },
  }));

  const supplierRequests: string[] = [];
  const lineages: Lineage[] = [];
  const hooks: World["hooks"] = {};
  const indexer = (url: URL): Response => {
    if (url.pathname === "/suppliers") return json([listingRow(ADVERT_REF, advert, AGENT_ID)]);
    const match = /^\/escrows\/([^/]+)\/lineage$/.exec(url.pathname);
    const lineage = match === null ? null : lineageOf(ledger, decodeURIComponent(match[1]!));
    if (lineage === null) return json({ error: "escrow not found" }, 404);
    const sent = hooks.lineage?.(lineage) ?? lineage;
    lineages.push(sent);
    return json(sent);
  };
  // Supplier URLs go to the real server; indexer URLs to the fake.
  const fetchFn = async (target: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(target));
    if (url.origin === INDEXER_URL) return indexer(url);
    if (url.origin !== endpoint) throw new Error(`unexpected request ${url.href}`);
    supplierRequests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const response = await fetch(url, init);
    if (hooks.result === undefined || response.status !== 200 || !url.pathname.startsWith("/v1/paper2agent/run/")) return response;
    return json(hooks.result(await response.json() as Record<string, unknown>));
  };
  const buyerChain = ledger.chain();
  const client = new Paper2AgentClient({
    chain: buyerChain, walletKey: buyer, indexerUrl: INDEXER_URL, fetchFn, networkId: 1, identityBlueprint: blueprint,
    // After the switch (§9.6): Post must write a new escrow.
    switchSlot: 0,
  });
  const prepare = () => client.prepare({
    advertRef: ADVERT_REF, manifestHash, input, expectedSupplierPkh: supplierKey.pubKeyHash, maxPriceLovelace: advert.price_lovelace,
  });
  return { ledger, buyerChain, client, supplierRequests, lineages, evaluations, hooks, prepare };
}

/** The buyer's node reports each escrow output in `state` with another agent_id. The ledger does not change. */
function misreport(w: World, state: IdentityEscrowDatum["state"]): void {
  const query = w.buyerChain.queryUtxo.bind(w.buyerChain);
  vi.spyOn(w.buyerChain, "queryUtxo").mockImplementation(async (ref) => {
    const utxo = await query(ref);
    if (utxo === null || utxo.datumHex === null || utxo.address !== ESCROW_ADDRESS) return utxo;
    const datum = decodeIdentityEscrowDatum(utxo.datumHex);
    return datum.state !== state ? utxo : { ...utxo, datumHex: encodeIdentityEscrowDatum({ ...datum, agent_id: OTHER_AGENT_ID }) };
  });
}

const paidAdmissions = (w: World): string[] => w.supplierRequests.filter((request) => request === "POST /v1/paper2agent/run");

beforeAll(() => {
  expect(aikenVersion()).toMatch(/^aiken v1\.1\.21/);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("VECTOR_ZERO_TIME_MS", String(VECTOR_MAINNET_ZERO_TIME_MS));
  // Every caller gets the test blueprint as an option: no identity hash from the env, no reference scripts.
  for (const key of ["IDENTITY_POLICY_ID", "IDENTITY_ESCROW_REF_UTXO", "IDENTITY_ADVERT_REF_UTXO", "ESCROW_REF_UTXO", "ADVERT_REF_UTXO"]) {
    vi.stubEnv(key, "");
  }
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Paper2Agent purchase on a new advert, buyer SDK to supplier runtime", () => {
  it("posts, executes and accepts: 9-field receipt, lineage of the agent, escrow script passes Claim, Submit and Accept", async () => {
    const w = await world();
    const posted = await w.client.post(await w.prepare());
    expect(posted.escrowUtxo.address).toBe(ESCROW_ADDRESS);
    expect(posted.escrowDatum).toMatchObject({
      state: "Open", agent_id: AGENT_ID, refund: { address: plutusAddressFromBech32(buyer.address), datum: null },
    });

    const verified = vi.fn(async () => undefined);
    const result = await w.client.execute(posted, { onReceiptVerified: verified });
    expect(verified).toHaveBeenCalledOnce();
    expect(paidAdmissions(w)).toHaveLength(1);
    expect(result.result).toEqual({ value: "HELLO" });

    // §6.3: the 8 fields and agent_did = "did:vector:<agent_id>", signed by the listed supplier key.
    const escrowRef = refText(posted.escrowRef);
    expect(Object.keys(result.receipt).sort()).toEqual([...AGENT_RECEIPT_FIELDS].sort());
    expect(result.receipt).toMatchObject({ agent_did: `did:vector:${AGENT_ID}`, supplier_pkh: supplierKey.pubKeyHash, escrow_ref: escrowRef });
    verifyPaper2AgentReceipt({
      manifest, input, result: result.result, receipt: result.receipt, signature: result.receipt_signature,
      publicKeyHex: supplierKey.pubKeyHex, supplierPkh: supplierKey.pubKeyHash, escrowRef, agentId: AGENT_ID,
    });

    // The lineage that the buyer checked: Open, Claimed and Submitted, each in the new layout with the agent.
    const lineage = w.lineages.at(-1)!;
    expect(lineage.rows.map((row) => [row.state, row.layout, row.agent_id])).toEqual([
      ["Open", "identity", AGENT_ID], ["Claimed", "identity", AGENT_ID], ["Submitted", "identity", AGENT_ID],
    ]);
    expect(lineage.rows[2]).toMatchObject({
      utxo_ref: result.submitted_ref, spent_tx: null,
      result_receipt_hash: receiptResultHash({ receipt: result.receipt, signature: result.receipt_signature }),
    });
    const claimTx = w.ledger.transactions.get(String(lineage.rows[0]!.spent_tx))!;
    const submitTx = w.ledger.transactions.get(String(lineage.rows[1]!.spent_tx))!;
    // §6.5: Claim and Submit carry the agent record as a reference input.
    expect(txFacts(claimTx).referenceInputs).toContain(RECORD_REF);
    expect(txFacts(submitTx).referenceInputs).toContain(RECORD_REF);

    // The buyer accepts; the Ogmios evaluation of the draft runs the escrow script.
    const submittedRef: OutputReference = { txHash: result.submitted_ref.split("#")[0]!, index: Number(result.submitted_ref.split("#")[1]) };
    const accept = await buildAcceptTx({ chain: w.buyerChain, buyerKey: buyer, escrowRef: submittedRef, identityBlueprint: blueprint });
    expect(w.ledger.spentBy.get(result.submitted_ref)).toBe(accept.expectedTxHash);
    expect(inspectSignedTransactionFinancials(accept.txCborHex).outputs.some((output) =>
      output.address === supplierKey.address && output.lovelace >= 3n * AP3X)).toBe(true);

    // Every draft passed, and so does each final signed transaction.
    expect(w.evaluations.length).toBeGreaterThanOrEqual(3);
    expect(w.evaluations.filter((simulation) => !simulation.passed).map(describeSimulation)).toEqual([]);
    for (const [label, tx] of [["Claim", claimTx], ["Submit", submitTx], ["Accept", accept.txCborHex]] as const) {
      const simulation = evaluateBuiltTx(tx, w.ledger.history.values(), label);
      expect(simulation.passed, describeSimulation(simulation)).toBe(true);
    }
  }, TIMEOUT_MS);

  it.each([
    {
      receipt: "names another agent",
      change: (receipt: Receipt) => buildReceipt({ ...receipt, agent_did: `did:vector:${OTHER_AGENT_ID}` }),
      refusal: "receipt agent DID does not match the escrow agent",
    },
    {
      receipt: "has no agent_did",
      change: ({ agent_did: _agentDid, ...receipt }: Receipt) => buildReceipt(receipt),
      refusal: "receipt has missing or unknown fields",
    },
  ])("refuses a receipt that $receipt, signed again with the supplier key", async ({ change, refusal }) => {
    const w = await world();
    const resigned: SignedReceipt[] = [];
    w.hooks.result = (body) => {
      const signed = signReceipt(change(body.receipt as Receipt), supplierKey.privateKeyHex);
      resigned.push(signed);
      return { ...body, receipt: signed.receipt, receipt_signature: signed.signature };
    };
    const posted = await w.client.post(await w.prepare());
    const verified = vi.fn(async () => undefined);
    await expect(w.client.execute(posted, { onReceiptVerified: verified })).rejects.toThrow(refusal);
    // The signatures are valid: the agent fields alone make the buyer refuse the receipt, before it reads the lineage.
    expect(resigned.length).toBeGreaterThan(0);
    expect(resigned.every((signed) => verifyReceipt(signed, supplierKey.pubKeyHex))).toBe(true);
    expect(verified).not.toHaveBeenCalled();
    expect(w.lineages).toEqual([]);
  }, TIMEOUT_MS);

  it("refuses a Submitted escrow that names another agent (submitted_escrow_mismatch)", async () => {
    const w = await world();
    misreport(w, "Submitted");
    const posted = await w.client.post(await w.prepare());
    await expect(w.client.execute(posted)).rejects.toMatchObject({ name: "ReceiptVerificationError", reason: "submitted_escrow_mismatch" });
    expect(w.lineages).toEqual([]);
  }, TIMEOUT_MS);

  it("refuses a lineage with a row that names another agent (escrow_lineage_mismatch)", async () => {
    const w = await world();
    w.hooks.lineage = (lineage) => ({
      ...lineage, rows: lineage.rows.map((row) => (row.state === "Claimed" ? { ...row, agent_id: OTHER_AGENT_ID } : row)),
    });
    const posted = await w.client.post(await w.prepare());
    await expect(w.client.execute(posted)).rejects.toMatchObject({ name: "ReceiptVerificationError", reason: "escrow_lineage_mismatch" });
    expect(w.lineages).toHaveLength(1);
  }, TIMEOUT_MS);

  it("refuses a confirmed Open escrow that names another agent, before any supplier admission", async () => {
    const w = await world();
    misreport(w, "Open");
    await expect(w.client.post(await w.prepare())).rejects.toThrow("original Open escrow does not match the prepared purchase");
    // Post is on the ledger. The buyer stops before it sends the paid admission.
    expect(w.ledger.submitted).toHaveLength(1);
    expect(paidAdmissions(w)).toEqual([]);
  }, TIMEOUT_MS);

  it("refuses to execute a posted purchase whose Open escrow names another agent", async () => {
    const w = await world();
    const posted = await w.client.post(await w.prepare());
    const escrowDatum: IdentityEscrowDatum = { ...decodeIdentityEscrowDatum(posted.escrowUtxo.datumHex!), agent_id: OTHER_AGENT_ID };
    const changed = { ...posted, escrowDatum, escrowUtxo: { ...posted.escrowUtxo, datumHex: encodeIdentityEscrowDatum(escrowDatum) } };
    await expect(w.client.execute(changed)).rejects.toThrow("original Open escrow does not match the prepared purchase");
    expect(paidAdmissions(w)).toEqual([]);
    expect(w.ledger.utxos.has(refText(posted.escrowRef))).toBe(true);
  }, TIMEOUT_MS);
});
