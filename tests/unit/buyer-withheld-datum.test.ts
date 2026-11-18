/**
 * buyer-withheld-datum.test.ts — the buyer when the chain client withholds the datum of an escrow.
 *
 * A chain client refuses CBOR that is nested deeper than 64 levels before it is decoded: it withholds a datum that fails the check.
 * The output stays in the answer. The caller sees an output with `datumHex: null`. These tests give the buyer such an output and
 * look at what each place does. The expected result is the normal refusal: the place throws a TxConstructionError, answers with an
 * error, or skips the escrow. No place sends a transaction. No place throws out of a loop. The next request, escrow or advert runs
 * as usual, and the library still decodes a known value.
 *
 * What each place does (traced in the source, and held by the tests below):
 * - POST /v1/accept (server.ts). The check "is the output still on chain" passes, because the output is there. runAccept calls
 *   buildAcceptTx, which refuses with TxConstructionError "escrow datum missing" (readEscrow, tx/internal/layout.ts). The route
 *   answers 502 `accept_failed`. The body holds the message of the error ("UTxO <ref> has no inline datum"). It does not hold the
 *   reason of the error.
 * - runAccept (cli/acceptFlow.ts). The CLI, the PDF job and the route share it. It gives the same TxConstructionError and writes
 *   only the line "accepting escrow".
 * - Marketplace.acceptResult, reclaim and refundRevoked. buildAcceptTx, buildReclaimTx and buildRefundRevokedTx refuse with
 *   TxConstructionError "escrow datum missing" before any other check. The method emits no event and does not change the history.
 * - Marketplace.endChat. After the receipt checks, buildAcceptTx refuses in the same way. endChat passes the error on and emits no
 *   `chain_submit_failed` event.
 * - recoverEscrow (cli/reclaim-orphans.ts). `!utxo?.datumHex` throws TxConstructionError "escrow ref not on chain", with the
 *   message "no escrow UTxO at <ref>". That reason names a spent output, not a withheld datum. It is not in SKIP_REASONS. So the
 *   loop of main() counts the escrow as failed (not skipped), writes one line, and goes on with the next escrow. main() runs only
 *   as the CLI, so a test runs it as the CLI.
 * - Paper2AgentClient (sdk/paper2agent.ts, scriptOutput). `!utxo?.datumHex` throws TxConstructionError
 *   "paper2agent_validation_failed" with the message "missing or invalid <advert|escrow> script UTxO". discover() catches it for
 *   each advert and keeps the other tools. prepare() passes it on. post() reads the escrow back after the Post transaction was
 *   sent, so it throws after the payment left. execute() throws before any request to the supplier. recover() saves the verified
 *   receipt, then throws when it reads the Submitted escrow.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../buyer/src/server.js";
import { runAccept } from "../../buyer/src/cli/acceptFlow.js";
import { recoverEscrow } from "../../buyer/src/cli/reclaim-orphans.js";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { MemoryTaskHistoryStore } from "../../buyer/src/sdk/history.js";
import { BuyerIdentity } from "../../buyer/src/sdk/identity.js";
import { Paper2AgentClient, type PostedPaper2Agent } from "../../buyer/src/sdk/paper2agent.js";
import type { ProgressEvent, TaskRecord } from "../../buyer/src/sdk/types.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { encodeIdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import type { PlutusData } from "../../packages/shared/src/cbor/plutus-data.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import {
  PAPER2AGENT_CAPABILITY_ID, paper2AgentManifestHash, paper2AgentModel, paper2AgentResultHash, type Paper2AgentManifest,
} from "../../packages/shared/src/paper2agent/index.js";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import { receiptResultHash, signReceipt } from "../../packages/shared/src/receipt/sign.js";
import type { ResponseItem } from "../../packages/shared/src/responses.js";
import { buildClaimTx, buildSubmitTx, chatSessionPromptHash, loadBlueprint, TxConstructionError } from "../../packages/shared/src/tx/index.js";
import { decoderWorks } from "../../packages/shared/src/tx/internal/decoderHealth.js";
import { TEST_IDENTITY_HASH } from "../fixtures/identity-builders/blueprint.js";
import { FakeOgmios } from "../fixtures/identity-builders/world.js";
import { buyer, escrowView, identityBlueprint, newEscrow, refText, seedNewEscrow, supplier } from "../fixtures/buyer-side/identity-world.js";

const TIP_SLOT = 1_745_500_000;
const NOW_MS = TIP_SLOT * 1000;
const INDEXER = "http://indexer.test";
const WITHHELD_REF: OutputReference = { txHash: "e1".repeat(32), index: 0 };
const READABLE_REF: OutputReference = { txHash: "e2".repeat(32), index: 0 };
const OPEN_REF: OutputReference = { txHash: "e3".repeat(32), index: 0 };

/** A Submitted new escrow of the buyer, inside its accept window at the tip of the mock chain. */
const submitted = newEscrow({
  state: "Submitted", submitted_at: NOW_MS - 5_000, result_receipt_hash: "d4".repeat(32), deliver_by: NOW_MS + 60_000,
});

