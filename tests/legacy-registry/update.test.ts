/**
 * Part 2 §12.2: can a legacy Update leave a legacy token in an output that
 * is not authentic (Part 1 §4)?
 *   (a) the legacy script address with a stake credential;
 *   (b) one output with two legacy tokens.
 */
import { describe, expect, it } from "vitest";
import {
  address,
  BURN,
  buildTx,
  DEREGISTER,
  describeSimulation,
  identifierOf,
  LEGACY_ADDRESS,
  LEGACY_HASH,
  LEGACY_MIN_DEPOSIT,
  LEGACY_SCRIPT,
  legacyToken,
  quantityOf,
  recordOutput,
  registerRedeemer,
  UPDATE,
  withChange,
  type Credential,
  type MintEntry,
  type TxOut,
  type TxSpec,
  type Utxo,
} from "./harness/index.js";
import {
  AP3X,
  collateralOf,
  evaluate,
  FEE,
  funds,
  newWallet,
  profile,
  registeredRecord,
  registerParts,
  verdicts,
} from "./scenario.js";

describe("legacy Update", () => {
  const owner = newWallet("update owner");
  const renamed = profile(owner, { name: "Renamed Agent" });

  /** Spends `records` with Update; the owner pays the fee from a wallet UTxO. */
  function update(
    label: string,
    records: ReadonlyArray<{ readonly record: Utxo; readonly name: string }>,
    outputs: TxOut[],
    extra: { mint?: MintEntry[]; inputs?: TxSpec["inputs"] } = {},
  ) {
    const spec: TxSpec = {
      inputs: [
        ...records.map(({ record, name }) => ({ utxo: record, redeemer: UPDATE, label: `legacy Update ${name}` })),
        ...(extra.inputs ?? [{ utxo: funds(`${label}: owner funds`, owner, 5n * AP3X) }]),
      ],
      collateral: [collateralOf(owner)],
      outputs,
      fee: FEE,
      mint: extra.mint ?? [],
      requiredSigners: [owner.key.keyHash],
      scripts: [LEGACY_SCRIPT],
      signers: [owner.key],
    };
    return buildTx(withChange(spec, owner.address));
  }

  it("passes when the record stays at the legacy address (positive control)", () => {
    const a = registeredRecord(owner, "update: positive control");
    const result = evaluate(update("update: positive control", [{ record: a.record, name: "A" }], [
      recordOutput({ ids: [a.id], datum: renamed }),
    ]));
    expect(result.passed, describeSimulation(result)).toBe(true);
    expect(verdicts(result)).toEqual({ "legacy Update A": true });
  });

  it("fails when the new owner is a script credential (no legacy record gets a script owner)", () => {
    const a = registeredRecord(owner, "update: script owner");
    const result = evaluate(update("update: script owner", [{ record: a.record, name: "A" }], [
      recordOutput({ ids: [a.id], datum: profile(owner, { owner: { script: LEGACY_HASH } }) }),
    ]));
    expect(result.passed).toBe(false);
    expect(verdicts(result)).toEqual({ "legacy Update A": false });
  });

  describe("(a) the legacy script address with a stake credential", () => {
    const stakeCredentials: Array<[string, Credential]> = [
      ["the owner's stake key", { key: owner.key.keyHash }],
      ["the legacy script as stake credential", { script: LEGACY_HASH }],
    ];

    it.each(stakeCredentials)("Update cannot move the token there (%s)", (_, stake) => {
      const a = registeredRecord(owner, `update: stake ${JSON.stringify(stake)}`);
      const target = address({ script: LEGACY_HASH }, stake);
      const result = evaluate(update("update: stake", [{ record: a.record, name: "A" }], [
        recordOutput({ ids: [a.id], datum: renamed, address: target }),
      ]));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Update A": false });
    });

    it("Register cannot put a new token there either", () => {
      const seed = funds("update: register to a stake address", owner, 50n * AP3X);
      const parts = registerParts(owner, seed, profile(owner), LEGACY_MIN_DEPOSIT);
      const target = address({ script: LEGACY_HASH }, { key: owner.key.keyHash });
      const result = evaluate(buildTx(withChange({
        ...parts,
        outputs: [recordOutput({ ids: [identifierOf(seed.ref)], datum: profile(owner), address: target })],
      }, owner.address)));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Register": false });
    });
  });

  describe("(b) two legacy tokens in one output", () => {
    it("two Updates cannot merge two records: both fail", () => {
      const a = registeredRecord(owner, "update: merge A");
      const b = registeredRecord(owner, "update: merge B");
      const result = evaluate(update("update: merge", [{ record: a.record, name: "A" }, { record: b.record, name: "B" }], [
        recordOutput({ ids: [a.id, b.id], datum: a.datum, coin: 2n * LEGACY_MIN_DEPOSIT }),
      ]));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Update A": false, "legacy Update B": false });
    });

    it("two Updates fail also with one output each: the script allows one input at the legacy address", () => {
      const a = registeredRecord(owner, "update: two outputs A");
      const b = registeredRecord(owner, "update: two outputs B");
      const result = evaluate(update("update: two outputs", [{ record: a.record, name: "A" }, { record: b.record, name: "B" }], [
        recordOutput({ ids: [a.id], datum: a.datum }),
        recordOutput({ ids: [b.id], datum: b.datum }),
      ]));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Update A": false, "legacy Update B": false });
    });

    /** A Register (seed: an owner wallet UTxO) and an Update of record A, with both tokens in one output. */
    function registerIntoRecord(label: string) {
      const a = registeredRecord(owner, `${label}: A`);
      const seed = funds(`${label}: seed`, owner, 20n * AP3X);
      const n = identifierOf(seed.ref);
      const built = update(label, [{ record: a.record, name: "A" }], [recordOutput({ ids: [a.id, n], datum: a.datum })], {
        inputs: [{ utxo: seed }],
        mint: [{ policy: LEGACY_HASH, assets: [{ name: n, quantity: 1n }], redeemer: registerRedeemer(seed.ref), label: "legacy Register N" }],
      });
      return { a, n, built };
    }

    it("a Register and an Update in one transaction leave two tokens in one output: both pass", () => {
      const { a, n, built } = registerIntoRecord("update: register into A");
      const result = evaluate(built);
      expect(result.passed, describeSimulation(result)).toBe(true);
      expect(verdicts(result)).toEqual({ "legacy Update A": true, "legacy Register N": true });
      // The output is at the legacy address but holds two tokens of the policy: not authentic.
      const merged = built.utxo(0).output;
      expect(merged.address).toEqual(LEGACY_ADDRESS);
      expect(quantityOf(merged.value, LEGACY_HASH)).toBe(2n);
      expect(quantityOf(merged.value, LEGACY_HASH, a.id)).toBe(1n);
      expect(quantityOf(merged.value, LEGACY_HASH, n)).toBe(1n);
    });

    it("the two-token output cannot be spent again: Update fails", () => {
      const { a, n, built } = registerIntoRecord("update: spend merged by Update");
      const result = evaluate(update("update: spend merged by Update", [{ record: built.utxo(0), name: "merged" }], [
        recordOutput({ ids: [a.id, n], datum: a.datum }),
      ]));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Update merged": false });
    });

    it("the two-token output cannot be spent again: Deregister fails, the Burn alone passes", () => {
      const { a, n, built } = registerIntoRecord("update: spend merged by Deregister");
      const spec: TxSpec = {
        inputs: [
          { utxo: built.utxo(0), redeemer: DEREGISTER, label: "legacy Deregister merged" },
          { utxo: funds("update: spend merged by Deregister: owner funds", owner, 5n * AP3X) },
        ],
        collateral: [collateralOf(owner)],
        outputs: [{ address: owner.address, value: { coin: 10n * AP3X, assets: [legacyToken(n)] } }],
        fee: FEE,
        mint: [{ policy: LEGACY_HASH, assets: [{ name: a.id, quantity: -1n }], redeemer: BURN, label: "legacy Burn A" }],
        requiredSigners: [owner.key.keyHash],
        scripts: [LEGACY_SCRIPT],
        signers: [owner.key],
      };
      const result = evaluate(buildTx(withChange(spec, owner.address)));
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Deregister merged": false, "legacy Burn A": true });
    });
  });
});
