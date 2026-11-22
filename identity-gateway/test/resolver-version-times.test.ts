import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { httpStatus } from "../src/resolve/resolver.js";
import { formatTime } from "../src/resolve/time.js";
import { nightly } from "./support/depth.js";
import { CONTROLLER_2, LedgerBuilder, PARTY_KEY, identityDatum, idOf, keySigner, timeAt, utf8 } from "./support/ledger.js";
import { didOf, errorType, resolveIn, resolverFor, tombstoneOf } from "./support/resolve.js";

// `updated` and `nextUpdate` (DID Core, "Revocation in Trustless Systems"). A verifier of a signature
// made at time S resolves with `versionTime` S. It accepts the document when `updated` is before S and
// `nextUpdate` is after S. Both times are block times in whole seconds. A version counts for
// `versionTime` S only when its block time is before S.
// Blocks have heights 100, 200, 300 and so on. The tip is block 1000, so each version of these
// tests is confirmed, except where a test says otherwise.

const ID = idOf("version times");
const DID = didOf(ID);

/** The time of the block at `height`, plus `seconds`, as the resolver writes times. */
const stamp = (height: number, seconds = 0): string => formatTime(timeAt(height) + seconds * 1000);
const named = (name: string) => identityDatum({ name: utf8(name) });

/** Version 0 at block 100, version 1 at block 200, version 2 at block 300. */
function threeVersions(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(ID, named("zero"), { height: 100 });
  b.update(ID, named("one"), { height: 200 });
  b.update(ID, named("two"), { height: 300 });
  return b;
}

describe("a version in the middle of the history", () => {
  test("the metadata of this version has exactly these members", async () => {
    const result = await resolveIn(threeVersions(), DID, { versionId: "1" });
    expect(Object.keys(result.didDocumentMetadata).sort()).toEqual([
      "canonicalId",
      "created",
      "nextUpdate",
      "nextVersionId",
      "updated",
      "vectorCurrent",
      "vectorKeys",
      "vectorLedger",
      "vectorOrigin",
      "vectorParties",
      "vectorProfile",
      "vectorStatus",
      "versionId",
    ]);
  });
});

describe("the current version", () => {
  test("no option: updated is the newest update; no nextUpdate and no nextVersionId", async () => {
    const result = await resolveIn(threeVersions(), DID);
    expect(result.didDocumentMetadata).toMatchObject({ updated: stamp(300), versionId: "2", vectorProfile: { name: "two" } });
    expect(result.didDocumentMetadata.nextUpdate).toBeUndefined();
    expect(result.didDocumentMetadata.nextVersionId).toBeUndefined();
  });

  test("a change of the value only is not an update", async () => {
    const b = threeVersions();
    b.touch(ID, 7_000_000n, { height: 400 });
    const result = await resolveIn(b, DID);
    expect(result.didDocumentMetadata).toMatchObject({ updated: stamp(300), versionId: "2" });
    expect(result.didDocumentMetadata.nextUpdate).toBeUndefined();
    expect((await resolveIn(b, DID, { versionId: "1" })).didDocumentMetadata.nextUpdate).toBe(stamp(300));
  });
});

