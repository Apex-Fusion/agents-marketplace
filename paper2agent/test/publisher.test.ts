import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import Database from "better-sqlite3";
import { MockChainProvider } from "@marketplace/shared/chain";
import { decodeAdvertDatum, decodeIdentityAdvertDatum, encodeAdvertDatum, encodeIdentityAdvertDatum,
  type AdvertDatum } from "@marketplace/shared/cbor";
import { PAPER2AGENT_CAPABILITY_ID } from "@marketplace/shared/paper2agent";
import type { PaperPackageArtifact, PaperPublishTerms } from "@marketplace/shared/paper2agent/workflow";
import { deriveSupplierKey } from "../../supplier/src/paper2agent/identity.js";
import { PublisherTarget, loadPaperPublisherConfig } from "../src/publisher-config.js";
import type { PaperPublisherDeps, SlotAdvertView } from "../src/publisher.js";
import { PaperPublisherStore, type SignedAdvert } from "../src/publisher-store.js";
import { AGENT_ID, CONTROLLER, IDENTITY, recordUtxo, supplierAgentRecord, testIdentity } from "../../tests/fixtures/supplier-side/identity.js";
import {
  AUTH, BASE_IMAGE, JOB_ID, KEY_A, KEY_B, PUBLIC_URL, RUNTIME_IMAGE, TOKEN, TOOL_TOKEN, cleanup, fakeImages, fundWallet, preparation,
  publisher, reviewedPackage, target, temporary, terms, tick, until, walletFundedAdvert,
} from "./publisher-fixtures.js";

afterEach(cleanup);

describe("publisher management boundary", () => {
  it("checks the bearer token before reading a body and never returns wallet keys", async () => {
    const { app } = await publisher();
    const unauthenticated = await request(app).post("/publications").set("Content-Type", "application/json").send("{not json");
    expect(unauthenticated.status).toBe(401);
    expect((await request(app).get("/targets").set("Authorization", `Bearer ${"x".repeat(48)}`)).status).toBe(401);
    expect((await request(app).get("/healthz")).status).toBe(200);

    const listed = await request(app).get("/targets").set(AUTH);
    expect(listed.status).toBe(200);
    expect(listed.body.targets).toEqual([{ id: "slot-a", label: "Slot slot-a", network_id: 0,
      supplier_pkh: deriveSupplierKey(KEY_A, 0).pubKeyHash, deposit_address: deriveSupplierKey(KEY_A, 0).address,
      endpoint_url: `${PUBLIC_URL}/tools/slot-a`, available: true, live_chain: true, agent_id: null }]);
    expect(listed.text).not.toContain(KEY_A);
  });
});

describe("publication preparation", () => {
  it("rejects an archive that differs from the reviewed artifact before storing or building anything", async () => {
    const { app, images } = await publisher();
    const pkg = await reviewedPackage();
    const tampered = { ...pkg, archive: Buffer.concat([pkg.archive, Buffer.alloc(512)]) };
    const response = await request(app).post("/publications").set(AUTH).send(preparation(tampered, terms(pkg.artifact)));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("archive_hash_mismatch");
    expect(images.build).not.toHaveBeenCalled();
    expect((await request(app).get(`/publications/${JOB_ID}`).set(AUTH)).status).toBe(404);
  });

  it("builds once per exact request, conflicts on changed inputs, and holds the wallet slot", async () => {
    const { app, images } = await publisher();
    const pkg = await reviewedPackage();
    const first = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: JOB_ID, state: "prepared", tx_hash: null, advert_ref: null,
      deposit_address: deriveSupplierKey(KEY_A, 0).address, endpoint_url: `${PUBLIC_URL}/tools/slot-a` });

    const replay = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    expect(replay.body).toEqual(first.body);
    expect(images.build).toHaveBeenCalledTimes(1);

    const changed = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact, "slot-a", "3000000")));
    expect([changed.status, changed.body.error]).toEqual([409, "publication_conflict"]);
    const second = await request(app).post("/publications").set(AUTH)
      .send(preparation(pkg, terms(pkg.artifact), "7d6c5b4a-3e2f-4a1b-8c9d-0e1f2a3b4c5d"));
    expect([second.status, second.body.error]).toEqual([409, "target_slot_in_use"]);
    expect((await request(app).get("/targets").set(AUTH)).body.targets[0].available).toBe(false);
  });

  it("releases the slot after a failed image build and rebuilds on an exact retry", async () => {
    const { app, images } = await publisher({ images: fakeImages(1) });
    const pkg = await reviewedPackage();
    const failed = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ state: "failed", tx_hash: null });
    expect(failed.body.error).toContain("pip install failed");
    expect((await request(app).get("/targets").set(AUTH)).body.targets[0].available).toBe(true);

    const retried = await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    expect(retried.body).toMatchObject({ state: "prepared", error: null });
    expect(images.build).toHaveBeenCalledTimes(2);
  });
});

