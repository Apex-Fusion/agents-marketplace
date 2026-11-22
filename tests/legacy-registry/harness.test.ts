/**
 * Self-tests of the harness: the Plutus Data encoder and the phase-1 guards.
 * The identity tests run the withdrawals, the validity ranges and the parameterised validators of the harness.
 */
import { describe, expect, it } from "vitest";
import {
  buildTx,
  constr,
  dataMap,
  encodeData,
  HarnessError,
  simulate,
  toHex,
  utf8,
  withChange,
  type Data,
} from "./harness/index.js";
import { AP3X, funds, newWallet, profile, registerParts } from "./scenario.js";

describe("Plutus Data encoding", () => {
  const vectors: Array<[string, Data, string]> = [
    ["constructor 6 with fields", constr(6, 1n, utf8("a")), "d87f9f014161ff"],
    ["constructor 7", constr(7), "d9050080"],
    ["constructor 127", constr(127), "d9057880"],
    ["constructor 128", constr(128), "d86682188080"],
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