describe("a next version that is not confirmed yet", () => {
  test("gives no nextVersionId and no nextUpdate until it has 30 confirmations", async () => {
    const b = new LedgerBuilder();
    b.register(ID, named("zero"), { height: 100 });
    const update = b.update(ID, named("one"), { height: 990 });
    const requests: Array<Record<string, string> | undefined> = [{ versionId: "0" }, { versionTime: stamp(985) }, { versionTime: stamp(990, 1) }, undefined];
    for (const options of requests) {
      const metadata = (await resolveIn(b, DID, options)).didDocumentMetadata;
      expect(metadata.versionId).toBe("0");
      expect(metadata.nextVersionId).toBeUndefined();
      expect(metadata.nextUpdate).toBeUndefined();
    }
    expect((await resolveIn(b, DID)).didDocumentMetadata.vectorPending).toEqual([update.txHash]);

    b.tip(1020);
    expect((await resolveIn(b, DID, { versionId: "0" })).didDocumentMetadata).toMatchObject({ nextVersionId: "1", nextUpdate: stamp(990) });
    expect((await resolveIn(b, DID, { versionTime: stamp(985) })).didDocumentMetadata).toMatchObject({ versionId: "0", nextUpdate: stamp(990) });
    expect((await resolveIn(b, DID)).didDocumentMetadata).toMatchObject({ versionId: "1", updated: stamp(990) });
  });

  test("29 confirmations give no nextUpdate; 30 give it", async () => {
    const b = new LedgerBuilder();
    b.register(ID, named("zero"), { height: 100 });
    b.update(ID, named("one"), { height: 990 });
    b.tip(1019);
    expect((await resolveIn(b, DID, { versionId: "0" })).didDocumentMetadata.nextUpdate).toBeUndefined();
    b.tip(1020);
    expect((await resolveIn(b, DID, { versionId: "0" })).didDocumentMetadata.nextUpdate).toBe(stamp(990));
  });
});

describe("versionTime and the time of an update (a version counts only when its block time is before the requested time)", () => {
  test.each([
    ["one second before an update", -1, { versionId: "0", updated: undefined, nextUpdate: stamp(200) }],
    ["exactly at an update", 0, { versionId: "0", updated: undefined, nextUpdate: stamp(200) }],
    ["one second after an update", 1, { versionId: "1", updated: stamp(200), nextUpdate: stamp(300) }],
  ])("%s", async (_name, seconds, expected) => {
    const metadata = (await resolveIn(threeVersions(), DID, { versionTime: stamp(200, seconds) })).didDocumentMetadata;
    expect(metadata.versionId).toBe(expected.versionId);
    expect(metadata.updated).toBe(expected.updated);
    expect(metadata.nextUpdate).toBe(expected.nextUpdate);
  });
});

describe("a revoked DID at a time before the revocation", () => {
  /** Version 0 at block 100, version 1 at block 200, the revocation at block 300. `at` is ten seconds before the block time. */
  function revoked(): LedgerBuilder {
    const b = new LedgerBuilder();
    b.register(ID, named("zero"), { height: 100 });
    b.update(ID, named("one"), { height: 200 });
    b.update(ID, tombstoneOf(named("one"), { type: "Revoked", by: keySigner(PARTY_KEY), reason: 9, at: timeAt(299), invalidFrom: null, successor: null }), { height: 300 });
    return b;
  }

  test.each([
    ["between the two updates", stamp(250)],
    ["after the lower bound of the revocation and before its block time", stamp(300, -5)],
    ["at the block time of the revocation", stamp(300)],
  ])("%s: 410 with the document of version 1; nextUpdate is the time of the revocation", async (_name, versionTime) => {
    const result = await resolveIn(revoked(), DID, { versionTime });
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).not.toBeNull();
    expect(result.didDocumentMetadata).toMatchObject({
      deactivated: true,
      versionId: "1",
      updated: stamp(200),
      nextVersionId: "2",
      nextUpdate: stamp(300),
      vectorStatus: { effective: "active" },
      vectorCurrent: { effective: "revoked" },
    });
  });

  test("one second after the revocation: 410 without a document; updated is the time of the revocation; no nextUpdate", async () => {
    const result = await resolveIn(revoked(), DID, { versionTime: stamp(300, 1) });
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).toBeNull();
    expect(result.didDocumentMetadata).toMatchObject({ deactivated: true, versionId: "2", updated: stamp(300), vectorStatus: { effective: "revoked" } });
    expect(result.didDocumentMetadata.nextUpdate).toBeUndefined();
    expect(result.didDocumentMetadata.nextVersionId).toBeUndefined();
  });

  test.each([
    ["no option", undefined],
    ["versionId of the revocation", { versionId: "2" }],
  ])("%s: 410 without a document; updated is the time of the revocation; no nextUpdate", async (_name, options) => {
    const result = await resolveIn(revoked(), DID, options);
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).toBeNull();
    expect(result.didDocumentMetadata).toMatchObject({ deactivated: true, versionId: "2", updated: stamp(300) });
    expect(result.didDocumentMetadata.nextUpdate).toBeUndefined();
  });

  test("a retired DID is the same", async () => {
    const b = new LedgerBuilder();
    b.register(ID, named("zero"), { height: 100 });
    b.update(ID, tombstoneOf(named("zero"), { type: "Retired", at: timeAt(300), successor: null }), { height: 300 });
    const before = await resolveIn(b, DID, { versionTime: stamp(250) });
    expect(httpStatus(before)).toBe(410);
    expect(before.didDocument).not.toBeNull();
    expect(before.didDocumentMetadata).toMatchObject({ versionId: "0", nextVersionId: "1", nextUpdate: stamp(300) });
    const now = await resolveIn(b, DID);
    expect(now.didDocument).toBeNull();
    expect(now.didDocumentMetadata).toMatchObject({ updated: stamp(300), versionId: "1" });
    expect(now.didDocumentMetadata.nextUpdate).toBeUndefined();
  });
});