beforeEach(() => {
  // The chain clients write one line for each output that they withhold. The tests do not read it.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // runAccept builds a new escrow with the scripts of the identity hash in the environment.
  vi.stubEnv("IDENTITY_POLICY_ID", TEST_IDENTITY_HASH);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** The reason of the TxConstructionError that `promise` rejects with. Another rejection, or none, fails the test. */
async function refusalReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TxConstructionError) return error.reason;
    throw error;
  }
  throw new Error("expected a TxConstructionError");
}

/** The escrow at `ref` on a mock chain, as the chain client gives it after it withheld the datum: the output with no datum. */
function seedWithheld(chain: MockChainProvider, ref: OutputReference, datum = submitted): Utxo {
  const utxo = seedNewEscrow(chain, datum, ref);
  chain.seed({ ...utxo, datumHex: null });
  return { ...utxo, datumHex: null };
}

/** `levels` lists inside each other around the integer 7. */
function nest(levels: number): PlutusData {
  let data: PlutusData = { kind: "int", value: 7n };
  for (let level = 0; level < levels; level += 1) data = { kind: "list", items: [data] };
  return data;
}

describe("POST /v1/accept when the chain client withheld the datum of the escrow", () => {
  /** An app on a mock chain with two Submitted escrows of the buyer: one with its datum withheld, one readable. */
  function acceptApp() {
    const chain = new MockChainProvider();
    chain.advanceSlot(TIP_SLOT);
    const withheld = seedWithheld(chain, WITHHELD_REF);
    const readable = seedNewEscrow(chain, submitted, READABLE_REF);
    const rows = [escrowView(withheld, submitted, null), escrowView(readable, submitted, null)];
    const fetchImpl = vi.fn(async () => json(rows));
    const app = createApp({ chain, walletKey: buyer, indexerUrl: INDEXER, fetchImpl });
    const submit = vi.spyOn(chain, "submitTx");
    return { app, submit };
  }

  beforeEach(() => {
    // The route writes "[accept] accepting escrow" to stderr.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("answers 502 accept_failed with the message of the refusal and sends no transaction", async () => {
    const { app, submit } = acceptApp();

    const res = await request(app).post("/v1/accept").send({ escrow_ref: refText(WITHHELD_REF) });

    expect(res.status).toBe(502);
    // The body holds the message of the TxConstructionError. Its reason "escrow datum missing" is not in the body.
    expect(res.body).toEqual({ error: "accept_failed", message: `UTxO ${refText(WITHHELD_REF)} has no inline datum` });
    expect(submit).not.toHaveBeenCalled();
  });

  it("builds and sends the Accept of an escrow whose datum is readable (control)", async () => {
    const { app, submit } = acceptApp();

    const res = await request(app).post("/v1/accept").send({ escrow_ref: refText(READABLE_REF) });

    expect(res.status).toBe(200);
    expect(res.body.accepted_ref).toBe(refText(READABLE_REF));
    expect(res.body.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("serves the next request of the same app: a health probe, and the Accept of another escrow", async () => {
    const { app, submit } = acceptApp();

    expect((await request(app).post("/v1/accept").send({ escrow_ref: refText(WITHHELD_REF) })).status).toBe(502);
    const health = await request(app).get("/healthz");
    const next = await request(app).post("/v1/accept").send({ escrow_ref: refText(READABLE_REF) });

    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
    expect(next.status).toBe(200);
    expect(next.body.accepted_ref).toBe(refText(READABLE_REF));
    expect(submit).toHaveBeenCalledOnce();
    expect(decoderWorks()).toBe(true);
  });

  it("through the real chain client: an escrow whose refund datum nests 70 levels is withheld, and the route answers 502", async () => {
    const fake = new FakeOgmios();
    const deep = { ...submitted, refund: { address: submitted.refund!.address, datum: nest(70) } };
    const utxo: Utxo = {
      ref: WITHHELD_REF, address: identityBlueprint.escrowScriptAddress(1), lovelace: 4_500_000n, assets: {},
      datumHex: encodeIdentityEscrowDatum(deep), scriptRef: null,
    };
    fake.add(utxo);
    const fetchImpl = vi.fn(async () => json([escrowView(utxo, deep, null)]));
    const app = createApp({ chain: fake.chain(), walletKey: buyer, indexerUrl: INDEXER, fetchImpl });

    const res = await request(app).post("/v1/accept").send({ escrow_ref: refText(WITHHELD_REF) });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "accept_failed", message: `UTxO ${refText(WITHHELD_REF)} has no inline datum` });
    expect(fake.evaluated).toEqual([]);
    expect(fake.submitted).toEqual([]);
    expect(decoderWorks()).toBe(true);
    expect((await request(app).get("/healthz")).status).toBe(200);
  });
});

describe("runAccept when the chain client withheld the datum of the escrow", () => {
  it("refuses with TxConstructionError \"escrow datum missing\", writes only its first line, and sends no transaction", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(TIP_SLOT);
    seedWithheld(chain, WITHHELD_REF);
    const submit = vi.spyOn(chain, "submitTx");
    const lines: string[] = [];

    expect(await refusalReason(runAccept({ chain, walletKey: buyer, escrowRef: WITHHELD_REF, log: (line) => lines.push(line) })))
      .toBe("escrow datum missing");

    expect(lines).toEqual(["accepting escrow"]);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("Marketplace when the chain client withheld the datum of the escrow", () => {
  const pending: TaskRecord = {
    escrow_ref: refText(WITHHELD_REF), supplier_pkh: supplier.pubKeyHash, capability_id: "llm.text.generate.v1",
    prompt_preview: "hello", posted_at: NOW_MS - 10_000, status: "pending",
  };

  /** A Marketplace on a mock chain whose escrow at WITHHELD_REF has no datum, with a pending history record of that escrow. */
  function marketplaceWorld(fetchImpl?: typeof globalThis.fetch) {
    const chain = new MockChainProvider();
    chain.advanceSlot(TIP_SLOT);
    seedWithheld(chain, WITHHELD_REF);
    const history = new MemoryTaskHistoryStore();
    history.save(pending);
    const marketplace = new Marketplace({
      chain, indexerUrl: INDEXER, walletKey: buyer, networkParams: { networkId: 0 }, identityBlueprint, historyStore: history, _fetch: fetchImpl,
    });
    const events: ProgressEvent[] = [];
    marketplace.on("progress", (event: ProgressEvent) => { events.push(event); });
    return { marketplace, history, events, submit: vi.spyOn(chain, "submitTx") };
  }

  it.each([
    { name: "acceptResult", run: (marketplace: Marketplace) => marketplace.acceptResult({ escrowRef: WITHHELD_REF }) },
    { name: "reclaim", run: (marketplace: Marketplace) => marketplace.reclaim({ escrowRef: WITHHELD_REF }) },
    { name: "refundRevoked", run: (marketplace: Marketplace) => marketplace.refundRevoked({ escrowRef: WITHHELD_REF }) },
  ])("$name refuses with TxConstructionError \"escrow datum missing\", emits no event, keeps the history and sends no transaction", async ({ run }) => {
    const { marketplace, history, events, submit } = marketplaceWorld();

    expect(await refusalReason(run(marketplace))).toBe("escrow datum missing");

    expect(events).toEqual([]);
    expect(history.get(pending.escrow_ref)).toEqual(pending);
    expect(submit).not.toHaveBeenCalled();
  });

  it("endChat passes the refusal of the Accept on as it is, with no failure event and no transaction", async () => {
    const transcript: ResponseItem[] = [];
    const receipt = {
      prompt_hash: chatSessionPromptHash({ session_nonce: "nonce" }),
      response_hash: createHash("sha256").update(canonicalize(transcript), "utf8").digest("hex"),
      model: "kimi", prompt_tokens: 1, completion_tokens: 1, wallclock_ms: 1, supplier_pkh: supplier.pubKeyHash, escrow_ref: refText(OPEN_REF),
    };
    const supplierFetch = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.endsWith("/v1/chat/end")) {
        return json({
          status: "submitted", escrow_ref: refText(OPEN_REF), receipt, receipt_signature: "f".repeat(128), submitted_ref: refText(WITHHELD_REF),
        });
      }
      if (target.endsWith("/capability")) return json({});
      throw new Error(`unexpected URL ${target}`);
    });
    const { marketplace, events, submit } = marketplaceWorld(supplierFetch);

    expect(await refusalReason(marketplace.endChat({
      escrowRef: OPEN_REF, sessionNonce: "nonce", supplierBaseUrl: "https://supplier.example.com", agentId: null, transcript,
    }))).toBe("escrow datum missing");

    expect(events.map((event) => event.type)).toEqual(["receipt_verified"]);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("the reclaim-orphans CLI when the chain client withheld the datum of an escrow", () => {
  it("recoverEscrow refuses with TxConstructionError \"escrow ref not on chain\", sends no transaction, and recovers the next escrow", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(TIP_SLOT);
    seedWithheld(chain, WITHHELD_REF, newEscrow({ deliver_by: NOW_MS - 1_000 }));
    seedNewEscrow(chain, newEscrow({ deliver_by: NOW_MS - 1_000 }), READABLE_REF);
    const identity = new BuyerIdentity(chain, 0, { identityBlueprint }, async () => []);
    const submit = vi.spyOn(chain, "submitTx");

    expect(await refusalReason(recoverEscrow({ chain, walletKey: buyer, escrowRef: WITHHELD_REF, identity })))
      .toBe("escrow ref not on chain");
    expect(submit).not.toHaveBeenCalled();

    expect((await recoverEscrow({ chain, walletKey: buyer, escrowRef: READABLE_REF, identity })).action).toBe("Reclaim");
    expect(submit).toHaveBeenCalledOnce();
  });

  it("a run of the CLI counts the escrow as failed, goes on with the next escrow, and exits with code 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buyer-withheld-datum-"));
    try {
      const envPath = join(dir, "buyer.env");
      const logPath = join(dir, "reclaim.log");
      // A throwaway key of the test fixtures. The values of the other keys point at the fakes below.
      writeFileSync(envPath, [
        `BUYER_PRIV_KEY_HEX=${buyer.privateKeyHex}`, "OGMIOS_URL=http://ogmios.invalid", "INDEXER_URL=http://indexer.invalid", "NETWORK_ID=0",
      ].join("\n"));
      // The CLI copies these keys into the environment when they are not set. The stubs give them back to the test.
      for (const key of ["OGMIOS_URL", "INDEXER_URL", "NETWORK_ID"]) vi.stubEnv(key, "stub");

      const fake = new FakeOgmios();
      // Row 1: a new escrow whose refund datum nests 70 levels. The client withholds its datum.
      const deep = { ...newEscrow(), refund: { address: newEscrow().refund!.address, datum: nest(70) } };
      fake.add({
        ref: WITHHELD_REF, address: identityBlueprint.escrowScriptAddress(0), lovelace: 4_500_000n, assets: {},
        datumHex: encodeIdentityEscrowDatum(deep), scriptRef: null,
      });
      // Row 2: a legacy escrow that is not due yet. The CLI skips it, and a skip is a normal result.
      const { agent_id: _agent, refund: _refund, ...legacy } = newEscrow({ posted_at: Date.now() - 1_000, deliver_by: Date.now() + 3_600_000 });
      fake.add({
        ref: READABLE_REF, address: "addr_test1wfakeescrow", lovelace: 4_500_000n, assets: {}, datumHex: encodeEscrowDatum(legacy), scriptRef: null,
      });
      const rows = [
        { utxo_ref: refText(WITHHELD_REF), buyer_pkh: buyer.pubKeyHash, state: "Open", layout: "identity" },
        { utxo_ref: refText(READABLE_REF), buyer_pkh: buyer.pubKeyHash, state: "Open", layout: "legacy" },
      ];
      vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) =>
        String(url).startsWith("http://indexer.invalid") ? json(rows) : fake.fetch(url, init));
      const stderr: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      // Node 20 has no Promise.withResolvers.
      const exited = new Promise<number | undefined>((resolve) => {
        vi.spyOn(process, "exit").mockImplementation(((code?: number) => { resolve(code); }) as never);
      });

      // The CLI starts when its module loads, and only when the script name is the CLI. So the test sets the arguments first, and
      // imports the module after that: a static import would run before it.
      const argv = process.argv;
      process.argv = [argv[0]!, "buyer/src/cli/reclaim-orphans.ts", "--env", envPath, "--log-file", logPath];
      try {
        vi.resetModules();
        await import("../../buyer/src/cli/reclaim-orphans.js");
        expect(await exited).toBe(0);
      } finally {
        process.argv = argv;
      }

      const output = stderr.join("");
      expect(output).toContain(`recover ${refText(WITHHELD_REF)} FAILED: no escrow UTxO at ${refText(WITHHELD_REF)}`);
      expect(output).toContain(`skip ${refText(READABLE_REF)}: reclaim before deliver_by`);
      expect(output).toContain("summary: attempted=2 succeeded=0 skipped=1 failed=1");
      expect(readFileSync(logPath, "utf8")).toContain(`RECLAIM_FAIL escrow=${WITHHELD_REF.txHash.slice(0, 8)}…#0 state=Open`);
      expect(fake.evaluated).toEqual([]);
      expect(fake.submitted).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Paper2AgentClient when the chain client withheld the datum of an advert or an escrow", () => {
  // The fixture follows buyer-paper2agent.test.ts. The suppliers are reduced to what these tests read: /capability, the job result,
  // and the Claim and Submit of the paid job on the mock chain.
  const legacyBlueprint = loadBlueprint();
  const manifest: Paper2AgentManifest = {
    schema_version: 1, name: "reviewed_tool", description: "A configured JSON tool.", package_sha256: "c".repeat(64),
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    limits: { max_input_bytes: 4096, max_output_bytes: 4096, max_runtime_ms: 10_000 },
  };
  const manifestHash = paper2AgentManifestHash(manifest);

  interface Tool {
    ref: OutputReference;
    advert: AdvertDatum;
  }

  function tool(index: number): Tool {
    const endpoint = `https://supplier-${index}.test`;
    return {
      ref: { txHash: `b${index}`.repeat(32), index: 0 },
      advert: {
        supplier_pkh: supplier.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID, model: paper2AgentModel(manifest),
        max_output_tokens: 0, max_processing_ms: 120_000, price_lovelace: 2_000_000n,
        supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n,
        endpoint_url: endpoint, detail_uri: `${endpoint}/capability`, detail_hash: "a".repeat(64),
        advertised_at: Date.now(), status: "Active",
      },
    };
  }

  /** A client on a mock chain that holds the adverts of `tools`, over an indexer and suppliers that agree with the chain. */
  function paper2agentWorld(tools: Tool[]) {
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor(Date.now() / 1000));
    for (const { ref, advert } of tools) {
      chain.seed({ ref, address: legacyBlueprint.advertScriptAddress(0), lovelace: 2_000_000n, assets: {}, datumHex: encodeAdvertDatum(advert), scriptRef: null });
    }
    /** The body that the suppliers answer with when the client reads the job "job_1". */
    const job: { result?: unknown } = {};
    const fetchFn = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
      const target = String(url);
      if (target.includes("/suppliers?")) {
        return json(tools.map(({ ref }) => ({ utxo_ref: refText(ref), advert_status: "Active", status: "free", capability_id: PAPER2AGENT_CAPABILITY_ID })));
      }
      if (target.endsWith("/v1/paper2agent/run/job_1")) return json(job.result);
      const found = tools.find(({ advert }) => target === `${advert.endpoint_url}/capability`);
      if (found === undefined) throw new Error(`unexpected URL ${target}`);
      return json({
        advert_ref: refText(found.ref), supplier_pkh: supplier.pubKeyHash, pub_key_hex: supplier.pubKeyHex,
        capability_id: found.advert.capability_id, model: found.advert.model, max_output_tokens: 0,
        max_processing_ms: found.advert.max_processing_ms, price_lovelace: found.advert.price_lovelace.toString(),
        paper2agent: { manifest, manifest_hash: manifestHash },
      });
    });
    const client = new Paper2AgentClient({ chain, walletKey: buyer, indexerUrl: "https://indexer.test", fetchFn });
    const prepare = ({ ref, advert }: Tool) => client.prepare({
      advertRef: ref, manifestHash, input: { text: "hello" }, expectedSupplierPkh: supplier.pubKeyHash, maxPriceLovelace: advert.price_lovelace,
    });
    return { chain, client, fetchFn, job, prepare, submit: vi.spyOn(chain, "submitTx") };
  }

  /** From now on the chain client withholds the datum of each output that `isWithheld` selects. */
  function withhold(chain: MockChainProvider, isWithheld: (utxo: Utxo) => boolean): void {
    const query = chain.queryUtxo.bind(chain);
    vi.spyOn(chain, "queryUtxo").mockImplementation(async (ref) => {
      const utxo = await query(ref);
      return utxo !== null && isWithheld(utxo) ? { ...utxo, datumHex: null } : utxo;
    });
  }

  /** The supplier's side of the paid job on the mock chain: Claim, then Submit with the hash of a signed receipt. */
  async function supplierSubmits(chain: MockChainProvider, posted: PostedPaper2Agent) {
    const result = { value: "hello" };
    const escrowRef = refText(posted.escrowRef);
    const receipt = buildReceipt({
      prompt_hash: posted.requestHash, response_hash: paper2AgentResultHash(manifestHash, posted.requestHash, result),
      model: posted.advert.model, prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 10, supplier_pkh: supplier.pubKeyHash, escrow_ref: escrowRef,
    });
    const signed = signReceipt(receipt, supplier.privateKeyHex);
    const claimed = await buildClaimTx({ chain, supplierKey: supplier, escrowRef: posted.escrowRef });
    const submitted = await buildSubmitTx({
      chain, supplierKey: supplier, escrowRef: { txHash: claimed.expectedTxHash, index: 0 }, receiptHash: receiptResultHash(signed),
    });
    const submittedRef: OutputReference = { txHash: submitted.expectedTxHash, index: 0 };
    const body = {
      manifest_hash: manifestHash, result, receipt, receipt_signature: signed.signature, pub_key_hex: supplier.pubKeyHex,
      escrow_ref: escrowRef, submitted_ref: refText(submittedRef),
    };
    return { submittedRef, body };
  }

  // The refusal of scriptOutput: the generic reason of the client, and a message that names the kind of output.
  const advertMissing = { name: "TxConstructionError", reason: "paper2agent_validation_failed", message: "missing or invalid advert script UTxO" };
  const escrowMissing = { name: "TxConstructionError", reason: "paper2agent_validation_failed", message: "missing or invalid escrow script UTxO" };

  it("discover leaves out the tool whose advert datum is withheld, and keeps the other tool", async () => {
    const [withheld, healthy] = [tool(1), tool(2)];
    const { chain, client } = paper2agentWorld([withheld, healthy]);
    expect((await client.discover()).map((offer) => refText(offer.advertRef))).toEqual([refText(withheld.ref), refText(healthy.ref)]);
    withhold(chain, (utxo) => refText(utxo.ref) === refText(withheld.ref));

    const offers = await client.discover();

    expect(offers.map((offer) => refText(offer.advertRef))).toEqual([refText(healthy.ref)]);
  });

  it("prepare refuses the advert with TxConstructionError \"paper2agent_validation_failed\" and sends no transaction", async () => {
    const only = tool(1);
    const { chain, prepare, submit } = paper2agentWorld([only]);
    withhold(chain, () => true);

    await expect(prepare(only)).rejects.toMatchObject(advertMissing);
    expect(submit).not.toHaveBeenCalled();
  });

  it("post refuses the escrow that it reads back with TxConstructionError \"paper2agent_validation_failed\", after the Post transaction was sent", async () => {
    const only = tool(1);
    const { chain, client, prepare, submit } = paper2agentWorld([only]);
    const prepared = await prepare(only);
    withhold(chain, (utxo) => utxo.address === legacyBlueprint.escrowScriptAddress(0));

    await expect(client.post(prepared)).rejects.toMatchObject(escrowMissing);

    expect(submit).toHaveBeenCalledOnce();
  });

  it("execute refuses the escrow with TxConstructionError \"paper2agent_validation_failed\" before any request to the supplier", async () => {
    const only = tool(1);
    const { chain, client, fetchFn, prepare } = paper2agentWorld([only]);
    const posted = await client.post(await prepare(only));
    withhold(chain, (utxo) => refText(utxo.ref) === refText(posted.escrowRef));
    fetchFn.mockClear();

    await expect(client.execute(posted)).rejects.toMatchObject(escrowMissing);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(decoderWorks()).toBe(true);
  });

  it("recover saves the verified receipt, then refuses the Submitted escrow with TxConstructionError \"paper2agent_validation_failed\"", async () => {
    const only = tool(1);
    const { chain, client, job, prepare } = paper2agentWorld([only]);
    const posted = await client.post(await prepare(only));
    const { submittedRef, body } = await supplierSubmits(chain, posted);
    job.result = body;
    withhold(chain, (utxo) => refText(utxo.ref) === refText(submittedRef));
    const saved = vi.fn();

    await expect(client.recover(posted, { jobId: "job_1", onReceiptVerified: saved })).rejects.toMatchObject(escrowMissing);

    expect(saved).toHaveBeenCalledOnce();
  });
});
