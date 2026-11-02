/**
 * advert-eval.test.ts — the real compiled new advert (Part 2 §6.2) runs
 * offline (`aiken tx simulate`, through tests/legacy-registry/harness)
 * against the UpdateAdvert and RetireAdvert transactions that the shared
 * builders produce.
 *
 * - The advert script: contracts/identity-marketplace (advert.advert.spend,
 *   no parameter); inline in the witness set, and as a reference script
 *   (IDENTITY_ADVERT_REF_UTXO).
 * - PostAdvert writes the advert output and runs no script; its output is
 *   the input of UpdateAdvert, whose output is the input of RetireAdvert.
 * - Negative controls evaluate a passing transaction against a changed
 *   advert input, to show that the script checks what the builders rely on.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aikenVersion, describeSimulation } from "../legacy-registry/harness/index.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import {
  decodeIdentityAdvertDatum, encodeIdentityAdvertDatum, type IdentityAdvertDatum,
} from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import type { IdentityBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import {
  buildPostAdvertTx, buildRetireAdvertTx, buildUpdateAdvertTx, type BuildResult, type RecordLookup,
} from "../../packages/shared/src/tx/index.js";
import { pkhToEnterpriseAddress } from "../../packages/shared/src/tx/internal/pkhAddress.js";
import { testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";
import {
  agentRecord, AP3X, FakeOgmios, identityAdvert, outputOf, recordUtxo, testWallet, VECTOR_MAINNET_ZERO_TIME_MS,
} from "../fixtures/identity-builders/world.js";
import { evaluateBuiltTx } from "./evaluate.js";

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0, 500);
const SCRIPT_REF: OutputReference = { txHash: "5c".repeat(32), index: 1 };

const supplier = testWallet("advert eval supplier");
const controller = testWallet("advert eval controller");
const stranger = testWallet("advert eval stranger");

let blueprint: IdentityBlueprint;
let ogmios: FakeOgmios;
let lookupRecord: RecordLookup;
const results: Array<{ mode: string; redeemer: string; mem?: number; cpu?: number }> = [];

const MODES = ["inline script", "reference script"] as const;
type Mode = (typeof MODES)[number];

beforeAll(() => {
  expect(aikenVersion()).toMatch(/^aiken v1\.1\.21/);
  blueprint = testIdentityBlueprint();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("VECTOR_ZERO_TIME_MS", String(VECTOR_MAINNET_ZERO_TIME_MS));
  vi.stubEnv("IDENTITY_ADVERT_REF_UTXO", "");
  ogmios = new FakeOgmios();
  ogmios.fund(supplier, 100n * AP3X, 6n * AP3X);
  const record = recordUtxo(blueprint, agentRecord(controller, supplier));
  lookupRecord = async () => record;
  // As Ogmios evaluateTransaction: run the scripts of the draft, give the budget or the failure.
  ogmios.evaluate = (tx) => {
    const simulation = evaluateBuiltTx(tx, ogmios.utxos.values(), "advert");
    if (!simulation.passed) return { code: 3010, message: describeSimulation(simulation) };
    return simulation.verdicts.map((verdict) => ({
      validator: { purpose: "spend" as const, index: Number(/\[(\d+)\]/.exec(verdict.purpose)![1]) },
      budget: { memory: verdict.mem!, cpu: verdict.cpu! },
    }));
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  // One line per evaluated redeemer: the execution units (memory / CPU) of the final signed transaction.
  console.info(results.map((r) => `[advert-eval] ${r.mode} | ${r.redeemer} | ${r.mem} / ${r.cpu}`).join("\n"));
});

function useScript(mode: Mode): void {
  if (mode !== "reference script") return;
  ogmios.add({
    ref: SCRIPT_REF,
    address: pkhToEnterpriseAddress("00".repeat(28), 1),
    lovelace: 10n * AP3X,
    assets: {},
    datumHex: null,
    scriptRef: blueprint.advertCompiledCode,
  });
  vi.stubEnv("IDENTITY_ADVERT_REF_UTXO", `${SCRIPT_REF.txHash}#${SCRIPT_REF.index}`);
}

/** Output `index` of a built transaction, now on the test chain. */
function take(built: BuildResult, index = 0): Utxo {
  const utxo = outputOf(built.txCborHex, built.expectedTxHash, index);
  ogmios.add(utxo);
  return utxo;
}

/** Builds with the live builder and evaluates the signed transaction once more; it must pass. */
async function passes(mode: Mode, redeemer: string, build: () => Promise<BuildResult>): Promise<BuildResult> {
  const built = await build();
  const simulation = evaluateBuiltTx(built.txCborHex, ogmios.utxos.values(), redeemer);
  expect(simulation.passed, describeSimulation(simulation)).toBe(true);
  results.push({ mode, redeemer, mem: simulation.verdicts[0]!.mem, cpu: simulation.verdicts[0]!.cpu });
  return built;
}

/** The same signed transaction with the advert input's datum changed: the script must reject it. */
function rejectsWith(built: BuildResult, input: Utxo, datum: IdentityAdvertDatum): void {
  const utxos = new Map([...ogmios.utxos.values()].map((u) => [`${u.ref.txHash}#${u.ref.index}`, u]));
  utxos.set(`${input.ref.txHash}#${input.ref.index}`, { ...input, datumHex: encodeIdentityAdvertDatum(datum) });
  const simulation = evaluateBuiltTx(built.txCborHex, utxos.values(), "advert");
  expect(simulation.passed).toBe(false);
  expect(simulation.verdicts[0]!.reason).toMatch(/validator crashed|exited prematurely/);
}

describe.each(MODES)("new advert, %s", (mode) => {
  beforeEach(() => useScript(mode));

  it("UpdateAdvert keeps agent_id and passes; RetireAdvert passes", async () => {
    const advert = identityAdvert(supplier, { advertised_at: NOW_MS });
    const posted = take(await buildPostAdvertTx({
      chain: ogmios.chain(), walletKey: supplier, advertDatum: advert, deposit_lovelace: 2n * AP3X,
      lookupRecord, identityBlueprint: blueprint,
    }));
    expect(posted.address).toBe(blueprint.advertScriptAddress(1));

    vi.setSystemTime(NOW_MS + 60_000);
    const next: IdentityAdvertDatum = { ...advert, price_lovelace: 3n * AP3X, advertised_at: NOW_MS + 60_000 };
    const updatedTx = await passes(mode, "UpdateAdvert", () => buildUpdateAdvertTx({
      chain: ogmios.chain(), walletKey: supplier, advertRef: posted.ref, newAdvertDatum: next, deposit_lovelace: 2n * AP3X,
      lookupRecord, identityBlueprint: blueprint,
    }));
    const updated = take(updatedTx);
    expect(decodeIdentityAdvertDatum(updated.datumHex!)).toEqual(next);
    // With another agent_id in the spent advert, the same update changes agent_id: the script rejects it.
    rejectsWith(updatedTx, posted, { ...advert, agent_id: "11".repeat(32) });

    vi.setSystemTime(NOW_MS + 120_000);
    const retiredTx = await passes(mode, "RetireAdvert", () =>
      buildRetireAdvertTx({ chain: ogmios.chain(), walletKey: supplier, advertRef: updated.ref, identityBlueprint: blueprint }));
    // With another supplier in the spent advert, its key neither signs nor gets an output: the script rejects it.
    rejectsWith(retiredTx, updated, { ...next, supplier_pkh: stranger.pubKeyHash });
  });
});
