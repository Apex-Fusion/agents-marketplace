/**
 * publisher-readvert-live.test.ts — the re-advertisement of a published slot
 * with the real shared builders (lucid, Vector mainnet network) over a fake
 * Ogmios with a ledger. Each transaction is evaluated offline by
 * `aiken tx simulate` (evaluateBuiltTx of tests/legacy-registry/harness), as
 * the identity builder tests do, and so is each draft that a builder sends to
 * evaluateTransaction:
 * - publish: the legacy PostAdvert (no script runs);
 * - readvert: the identity-layout PostAdvert for the slot's record (no script runs);
 * - retire-legacy: RetireAdvert, which runs the legacy advert script.
 *
 * Needs `aiken` v1.1.21 on PATH. Nothing goes to a network. Every key comes
 * from a public label or a fixed test value and controls nothing on any network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { transactionId } from "@marketplace/shared";
import { LiveOgmiosProvider, type Utxo } from "@marketplace/shared/chain";
import { decodeIdentityAdvertDatum } from "@marketplace/shared/cbor";
import { utf8ToHex } from "@marketplace/shared/identity";
import { PAPER2AGENT_CAPABILITY_ID } from "@marketplace/shared/paper2agent";
import { inspectSignedTransactionFinancials } from "@marketplace/shared/tx/server";
import { supplierIdentity } from "../../supplier/src/identity/agent.js";
import { deriveSupplierKey } from "../../supplier/src/paper2agent/identity.js";
import { aikenVersion, describeSimulation, type Simulation } from "../../tests/legacy-registry/harness/index.js";
import { evaluateBuiltTx } from "../../tests/legacy-registry/harness/identity.js";
import { testIdentityBlueprint } from "../../tests/fixtures/identity-builders/blueprint.js";
import {
  AGENT_ID, AP3X, FakeOgmios, VECTOR_MAINNET_ZERO_TIME_MS, agentRecord, outputOf, recordUtxo, testWallet,
} from "../../tests/fixtures/identity-builders/world.js";
import { PublisherTarget } from "../src/publisher-config.js";
import { AUTH, JOB_ID, PUBLIC_URL, cleanup, preparation, publisher, reviewedPackage, temporary, terms } from "./publisher-fixtures.js";

const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0, 500);
const SLOT_KEY = "5a".repeat(32);
const blueprint = testIdentityBlueprint();
const controller = testWallet("paper2agent publisher readvert controller");

/** slot-a on the Vector mainnet network; with `identity`, the identity release settings and AGENT_ID. */
function slot(identity: boolean): PublisherTarget {
  return new PublisherTarget("slot-a", "Slot slot-a", {
    SUPPLIER_PRIV_KEY_HEX: SLOT_KEY, NETWORK_ID: "1", OGMIOS_URL: "http://ogmios.invalid", LIVE_CHAIN: "1",
    VECTOR_ZERO_TIME_MS: String(VECTOR_MAINNET_ZERO_TIME_MS),
    ...(identity ? { IDENTITY_POLICY_ID: blueprint.identityHash, AGENT_ID } : {}),
  }, PUBLIC_URL);
}

/**
 * FakeOgmios with a ledger: submitTransaction spends the inputs and adds the
 * outputs under the transaction ID. `history` keeps every output, spent or
 * not, so that aiken can resolve the inputs of an applied transaction.
 */
class LedgerOgmios extends FakeOgmios {
  readonly history = new Map<string, Utxo>();
  readonly transactions = new Map<string, string>();

  override add(...utxos: Utxo[]): void {
    super.add(...utxos);
    for (const utxo of utxos) this.history.set(`${utxo.ref.txHash}#${utxo.ref.index}`, utxo);
  }

  override chain(): LiveOgmiosProvider {
    return new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios.invalid", fetch: async (url, init) => {
      // Our own Ogmios provider sends these requests.
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { transaction?: { cbor?: string } } };
      if (body.method !== "submitTransaction") return this.fetch(url, init);
      const tx = body.params?.transaction?.cbor ?? "";
      const id = transactionId(tx);
      for (const input of inspectSignedTransactionFinancials(tx).inputs) {
        const key = `${input.txHash}#${input.index}`;
        if (!this.utxos.delete(key)) throw new Error(`ledger: transaction ${id} spends ${key}, which the ledger does not hold`);
      }
      inspectSignedTransactionFinancials(tx).outputs.forEach((_output, index) => this.add(outputOf(tx, id, index)));
      this.transactions.set(id, tx);
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { transaction: { id } } }),
        { headers: { "content-type": "application/json" } });
    } });
  }

  /** aiken's run of an applied transaction against the outputs that it spends. */
  simulate(txHash: string): Simulation {
    const tx = this.transactions.get(txHash);
    if (tx === undefined) throw new Error(`the ledger did not apply ${txHash}`);
    return evaluateBuiltTx(tx, this.history.values(), "advert");
  }
}