describe("live advert publication", () => {
  it("refuses a slot without LIVE_CHAIN=1 instead of simulating a transaction", async () => {
    const { app, chain } = await publisher({ targets: [target("slot-a", KEY_A, false)] });
    const submit = vi.spyOn(chain, "submitTx");
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const refused = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect([refused.status, refused.body.error]).toEqual([409, "live_chain_disabled"]);
    expect(submit).not.toHaveBeenCalled();
    expect((await request(app).get(`/publications/${JOB_ID}`).set(AUTH)).body.state).toBe("prepared");
  });

  it("never broadcasts a signed advert whose exact wallet debit exceeds the approval", async () => {
    const chain = new MockChainProvider();
    const input = fundWallet(chain, KEY_A, 10_000_000n);
    const { app } = await publisher({ chain, postAdvert: walletFundedAdvert(input, 7_000_000n) });
    const submit = vi.spyOn(chain, "submitTx");
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));

    const refused = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "2999999" });
    expect([refused.status, refused.body.error]).toEqual([409, "debit_exceeds_approval"]);
    expect(submit).not.toHaveBeenCalled();
    const unchanged = await request(app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(unchanged.body).toMatchObject({ state: "prepared", tx_hash: null });
    expect(unchanged.body.error).toContain("debits 3000000 lovelace");

    const published = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "3000000" });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ state: "published", actual_debit_lovelace: "3000000", error: null });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("journals before broadcast and recovers an unknown outcome from chain evidence without signing again", async () => {
    const dataDir = temporary();
    const first = await publisher({ dataDir });
    const pkg = await reviewedPackage();
    await request(first.app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const broadcast = first.chain.submitTx.bind(first.chain);
    const journaledAtBroadcast: Array<string | null> = [];
    const submit = vi.spyOn(first.chain, "submitTx").mockImplementation(async (cbor) => {
      journaledAtBroadcast.push((await first.service.refresh(JOB_ID)).tx_hash);
      return broadcast(cbor);
    });
    vi.spyOn(first.chain, "awaitTx").mockRejectedValue(new Error("awaitTx_timeout: not observed"));

    const pending = await request(first.app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect(pending.status).toBe(200);
    expect(pending.body.state).toBe("confirmation_pending");
    expect(journaledAtBroadcast).toEqual([pending.body.tx_hash]);
    const again = await request(first.app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect([again.status, again.body.error]).toEqual([409, "publication_not_prepared"]);
    expect(submit).toHaveBeenCalledTimes(1);
    const advert = await first.chain.queryUtxo({ txHash: pending.body.tx_hash, index: 0 });
    await first.service.close();

    // Restart: the advert is now visible. Recovery reads it and starts the supplier only.
    const chain = new MockChainProvider();
    chain.seed(advert!);
    const postAdvert = vi.fn();
    const second = await publisher({ dataDir, chain, postAdvert, images: first.images });
    const resubmit = vi.spyOn(chain, "submitTx");
    const recovering = await request(second.app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(recovering.body.state).toBe("publishing");
    await second.service.idle();
    const recovered = await request(second.app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(recovered.body).toMatchObject({ state: "published", tx_hash: pending.body.tx_hash, advert_ref: `${pending.body.tx_hash}#0`, error: null });
    expect(postAdvert).not.toHaveBeenCalled();
    expect(resubmit).not.toHaveBeenCalled();

    const env = second.launches[0].env;
    expect(env).toMatchObject({ CAPABILITY_KIND: "paper2agent", ADVERT_REF: `${pending.body.tx_hash}#0`,
      SUPPLIER_BIND_HOST: "127.0.0.1", WALLET_HEALTH_INTERVAL_MS: "0" });
    expect(JSON.parse(env.PAPER2AGENT_ARGV_JSON)).toEqual(expect.arrayContaining(["--network", "none", "--read-only", RUNTIME_IMAGE]));
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it("marks an expired, unspent advert transaction failed only after the finality margin and keeps the slot", async () => {
    const chain = new MockChainProvider();
    const input = fundWallet(chain, KEY_A, 10_000_000n);
    const { app } = await publisher({ chain, postAdvert: walletFundedAdvert(input, 7_000_000n, 600_000) });
    vi.spyOn(chain, "submitTx").mockRejectedValue(new Error("socket hang up"));
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const pending = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect(pending.body.state).toBe("confirmation_pending");

    chain.advanceSlot(600 + 43_200);
    const withinMargin = await request(app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(withinMargin.body.state).toBe("confirmation_pending");
    expect(withinMargin.body.error).toContain("cannot confirm after slot 600");

    chain.advanceSlot(1);
    const expired = await request(app).get(`/publications/${JOB_ID}`).set(AUTH);
    expect(expired.body).toMatchObject({ state: "failed", tx_hash: pending.body.tx_hash });
    expect((await request(app).get("/targets").set(AUTH)).body.targets[0].available).toBe(false);
  });
});

describe("supplier supervision", () => {
  it("proxies only the fixed supplier protocol and drains active work before stopping the child", async () => {
    const { app, service, launches } = await publisher();
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const published = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect(published.body.state).toBe("published");

    expect((await request(app).get("/tools/slot-a/capability")).body.capability_id).toBe(PAPER2AGENT_CAPABILITY_ID);
    expect((await request(app).get("/tools/slot-a/admin")).status).toBe(404);
    expect((await request(app).get("/tools/slot-b/capability")).status).toBe(404);
    // Without a configured tool-call token the unpaid route does not exist.
    expect(launches[0].env.PAPER2AGENT_FREE_CALLS).toBeUndefined();
    const unconfigured = await request(app).post("/tools/slot-a/v1/paper2agent/call").set(AUTH)
      .send({ manifest_hash: pkg.artifact.manifest_hash, input: { value: "x" } });
    expect([unconfigured.status, unconfigured.body]).toEqual([404, { reason: "not_found", message: "not_found" }]);
    expect(launches[0].calls).toEqual([]);
    const admitted = await request(app).post("/tools/slot-a/v1/paper2agent/run")
      .set("X-Escrow-Ref", `${"e".repeat(64)}#0`).send({ manifest_hash: pkg.artifact.manifest_hash, input: { value: "x" } });
    expect(admitted.status).toBe(202);
    expect(launches[0].admissions).toBe(1);

    launches[0].activeSessions = 1;
    const closing = service.close();
    await until(() => launches[0].statusPolls >= 2);
    const refused = await request(app).post("/tools/slot-a/v1/paper2agent/run")
      .set("X-Escrow-Ref", `${"f".repeat(64)}#0`).send({ manifest_hash: pkg.artifact.manifest_hash, input: { value: "y" } });
    expect([refused.status, refused.body.reason]).toEqual([503, "supplier_draining"]);
    expect((await request(app).get("/tools/slot-a/status")).status).toBe(200);
    expect(launches[0].signals).toEqual([]);

    launches[0].activeSessions = 0;
    await closing;
    expect(launches[0].signals).toEqual(["SIGTERM"]);
    expect(launches[0].admissions).toBe(1);
  });

  it("forwards unpaid tool calls only with the tool-call token and drains them like admissions", async () => {
    const { app, service, launches } = await publisher({ toolCallToken: TOOL_TOKEN });
    const pkg = await reviewedPackage();
    await request(app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const published = await request(app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    expect(published.body.state).toBe("published");
    expect(launches[0].env.PAPER2AGENT_FREE_CALLS).toBe("1");
    const payload = { manifest_hash: pkg.artifact.manifest_hash, input: { value: "x" } };
    const call = (authorization?: string, targetId = "slot-a") => {
      const pending = request(app).post(`/tools/${targetId}/v1/paper2agent/call`);
      return (authorization === undefined ? pending : pending.set("Authorization", authorization)).send(payload);
    };

    for (const authorization of [undefined, "", "Bearer ", TOOL_TOKEN, `Basic ${TOOL_TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOOL_TOKEN}x`]) {
      const refused = await call(authorization);
      expect([refused.status, refused.body]).toEqual([401, { reason: "unauthorized", message: "unauthorized" }]);
    }
    expect((await call(`Bearer ${TOOL_TOKEN}`, "slot-b")).status).toBe(404);
    expect(launches[0].calls).toEqual([]);

    const timeout = vi.spyOn(AbortSignal, "timeout");
    const answered = await call(`Bearer ${TOOL_TOKEN}`);
    expect(answered.status).toBe(200);
    expect(answered.headers["cache-control"]).toBe("no-store");
    expect(answered.body).toEqual({ manifest_hash: pkg.artifact.manifest_hash, result: { value: "x" }, wallclock_ms: 5 });
    expect(timeout).toHaveBeenCalledWith(180_000);
    expect(launches[0].calls).toHaveLength(1);
    expect(launches[0].calls[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(launches[0].calls[0].body)).toEqual(payload);

    // The child reports no session, but the in-flight call still holds the drain.
    let release!: () => void;
    launches[0].callGate = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = call(`Bearer ${TOOL_TOKEN}`).then((reply) => reply);
    await until(() => launches[0].calls.length === 2);
    const closing = service.close();
    const draining = await call(`Bearer ${TOOL_TOKEN}`);
    expect([draining.status, draining.body.reason]).toEqual([503, "supplier_draining"]);
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(401);
    for (let turn = 0; turn < 100; turn++) await tick();
    expect(launches[0].signals).toEqual([]);

    release();
    expect((await inFlight).status).toBe(200);
    await closing;
    expect(launches[0].signals).toEqual(["SIGTERM"]);
    expect(launches[0].calls).toHaveLength(2);
    expect(launches[0].calls[1].headers.authorization).toBeUndefined();
  });
});

describe("publisher journal invariants", () => {
  it("recovers interrupted phases and never lets a signed publication become publishable again", () => {
    const store = PaperPublisherStore.open(join(temporary(), "publisher.db"));
    const record = (id: string, targetId: string) => ({ id, target_id: targetId, request_hash: "0".repeat(64),
      terms: {} as PaperPublishTerms, artifact: {} as PaperPackageArtifact, work_dir: `/data/${id}`, supplier_pkh: "aa".repeat(28),
      deposit_address: "addr_test1", endpoint_url: `${PUBLIC_URL}/tools/${targetId}` });
    const transaction = (id: string, targetId: string, hash: string): SignedAdvert => ({ publication_id: id, layout: "legacy",
      target_id: targetId, tx_hash: hash, tx_cbor: "00", advert_ref: `${hash}#0`, advert_address: "addr_test1", advert_datum_hex: "00",
      wallet_inputs: [], fee_lovelace: "0", wallet_debit_lovelace: "0", max_debit_lovelace: "1", valid_until_slot: null, signed_at: 1 });
    for (const [id, targetId] of [["unsigned", "slot-a"], ["signed", "slot-b"]]) {
      store.create(record(id, targetId), 1);
      store.update(id, ["preparing"], { phase: "prepared" }, 2);
      store.update(id, ["prepared"], { phase: "publishing" }, 3);
    }
    store.journal(transaction("signed", "slot-b", "ab".repeat(32)), 4);
    store.create(record("building", "slot-c"), 5);
    expect(() => store.create(record("second", "slot-b"), 6)).toThrow("target_slot_in_use");

    store.recover(7);
    expect(["unsigned", "signed", "building"].map((id) => store.get(id)?.phase)).toEqual(["prepared", "confirmation_pending", "failed"]);
    expect(() => store.update("signed", ["confirmation_pending"], { phase: "prepared" }, 8)).toThrow(/cannot be reset/);
    expect(() => store.journal(transaction("unsigned", "slot-b", "cd".repeat(32)), 9)).toThrow();
    expect(store.heldTargets()).toEqual(new Set(["slot-a", "slot-b"]));
    store.close();
  });
});

describe("publisher configuration", () => {
  it("loads private wallet slots only from an operator-private file with supported chain settings", () => {
    const directory = temporary();
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin", "docker"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(directory, "bin", "docker"), 0o755);
    const file = join(directory, "targets.json");
    const zeroTime = "1752057484000";
    const slot = (id: string, key: string, extra: Record<string, string> = {}) => ({ id, label: `Slot ${id}`,
      env: { SUPPLIER_PRIV_KEY_HEX: key, NETWORK_ID: "1", OGMIOS_URL: "https://ogmios.example", LIVE_CHAIN: "1",
        VECTOR_ZERO_TIME_MS: zeroTime, ...extra } });
    const load = (targets: unknown[], extra: Record<string, string> = {}) => {
      writeFileSync(file, JSON.stringify(targets));
      return loadPaperPublisherConfig({ PATH: join(directory, "bin"), PAPER2AGENT_PUBLISHER_TOKEN: TOKEN,
        PAPER2AGENT_PUBLISHER_TARGETS_FILE: file, PAPER2AGENT_PUBLISHER_PUBLIC_URL: PUBLIC_URL, VECTOR_ZERO_TIME_MS: zeroTime,
        PAPER2AGENT_RUNTIME_IMAGE: BASE_IMAGE, PAPER2AGENT_PUBLISHER_DATA_DIR: join(directory, "data"), ...extra });
    };

    writeFileSync(file, "[]");
    chmodSync(file, 0o644);
    expect(() => load([slot("slot-a", KEY_A)])).toThrow(/chmod 600/);
    chmodSync(file, 0o600);
    expect(() => load([slot("slot-a", KEY_A, { NODE_OPTIONS: "--inspect" })])).toThrow(/NODE_OPTIONS is not a supported/);
    expect(() => load([slot("slot-a", KEY_A), slot("slot-b", KEY_A)])).toThrow(/own key/);
    expect(() => load([slot("slot-a", KEY_A, { NETWORK_ID: "0" })])).toThrow(/requires NETWORK_ID=1/);
    expect(() => load([slot("slot-a", KEY_A, { VECTOR_ZERO_TIME_MS: "1" })])).toThrow(/VECTOR_ZERO_TIME_MS/);

    const loaded = load([slot("slot-a", KEY_A), slot("slot-b", KEY_B)]);
    expect(loaded.targets.map((entry) => entry.endpointUrl)).toEqual([`${PUBLIC_URL}/tools/slot-a`, `${PUBLIC_URL}/tools/slot-b`]);
    expect(loaded.dockerPath).toBe(join(directory, "bin", "docker"));
    expect(loaded.toolCallToken).toBeNull();
    expect(load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: "" }).toolCallToken).toBeNull();
    expect(load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: TOOL_TOKEN }).toolCallToken).toBe(TOOL_TOKEN);
    expect(() => load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: "short" })).toThrow(/PAPER2AGENT_TOOL_CALL_TOKEN must be/);
    expect(() => load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: `${"t".repeat(32)} x` })).toThrow(/without whitespace/);
    expect(() => load([slot("slot-a", KEY_A)], { PAPER2AGENT_TOOL_CALL_TOKEN: TOKEN })).toThrow(/must differ/);
    for (const text of [JSON.stringify(loaded.targets), inspect(loaded.targets)]) {
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(KEY_B);
    }
  });
});

/** Slot slot-a of the identity release: IDENTITY_POLICY_ID, and AGENT_ID when given. */
const identitySlot = (agentId?: string) => new PublisherTarget("slot-a", "Slot slot-a", { SUPPLIER_PRIV_KEY_HEX: KEY_A, NETWORK_ID: "0",
  OGMIOS_URL: "http://127.0.0.1:1337", LIVE_CHAIN: "1", IDENTITY_POLICY_ID: IDENTITY.identityHash,
  ...(agentId === undefined ? {} : { AGENT_ID: agentId }) }, PUBLIC_URL);
const controller = { controller: CONTROLLER.pubKeyHex, accountable: { type: "ControllerSet" as const } };
/** A stand-in Register builder: the slot key and the controller must sign. */
const registrar: PaperPublisherDeps["registrar"] = () => ({
  async build(args) {
    const signers = [args.wallet.pubKeyHash, deriveSupplierKey(CONTROLLER.privateKeyHex, 0).pubKeyHash].sort();
    return { txCborHex: "84a0a0f5f6", txHash: "ab".repeat(32), agentId: AGENT_ID, requiredSigners: signers };
  },
  sign: async (tx) => tx,
  txId: () => "ab".repeat(32),
});

describe("slot identity records (Part 2 §9.2)", () => {
  async function prepared(options: Parameters<typeof publisher>[0]) {
    const fixture = await publisher(options);
    const pkg = await reviewedPackage();
    expect((await request(fixture.app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)))).status).toBe(200);
    const publish = () => request(fixture.app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
    return { ...fixture, publish };
  }

  it("builds the slot key's Register for the offline controller, once, and shows the agent", async () => {
    const chain = new MockChainProvider();
    const { app } = await publisher({ chain, targets: [identitySlot()], identityController: controller, registrar,
      identity: () => testIdentity(chain) });
    const built = await request(app).post("/targets/slot-a/record").set(AUTH);
    expect(built.status).toBe(200);
    expect(built.body).toMatchObject({ agent_id: AGENT_ID, agent_did: `did:vector:${AGENT_ID}`, state: "awaiting_signatures",
      tx_hash: "ab".repeat(32), missing_signers: [deriveSupplierKey(CONTROLLER.privateKeyHex, 0).pubKeyHash] });
    expect((await request(app).post("/targets/slot-a/record").set(AUTH)).body.tx_hash).toBe(built.body.tx_hash);
    expect((await request(app).get("/targets").set(AUTH)).body.targets[0].agent_id).toBe(AGENT_ID);
    expect((await request(app).get("/targets/slot-a/record").set(AUTH)).body.state).toBe("awaiting_signatures");
  });

  it("refuses a registration for a legacy slot, without a controller, or when the key is already listed", async () => {
    const chain = new MockChainProvider();
    const legacy = await publisher({ chain, identityController: controller, registrar });
    expect((await request(legacy.app).post("/targets/slot-a/record").set(AUTH)).body.error).toBe("identity_not_configured");
    const noController = await publisher({ chain, targets: [identitySlot()], registrar, identity: () => testIdentity(chain) });
    expect((await request(noController.app).post("/targets/slot-a/record").set(AUTH)).status).toBe(503);
    chain.seed(recordUtxo(supplierAgentRecord(deriveSupplierKey(KEY_A, 0), [PAPER2AGENT_CAPABILITY_ID])));
    const listed = await publisher({ chain, targets: [identitySlot()], identityController: controller, registrar,
      identity: () => testIdentity(chain) });
    const response = await request(listed.app).post("/targets/slot-a/record").set(AUTH);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("slot_record_exists");
  });

  it("publishes a new advert only after the slot record lists the key and the capability", async () => {
    const chain = new MockChainProvider();
    const postAdvert = vi.fn<NonNullable<PaperPublisherDeps["postAdvert"]>>();
    const missing = await prepared({ chain, targets: [identitySlot()], postAdvert, identity: () => testIdentity(chain) });
    const refused = await missing.publish();
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("slot_record_required");

    const configured = await prepared({ chain, targets: [identitySlot(AGENT_ID)], postAdvert, identity: () => testIdentity(chain) });
    const notFound = await configured.publish();
    expect(notFound.body.error).toBe("slot_record_invalid");
    expect(notFound.body.message).toMatch(/agent record not found/);
    expect(postAdvert).not.toHaveBeenCalled();
    expect((await request(configured.app).get(`/publications/${JOB_ID}`).set(AUTH)).body.state).toBe("prepared");

    chain.seed(recordUtxo(supplierAgentRecord(deriveSupplierKey(KEY_A, 0), [PAPER2AGENT_CAPABILITY_ID])));
    postAdvert.mockRejectedValue(new Error("stop before signing"));
    await configured.publish();
    expect(postAdvert).toHaveBeenCalledTimes(1);
    expect(postAdvert.mock.calls[0]![0].advertDatum).toMatchObject({ agent_id: AGENT_ID, supplier_pkh: deriveSupplierKey(KEY_A, 0).pubKeyHash });
    expect(postAdvert.mock.calls[0]![0].identity).toBeDefined();
  });
});

