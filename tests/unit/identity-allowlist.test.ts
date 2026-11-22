/**
 * Allowlist Merkle tree (Part 2 §3.4): the leaf, the proof of each member at several tree sizes,
 * wrong and malformed proofs, and refusals. The independent roots of the published trees are in
 * tests/identity-vectors/allowlist.test.ts.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { describe, expect, it } from "vitest";
import {
  allowlistLeaf, allowlistProof, allowlistRoot, buildAllowlistTree, vectorIdFromSeed, verifyAllowlistProof,
} from "../../packages/shared/src/identity/index.js";
import { nightly } from "../depth.js";

const H = (hex: string): string => Buffer.from(blake2b(Buffer.from(hex, "hex"), { dkLen: 32 })).toString("hex");
const ids = (count: number, salt = 0): string[] =>
  Array.from({ length: count }, (_, i) => vectorIdFromSeed((salt + i).toString(16).padStart(64, "0"), i));

describe("allowlist leaves and roots", () => {
  it("hashes the identifier bytes for a leaf", () => {
    const [id] = ids(1);
    expect(allowlistLeaf(id!)).toBe(H(id!));
    expect(() => allowlistLeaf(id!.toUpperCase())).toThrow(/allowlistLeaf: identifier must be 64 lowercase/);
  });

  it("does not depend on the input order", () => {
    const list = ids(9, 7);
    expect(allowlistRoot([...list].reverse())).toBe(allowlistRoot(list));
  });
});

describe("allowlist proofs", () => {
  // Gate: 1 leaf, a power of two plus one, a power of two and 13 leaves. Night: also 64 and 257 leaves.
  const proofSizes = nightly ? [1, 5, 8, 13, 64, 257] : [1, 5, 8, 13];

  it.each(proofSizes)("verifies every proof of a %i-leaf tree", (count) => {
    const list = ids(count, count * 1000);
    const tree = buildAllowlistTree(list);
    for (const id of list) {
      const proof = tree.proof(id);
      expect(proof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(count)));
      expect(verifyAllowlistProof(tree.root, id, proof)).toBe(true);
    }
  });

  it("fails a wrong proof", () => {
    const list = ids(7, 42);
    const tree = buildAllowlistTree(list);
    const [id, other] = list;
    const proof = tree.proof(id!);
    const flipped = `${proof[0]!.slice(0, 63)}${proof[0]!.endsWith("0") ? "1" : "0"}`;
    expect(verifyAllowlistProof(tree.root, id!, [flipped, ...proof.slice(1)])).toBe(false);
    expect(verifyAllowlistProof(tree.root, other!, proof)).toBe(false);
    expect(verifyAllowlistProof(tree.root, id!, [...proof, proof[0]!])).toBe(false);
    expect(verifyAllowlistProof(tree.root, id!, proof.slice(1))).toBe(false);
    expect(verifyAllowlistProof(tree.root, id!, [])).toBe(false);
    expect(verifyAllowlistProof(allowlistRoot(ids(7, 43)), id!, proof)).toBe(false);
    const outsider = ids(1, 999)[0]!;
    expect(verifyAllowlistProof(tree.root, outsider, proof)).toBe(false);
  });

  it("returns false for malformed input", () => {
    const list = ids(4);
    const tree = buildAllowlistTree(list);
    const proof = tree.proof(list[0]!);
    expect(verifyAllowlistProof(tree.root.toUpperCase(), list[0]!, proof)).toBe(false);
    expect(verifyAllowlistProof(tree.root, list[0]!.toUpperCase(), proof)).toBe(false);
    expect(verifyAllowlistProof(tree.root, list[0]!, [proof[0]!.toUpperCase(), ...proof.slice(1)])).toBe(false);
    expect(verifyAllowlistProof(tree.root, list[0]!, [proof[0]!.slice(2), ...proof.slice(1)])).toBe(false);
    expect(verifyAllowlistProof(tree.root, list[0]!, "proof" as unknown as string[])).toBe(false);
  });

  it("refuses an empty list, duplicates, invalid identifiers and unknown identifiers", () => {
    const list = ids(3);
    expect(() => buildAllowlistTree([])).toThrow(/at least one identifier/);
    expect(() => buildAllowlistTree([list[0]!, list[0]!])).toThrow(/duplicate identifier/);
    expect(() => buildAllowlistTree([list[0]!.toUpperCase()])).toThrow(/invalid identifier/);
    expect(() => allowlistProof(list, ids(1, 500)[0]!)).toThrow(/is not in the allowlist/);
  });
});
