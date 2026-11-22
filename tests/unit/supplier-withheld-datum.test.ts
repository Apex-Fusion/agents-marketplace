/**
 * supplier-withheld-datum.test.ts — the supplier reads an output whose datum a chain client withholds.
 *
 * A chain client withholds an inline datum that fails the check: the output stays in the list, and its `datumHex` is null. The
 * supplier then sees an output with no datum. This file covers the three places where the supplier reads such an output:
 *   - the escrow that a request names: each route that reads an escrow answers 404 `escrow_not_found`, builds no Claim, frees the
 *     slot, and serves the next request;
 *   - the claimed escrow that Submit spends: the builder refuses it, and each runner ends its job in the normal failed state;
 *   - the agent record that Claim and Submit read as a reference input: the readers refuse it as not authentic.
 * A stand-in chain gives the output with no datum. One case uses a real Ogmios client over a fake Ogmios: the client withholds a
 * datum that is nested deeper than 64 levels (`chain-datum-check.test.ts` tests that limit at its source).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildClaimTx, buildSubmitTx, readAgentRecord, TxConstructionError } from "../../packages/shared/src/tx/index.js";
import { decoderWorks } from "../../packages/shared/src/tx/internal/decoderHealth.js";
import type { TestTxBody } from "../../packages/shared/src/tx/internal/testTxBody.js";
import { SupplierState } from "../../supplier/src/state.js";
import { JobStore } from "../../supplier/src/jobs.js";
import { ChatSessionStore } from "../../supplier/src/chatSession.js";
import { runChatJob, runOcrJob, runTtsJob } from "../../supplier/src/jobRunner.js";
import { endChatSession } from "../../supplier/src/chatSessionRunner.js";
import { advertRecordProblem } from "../../supplier/src/identity/agent.js";
import { ESCROW_SCRIPT_ADDRESS, TEST_MAX_OUTPUT_TOKENS, TEST_RESPONSE_INPUT } from "../fixtures/supplier-side/sample-escrow-state.js";
import {
  IDENTITY, identityEscrowUtxo, identitySupplierKey, recordSubmissions, recordUtxo as supplierRecordUtxo, supplierAgentRecord,
  testIdentity, withAgent,
} from "../fixtures/supplier-side/identity.js";
import {
  advertOf, advertUtxoOf, escrowOf, escrowUtxoOf, OCR_BODY, refString, ROUTE_KINDS, routeOf, serve, stubUpstreams, TTS_BODY,
  type Route, type RouteKind, type Served,
} from "../fixtures/supplier-side/route-kinds.js";
import { AGENT_ID, agentRecord, FakeOgmios, recordUtxo, testWallet } from "../fixtures/identity-builders/world.js";

const supplier = identitySupplierKey();
/** An escrow whose datum the client withholds, and an escrow that it reads in full. */
const WITHHELD_REF: OutputReference = { txHash: "e1".repeat(32), index: 0 };
const GOOD_REF: OutputReference = { txHash: "e2".repeat(32), index: 0 };
const CLAIMED_REF: OutputReference = { txHash: "c1".repeat(32), index: 0 };
const RECORD_REF: OutputReference = { txHash: "7e".repeat(32), index: 0 };
const RECEIPT_HASH = "e5".repeat(32);
/** A datum that is nested 70 levels deep: deeper than the limit of 64 levels. */
const DEEP_DATUM = `${"81".repeat(70)}00`;

/** The same output, with the datum that the client withholds. */
const withheld = (utxo: Utxo): Utxo => ({ ...utxo, datumHex: null });

/** A supplier app over a stand-in chain, with the synthetic transactions that the chain received. */
interface World extends Served {
  route: Route;
  chain: MockChainProvider;
  bodies: TestTxBody[];
}

/** The legacy escrow of `kind`: one escrow output with no datum and one that the client reads in full, on a stand-in chain. */
function legacyWorld(kind: RouteKind): World {
  const route = routeOf(kind);
  const chain = new MockChainProvider();
  chain.advanceSlot(1_000);
  chain.seed(advertUtxoOf(route));
  chain.seed(withheld(escrowUtxoOf(route, WITHHELD_REF)));
  chain.seed(escrowUtxoOf(route, GOOD_REF));
  const bodies = recordSubmissions(chain);
  return { route, chain, bodies, ...serve(route, chain) };
}