/** The publication and advert journal schema of the deployed publisher (commit 90b7a56): one advert per publication and per slot. */
const DEPLOYED_SCHEMA = `
CREATE TABLE publications (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('preparing', 'prepared', 'publishing', 'confirmation_pending', 'published', 'failed')),
  request_hash TEXT NOT NULL, terms_json TEXT NOT NULL, artifact_json TEXT NOT NULL, work_dir TEXT NOT NULL, runtime_image_id TEXT,
  supplier_pkh TEXT NOT NULL, deposit_address TEXT NOT NULL, endpoint_url TEXT NOT NULL, advert_ref TEXT, tx_hash TEXT,
  actual_debit_lovelace TEXT, error TEXT, prepared_at INTEGER, published_at INTEGER, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX publications_one_per_slot ON publications (target_id) WHERE phase <> 'failed' OR tx_hash IS NOT NULL;
CREATE TABLE advert_transactions (
  publication_id TEXT PRIMARY KEY REFERENCES publications (id), target_id TEXT NOT NULL UNIQUE, tx_hash TEXT NOT NULL UNIQUE,
  tx_cbor TEXT NOT NULL, advert_ref TEXT NOT NULL, advert_address TEXT NOT NULL, advert_datum_hex TEXT NOT NULL,
  wallet_inputs_json TEXT NOT NULL, fee_lovelace TEXT NOT NULL, wallet_debit_lovelace TEXT NOT NULL,
  max_debit_lovelace TEXT NOT NULL, valid_until_slot INTEGER, signed_at INTEGER NOT NULL, confirmed_at INTEGER
) WITHOUT ROWID;
CREATE TRIGGER advert_transactions_append_only BEFORE DELETE ON advert_transactions
BEGIN SELECT RAISE(ABORT, 'the advert transaction journal is append-only'); END;
CREATE TRIGGER advert_transactions_immutable BEFORE UPDATE ON advert_transactions
WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.tx_hash IS NOT OLD.tx_hash OR NEW.tx_cbor IS NOT OLD.tx_cbor
  OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
BEGIN SELECT RAISE(ABORT, 'a journaled advert transaction is immutable'); END;
CREATE TRIGGER publications_retained BEFORE DELETE ON publications
BEGIN SELECT RAISE(ABORT, 'publication records are retained'); END;
`;

