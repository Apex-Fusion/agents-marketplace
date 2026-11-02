/**
 * Part 2 §12.2: the legacy Deregister and Burn by the owner, and the
 * minimum change back to the owner (Part 2 §9.1 "Funding").
 *
 * Rule in the deployed script (validate_deregister, check AR-10): some
 * transaction output has the owner's key hash as payment credential (any
 * stake credential) and holds at least 10,000,000 base units of AP3X.
 */
import { describe, expect, it } from "vitest";
import {
  address,
  buildTx,
  constr,
  DEREGISTER,
  describeSimulation,
  LEGACY_HASH,
  LEGACY_MIN_DEPOSIT,
  LEGACY_SCRIPT,
  BURN,
  minUtxo,
  scriptHash,
  withChange,
  type KeyPair,
  type TxOut,
  type TxSpec,
} from "./harness/index.js";
import {
  AP3X,
  collateralOf,
  evaluate,
  FEE,
  funds,
  newWallet,
  registeredRecord,
  STAND_IN_IDENTITY,
  verdicts,
  type Wallet,
} from "./scenario.js";

describe("legacy Deregister and Burn", () => {
  const owner = newWallet("deregister owner");
  // A second wallet pays the fee and takes the change, so that the test
  // controls every output that reaches the owner.
  const payer = newWallet("deregister payer");

  function deregister(
    label: string,
    toOwner: (owner: Wallet) => TxOut[],
    options: { deposit?: bigint; ownerSigns?: boolean } = {},
  ) {
    const { record, id } = registeredRecord(owner, label, options.deposit ?? LEGACY_MIN_DEPOSIT);
    const ownerSigns = options.ownerSigns ?? true;
    const signers: KeyPair[] = ownerSigns ? [owner.key, payer.key] : [payer.key];
    const spec: TxSpec = {
      inputs: [
        { utxo: record, redeemer: DEREGISTER, label: "legacy Deregister" },
        { utxo: funds(`${label}: payer funds`, payer, 5n * AP3X) },
      ],
      collateral: [collateralOf(payer)],
      outputs: toOwner(owner),
      fee: FEE,
      mint: [{ policy: LEGACY_HASH, assets: [{ name: id, quantity: -1n }], redeemer: BURN, label: "legacy Burn" }],
      requiredSigners: ownerSigns ? [owner.key.keyHash] : [],
      scripts: [LEGACY_SCRIPT],
      signers,
    };
    return buildTx(withChange(spec, payer.address));
  }

  const ap3xTo = (addr: Uint8Array, coin: bigint): TxOut => ({ address: addr, value: { coin } });

  it("passes for the owner with 10 AP3X back (positive control)", () => {
    const result = evaluate(deregister("deregister: positive control", (o) => [ap3xTo(o.address, 10n * AP3X)]));
    expect(result.passed, describeSimulation(result)).toBe(true);
    expect(verdicts(result)).toEqual({ "legacy Deregister": true, "legacy Burn": true });
  });

  describe("minimum change back to the owner", () => {
    it("fails with 9,999,999 base units: the Deregister fails, the Burn passes", () => {
      const result = evaluate(deregister("deregister: 9999999", (o) => [ap3xTo(o.address, 9_999_999n)]));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Deregister": false, "legacy Burn": true });
    });

    it("passes with 10,000,000 base units", () => {
      const result = evaluate(deregister("deregister: 10000000", (o) => [ap3xTo(o.address, 10_000_000n)]));
      expect(result.passed, describeSimulation(result)).toBe(true);
    });

    it("fails when the 10 AP3X come in two outputs of 5 AP3X", () => {
      const result = evaluate(deregister("deregister: split", (o) => [ap3xTo(o.address, 5n * AP3X), ap3xTo(o.address, 5n * AP3X)]));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Deregister": false, "legacy Burn": true });
    });

    it("passes when the owner output has a stake credential", () => {
      const result = evaluate(deregister("deregister: base address", (o) => [
        ap3xTo(address({ key: o.key.keyHash }, { key: payer.key.keyHash }), 10n * AP3X),
      ]));
      expect(result.passed, describeSimulation(result)).toBe(true);
    });

    it("fails when the 10 AP3X go to another payment key with the owner's stake key", () => {
      const result = evaluate(deregister("deregister: other payment key", (o) => [
        ap3xTo(address({ key: payer.key.keyHash }, { key: o.key.keyHash }), 10n * AP3X),
      ]));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Deregister": false, "legacy Burn": true });
    });

    it("needs only 10 AP3X back, not the whole deposit", () => {
      // A 25 AP3X record: 10 AP3X go to the owner, 15 AP3X go to the payer's change.
      const result = evaluate(deregister("deregister: 25 AP3X record", (o) => [ap3xTo(o.address, 10n * AP3X)], { deposit: 25n * AP3X }));
      expect(result.passed, describeSimulation(result)).toBe(true);
    });

    it("is far above the ledger min-UTxO of the owner output", () => {
      const owned = ap3xTo(owner.address, 10n * AP3X);
      // (160 + 39 bytes) × 4310 and (160 + 67 bytes) × 4310.
      expect(minUtxo(owned)).toBe(857_690n);
      expect(minUtxo(ap3xTo(address({ key: owner.key.keyHash }, { key: payer.key.keyHash }), 10n * AP3X))).toBe(978_370n);
      expect(minUtxo(owned)).toBeLessThan(LEGACY_MIN_DEPOSIT);
    });
  });

  it("fails when the owner does not sign: the Deregister and the Burn fail", () => {
    const result = evaluate(deregister("deregister: no owner signature", (o) => [ap3xTo(o.address, 10n * AP3X)], { ownerSigns: false }));
    expect(result.passed).toBe(false);
    expect(verdicts(result)).toEqual({ "legacy Deregister": false, "legacy Burn": false });
  });

  // Part 2 §9.5: each record needs its own Deregister transaction.
  it("fails for two records in one transaction: both Deregisters and the Burn fail", () => {
    const a = registeredRecord(owner, "deregister: two records A");
    const b = registeredRecord(owner, "deregister: two records B");
    const spec: TxSpec = {
      inputs: [
        { utxo: a.record, redeemer: DEREGISTER, label: "legacy Deregister A" },
        { utxo: b.record, redeemer: DEREGISTER, label: "legacy Deregister B" },
        { utxo: funds("deregister: two records: payer funds", payer, 5n * AP3X) },
      ],
      collateral: [collateralOf(payer)],
      outputs: [ap3xTo(owner.address, 10n * AP3X), ap3xTo(owner.address, 10n * AP3X)],
      fee: FEE,
      mint: [{
        policy: LEGACY_HASH,
        assets: [{ name: a.id, quantity: -1n }, { name: b.id, quantity: -1n }],
        redeemer: BURN,
        label: "legacy Burn",
      }],
      requiredSigners: [owner.key.keyHash],
      scripts: [LEGACY_SCRIPT],
      signers: [owner.key, payer.key],
    };
    const result = evaluate(buildTx(withChange(spec, payer.address)));
    expect(result.passed).toBe(false);
    expect(verdicts(result)).toEqual({ "legacy Deregister A": false, "legacy Deregister B": false, "legacy Burn": false });
  });

  describe("in the shape of an adoption (a second V3 policy mints the new record)", () => {
    // STAND_IN_IDENTITY accepts everything. Wave 2 puts the identity
    // validator in its place; this test only shows the legacy side.
    const standIn = scriptHash(STAND_IN_IDENTITY);

    function adoption(label: string, ownerFunds: bigint) {
      const { record, id } = registeredRecord(owner, label);
      const spec: TxSpec = {
        inputs: [
          { utxo: record, redeemer: DEREGISTER, label: "legacy Deregister" },
          { utxo: funds(`${label}: owner funds`, owner, ownerFunds) },
        ],
        collateral: [collateralOf(owner)],
        outputs: [
          {
            address: address({ script: standIn }),
            value: { coin: 10n * AP3X, assets: [{ policy: standIn, name: id, quantity: 1n }] },
            datum: { inline: constr(0, owner.key.publicKey) },
          },
        ],
        fee: FEE,
        mint: [
          { policy: LEGACY_HASH, assets: [{ name: id, quantity: -1n }], redeemer: BURN, label: "legacy Burn" },
          { policy: standIn, assets: [{ name: id, quantity: 1n }], redeemer: constr(1, []), label: "stand-in identity mint" },
        ],
        requiredSigners: [owner.key.keyHash],
        scripts: [LEGACY_SCRIPT, STAND_IN_IDENTITY],
        signers: [owner.key],
      };
      return buildTx(withChange(spec, owner.address));
    }

    it("passes when the owner adds 10 AP3X plus the fee", () => {
      // In: deposit 10 + owner 10.4. Out: new record 10 + owner change 10. Fee 0.4.
      const result = evaluate(adoption("adoption shape: enough", 10n * AP3X + FEE));
      expect(result.passed, describeSimulation(result)).toBe(true);
      expect(verdicts(result)).toEqual({ "legacy Deregister": true, "legacy Burn": true, "stand-in identity mint": true });
    });

    it("fails when the owner adds 1 base unit less", () => {
      const result = evaluate(adoption("adoption shape: short", 10n * AP3X + FEE - 1n));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Deregister": false, "legacy Burn": true, "stand-in identity mint": true });
    });
  });
});