/** The TxConstructionError that `run` throws, a builder or a reader that refuses its input. */
async function refusal(run: () => unknown): Promise<TxConstructionError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TxConstructionError) return error;
    throw error;
  }
  throw new Error("the builder did not refuse");
}

beforeEach(() => {
  // The Ogmios clients and the runners write one log line for each output or job that they refuse.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  stubUpstreams();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The next request, for the escrow that the client reads in full, is accepted, and its Claim and Submit are the only ones built. */
async function expectNextRequestServed(world: World, ref: OutputReference): Promise<void> {
  const { route, app, jobs, state, bodies } = world;
  const next = await request(app).post(route.path).set("X-Escrow-Ref", refString(ref)).send(route.body);
  if (route.path === "/v1/chat/start") {
    expect(next.status).toBe(200);
    expect(next.body).toEqual({ status: "claimed", escrow_ref: refString(ref) });
    const end = await request(app).post("/v1/chat/end").set("X-Escrow-Ref", refString(ref)).send({});
    expect(end.status).toBe(200);
    expect(end.body.status).toBe("submitted");
  } else {
    expect(next.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(next.body.job_id)?.status).toBe("done"), { timeout: 5_000 });
  }
  expect(bodies.map((body) => body.type)).toEqual(["claim", "submit"]);
  expect(bodies[0]).toMatchObject({ inputs: [ref] });
  expect(state.snapshot().status).toBe("free");
}

describe("supplier routes: the datum of the escrow output is withheld", () => {
  it.each(ROUTE_KINDS)("%s: answers 404 escrow_not_found, builds no Claim, and serves the next request", async (kind) => {
    const world = legacyWorld(kind);
    const read = vi.spyOn(world.chain, "queryUtxo");

    const refused = await request(world.app).post(world.route.path).set("X-Escrow-Ref", refString(WITHHELD_REF)).send(world.route.body);

    expect(refused.status).toBe(404);
    expect(refused.body.reason).toBe("escrow_not_found");
    expect(refused.body.error.reason).toBe("escrow_not_found");
    // The route read the output, and it built nothing for it.
    expect(read).toHaveBeenCalledWith(WITHHELD_REF);
    expect(world.bodies).toHaveLength(0);
    expect(world.state.snapshot().status).toBe("free");
    expect(world.jobs.count()).toBe(0);
    expect(world.chatSessions.count()).toBe(0);

    await expectNextRequestServed(world, GOOD_REF);
  });

  it("the Ogmios client withholds an escrow datum nested 70 levels, and the route answers 404 escrow_not_found", async () => {
    const route = routeOf("chat");
    const fake = new FakeOgmios();
    fake.add(advertUtxoOf(route), { ...escrowUtxoOf(route, WITHHELD_REF), datumHex: DEEP_DATUM });
    const { app, state, jobs, chatSessions } = serve(route, fake.chain());

    const refused = await request(app).post(route.path).set("X-Escrow-Ref", refString(WITHHELD_REF)).send(route.body);

    expect(refused.status).toBe(404);
    expect(refused.body.reason).toBe("escrow_not_found");
    expect(fake.submitted).toHaveLength(0);
    expect(fake.evaluated).toHaveLength(0);
    expect(state.snapshot().status).toBe("free");
    expect(jobs.count()).toBe(0);
    expect(chatSessions.count()).toBe(0);

    // The supplier goes on: it still reads its advert, and the library still decodes a known value.
    expect((await request(app).get("/capability")).status).toBe(200);
    expect(decoderWorks()).toBe(true);
  });
});

describe("Submit: the claimed escrow output has no datum", () => {
  /** A claimed escrow at CLAIMED_REF on a stand-in chain; the client withholds its datum. */
  function claimedWorld(kind: RouteKind) {
    const route = routeOf(kind);
    const chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    chain.seed(withheld(escrowUtxoOf(route, CLAIMED_REF, { state: "Claimed" })));
    const bodies = recordSubmissions(chain);
    return { route, chain, bodies };
  }

  it("buildSubmitTx rejects with `escrow datum missing` and submits nothing", async () => {
    const { chain, bodies } = claimedWorld("chat");

    const error = await refusal(() => buildSubmitTx({ chain, supplierKey: supplier, escrowRef: CLAIMED_REF, receiptHash: RECEIPT_HASH }));

    expect(error.reason).toBe("escrow datum missing");
    expect(error.message).toContain("no inline datum");
    expect(bodies).toHaveLength(0);
  });

  it.each(["chat", "tts", "ocr"] as const)("%s runner: ends the job as failed with submit_failed, frees the slot, and resolves", async (kind) => {
    const { route, chain, bodies } = claimedWorld(kind);
    const state = new SupplierState();
    const jobs = new JobStore();
    const escrowRef = refString(GOOD_REF);
    state.tryAcquire(escrowRef);
    const jobId = jobs.create(escrowRef);
    const params = {
      deps: { chain, state, config: route.config, supplierKey: supplier, jobs },
      jobId, escrowRef, claimedRef: CLAIMED_REF, advert: advertOf(route), escrowDatum: escrowOf(route, { state: "Claimed" }),
    };

    const run = kind === "chat"
      ? runChatJob({ ...params, requestBody: { input: TEST_RESPONSE_INPUT, max_output_tokens: TEST_MAX_OUTPUT_TOKENS } })
      : kind === "tts"
        ? runTtsJob({ ...params, requestBody: TTS_BODY })
        : runOcrJob({ ...params, requestBody: OCR_BODY });

    // Nothing is thrown out of the runner.
    await expect(run).resolves.toBeUndefined();
    expect(jobs.get(jobId)).toMatchObject({
      status: "failed",
      failure: { httpStatus: 502, reason: "submit_failed", message: expect.stringContaining("no inline datum") },
    });
    expect(jobs.get(jobId)?.responsePayload).toBeUndefined();
    expect(state.snapshot().status).toBe("free");
    expect(bodies).toHaveLength(0);
  });

  it("chat session runner: ends the session with a submit_failed failure, frees the slot, and resolves with the ended record", async () => {
    const { route, chain, bodies } = claimedWorld("chat-session");
    const state = new SupplierState();
    const sessions = new ChatSessionStore();
    const escrowRef = refString(GOOD_REF);
    state.tryAcquire(escrowRef);
    const record = sessions.create({
      escrowRef, claimedRef: CLAIMED_REF, settleMode: "full", advert: advertOf(route), escrowDatum: escrowOf(route, { state: "Claimed" }),
    });

    const ended = await endChatSession({
      deps: { chain, state, config: route.config, supplierKey: supplier, jobs: new JobStore(), sessions }, escrowRef, trigger: "end",
    });

    expect(ended).toBe(record);
    expect(ended?.status).toBe("ended");
    expect(ended?.endFailure).toEqual({ reason: "submit_failed", message: expect.stringContaining("no inline datum") });
    expect(ended?.endResult).toBeUndefined();
    expect(state.snapshot().status).toBe("free");
    expect(bodies).toHaveLength(0);
  });

  /** After the Claim, the client withholds the datum of the claimed output that the Claim wrote. */
  function withholdClaimedOutput(chain: MockChainProvider): void {
    const read = chain.queryUtxo.bind(chain);
    vi.spyOn(chain, "queryUtxo").mockImplementation(async (ref) => {
      const utxo = await read(ref);
      return utxo !== null && utxo.address === ESCROW_SCRIPT_ADDRESS && utxo.ref.txHash !== GOOD_REF.txHash ? withheld(utxo) : utxo;
    });
  }

  it("the poll route shows the failed job: 502 with the reason submit_failed", async () => {
    const world = legacyWorld("chat");
    withholdClaimedOutput(world.chain);

    const accepted = await request(world.app).post(world.route.path).set("X-Escrow-Ref", refString(GOOD_REF)).send(world.route.body);
    expect(accepted.status).toBe(202);
    await vi.waitFor(() => expect(world.jobs.get(accepted.body.job_id)?.status).toBe("failed"), { timeout: 5_000 });

    const polled = await request(world.app).get(`${world.route.path}/${accepted.body.job_id}`);
    expect(polled.status).toBe(502);
    expect(polled.body).toMatchObject({ status: "failed", reason: "submit_failed", escrow_ref: refString(GOOD_REF) });
    expect(polled.body.message).toContain("no inline datum");
    expect(world.bodies.map((body) => body.type)).toEqual(["claim"]);
    expect(world.state.snapshot().status).toBe("free");
  });

  it("the end route of a chat session answers 502 with the reason submit_failed", async () => {
    const world = legacyWorld("chat-session");
    withholdClaimedOutput(world.chain);

    const started = await request(world.app).post(world.route.path).set("X-Escrow-Ref", refString(GOOD_REF)).send(world.route.body);
    expect(started.status).toBe(200);

    const ended = await request(world.app).post("/v1/chat/end").set("X-Escrow-Ref", refString(GOOD_REF)).send({});
    expect(ended.status).toBe(502);
    expect(ended.body.reason).toBe("submit_failed");
    expect(ended.body.message).toContain("no inline datum");
    expect(world.bodies.map((body) => body.type)).toEqual(["claim"]);
    expect(world.state.snapshot().status).toBe("free");
  });
});

describe("an agent record output with no inline datum", () => {
  const controller = testWallet("agent record controller");
  const recordSupplier = testWallet("agent record supplier");
  const record = agentRecord(controller, recordSupplier);

  it("readAgentRecord refuses it as not authentic, and reads the same output with its datum", async () => {
    const utxo = recordUtxo(IDENTITY, record);
    expect(readAgentRecord(utxo, IDENTITY.identityHash, AGENT_ID).controller).toBe(record.controller);

    const error = await refusal(() => readAgentRecord(withheld(utxo), IDENTITY.identityHash, AGENT_ID));
    expect(error.reason).toBe("agent record not authentic");
    expect(error.message).toContain("no inline datum");
  });

  it("the chain lookup of the supplier finds the output, and the readers refuse it", async () => {
    const chain = new MockChainProvider();
    chain.seed(withheld(recordUtxo(IDENTITY, record)));
    const identity = testIdentity(chain, 1);

    const found = await identity.lookupRecord(AGENT_ID);

    expect(found).toMatchObject({ ref: RECORD_REF, datumHex: null });
    expect((await refusal(() => readAgentRecord(found, IDENTITY.identityHash, AGENT_ID))).reason).toBe("agent record not authentic");
    expect(await advertRecordProblem(identity, AGENT_ID, recordSupplier.pubKeyHash, "llm.text.generate.v1", 1_000_000))
      .toBe("agent record not authentic");
  });

  it.each(["Claim", "Submit"] as const)("%s refuses it, and submits nothing", async (action) => {
    const route = routeOf("chat");
    const chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    chain.seed(identityEscrowUtxo(withAgent(escrowOf(route, action === "Submit" ? { state: "Claimed" } : {})), GOOD_REF));
    chain.seed(withheld(supplierRecordUtxo(supplierAgentRecord(supplier, [route.capability]))));
    const bodies = recordSubmissions(chain);
    const params = {
      chain, supplierKey: supplier, escrowRef: GOOD_REF, lookupRecord: testIdentity(chain).lookupRecord, identityBlueprint: IDENTITY,
    };

    const error = await refusal(() => (action === "Claim" ? buildClaimTx(params) : buildSubmitTx({ ...params, receiptHash: RECEIPT_HASH })));

    expect(error.reason).toBe("agent record not authentic");
    expect(error.message).toContain("no inline datum");
    expect(bodies).toHaveLength(0);
  });

  it.each(ROUTE_KINDS)("%s route: answers 503 agent_not_eligible, builds no Claim, frees the slot, and serves the next request", async (kind) => {
    const route = routeOf(kind);
    const chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    chain.seed(advertUtxoOf(route));
    chain.seed(identityEscrowUtxo(withAgent(escrowOf(route)), GOOD_REF));
    const authentic = supplierRecordUtxo(supplierAgentRecord(supplier, [route.capability]));
    chain.seed(withheld(authentic));
    const bodies = recordSubmissions(chain);
    const world = { route, chain, bodies, ...serve(route, chain, { agentId: AGENT_ID, identity: testIdentity(chain) }) };

    const refused = await request(world.app).post(route.path).set("X-Escrow-Ref", refString(GOOD_REF)).send(route.body);

    expect(refused.status).toBe(503);
    expect(refused.body.reason).toBe("agent_not_eligible");
    expect(refused.body.message).toContain("no inline datum");
    expect(bodies).toHaveLength(0);
    expect(world.state.snapshot().status).toBe("free");
    expect(world.jobs.count()).toBe(0);
    expect(world.chatSessions.count()).toBe(0);

    // The client reads the record in full again, and the same request is served. Claim and Submit read the record.
    chain.seed(authentic);
    await expectNextRequestServed(world, GOOD_REF);
    expect(bodies[0]).toMatchObject({ referenceInputs: [RECORD_REF] });
    expect(bodies[1]).toMatchObject({ referenceInputs: [RECORD_REF] });
  });
});