describe("advert journal migration", () => {
  it("keeps every journaled advert as generation 1, one publication per slot, and the journal rules", () => {
    const path = join(temporary(), "publisher.db");
    const offer: AdvertDatum = { supplier_pkh: "aa".repeat(28), capability_id: PAPER2AGENT_CAPABILITY_ID, model: "paper2agent:test",
      max_output_tokens: 0, max_processing_ms: 280_000, price_lovelace: 200_000n, supplier_bond_lovelace: 1_000_000n,
      buyer_bond_lovelace: 1_000_000n, endpoint_url: `${PUBLIC_URL}/tools/slot-a`, detail_uri: "", detail_hash: "ab".repeat(32),
      advertised_at: 1_760_000_000_000, status: "Active" };
    const legacyDatum = encodeAdvertDatum(offer);
    const identityDatum = encodeIdentityAdvertDatum({ ...offer, agent_id: AGENT_ID });
    const inputs = JSON.stringify([{ ref: `${"dd".repeat(32)}#0`, lovelace: "10000000" }]);
    const old = new Database(path);
    old.exec(DEPLOYED_SCHEMA);
    const publication = old.prepare(`INSERT INTO publications (id, target_id, phase, request_hash, terms_json, artifact_json, work_dir,
      supplier_pkh, deposit_address, endpoint_url, advert_ref, tx_hash, actual_debit_lovelace, created_at, updated_at)
      VALUES (?, ?, ?, ?, '{}', '{}', ?, ?, 'addr_test1', ?, ?, ?, ?, 1, ?)`);
    const advert = old.prepare(`INSERT INTO advert_transactions (publication_id, target_id, tx_hash, tx_cbor, advert_ref, advert_address,
      advert_datum_hex, wallet_inputs_json, fee_lovelace, wallet_debit_lovelace, max_debit_lovelace, valid_until_slot, signed_at,
      confirmed_at) VALUES (?, ?, ?, ?, ?, 'addr_test1wadvert', ?, ?, '182488', '2682488', '3000000', 600, 2, ?)`);
    const rows = [["live", "slot-a", "published", "a1", legacyDatum, 3], ["identity", "slot-b", "published", "b1", identityDatum, 3],
      ["expired", "slot-c", "failed", "c1", legacyDatum, null]] as const;
    for (const [id, slot, phase, byte, datum, confirmed] of rows) {
      const hash = byte.repeat(32);
      publication.run(id, slot, phase, "0".repeat(64), `/data/${id}`, "aa".repeat(28), `${PUBLIC_URL}/tools/${slot}`, `${hash}#0`, hash,
        "2682488", phase === "failed" ? 9 : 4);
      advert.run(id, slot, hash, `cbor-${id}`, `${hash}#0`, datum, inputs, confirmed);
    }
    publication.run("unsigned", "slot-d", "prepared", "0".repeat(64), "/data/unsigned", "aa".repeat(28), `${PUBLIC_URL}/tools/slot-d`,
      null, null, null, 4);
    old.close();

    const store = PaperPublisherStore.open(path);
    expect(store.adverts("live")).toEqual([{ publication_id: "live", generation: 1, layout: "legacy", target_id: "slot-a",
      tx_hash: "a1".repeat(32), tx_cbor: "cbor-live", advert_ref: `${"a1".repeat(32)}#0`, advert_address: "addr_test1wadvert",
      advert_datum_hex: legacyDatum, wallet_inputs: JSON.parse(inputs), fee_lovelace: "182488", wallet_debit_lovelace: "2682488",
      max_debit_lovelace: "3000000", valid_until_slot: 600, signed_at: 2, confirmed_at: 3, switched_at: null, ended_at: null,
      end_reason: null }]);
    expect(store.publishAdvert("identity")).toMatchObject({ generation: 1, layout: "identity", ended_at: null });
    expect(store.publishAdvert("expired")).toMatchObject({ generation: 1, layout: "legacy", ended_at: 9, end_reason: "expired" });
    expect(store.adverts("unsigned")).toEqual([]);
    expect(store.get("live")).toMatchObject({ phase: "published", tx_hash: "a1".repeat(32), advert_ref: `${"a1".repeat(32)}#0` });

    expect(store.heldTargets()).toEqual(new Set(["slot-a", "slot-b", "slot-c", "slot-d"]));
    expect(() => store.create({ id: "second", target_id: "slot-a", request_hash: "1".repeat(64), terms: {} as PaperPublishTerms,
      artifact: {} as PaperPackageArtifact, work_dir: "/data/second", supplier_pkh: "aa".repeat(28), deposit_address: "addr_test1",
      endpoint_url: `${PUBLIC_URL}/tools/slot-a` }, 10)).toThrow("target_slot_in_use");
    const raw = new Database(path);
    expect(() => raw.prepare("DELETE FROM advert_transactions WHERE publication_id = 'live'").run()).toThrow(/append-only/);
    expect(() => raw.prepare("UPDATE advert_transactions SET tx_cbor = 'x' WHERE publication_id = 'live'").run()).toThrow(/immutable/);
    expect(() => raw.prepare("UPDATE advert_transactions SET end_reason = 'retired' WHERE publication_id = 'expired'").run())
      .toThrow(/immutable/);
    raw.close();

    // A published slot takes one live advert per layout; a re-advertisement is the next generation.
    const signed = (byte: string, layout: "legacy" | "identity", publicationId = "live", slot = "slot-a"): SignedAdvert => ({
      publication_id: publicationId, layout, target_id: slot, tx_hash: byte.repeat(32), tx_cbor: `cbor-${byte}`,
      advert_ref: `${byte.repeat(32)}#0`, advert_address: "addr_test1wnew", advert_datum_hex: identityDatum, wallet_inputs: [],
      fee_lovelace: "0", wallet_debit_lovelace: "0", max_debit_lovelace: "1", valid_until_slot: null, signed_at: 11 });
    expect(store.journalReadvert(signed("e1", "identity"))).toMatchObject({ generation: 2, layout: "identity", target_id: "slot-a" });
    expect(() => store.journalReadvert(signed("e2", "identity"))).toThrow("advert_layout_live");
    expect(() => store.journalReadvert(signed("e3", "legacy"))).toThrow("advert_layout_live");
    expect(() => store.journalReadvert(signed("e4", "identity", "unsigned", "slot-d"))).toThrow("publication_state_changed");
    // Retirements need a live advert of the journal; foreign keys are on again after the migration.
    const attempt = { tx_hash: "f1".repeat(32), publication_id: "expired", generation: 1, tx_cbor: "00", wallet_inputs: [],
      fee_lovelace: "0", wallet_debit_lovelace: "0", max_debit_lovelace: "1", valid_until_slot: null, signed_at: 12 };
    expect(() => store.journalRetirement(attempt)).toThrow(/not retired again/);
    expect(() => store.journalRetirement({ ...attempt, publication_id: "live", generation: 9 })).toThrow(/FOREIGN KEY/);
    store.close();

    const reopened = PaperPublisherStore.open(path);
    expect(reopened.adverts("live").map((row) => [row.generation, row.layout])).toEqual([[1, "legacy"], [2, "identity"]]);
    reopened.close();
  });
});

