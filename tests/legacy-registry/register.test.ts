/**
 * Part 2 §12.2, deployment blockers. Part 1 §3.1 needs every legacy mint to
 * spend its seed, mint exactly one token and name it
 * blake2b_256(serialise(seed)). Each negative test changes one thing in the
 * Register of the positive control.
 */
import { describe, expect, it } from "vitest";
import {
  blake2b256,
  BURN,
  buildTx,
  cbor,
  describeSimulation,
  encodeData,
  identifierOf,
  LEGACY_ADDRESS,
  LEGACY_HASH,
  LEGACY_MIN_DEPOSIT,
  legacyToken,
  outRefData,
  quantityOf,
  recordOutput,
  toHex,
  withChange,
  type Asset,
  type TxSpec,
} from "./harness/index.js";
import { AP3X, evaluate, funds, newWallet, profile, registerParts, registerTx, verdicts } from "./scenario.js";

describe("legacy Register", () => {
  const owner = newWallet("register owner");

  /** The positive control's parts for `seed`, with the change added after `change` edits them. */
  const variant = (seedLabel: string, change: (parts: TxSpec) => TxSpec, extraChange: readonly Asset[] = []) => {
    const seed = funds(seedLabel, owner, 50n * AP3X);
    const parts = registerParts(owner, seed, profile(owner), LEGACY_MIN_DEPOSIT);
    return { seed, built: buildTx(withChange(change(parts), owner.address, extraChange)) };
  };

  it("passes when it follows the rules (positive control)", () => {
    const seed = funds("register: positive control", owner, 50n * AP3X);
    const built = registerTx(owner, seed);
    const result = evaluate(built);
    expect(result.passed, describeSimulation(result)).toBe(true);
    expect(verdicts(result)).toEqual({ "legacy Register": true });
    // The record holds the token named from the seed, with the Part 1 §3.1 layout of serialise(seed).
    const record = built.utxo(0).output;
    expect(toHex(record.address)).toBe(toHex(LEGACY_ADDRESS));
    expect(quantityOf(record.value, LEGACY_HASH, identifierOf(seed.ref))).toBe(1n);
    expect(toHex(encodeData(outRefData(seed.ref)))).toBe(`d8799f5820${toHex(seed.ref.txId)}00ff`);
  });

  describe("deployment blockers", () => {
    it("fails when the seed is not a transaction input", () => {
      const unspent = funds("register: unspent seed", owner, 50n * AP3X);
      const spent = funds("register: spent wallet UTxO", owner, 50n * AP3X);
      // Redeemer, name and record all use `unspent`; the transaction spends `spent`.
      const parts = registerParts(owner, unspent, profile(owner), LEGACY_MIN_DEPOSIT);
      const built = buildTx(withChange({ ...parts, inputs: [{ utxo: spent }] }, owner.address));
      const result = evaluate(built);
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Register": false });
    });

    it("fails when the seed is only a reference input", () => {
      const referenced = funds("register: referenced seed", owner, 50n * AP3X);
      const spent = funds("register: spent wallet UTxO 2", owner, 50n * AP3X);
      const parts = registerParts(owner, referenced, profile(owner), LEGACY_MIN_DEPOSIT);
      const built = buildTx(withChange({ ...parts, inputs: [{ utxo: spent }], referenceInputs: [referenced] }, owner.address));
      const result = evaluate(built);
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Register": false });
    });

    it("fails when the minted quantity is 2", () => {
      const seed = funds("register: quantity 2", owner, 50n * AP3X);
      const id = identifierOf(seed.ref);
      // The record holds one token; the second token goes to the owner's change.
      const { built } = variant("register: quantity 2", (parts) => ({
        ...parts,
        mint: [{ ...parts.mint![0]!, assets: [{ name: id, quantity: 2n }] }],
      }), [legacyToken(id)]);
      const result = evaluate(built);
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Register": false });
    });

    it("fails when a second name is minted with the seed's name", () => {
      const seed = funds("register: second name", owner, 50n * AP3X);
      const id = identifierOf(seed.ref);
      const other = identifierOf({ txId: seed.ref.txId, index: seed.ref.index + 1 });
      const { built } = variant("register: second name", (parts) => ({
        ...parts,
        mint: [{ ...parts.mint![0]!, assets: [{ name: id, quantity: 1n }, { name: other, quantity: 1n }] }],
      }), [legacyToken(other)]);
      const result = evaluate(built);
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Register": false });
    });

    it("fails when the name comes from another seed", () => {
      const seed = funds("register: name of another seed", owner, 50n * AP3X);
      const wrong = identifierOf({ txId: seed.ref.txId, index: 1 });
      const { built } = variant("register: name of another seed", (parts) => ({
        ...parts,
        outputs: [recordOutput({ ids: [wrong], datum: profile(owner) })],
        mint: [{ ...parts.mint![0]!, assets: [{ name: wrong, quantity: 1n }] }],
      }));
      const result = evaluate(built);
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Register": false });
    });

    it("fails when the name hashes a definite-length encoding of the seed", () => {
      const seed = funds("register: definite-length name", owner, 50n * AP3X);
      // d8 79 82 ... : the same seed as a definite array, instead of 9f ... ff.
      const definite = blake2b256(cbor.tag(121, cbor.array([cbor.bytes(seed.ref.txId), cbor.uint(seed.ref.index)])));
      expect(toHex(definite)).not.toBe(toHex(identifierOf(seed.ref)));
      const { built } = variant("register: definite-length name", (parts) => ({
        ...parts,
        outputs: [recordOutput({ ids: [definite], datum: profile(owner) })],
        mint: [{ ...parts.mint![0]!, assets: [{ name: definite, quantity: 1n }] }],
      }));
      const result = evaluate(built);
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Register": false });
    });

    it("fails when the Burn redeemer mints a token", () => {
      const { built } = variant("register: mint with Burn", (parts) => ({
        ...parts,
        mint: [{ ...parts.mint![0]!, redeemer: BURN, label: "legacy Burn (+1)" }],
      }));
      const result = evaluate(built);
      expect(result.passed).toBe(false);
      expect(verdicts(result)).toEqual({ "legacy Burn (+1)": false });
    });
  });

  // Part 2 §9.1 says that a record with a script owner cannot adopt. The
  // deployed Register never creates one.
  it("fails when the owner is a script credential", () => {
    const scriptOwned = profile(owner, { owner: { script: LEGACY_HASH } });
    const { built } = variant("register: script owner", (parts) => ({
      ...parts,
      outputs: [recordOutput({ ids: [parts.mint![0]!.assets[0]!.name], datum: scriptOwned })],
    }));
    const result = evaluate(built);
    expect(result.passed).toBe(false);
    expect(verdicts(result)).toEqual({ "legacy Register": false });
  });
});
