/**
 * Adopt builder (Part 2 §3.4, §9.1): a legacy record made by a rule-following
 * legacy Register under the deployed legacy script adopts into the identity
 * registry in one transaction (legacy Deregister + legacy Burn + identity
 * Adopt). Every positive case is evaluated with `aiken tx simulate`; the
 * builder refuses what the contracts reject, before it builds.
 */
import { describe, expect, it } from "vitest";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import type { Party } from "../../packages/shared/src/cbor/IdentityDatum.js";
import {
  buildAdopt, LEGACY_CHANGE_MIN, paymentCredential, readRecord, TxConstructionError, type AdoptArgs, type UnsignedTx,
} from "../../packages/shared/src/identity/tx/index.js";
import { allowlistRoot } from "../../packages/shared/src/identity/allowlist.js";
import { utf8FromHex } from "../../packages/shared/src/identity/id.js";
import {
  bech32Address, constr, encodeData, LEGACY_ADDRESS, LEGACY_HASH, LEGACY_MIN_DEPOSIT, simulate, toHex, type Data,
} from "../legacy-registry/harness/index.js";
import { describeSimulation } from "../legacy-registry/harness/simulate.js";
import {
  AP3X, identityWorld, legacyIdOf, reportEvaluation, sharedUtxo, simulateUnsigned, TEST_ALLOWLIST, testContext,
  testWallet, testWindow, walletFunds, type TestWallet,
} from "../legacy-registry/harness/identity.js";
import { funds, newWallet, profile, registerTx, type Wallet } from "../legacy-registry/scenario.js";

const world = identityWorld();
const window = testWindow();

const accountable = (signer: Party["signer"], rights = 3, role: Party["role"] = "Accountable"): Party => ({
  role,
  signer,
  organisation: null,
  notBefore: window.lo - 60_000,
  notAfter: null,
  rights,
  removalAfter: null,
});

/** A legacy record that a rule-following legacy Register created under the deployed script. */
function legacyRecord(owner: Wallet, label: string, changes: Parameters<typeof profile>[1] = {}): Utxo {
  const seed = funds(label, owner, LEGACY_MIN_DEPOSIT + 20n * AP3X);
  const register = registerTx(owner, seed, profile(owner, changes));
  const result = simulate(register);
  if (!result.passed) throw new Error(`legacy Register of ${label} fails: ${describeSimulation(result)}`);
  return sharedUtxo(register.utxo(0));
}

/** The owner as a builder wallet (the same throwaway key as `newWallet`). */
const asTestWallet = (label: string): TestWallet => testWallet(label);

function evaluate(tx: UnsignedTx, utxos: Utxo[], keys: TestWallet[]) {
  const result = simulateUnsigned(tx, [...world.utxos, ...utxos], keys.map((k) => k.key));
  reportEvaluation(expect.getState().currentTestName ?? "", tx, result);
  expect(result.passed, `${describeSimulation(result)}\n${result.error ?? ""}`).toBe(true);
  return result;
}

const refusal = (run: () => unknown): TxConstructionError => {
  try {
    run();
  } catch (error) {
    if (error instanceof TxConstructionError) return error;
    throw error;
  }
  throw new Error("the builder did not refuse");
};

/** The owner output of the legacy change rule: one output of at least 10 AP3X to the owner's key hash. */
const ownerOutputs = (tx: UnsignedTx, ownerHash: string) =>
  tx.outputs.filter((o) => paymentCredential(o.address)?.hash === ownerHash && o.lovelace >= LEGACY_CHANGE_MIN);

