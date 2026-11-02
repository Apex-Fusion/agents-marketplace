// Status-list vectors (Part 2 §8.4, §8.6): the published file equals the bits that the gateway's
// status-list service gives for the gateway's DID-document vector set, and the bits agree with the
// effective status of the view without options.

import { describe, expect, test } from "vitest";
import { gatewayVectorFiles, publishedFile, statusListsFile, statusListVectors } from "./vectors.js";

const vectors = await statusListVectors();

/** Token Status List values of draft-ietf-oauth-status-list Section 7.1: 0 valid, 1 invalid, 2 suspended. */
const TSL_VALUE: Readonly<Record<string, number>> = { active: 0, suspended: 2, revoked: 1, retired: 1 };

describe("status-list vectors", () => {
  test("the published file is the output of the gateway's status-list service", async () => {
    expect(publishedFile("status-lists.json")).toBe(await statusListsFile());
  });

  test("one vector for each file of the gateway vector set", () => {
    expect(vectors.map((v) => v.name)).toEqual(gatewayVectorFiles().map((f) => f.name));
    expect(vectors.length).toBe(11);
  });

  test("the set covers every effective status and both bits", () => {
    const entries = vectors.flatMap((v) => v.entries);
    expect(new Set(entries.map((e) => e.effective))).toEqual(new Set(["active", "suspended", "revoked", "retired"]));
    expect(entries.some((e) => e.bitstringStatusList?.revocation === 1)).toBe(true);
    expect(entries.some((e) => e.bitstringStatusList?.suspension === 1)).toBe(true);
  });

  test.each(vectors.map((v) => [v.name, v] as const))("%s: the bits follow the effective status", (_name, v) => {
    const indexed = v.entries.filter((e) => e.statusListIndex !== null);
    expect(indexed.map((e) => e.statusListIndex)).toEqual(indexed.map((_, i) => i));
    for (const e of indexed) {
      const i = e.statusListIndex!;
      expect(e.list).toBe(0);
      expect(e.position).toBe(i);
      expect(e.tokenStatusList).toBe(TSL_VALUE[e.effective]);
      expect(e.bitstringStatusList).toEqual({
        revocationIndex: i,
        revocation: e.effective === "revoked" || e.effective === "retired" ? 1 : 0,
        suspensionIndex: 131_072 + i,
        suspension: e.effective === "suspended" ? 1 : 0,
      });
      // The same bits in the published bytes of list 0.
      expect((Number.parseInt(v.tokenStatusListBytes.slice((i >> 2) * 2, (i >> 2) * 2 + 2), 16) >> ((i & 3) * 2)) & 3).toBe(e.tokenStatusList);
      expect((Number.parseInt(v.bitstringRevocationBytes.slice((i >> 3) * 2, (i >> 3) * 2 + 2), 16) >> (7 - (i & 7))) & 1).toBe(
        e.bitstringStatusList!.revocation,
      );
      expect((Number.parseInt(v.bitstringSuspensionBytes.slice((i >> 3) * 2, (i >> 3) * 2 + 2), 16) >> (7 - (i & 7))) & 1).toBe(
        e.bitstringStatusList!.suspension,
      );
    }
  });
});
