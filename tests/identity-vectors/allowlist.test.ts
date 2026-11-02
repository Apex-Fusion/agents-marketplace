// legacy_root membership vectors (Part 2 §3.4): the published file equals the shared helper's
// output, a second implementation written here from the spec text agrees, and the Aiken module
// that checks the proofs with `allowlist.member` is the current rendering of the vectors.

import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { describe, expect, test } from "vitest";
import { verifyAllowlistProof } from "@marketplace/shared/identity";
import { AIKEN_VECTOR_MODULE, formatAiken, renderAikenVectors } from "./aiken-vectors.js";
import { allowlistFile, allowlistVectors, identifierVectors, publishedFile } from "./vectors.js";

const { trees, rejections } = allowlistVectors();

const blake2b256Hex = (hex: string): string => Buffer.from(blake2b(Buffer.from(hex, "hex"), { dkLen: 32 })).toString("hex");

/** blake2b_256(min(a, b) ++ max(a, b)); lowercase hex compares like the bytes. */
const node = (a: string, b: string): string => blake2b256Hex(a < b ? a + b : b + a);

/** The root by the spec text: sorted leaves, pairs from the left, a last node without a pair moves up. */
function specRoot(ids: readonly string[]): string {
  let level = ids.map(blake2b256Hex).sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(level[i + 1] === undefined ? level[i]! : node(level[i]!, level[i + 1]!));
    level = next;
  }
  return level[0]!;
}

/** Adopt rule 4: fold the proof into blake2b_256(id) and compare with the root. */
const specMember = (root: string, id: string, proof: readonly string[]): boolean =>
  proof.reduce((x, sibling) => node(x, sibling), blake2b256Hex(id)) === root;

describe("allowlist vectors", () => {
  test("the published file is the output of the shared helper", () => {
    expect(publishedFile("allowlist.json")).toBe(allowlistFile());
  });

  test("the trees have 1, 2, 3, 5, 7, 8 and 13 leaves", () => {
    expect(trees.map((t) => t.ids.length)).toEqual([1, 2, 3, 5, 7, 8, 13]);
  });

  test.each(trees.map((t) => [t.name, t] as const))("%s: the spec text gives the same root and accepts every proof", (_name, tree) => {
    expect(tree.root).toBe(specRoot(tree.ids));
    expect(tree.leaves).toEqual(tree.ids.map(blake2b256Hex).sort());
    for (const { id, proof } of tree.proofs) {
      expect(specMember(tree.root, id, proof)).toBe(true);
      expect(verifyAllowlistProof(tree.root, id, proof)).toBe(true);
    }
  });

  test("a single leaf is the root, with an empty proof", () => {
    const [one] = trees;
    expect(one!.root).toBe(blake2b256Hex(one!.ids[0]!));
    expect(one!.proofs[0]!.proof).toEqual([]);
  });

  test("odd trees: the last leaf moves up unchanged, so its proof is shorter", () => {
    const thirteen = trees.find((t) => t.ids.length === 13)!;
    const lengths = new Map(thirteen.proofs.map((p) => [blake2b256Hex(p.id), p.proof.length]));
    // 13 leaves: levels of 13, 7, 4, 2 and 1 nodes. The last leaf moves up twice, then pairs twice.
    expect(lengths.get(thirteen.leaves[12]!)).toBe(2);
    expect(thirteen.leaves.slice(0, 12).map((leaf) => lengths.get(leaf))).toEqual(Array(12).fill(4));
    const three = trees.find((t) => t.ids.length === 3)!;
    expect(three.proofs.map((p) => p.proof.length).sort()).toEqual([1, 2, 2]);
  });

  test.each(rejections.map((r) => [r.description, r] as const))("rejected: %s", (_description, r) => {
    expect(specMember(r.root, r.id, r.proof)).toBe(false);
    expect(verifyAllowlistProof(r.root, r.id, r.proof)).toBe(false);
  });

  test("the Aiken module checks the published identifiers and proofs", () => {
    expect(readFileSync(AIKEN_VECTOR_MODULE, "utf8")).toBe(formatAiken(renderAikenVectors(identifierVectors(), { trees, rejections })));
  });
});