describe("Adopt (§3.4, §9.1)", () => {
  it("adopts a legacy record: profile copy, owner change in the change output, all three redeemers pass", () => {
    const label = "adopt: plain";
    const ownerWallet = newWallet("adopt owner plain");
    const owner = asTestWallet("adopt owner plain");
    const controller = testWallet("adopt controller plain");
    const record = legacyRecord(ownerWallet, label);
    const fundsUtxo = walletFunds("adopt: plain owner funds", owner, 30n * AP3X);
    const tx = buildAdopt(testContext(owner, [fundsUtxo]), world.adoptionScripts, {
      legacyRecord: record,
      allowlist: TEST_ALLOWLIST,
      window,
      controller: controller.publicKey,
      parties: [accountable({ type: "ControllerSet" })],
    });
    expect(tx.id).toBe(legacyIdOf(label));
    expect(tx.requiredSigners).toEqual([owner.keyHash, controller.keyHash].sort());
    expect(ownerOutputs(tx, owner.keyHash)).toHaveLength(1);
    const result = evaluate(tx, [record, fundsUtxo], [owner, controller]);
    expect(result.verdicts.map((v) => v.label).sort()).toEqual(["identity Adopt", "legacy Burn", "legacy Deregister"]);
    const created = readRecord(tx.outputs[tx.recordOutput]!, world.identity.hash);
    expect(created.id).toBe(legacyIdOf(label));
    expect(created.datum.lineage).toEqual({ type: "Root" });
    expect(utf8FromHex(created.datum.name)).toBe("Legacy Test Agent");
    expect(created.datum.capabilities.map(utf8FromHex)).toEqual(["ocr.page.extract.v1"]);
    expect(utf8FromHex(created.datum.endpoint)).toBe("https://agent.example/a2a");
  });

  it("needs exactly 10 AP3X plus the fee from the owner; one base unit less is refused", () => {
    const label = "adopt: owner change";
    const ownerWallet = newWallet("adopt owner change");
    const owner = asTestWallet("adopt owner change");
    const record = legacyRecord(ownerWallet, label);
    const args: AdoptArgs = {
      legacyRecord: record,
      allowlist: TEST_ALLOWLIST,
      window,
      controller: owner.publicKey,
      parties: [accountable({ type: "ControllerSet" })],
    };
    const probe = buildAdopt(testContext(owner, [walletFunds("adopt: probe", owner, 100n * AP3X)]), world.adoptionScripts, args);
    const exact = walletFunds("adopt: exact funds", owner, LEGACY_CHANGE_MIN + probe.fee);
    const tx = buildAdopt(testContext(owner, [exact]), world.adoptionScripts, args);
    expect(tx.fee).toBe(probe.fee);
    expect(tx.outputs.map((o) => o.lovelace)).toEqual([record.lovelace, LEGACY_CHANGE_MIN]);
    evaluate(tx, [record, exact], [owner]);
    const short = walletFunds("adopt: short funds", owner, LEGACY_CHANGE_MIN + probe.fee - 1n);
    expect(refusal(() => buildAdopt(testContext(owner, [short]), world.adoptionScripts, args)).reason).toBe("insufficient_funds");
  });

  it("pays the 10 AP3X owner output separately when the change goes elsewhere", () => {
    const label = "adopt: refusals";
    const ownerWallet = newWallet("adopt owner separate");
    const owner = asTestWallet("adopt owner separate");
    const payer = testWallet("adopt payer separate");
    const record = legacyRecord(ownerWallet, label);
    const payerFunds = walletFunds("adopt: payer funds", payer, 40n * AP3X);
    const tx = buildAdopt(testContext(payer, [payerFunds]), world.adoptionScripts, {
      legacyRecord: record,
      allowlist: TEST_ALLOWLIST,
      window,
      controller: owner.publicKey,
      parties: [accountable({ type: "ControllerSet" })],
    });
    const owned = ownerOutputs(tx, owner.keyHash);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.lovelace).toBe(LEGACY_CHANGE_MIN);
    expect(owned[0]!.address).toBe(bech32Address(ownerWallet.address));
    evaluate(tx, [record, payerFunds], [owner, payer]);
  });

  it("copies the valid legacy fields and takes caller values for fields over the limits", () => {
    const label = "adopt: long profile";
    const ownerWallet = newWallet("adopt owner long");
    const owner = asTestWallet("adopt owner long");
    const record = legacyRecord(ownerWallet, label, {
      name: "N".repeat(100),
      description: "D".repeat(300),
      capabilities: ["c".repeat(100), "ok.capability.v1"],
    });
    const fundsUtxo = walletFunds("adopt: long owner funds", owner, 40n * AP3X);
    const base: AdoptArgs = {
      legacyRecord: record,
      allowlist: TEST_ALLOWLIST,
      window,
      controller: owner.publicKey,
      parties: [accountable({ type: "ControllerSet" })],
    };
    const refused = refusal(() => buildAdopt(testContext(owner, [fundsUtxo]), world.adoptionScripts, base));
    expect(refused.reason).toBe("legacy_profile_over_limits");
    expect(refused.message).toContain("name, description, capabilities");
    const tx = buildAdopt(testContext(owner, [fundsUtxo]), world.adoptionScripts, {
      ...base,
      profile: { name: "Short name", description: "Short description", capabilities: ["ok.capability.v1"] },
    });
    evaluate(tx, [record, fundsUtxo], [owner]);
    const created = readRecord(tx.outputs[tx.recordOutput]!, world.identity.hash).datum;
    expect(utf8FromHex(created.name)).toBe("Short name");
    expect(utf8FromHex(created.framework)).toBe("vector-agent");
  });

  it("appoints Module-1 as Accountable Party with its consent and the configuration reference input", () => {
    const label = "adopt: module-1";
    const ownerWallet = newWallet("adopt owner module-1");
    const owner = asTestWallet("adopt owner module-1");
    const record = legacyRecord(ownerWallet, label);
    const fundsUtxo = walletFunds("adopt: module-1 owner funds", owner, 40n * AP3X);
    const tx = buildAdopt(testContext(owner, [fundsUtxo]), world.adoptionScripts, {
      legacyRecord: record,
      allowlist: TEST_ALLOWLIST,
      window,
      controller: owner.publicKey,
      parties: [accountable({ type: "Script", hash: world.module1.hash })],
    });
    expect(tx.referenceInputs.some((r) => r.txHash === world.configRecord.ref.txHash)).toBe(true);
    const result = evaluate(tx, [record, fundsUtxo], [owner]);
    expect(result.verdicts.map((v) => v.label).sort()).toEqual(["Module-1 Consent", "identity Adopt", "legacy Burn", "legacy Deregister"]);
  });

  describe("refusals", () => {
    const owner = asTestWallet("adopt owner refusals");
    const fundsUtxo = walletFunds("adopt: refusal funds", owner, 40n * AP3X);
    const ctx = testContext(owner, [fundsUtxo]);
    /** A legacy-looking UTxO that no Register made; only the builder sees it. */
    const fake = (label: string, owner: Uint8Array | { script: Uint8Array }, datum?: Data): Utxo => {
      const ownerData = owner instanceof Uint8Array ? constr(0, owner) : constr(1, owner.script);
      const text = new TextEncoder();
      const legacy = datum ?? constr(0, ownerData, text.encode("Fake"), new Uint8Array(), [], new Uint8Array(), new Uint8Array(), 0n);
      return {
        ref: { txHash: "ab".repeat(32), index: 0 },
        address: bech32Address(LEGACY_ADDRESS),
        lovelace: 10n * AP3X,
        assets: { [`${toHex(LEGACY_HASH)}${legacyIdOf(label)}`]: 1n },
        datumHex: toHex(encodeData(legacy)),
        scriptRef: null,
      };
    };
    const base = (legacy: Utxo): AdoptArgs => ({
      legacyRecord: legacy,
      allowlist: TEST_ALLOWLIST,
      window,
      controller: owner.publicKey,
      parties: [accountable({ type: "ControllerSet" })],
    });

    it("refuses a record with a script owner", () => {
      const legacy = fake("adopt: refusals", { script: new Uint8Array(28).fill(7) });
      expect(refusal(() => buildAdopt(ctx, world.adoptionScripts, base(legacy))).reason).toBe("legacy_script_owner");
    });

    it("refuses a datum that does not decode", () => {
      const legacy = fake("adopt: refusals", owner.key.keyHash, constr(0, 1n, 2n));
      expect(refusal(() => buildAdopt(ctx, world.adoptionScripts, base(legacy))).reason).toBe("legacy_datum_invalid");
    });

    it("refuses an identifier that is not on the allowlist", () => {
      const legacy = fake("adopt: not on the allowlist", owner.key.keyHash);
      expect(refusal(() => buildAdopt(ctx, world.adoptionScripts, base(legacy))).reason).toBe("not_allowlisted");
    });

    it("refuses an allowlist that does not give the deployment root", () => {
      const legacy = fake("adopt: refusals", owner.key.keyHash);
      const scripts = { ...world.adoptionScripts, legacyRoot: allowlistRoot(TEST_ALLOWLIST.slice(1)) };
      expect(refusal(() => buildAdopt(ctx, scripts, base(legacy))).reason).toBe("allowlist_root_mismatch");
    });

    it("refuses a record that is not at the legacy address or holds two tokens", () => {
      const legacy = fake("adopt: refusals", owner.key.keyHash);
      expect(refusal(() => buildAdopt(ctx, world.adoptionScripts, base({ ...legacy, address: owner.address }))).reason).toBe("legacy_not_authentic");
      const two = { ...legacy, assets: { ...legacy.assets, [`${toHex(LEGACY_HASH)}${legacyIdOf("adopt: plain")}`]: 1n } };
      expect(refusal(() => buildAdopt(ctx, world.adoptionScripts, base(two))).reason).toBe("legacy_not_authentic");
    });

    it("refuses a record without an Accountable party and an owner address of another key", () => {
      const legacy = fake("adopt: refusals", owner.key.keyHash);
      expect(refusal(() => buildAdopt(ctx, world.adoptionScripts, { ...base(legacy), parties: [] })).reason).toBe("not_accountable");
      expect(refusal(() => buildAdopt(ctx, world.adoptionScripts, { ...base(legacy), ownerAddress: testWallet("other").address })).reason)
        .toBe("owner_address_invalid");
    });
  });
});
