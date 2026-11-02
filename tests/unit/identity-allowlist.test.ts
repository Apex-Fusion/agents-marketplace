/**
 * Allowlist Merkle tree (Part 2 §3.4). The expected roots are computed in
 * this file from the §3.4 text with @noble/hashes, independently of the module.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { describe, expect, it } from "vitest";
import {
  allowlistLeaf, allowlistProof, allowlistRoot, buildAllowlistTree, vectorIdFromSeed, verifyAllowlistProof,
} from "../../packages/shared/src/identity/index.js";

const H = (hex: string): string => Buffer.from(blake2b(Buffer.from(hex, "hex"), { dkLen: 32 })).toString("hex");
const node = (a: string, b: string): string => H(a < b ? a + b : b + a);
const ids = (count: number, salt = 0): string[] =>
  Array.from({ length: count }, (_, i) => vectorIdFromSeed((salt + i).toString(16).padStart(64, "0"), i));

describe("allowlist leaves and roots", () => {
  it("hashes the identifier bytes for a leaf", () => {
    const [id] = ids(1);
    expect(allowlistLeaf(id!)).toBe(H(id!));
    expect(() => allowlistLeaf(id!.toUpperCase())).toThrow(/allowlistLeaf: identifier must be 64 lowercase/);
  });

  it("uses the leaf as the root of a one-leaf tree, with an empty proof", () => {
    const [id] = ids(1);
    expect(allowlistRoot([id!])).toBe(H(id!));
    expect(allowlistProof([id!], id!)).toEqual([]);
    expect(verifyAllowlistProof(H(id!), id!, [])).toBe(true);
  });

  it("pairs two leaves with min ++ max", () => {
    const [a, b] = ids(2);
    expect(allowlistRoot([a!, b!])).toBe(node(H(a!), H(b!)));
    expect(allowlistProof([a!, b!], a!)).toEqual([H(b!)]);
    expect(allowlistProof([a!, b!], b!)).toEqual([H(a!)]);
  });

  it("moves an unpaired last node up unchanged (3 leaves)", () => {
    const list = ids(3);
    const [l0, l1, l2] = list.map(H).sort();
    const n01 = node(l0!, l1!);
    expect(allowlistRoot(list)).toBe(node(n01, l2!));
    const byLeaf = new Map(list.map((id) => [H(id), id]));
    expect(allowlistProof(list, byLeaf.get(l0!)!)).toEqual([l1, l2]);
    expect(allowlistProof(list, byLeaf.get(l1!)!)).toEqual([l0, l2]);
    expect(allowlistProof(list, byLeaf.get(l2!)!)).toEqual([n01]);
  });

  it("builds the levels from sorted leaves (5 leaves)", () => {
    const list = ids(5, 100);
    const [l0, l1, l2, l3, l4] = list.map(H).sort();
    const level1 = [node(l0!, l1!), node(l2!, l3!), l4!];
    const level2 = [node(level1[0]!, level1[1]!), l4!];
    expect(allowlistRoot(list)).toBe(node(level2[0]!, level2[1]!));
    const tree = buildAllowlistTree(list);
    expect(tree.leaves).toEqual([l0, l1, l2, l3, l4]);
    const last = list.find((id) => H(id) === l4)!;
    expect(tree.proof(last)).toEqual([level2[0]]);
    const first = list.find((id) => H(id) === l0)!;
    expect(tree.proof(first)).toEqual([l1, level1[1], l4]);
  });

  it("does not depend on the input order", () => {
    const list = ids(9, 7);
    expect(allowlistRoot([...list].reverse())).toBe(allowlistRoot(list));
  });
});

describe("allowlist proofs", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 13, 64, 257])("verifies every proof of a %i-leaf tree", (count) => {
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