describe("a time at or after the invalid-from time of a revocation", () => {
  /** Invalid from block 150, between version 0 (block 100) and version 1 (block 200). The revocation is at block 300. */
  function invalidatedFrom150(): LedgerBuilder {
    const b = new LedgerBuilder();
    b.register(ID, named("zero"), { height: 100 });
    b.update(ID, named("one"), { height: 200 });
    b.update(ID, tombstoneOf(named("one"), { type: "Revoked", by: keySigner(PARTY_KEY), reason: 1, at: timeAt(299), invalidFrom: timeAt(150), successor: null }), { height: 300 });
    return b;
  }

  // The requests one second before the invalid-from time, at it, at the revocation and one second after it, and versionId 0, are
  // in vectors/revoked-invalid-from.json (vectors.test.ts).
  test.each([
    ["after it and before version 1", stamp(150, 1), { versionId: "0", updated: undefined, nextUpdate: stamp(200) }],
    ["between version 1 and the revocation", stamp(250), { versionId: "1", updated: stamp(200), nextUpdate: stamp(300) }],
  ])("%s: no document, whichever version is the base", async (_name, versionTime, expected) => {
    const result = await resolveIn(invalidatedFrom150(), DID, { versionTime });
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).toBeNull();
    expect(result.didResolutionMetadata).toEqual({});
    const metadata = result.didDocumentMetadata;
    expect(metadata).toMatchObject({ deactivated: true, vectorStatus: { effective: "revoked", effectiveReason: "invalidated", invalidFrom: stamp(150) } });
    expect(metadata.versionId).toBe(expected.versionId);
    expect(metadata.updated).toBe(expected.updated);
    expect(metadata.nextUpdate).toBe(expected.nextUpdate);
  });
});