describe("identity re-advertisement of a published slot (Part 2 §9.6)", () => {
  const JOB_B = "7d6c5b4a-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
  const approval = { confirm: true, max_debit_lovelace: "5000000" };
  const readvert = (app: Express, body: object = approval) => request(app).post("/targets/slot-a/readvert").set(AUTH).send(body);
  const switchAdvert = (app: Express) => request(app).post("/targets/slot-a/switch").set(AUTH);
  const retireLegacy = (app: Express, body: object = approval) => request(app).post("/targets/slot-a/retire-legacy").set(AUTH).send(body);
  const adverts = (app: Express) => request(app).get("/targets/slot-a/adverts").set(AUTH);
  const outputOf = (ref: string) => ({ txHash: ref.split("#")[0]!, index: Number(ref.split("#")[1]) });
  const states = (rows: SlotAdvertView[]) => rows.map((row) => [row.generation, row.layout, row.state, row.serving]);

  /**
   * slot-a (and slot-b with secondSlot) published with legacy adverts by the
   * legacy release; then the publisher restarts with the identity settings of
   * slot-a. `record` (default) puts the record of AGENT_ID on chain; `register`
   * builds the slot's record registration first (a slot without AGENT_ID).
   */
  async function republished(options: { chain?: MockChainProvider; slot?: PublisherTarget; record?: boolean; register?: boolean;
    secondSlot?: boolean; postAdvert?: PaperPublisherDeps["postAdvert"] } = {}) {
    const chain = options.chain ?? new MockChainProvider();
    const dataDir = temporary();
    const legacySlots = [target("slot-a", KEY_A), ...(options.secondSlot ? [target("slot-b", KEY_B)] : [])];
    const legacy = await publisher({ dataDir, chain, targets: legacySlots });
    const pkg = await reviewedPackage();
    const legacyRefs: string[] = [];
    for (const [slot, job] of [["slot-a", JOB_ID], ["slot-b", JOB_B]].slice(0, legacySlots.length)) {
      expect((await request(legacy.app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact, slot), job))).status)
        .toBe(200);
      const published = await request(legacy.app).post(`/publications/${job}/publish`).set(AUTH)
        .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "5000000" });
      expect(published.body.state).toBe("published");
      legacyRefs.push(published.body.advert_ref);
    }
    await legacy.service.close();
    const settings = { dataDir, chain, images: legacy.images, targets: [options.slot ?? identitySlot(AGENT_ID), ...legacySlots.slice(1)],
      identity: () => testIdentity(chain), identityController: controller, registrar };
    const fixture = await publisher({ ...settings, postAdvert: options.postAdvert });
    await fixture.service.idle();
    if (options.register) expect((await request(fixture.app).post("/targets/slot-a/record").set(AUTH)).body.agent_id).toBe(AGENT_ID);
    if (options.record !== false) chain.seed(recordUtxo(supplierAgentRecord(deriveSupplierKey(KEY_A, 0), [PAPER2AGENT_CAPABILITY_ID])));
    /** A publisher restart on the same state and chain. */
    const restart = async (deps: Pick<Parameters<typeof publisher>[0] & object, "postAdvert" | "retireAdvert"> = {}) => {
      await fixture.service.close();
      const next = await publisher({ ...settings, ...deps });
      await next.service.idle();
      return next;
    };
    return { ...fixture, chain, pkg, legacyRef: legacyRefs[0]!, restart };
  }

  it("refuses an unpublished slot, a slot without identity settings or a listed record, and an unapproved request", async () => {
    const chain = new MockChainProvider();
    const unpublished = await publisher({ chain, targets: [identitySlot(AGENT_ID)], identity: () => testIdentity(chain) });
    expect((await readvert(unpublished.app)).body.error).toBe("slot_not_published");
    const pkg = await reviewedPackage();
    await request(unpublished.app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)));
    const prepared = await readvert(unpublished.app);
    expect([prepared.status, prepared.body.error]).toEqual([409, "slot_not_published"]);
    expect((await adverts(unpublished.app)).status).toBe(404);
    for (const call of [switchAdvert(unpublished.app), retireLegacy(unpublished.app)]) expect((await call).body.error).toBe("slot_not_published");

    const legacyOnly = await republished({ slot: target("slot-a", KEY_A) });
    const noRecord = await republished({ slot: identitySlot(), record: false });
    const unlisted = await republished({ record: false });
    const submits = [legacyOnly, noRecord, unlisted].map((fixture) => vi.spyOn(fixture.chain, "submitTx"));
    expect((await readvert(legacyOnly.app)).body.error).toBe("identity_not_configured");
    const required = await readvert(noRecord.app);
    expect([required.status, required.body.error]).toEqual([409, "slot_record_required"]);
    const invalid = await readvert(unlisted.app);
    expect([invalid.status, invalid.body.error]).toEqual([409, "slot_record_invalid"]);
    expect(invalid.body.message).toMatch(/agent record not found/);
    expect((await readvert(unlisted.app, { confirm: false, max_debit_lovelace: "5000000" })).body.error).toBe("confirmation_required");
    expect((await readvert(unlisted.app, { confirm: true })).status).toBe(400);
    expect((await adverts(unlisted.app)).body.adverts.map((row: SlotAdvertView) => row.layout)).toEqual(["legacy"]);
    for (const submit of submits) expect(submit).not.toHaveBeenCalled();
  });

  it("posts one identity advert with the publish advert's offer and keeps serving the legacy advert until the switch", async () => {
    const fixture = await republished();
    const submit = vi.spyOn(fixture.chain, "submitTx");
    const first = await readvert(fixture.app);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ target_id: "slot-a", publication_id: JOB_ID, agent_id: AGENT_ID,
      serving_advert_ref: fixture.legacyRef, child_advert_ref: fixture.legacyRef, error: null });
    expect(states(first.body.adverts)).toEqual([[1, "legacy", "live", true], [2, "identity", "live", false]]);
    const [legacy, identity] = first.body.adverts as SlotAdvertView[];
    expect(legacy).toMatchObject({ advert_ref: fixture.legacyRef, agent_id: null, retire_tx_hash: null });
    expect(identity).toMatchObject({ agent_id: AGENT_ID, advert_ref: `${identity!.tx_hash}#0`, switched_at: null });
    expect(submit).toHaveBeenCalledTimes(1);
    const legacyOutput = await fixture.chain.queryUtxo(outputOf(legacy!.advert_ref));
    const identityOutput = await fixture.chain.queryUtxo(outputOf(identity!.advert_ref));
    expect(identityOutput?.address).toBe(IDENTITY.advertScriptAddress(0));
    const posted = decodeIdentityAdvertDatum(identityOutput!.datumHex!);
    expect(posted).toEqual({ ...decodeAdvertDatum(legacyOutput!.datumHex!), advertised_at: posted.advertised_at, agent_id: AGENT_ID });

    // Repeats never sign again. The child still serves the legacy advert, and it was not restarted.
    const again = await readvert(fixture.app);
    expect(again.body.adverts).toEqual(first.body.adverts);
    expect((await adverts(fixture.app)).body.adverts).toEqual(first.body.adverts);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(fixture.launches).toHaveLength(1);
    expect(fixture.launches[0]!.signals).toEqual([]);
    expect((await request(fixture.app).get("/tools/slot-a/capability")).body.advert_ref).toBe(fixture.legacyRef);
  });

  it("reads a readvert lost between broadcast and confirmation from the chain after a restart, without signing again", async () => {
    const fixture = await republished();
    const broadcast = fixture.chain.submitTx.bind(fixture.chain);
    const atBroadcast: unknown[] = [];
    vi.spyOn(fixture.chain, "submitTx").mockImplementation(async (cbor) => {
      atBroadcast.push(states((await adverts(fixture.app)).body.adverts));
      return broadcast(cbor);
    });
    vi.spyOn(fixture.chain, "awaitTx").mockRejectedValue(new Error("awaitTx_timeout: not observed"));
    const lost = await readvert(fixture.app);
    expect(lost.status).toBe(200);
    expect(lost.body.error).toMatch(/outcome is unknown.*never signed again/);
    expect(states(lost.body.adverts)).toEqual([[1, "legacy", "live", true], [2, "identity", "pending", false]]);
    expect(atBroadcast).toEqual([[[1, "legacy", "live", true], [2, "identity", "pending", false]]]);
    vi.restoreAllMocks();

    const postAdvert = vi.fn<NonNullable<PaperPublisherDeps["postAdvert"]>>();
    const restarted = await fixture.restart({ postAdvert });
    const submit = vi.spyOn(fixture.chain, "submitTx");
    const resumed = await readvert(restarted.app);
    expect(resumed.body.error).toBeNull();
    expect(states(resumed.body.adverts)).toEqual([[1, "legacy", "live", true], [2, "identity", "live", false]]);
    expect(resumed.body.adverts[1].tx_hash).toBe(lost.body.adverts[1].tx_hash);
    expect(postAdvert).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("checks the readvert debit, ends an unconfirmed readvert only after the finality margin, then signs the next generation", async () => {
    const chain = new MockChainProvider();
    const input = fundWallet(chain, KEY_A, 10_000_000n);
    const fixture = await republished({ chain, postAdvert: walletFundedAdvert(input, 7_000_000n, 600_000) });
    const over = await readvert(fixture.app, { confirm: true, max_debit_lovelace: "2999999" });
    expect([over.status, over.body.error]).toEqual([409, "debit_exceeds_approval"]);
    expect(over.body.message).toContain("debits 3000000 lovelace");
    expect(states((await adverts(fixture.app)).body.adverts)).toEqual([[1, "legacy", "live", true]]);

    vi.spyOn(chain, "submitTx").mockRejectedValueOnce(new Error("socket hang up"));
    const lost = await readvert(fixture.app);
    expect(lost.body.adverts[1]).toMatchObject({ generation: 2, state: "pending", wallet_debit_lovelace: "3000000" });
    chain.advanceSlot(600 + 43_200);
    const within = await adverts(fixture.app);
    expect(within.body.adverts[1].state).toBe("pending");
    expect(within.body.error).toContain("cannot confirm after slot 600");
    expect((await readvert(fixture.app)).body.adverts).toHaveLength(2);

    chain.advanceSlot(1);
    const expired = await adverts(fixture.app);
    expect(expired.body.adverts[1]).toMatchObject({ generation: 2, state: "expired" });
    expect(expired.body.error).toMatch(/no funds moved/);
    const next = await readvert(fixture.app);
    expect(states(next.body.adverts)).toEqual([[1, "legacy", "live", true], [2, "identity", "expired", false],
      [3, "identity", "live", false]]);
    expect(await chain.queryUtxo(input)).toBeNull();
  });

  it("switches only that slot's child to the identity advert after its active work, durably", async () => {
    const fixture = await republished({ slot: identitySlot(), register: true, secondSlot: true });
    const identityRef = (await readvert(fixture.app)).body.adverts[1].advert_ref as string;
    const legacyChild = fixture.launches.find((launch) => launch.targetId === "slot-a")!;
    const otherChild = fixture.launches.find((launch) => launch.targetId === "slot-b")!;
    expect(legacyChild.env.ADVERT_REF).toBe(fixture.legacyRef);
    expect(legacyChild.env.AGENT_ID).toBeUndefined();

    legacyChild.activeSessions = 1;
    const switching = switchAdvert(fixture.app).then((reply) => reply);
    await until(() => legacyChild.statusPolls >= 2);
    const payload = { manifest_hash: fixture.pkg.artifact.manifest_hash, input: { value: "x" } };
    const refused = await request(fixture.app).post("/tools/slot-a/v1/paper2agent/run").set("X-Escrow-Ref", `${"e".repeat(64)}#0`).send(payload);
    expect([refused.status, refused.body.reason]).toEqual([503, "supplier_draining"]);
    expect((await request(fixture.app).get("/tools/slot-a/status")).status).toBe(200);
    expect((await request(fixture.app).post("/tools/slot-b/v1/paper2agent/run").set("X-Escrow-Ref", `${"e".repeat(64)}#1`)
      .send(payload)).status).toBe(202);
    expect(legacyChild.signals).toEqual([]);
    legacyChild.activeSessions = 0;
    const switched = await switching;
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ serving_advert_ref: identityRef, child_advert_ref: identityRef, error: null });
    expect(states(switched.body.adverts)).toEqual([[1, "legacy", "live", false], [2, "identity", "live", true]]);
    expect(legacyChild.signals).toEqual(["SIGTERM"]);
    const identityChild = fixture.launches.at(-1)!;
    expect(identityChild.targetId).toBe("slot-a");
    expect(identityChild.env).toMatchObject({ ADVERT_REF: identityRef, AGENT_ID, IDENTITY_POLICY_ID: IDENTITY.identityHash,
      CAPABILITY_KIND: "paper2agent" });
    expect(otherChild.signals).toEqual([]);
    expect(fixture.launches.filter((launch) => launch.targetId === "slot-b")).toHaveLength(1);
    expect((await request(fixture.app).get("/tools/slot-a/capability")).body).toMatchObject({ advert_ref: identityRef, agent_id: AGENT_ID });

    // A repeated switch restarts nothing; a publisher restart serves the identity advert.
    const launched = fixture.launches.length;
    expect((await switchAdvert(fixture.app)).body.child_advert_ref).toBe(identityRef);
    expect(fixture.launches).toHaveLength(launched);
    const restarted = await fixture.restart();
    expect(restarted.launches.find((launch) => launch.targetId === "slot-a")!.env).toMatchObject({ ADVERT_REF: identityRef, AGENT_ID });
    expect(restarted.launches.find((launch) => launch.targetId === "slot-b")!.env.ADVERT_REF).not.toBe(identityRef);
  });

  it("refuses a switch before the identity advert is confirmed", async () => {
    const fixture = await republished();
    const missing = await switchAdvert(fixture.app);
    expect([missing.status, missing.body.error]).toEqual([409, "identity_advert_missing"]);
    vi.spyOn(fixture.chain, "submitTx").mockRejectedValueOnce(new Error("socket hang up"));
    await readvert(fixture.app);
    const pending = await switchAdvert(fixture.app);
    expect([pending.status, pending.body.error]).toEqual([409, "identity_advert_pending"]);
    expect(fixture.launches).toHaveLength(1);
  });

  it("retires the legacy advert only while the identity advert is live, once", async () => {
    const fixture = await republished();
    const submit = vi.spyOn(fixture.chain, "submitTx");
    const early = await retireLegacy(fixture.app);
    expect([early.status, early.body.error]).toEqual([409, "identity_advert_not_live"]);
    expect(early.body.message).toMatch(/no confirmed identity advert/);
    await readvert(fixture.app);
    const unswitched = await retireLegacy(fixture.app);
    expect([unswitched.status, unswitched.body.error]).toEqual([409, "identity_advert_not_live"]);
    expect(unswitched.body.message).toMatch(/has not switched/);
    await switchAdvert(fixture.app);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await fixture.chain.queryUtxo(outputOf(fixture.legacyRef))).not.toBeNull();

    const retired = await retireLegacy(fixture.app);
    expect(retired.status).toBe(200);
    expect(retired.body.error).toBeNull();
    expect(states(retired.body.adverts)).toEqual([[1, "legacy", "retired", false], [2, "identity", "live", true]]);
    const retireTx = retired.body.adverts[0].retire_tx_hash as string;
    expect(await fixture.chain.queryUtxo(outputOf(fixture.legacyRef))).toBeNull();
    expect(await fixture.chain.queryUtxo({ txHash: retireTx, index: 0 }))
      .toMatchObject({ address: deriveSupplierKey(KEY_A, 0).address, lovelace: 1_000_000n });
    expect(submit).toHaveBeenCalledTimes(2);
    const again = await retireLegacy(fixture.app);
    expect(again.body.adverts).toEqual(retired.body.adverts);
    expect(submit).toHaveBeenCalledTimes(2);
    expect((await request(fixture.app).get("/tools/slot-a/capability")).body.advert_ref).toBe(retired.body.adverts[1].advert_ref);
  });

  it("refuses to retire while no ready child serves the identity advert", async () => {
    const fixture = await republished();
    await readvert(fixture.app);
    await switchAdvert(fixture.app);
    const submit = vi.spyOn(fixture.chain, "submitTx");
    // The identity child exits; no request has started it again yet.
    fixture.launches.at(-1)!.crash();
    const refused = await retireLegacy(fixture.app);
    expect([refused.status, refused.body.error]).toEqual([409, "identity_advert_not_live"]);
    expect(refused.body.message).toMatch(/no ready supplier serves identity advert/);
    expect(refused.body.message).toContain("Nothing was broadcast");
    expect(submit).not.toHaveBeenCalled();
    expect(await fixture.chain.queryUtxo(outputOf(fixture.legacyRef))).not.toBeNull();
  });

  it("reads a lost RetireAdvert outcome from the chain, sends the same bytes again while they can confirm, and never signs anew", async () => {
    const retireCalls: unknown[] = [];
    const fixture = await republished();
    await readvert(fixture.app);
    await switchAdvert(fixture.app);
    // The node rejects the first broadcast: the journaled attempt stays valid (the mock body has no expiry).
    vi.spyOn(fixture.chain, "submitTx").mockRejectedValueOnce(new Error("socket hang up"));
    const lost = await retireLegacy(fixture.app);
    expect(lost.status).toBe(200);
    expect(lost.body.error).toMatch(/outcome is unknown/);
    expect(states(lost.body.adverts)[0]).toEqual([1, "legacy", "retiring", false]);
    const attempt = lost.body.adverts[0].retire_tx_hash as string;
    expect(await fixture.chain.queryUtxo(outputOf(fixture.legacyRef))).not.toBeNull();
    vi.restoreAllMocks();

    const restarted = await fixture.restart({ retireAdvert: async (params) => { retireCalls.push(params); throw new Error("not again"); } });
    const submit = vi.spyOn(fixture.chain, "submitTx");
    const resent = await retireLegacy(restarted.app);
    expect(resent.body.error).toBeNull();
    expect(states(resent.body.adverts)).toEqual([[1, "legacy", "retired", false], [2, "identity", "live", true]]);
    expect(resent.body.adverts[0].retire_tx_hash).toBe(attempt);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(retireCalls).toEqual([]);
  });

  it("settles a RetireAdvert that confirmed while the publisher was down", async () => {
    const fixture = await republished();
    await readvert(fixture.app);
    await switchAdvert(fixture.app);
    vi.spyOn(fixture.chain, "awaitTx").mockRejectedValueOnce(new Error("awaitTx_timeout: not observed"));
    const lost = await retireLegacy(fixture.app);
    const attempt = lost.body.adverts[0].retire_tx_hash as string;
    expect(await fixture.chain.queryUtxo(outputOf(fixture.legacyRef))).toBeNull();
    vi.restoreAllMocks();

    const restarted = await fixture.restart();
    const settled = await adverts(restarted.app);
    expect(states(settled.body.adverts)).toEqual([[1, "legacy", "retired", false], [2, "identity", "live", true]]);
    expect(settled.body.adverts[0].retire_tx_hash).toBe(attempt);
  });
});
