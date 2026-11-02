/**
 * Self-tests of the harness: the Plutus Data encoder, the phase-1 guards,
 * and a parameterised validator that gets its parameters from a blueprint
 * and runs in a transaction (the path that wave 2 uses for the identity
 * validator).
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  address,
  blueprintScript,
  buildTx,
  constr,
  dataMap,
  encodeData,
  HarnessError,
  posixMsToSlot,
  rewardAddress,
  scriptHash,
  simulate,
  slotToPosixMs,
  toHex,
  utf8,
  withChange,
  type Data,
} from "./harness/index.js";
import {
  AP3X,
  collateralOf,
  evaluate,
  FEE,
  funds,
  newWallet,
  profile,
  registerParts,
  STAND_IN_IDENTITY,
  verdicts,
} from "./scenario.js";

describe("Plutus Data encoding", () => {
  const vectors: Array<[string, Data, string]> = [
    ["constructor 0", constr(0), "d87980"],
    ["constructor 6 with fields", constr(6, 1n, utf8("a")), "d87f9f014161ff"],
    ["constructor 7", constr(7), "d9050080"],
    ["constructor 127", constr(127), "d9057880"],
    ["constructor 128", constr(128), "d86682188080"],
    ["empty list", [], "80"],
    ["list", [1n, 2n], "9f0102ff"],
    ["64 bytes", new Uint8Array(64), `5840${"00".repeat(64)}`],
    ["65 bytes in chunks", new Uint8Array(65), `5f5840${"00".repeat(64)}4100ff`],
    ["2^64 - 1", (1n << 64n) - 1n, "1bffffffffffffffff"],
    ["2^64", 1n << 64n, "c249010000000000000000"],
    ["-2^64", -(1n << 64n), "3bffffffffffffffff"],
    ["-2^64 - 1", -(1n << 64n) - 1n, "c349010000000000000000"],
    ["map", dataMap([[1n, 2n]]), "a10102"],
  ];

  it.each(vectors)("%s", (_, value, expected) => {
    expect(toHex(encodeData(value))).toBe(expected);
  });
});

describe("phase-1 guards: a malformed transaction never counts as a script failure", () => {
  const owner = newWallet("harness guard owner");
  const seed = funds("harness: guard seed", owner, 50n * AP3X);
  const parts = registerParts(owner, seed, profile(owner), 10n * AP3X);

  it("aiken reports a missing script; simulate() throws HarnessError", () => {
    const built = buildTx(withChange({ ...parts, scripts: [] }, owner.address));
    expect(() => simulate(built)).toThrow(HarnessError);
  });

  it("buildTx() rejects an unbalanced transaction", () => {
    expect(() => buildTx({ ...parts, outputs: parts.outputs })).toThrow(/Unbalanced/);
  });

  it("buildTx() rejects a required signer without a key witness", () => {
    expect(() => buildTx(withChange({ ...parts, signers: [] }, owner.address))).toThrow(/No key witness/);
  });
});

describe("withdrawals and validity ranges", () => {
  // A Module-1 `Script` signer needs a withdrawal (Part 2 §3.2); identity
  // transactions have finite validity bounds (Part 2 §3.2).
  it("a script withdrawal runs its script as Withdraw[0], in a transaction with both validity bounds", () => {
    const owner = newWallet("harness withdrawal owner");
    const lo = posixMsToSlot(1_780_000_000_000n);
    const built = buildTx(withChange({
      inputs: [{ utxo: funds("harness: withdrawal funds", owner, 10n * AP3X) }],
      collateral: [collateralOf(owner)],
      outputs: [],
      fee: FEE,
      withdrawals: [{ rewardAddress: rewardAddress({ script: scriptHash(STAND_IN_IDENTITY) }), amount: 0n, redeemer: constr(0), label: "stand-in withdraw" }],
      validity: { invalidBefore: lo, invalidHereafter: lo + 3_600n },
      scripts: [STAND_IN_IDENTITY],
      signers: [owner.key],
    }, owner.address));
    const result = evaluate(built);
    expect(result.verdicts.map((v) => [v.purpose, v.passed])).toEqual([["Withdraw[0]", true]]);
    expect(slotToPosixMs(lo)).toBe(1_780_000_000_000n);
  });
});

describe("parameterised validator from a blueprint", () => {
  // fixtures/param-demo.plutus.json: `aiken build` (v1.1.21) of
  //   validator gate(expected: Int, tag: ByteArray) {
  //     mint(redeemer: Int, _policy: ByteArray, _tx: Data) { redeemer == expected && tag == "ok" }
  //     else(_) { fail }
  //   }
  const path = fileURLToPath(new URL("./fixtures/param-demo.plutus.json", import.meta.url));
  const gate = blueprintScript(path, "demo.gate.mint", [42n, utf8("ok")]);
  const policy = scriptHash(gate);
  const owner = newWallet("harness owner");

  const mintWith = (redeemer: bigint) => {
    const wallet = funds(`harness: redeemer ${redeemer}`, owner, 10n * AP3X);
    return buildTx(withChange({
      inputs: [{ utxo: wallet }],
      collateral: [collateralOf(owner)],
      outputs: [{ address: address({ key: owner.key.keyHash }), value: { coin: 2n * AP3X, assets: [{ policy, name: utf8("t"), quantity: 1n }] } }],
      fee: FEE,
      mint: [{ policy, assets: [{ name: utf8("t"), quantity: 1n }], redeemer, label: "gate" }],
      scripts: [gate],
      signers: [owner.key],
    }, owner.address));
  };

  it("applies the parameters in order and keeps the blueprint hash", () => {
    expect(toHex(policy)).not.toBe("1c0597674c7b3a669368b792bcb396a98aa24786fa293ea11dadcf9f");
    expect(() => blueprintScript(path, "demo.gate.mint")).toThrow(/still needs 2 parameter/);
  });

  it("passes with the applied parameter and fails without it", () => {
    expect(verdicts(evaluate(mintWith(42n)))).toEqual({ gate: true });
    expect(verdicts(evaluate(mintWith(41n)))).toEqual({ gate: false });
  });
});