beforeAll(() => {
  expect(aikenVersion()).toMatch(/^aiken v1\.1\.21/);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("VECTOR_ZERO_TIME_MS", String(VECTOR_MAINNET_ZERO_TIME_MS));
  // The test chain holds no reference scripts: the builders put the scripts in the witness set.
  vi.stubEnv("ADVERT_REF_UTXO", "");
  vi.stubEnv("IDENTITY_ADVERT_REF_UTXO", "");
});

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("identity re-advertisement with the shared builders, evaluated by aiken", () => {
  it("publishes a legacy advert, posts the identity advert, switches the child and retires the legacy advert", async () => {
    const ledger = new LedgerOgmios();
    const drafts: Simulation[] = [];
    // As Ogmios evaluateTransaction: run the scripts of a draft, give the budgets or the failure.
    ledger.evaluate = (tx) => {
      const simulation = evaluateBuiltTx(tx, ledger.history.values(), "advert");
      drafts.push(simulation);
      if (!simulation.passed) return { code: 3010, message: describeSimulation(simulation) };
      return simulation.verdicts.map((verdict) => ({
        validator: { purpose: "spend" as const, index: Number(/\[(\d+)\]/.exec(verdict.purpose)![1]) },
        budget: { memory: verdict.mem!, cpu: verdict.cpu! },
      }));
    };
    const slotKey = deriveSupplierKey(SLOT_KEY, 1);
    ledger.fund(slotKey, 20n * AP3X, 6n * AP3X);
    const chain = ledger.chain();
    const dataDir = temporary();

    // The legacy release publishes the tool.
    const legacy = await publisher({ dataDir, chain, targets: [slot(false)] });
    const pkg = await reviewedPackage();
    expect((await request(legacy.app).post("/publications").set(AUTH).send(preparation(pkg, terms(pkg.artifact)))).status).toBe(200);
    const published = await request(legacy.app).post(`/publications/${JOB_ID}/publish`).set(AUTH)
      .send({ artifact_sha256: pkg.artifact.sha256, confirm: true, max_debit_lovelace: "3000000" });
    expect(published.body).toMatchObject({ state: "published", error: null });
    const legacyRef = published.body.advert_ref as string;
    const postedLegacy = ledger.simulate(published.body.tx_hash);
    expect(postedLegacy.passed, describeSimulation(postedLegacy)).toBe(true);
    expect(postedLegacy.verdicts).toEqual([]);
    await legacy.service.close();

    // The identity release: the slot's record lists the slot key and the capability.
    ledger.add(recordUtxo(blueprint, agentRecord(controller, slotKey, { capabilities: [utf8ToHex(PAPER2AGENT_CAPABILITY_ID)] })));
    const fixture = await publisher({ dataDir, chain, images: legacy.images, targets: [slot(true)],
      identity: () => supplierIdentity(chain, 1, { blueprint }) });
    await fixture.service.idle();
    expect(fixture.launches[0]!.env.ADVERT_REF).toBe(legacyRef);

    const readvert = await request(fixture.app).post("/targets/slot-a/readvert").set(AUTH)
      .send({ confirm: true, max_debit_lovelace: "3000000" });
    expect(readvert.status).toBe(200);
    expect(readvert.body.error).toBeNull();
    const identity = readvert.body.adverts[1];
    expect(identity).toMatchObject({ generation: 2, layout: "identity", agent_id: AGENT_ID, state: "live", serving: false });
    expect(BigInt(identity.wallet_debit_lovelace)).toBeGreaterThan(2n * AP3X);
    expect(BigInt(identity.wallet_debit_lovelace)).toBeLessThanOrEqual(3n * AP3X);
    const postedIdentity = ledger.simulate(identity.tx_hash);
    expect(postedIdentity.passed, describeSimulation(postedIdentity)).toBe(true);
    expect(postedIdentity.verdicts).toEqual([]);
    const identityOutput = ledger.utxos.get(identity.advert_ref)!;
    expect(identityOutput.address).toBe(blueprint.advertScriptAddress(1));
    expect(decodeIdentityAdvertDatum(identityOutput.datumHex!)).toMatchObject({ agent_id: AGENT_ID,
      supplier_pkh: slotKey.pubKeyHash, capability_id: PAPER2AGENT_CAPABILITY_ID, endpoint_url: `${PUBLIC_URL}/tools/slot-a`,
      price_lovelace: 2_000_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n,
      detail_hash: pkg.artifact.manifest_hash });

    const switched = await request(fixture.app).post("/targets/slot-a/switch").set(AUTH);
    expect(switched.body).toMatchObject({ serving_advert_ref: identity.advert_ref, child_advert_ref: identity.advert_ref, error: null });
    expect(fixture.launches.at(-1)!.env).toMatchObject({ ADVERT_REF: identity.advert_ref, AGENT_ID });

    // The approval bounds the worst case, the collateral: a lower one is refused before broadcast.
    const low = await request(fixture.app).post("/targets/slot-a/retire-legacy").set(AUTH)
      .send({ confirm: true, max_debit_lovelace: "1000000" });
    expect([low.status, low.body.error]).toEqual([409, "debit_exceeds_approval"]);
    expect(ledger.utxos.has(legacyRef)).toBe(true);
    const retired = await request(fixture.app).post("/targets/slot-a/retire-legacy").set(AUTH)
      .send({ confirm: true, max_debit_lovelace: "5000000" });
    expect(retired.status).toBe(200);
    expect(retired.body.error).toBeNull();
    expect(retired.body.adverts.map((row: { layout: string; state: string }) => [row.layout, row.state]))
      .toEqual([["legacy", "retired"], ["identity", "live"]]);
    const retireTx = retired.body.adverts[0].retire_tx_hash as string;
    const retirement = ledger.simulate(retireTx);
    expect(retirement.passed, describeSimulation(retirement)).toBe(true);
    expect(retirement.verdicts).toHaveLength(1);
    expect(ledger.utxos.has(legacyRef)).toBe(false);
    expect(ledger.utxos.has(identity.advert_ref)).toBe(true);
    // The retired deposit came back to the slot wallet, less the fee.
    const refund = ledger.utxos.get(`${retireTx}#0`)!;
    expect(refund.address).toBe(slotKey.address);
    expect(drafts.every((draft) => draft.passed)).toBe(true);
    expect(drafts.some((draft) => draft.verdicts.length === 1)).toBe(true);
  }, 120_000);
});
