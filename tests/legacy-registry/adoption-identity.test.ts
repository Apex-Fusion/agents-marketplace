/**
 * Part 2 §9.1 and §12.2: the adoption transaction with both real scripts. A
 * legacy record made by a rule-following Register under the deployed legacy
 * script adopts into the identity registry: the legacy Deregister (spend),
 * the legacy Burn (mint) and the identity Adopt (mint, the applied
 * `identity` validator of contracts/identity-marketplace/plutus.json with test
 * parameters) run in one transaction.
 *
 * Funding (§9.1): the legacy Deregister needs one output of at least
 * 10,000,000 base units to the owner's key hash. With a 10 AP3X legacy
 * deposit and a 10 AP3X new record, the owner adds exactly 10 AP3X plus the
 * fee; one base unit less makes the Deregister fail.
 */
import { describe, expect, it } from "vitest";
import { identityDatumToData, type IdentityDatum } from "../../packages/shared/src/cbor/IdentityDatum.js";
import { identityMintToData } from "../../packages/shared/src/cbor/IdentityRedeemer.js";
import { allowlistProof } from "../../packages/shared/src/identity/allowlist.js";
import { utf8ToHex } from "../../packages/shared/src/identity/id.js";
import { buildAdopt, LEGACY_CHANGE_MIN, TxConstructionError } from "../../packages/shared/src/identity/tx/index.js";
import {
  address, BURN, buildTx, DEREGISTER, describeSimulation, fromHex, LEGACY_HASH, LEGACY_MIN_DEPOSIT, LEGACY_SCRIPT,
  posixMsToSlot, toHex, type TxSpec,
} from "./harness/index.js";
import {
  controllerAccountable, harnessData, harnessUtxo, identityWorld, legacyIdOf, sharedUtxo, simulateUnsigned,
  TEST_ALLOWLIST, testContext, testWallet, testWindow, walletFunds,
} from "./harness/identity.js";
import { AP3X, collateralOf, evaluate, FEE, funds, newWallet, registeredRecord, verdicts } from "./scenario.js";

describe("adoption with the deployed legacy script and the identity validator", () => {
  const world = identityWorld();
  const owner = newWallet("adoption-identity owner");
  const identityPolicy = fromHex(world.identity.hash);
  const window = testWindow();

  /** Deregister + Burn + Adopt, with `ownerChange` base units to the owner's key hash and the fee from the owner. */
  function adoption(label: string, ownerChange: bigint) {
    const { record, id } = registeredRecord(owner, label);
    expect(toHex(id)).toBe(legacyIdOf(label));
    const datum: IdentityDatum = {
      controller: toHex(owner.key.publicKey),
      keys: [],
      parties: [controllerAccountable(window)],
      guardianThreshold: 0,
      pendingRecovery: null,
      lineage: { type: "Root" },
      subagentEpoch: 0,
      name: utf8ToHex("Legacy Test Agent"),
      description: utf8ToHex("Offline test record"),
      framework: utf8ToHex("vector-agent"),
      endpoint: utf8ToHex("https://agent.example/a2a"),
      capabilities: [utf8ToHex("ocr.page.extract.v1")],
      createdAt: window.hi,
      status: { type: "Active" },
    };
    const spec: TxSpec = {
      inputs: [
        { utxo: record, redeemer: DEREGISTER, label: "legacy Deregister" },
        // The owner adds the change and the fee; the legacy deposit funds the new record.
        { utxo: funds(`${label}: owner funds`, owner, ownerChange + FEE) },
      ],
      referenceInputs: [harnessUtxo(world.identity.reference)],
      collateral: [collateralOf(owner)],
      outputs: [
        {
          address: address({ script: identityPolicy }),
          value: { coin: LEGACY_MIN_DEPOSIT, assets: [{ policy: identityPolicy, name: id, quantity: 1n }] },
          datum: { inline: harnessData(identityDatumToData(datum)) },
        },
        { address: owner.address, value: { coin: ownerChange } },
      ],
      fee: FEE,
      mint: [
        { policy: LEGACY_HASH, assets: [{ name: id, quantity: -1n }], redeemer: BURN, label: "legacy Burn" },
        {
          policy: identityPolicy,
          assets: [{ name: id, quantity: 1n }],
          redeemer: harnessData(identityMintToData({ type: "Adopt", proof: allowlistProof(TEST_ALLOWLIST, toHex(id)) })),
          label: "identity Adopt",
        },
      ],
      requiredSigners: [owner.key.keyHash],
      scripts: [LEGACY_SCRIPT],
      signers: [owner.key],
      validity: { invalidBefore: posixMsToSlot(BigInt(window.lo)), invalidHereafter: posixMsToSlot(BigInt(window.hi)) },
    };
    return buildTx(spec);
  }

  it("passes: Deregister + Burn + Adopt with 10 AP3X back to the owner", () => {
    const result = evaluate(adoption("adoption-identity: combined", 10n * AP3X));
    expect(result.passed, `${describeSimulation(result)}\n${result.error ?? ""}`).toBe(true);
    expect(verdicts(result)).toEqual({ "legacy Deregister": true, "legacy Burn": true, "identity Adopt": true });
  });

  it("fails with one base unit less change to the owner: the Deregister fails, the Burn and the Adopt pass", () => {
    const result = evaluate(adoption("adoption-identity: short", 10n * AP3X - 1n));
    expect(result.passed).toBe(false);
    expect(verdicts(result)).toEqual({ "legacy Deregister": false, "legacy Burn": true, "identity Adopt": true });
  });

  it("the shared Adopt builder writes a transaction that both scripts accept, and refuses one base unit less", () => {
    const label = "adoption-identity: builder";
    const { record } = registeredRecord(owner, label);
    const wallet = testWallet("adoption-identity owner");
    const args = {
      legacyRecord: sharedUtxo(record),
      allowlist: TEST_ALLOWLIST,
      window,
      controller: wallet.publicKey,
      parties: [controllerAccountable(window)],
    };
    const probe = buildAdopt(testContext(wallet, [walletFunds(`${label}: probe`, wallet, 100n * AP3X)]), world.adoptionScripts, args);
    const exact = walletFunds(`${label}: exact`, wallet, LEGACY_CHANGE_MIN + probe.fee);
    const tx = buildAdopt(testContext(wallet, [exact]), world.adoptionScripts, args);
    const result = simulateUnsigned(tx, [...world.utxos, sharedUtxo(record), exact], [wallet.key]);
    expect(result.passed, `${describeSimulation(result)}\n${result.error ?? ""}`).toBe(true);
    expect(Object.fromEntries(result.verdicts.map((v) => [v.label, v.passed]))).toEqual({
      "legacy Deregister": true,
      "legacy Burn": true,
      "identity Adopt": true,
    });
    const short = walletFunds(`${label}: short`, wallet, LEGACY_CHANGE_MIN + probe.fee - 1n);
    expect(() => buildAdopt(testContext(wallet, [short]), world.adoptionScripts, args)).toThrow(TxConstructionError);
  });
});