describe("a subagent", () => {
  const PARENT = idOf("version times parent");
  const CHILD = idOf("version times child");
  const childDatum = (name: string) =>
    identityDatum({ lineage: { type: "Subagent", parent: PARENT, parentEpoch: 0, depth: 1 }, endpoint: new Uint8Array(), controller: CONTROLLER_2, name: utf8(name) });

  test("has the times of its own versions: an update of its parent is not an update of the subagent", async () => {
    const b = new LedgerBuilder();
    b.register(PARENT, identityDatum(), { height: 100 });
    b.register(CHILD, childDatum("child"), { height: 150 });
    b.update(PARENT, identityDatum({ subagentEpoch: 1 }), { height: 400 });
    const result = await resolveIn(b, didOf(CHILD), { versionTime: stamp(300) });
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).not.toBeNull();
    expect(result.didDocumentMetadata).toMatchObject({ versionId: "0", vectorStatus: { effective: "active" }, vectorCurrent: { effective: "revoked", effectiveReason: "parentRevoked" } });
    expect(result.didDocumentMetadata.updated).toBeUndefined();
    expect(result.didDocumentMetadata.nextUpdate).toBeUndefined();
  });

  test("a time at or after the invalid-from time of its parent gives no document; the times stay those of the subagent", async () => {
    const b = new LedgerBuilder();
    b.register(PARENT, identityDatum(), { height: 100 });
    b.register(CHILD, childDatum("child"), { height: 150 });
    b.update(CHILD, childDatum("child one"), { height: 250 });
    b.update(PARENT, tombstoneOf(identityDatum(), { type: "Revoked", by: keySigner(PARTY_KEY), reason: 1, at: timeAt(399), invalidFrom: timeAt(200), successor: null }), { height: 400 });
    const before = await resolveIn(b, didOf(CHILD), { versionTime: stamp(200, -1) });
    expect(before.didDocument).not.toBeNull();
    expect(before.didDocumentMetadata).toMatchObject({ versionId: "0", nextVersionId: "1", nextUpdate: stamp(250), vectorStatus: { effective: "active" } });
    const at = await resolveIn(b, didOf(CHILD), { versionTime: stamp(200) });
    expect(at.didDocument).toBeNull();
    expect(at.didDocumentMetadata).toMatchObject({ versionId: "0", nextUpdate: stamp(250), vectorStatus: { effective: "revoked", effectiveReason: "parentRevoked" } });
    const later = await resolveIn(b, didOf(CHILD), { versionTime: stamp(300) });
    expect(later.didDocument).toBeNull();
    expect(later.didDocumentMetadata).toMatchObject({ versionId: "1", updated: stamp(250) });
    expect(later.didDocumentMetadata.nextUpdate).toBeUndefined();
  });
});

describe("any history", () => {
  /** Each step is 0 (another transaction of the same block) or 1 to 3 (blocks later). */
  const steps = fc.array(fc.constantFrom(0, 0, 1, 2, 3), { maxLength: 7 });

  test("the version that versionTime or versionId picks has its own profile and the times created, updated and nextUpdate", async () => {
    const seed = Date.now();
    console.info(`resolver-version-times: seed ${seed}`);
    await fc.assert(
      fc.asyncProperty(steps, async (history) => {
        const b = new LedgerBuilder();
        const heights = [100];
        b.register(ID, named("version 0"), { height: 100 });
        let txIndex = 0;
        for (const [i, step] of history.entries()) {
          const height = heights[i]! + step * 10;
          txIndex = step === 0 ? txIndex + 1 : 0;
          heights.push(height);
          b.update(ID, named(`version ${i + 1}`), { height, txIndex });
        }
        const times = heights.map((height) => timeAt(height));
        // `base` is the number of the version that the request picks, or null when no version is before the requested time.
        const requests: Array<{ options: Record<string, string>; base: number | null }> = [];
        for (const time of times) {
          for (const seconds of [-1, 0, 1]) {
            const requested = time + seconds * 1000;
            const counted = times.filter((t) => t < requested).length;
            requests.push({ options: { versionTime: formatTime(requested) }, base: counted === 0 ? null : counted - 1 });
          }
        }
        times.forEach((_time, version) => requests.push({ options: { versionId: String(version) }, base: version }));

        const resolver = resolverFor(b);
        for (const { options, base } of requests) {
          const result = await resolver.resolveDid(DID, options);
          if (base === null) {
            expect(errorType(result)).toBe("NOT_FOUND");
            continue;
          }
          const { versionId, created, updated, nextVersionId, nextUpdate, vectorProfile } = result.didDocumentMetadata;
          const hasNext = base + 1 < times.length;
          expect({ versionId, created, updated, nextVersionId, nextUpdate, name: vectorProfile?.name }).toEqual({
            versionId: String(base),
            created: formatTime(times[0]!),
            updated: base > 0 ? formatTime(times[base]!) : undefined,
            nextVersionId: hasNext ? String(base + 1) : undefined,
            nextUpdate: hasNext ? formatTime(times[base + 1]!) : undefined,
            name: `version ${base}`,
          });
        }
      }),
      // The examples are the shapes of the cases that this property replaced (a chain of three versions, and two updates in one block)
      // and two edges: no update, and an update in the block of the mint.
      { seed, numRuns: nightly ? 200 : 15, examples: [[[]], [[0]], [[1, 1]], [[1, 0, 1]]] },
    );
  });
});
