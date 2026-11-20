import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { httpStatus } from "../src/resolve/resolver.js";
import { formatTime } from "../src/resolve/time.js";
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

/** Versions 1 and 2 are two transactions of block 200: the same block time. */
function twoUpdatesInOneSecond(): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(ID, named("zero"), { height: 100 });
  b.update(ID, named("one"), { height: 200, txIndex: 0 });
  b.update(ID, named("two"), { height: 200, txIndex: 1 });
  b.update(ID, named("three"), { height: 300 });
  return b;
}

describe("a version in the middle of the history", () => {
  test("versionId gives the time of its own update and the time of the next update", async () => {
    const result = await resolveIn(threeVersions(), DID, { versionId: "1" });
    expect(httpStatus(result)).toBe(200);
    expect(result.didDocumentMetadata).toMatchObject({
      created: stamp(100),
      updated: stamp(200),
      versionId: "1",
      nextVersionId: "2",
      nextUpdate: stamp(300),
      vectorProfile: { name: "one" },
    });
  });

  test("versionTime between the two updates gives the same two times", async () => {
    const result = await resolveIn(threeVersions(), DID, { versionTime: stamp(250) });
    expect(result.didDocumentMetadata).toMatchObject({
      updated: stamp(200),
      versionId: "1",
      nextVersionId: "2",
      nextUpdate: stamp(300),
      vectorProfile: { name: "one" },
    });
  });

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

  test("the time of each next update is the time of the next version, so the versions chain without a gap", async () => {
    const b = twoUpdatesInOneSecond();
    for (let version = 0; version < 3; version++) {
      const here = (await resolveIn(b, DID, { versionId: String(version) })).didDocumentMetadata;
      const next = (await resolveIn(b, DID, { versionId: String(version + 1) })).didDocumentMetadata;
      expect(here.nextVersionId).toBe(String(version + 1));
      expect(here.nextUpdate).toBe(next.updated);
    }
  });
});

describe("the first version", () => {
  test.each([
    ["versionId 0", { versionId: "0" }],
    ["versionTime after the first mint", { versionTime: stamp(100, 1) }],
  ])("%s has no updated, because no update happened; nextUpdate is the time of version 1", async (_name, options) => {
    const result = await resolveIn(threeVersions(), DID, options);
    expect(result.didDocumentMetadata).toMatchObject({ created: stamp(100), versionId: "0", nextVersionId: "1", nextUpdate: stamp(200) });
    expect(result.didDocumentMetadata.updated).toBeUndefined();
  });

  test("versionTime at the time of the first mint is NOT_FOUND: no version is before it", async () => {
    expect(errorType(await resolveIn(threeVersions(), DID, { versionTime: stamp(100) }))).toBe("NOT_FOUND");
  });
});

describe("the current version", () => {
  test.each([
    ["no option", undefined],
    ["versionId of the newest version", { versionId: "2" }],
    ["versionTime after the newest update", { versionTime: stamp(300, 1) }],
    ["versionTime later than the tip", { versionTime: "9999-12-31T23:59:59Z" }],
  ])("%s: updated is the newest update; no nextUpdate and no nextVersionId", async (_name, options) => {
    const result = await resolveIn(threeVersions(), DID, options);
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

  test("at an update the next update is not after the requested time, so DID Core accepts no signature made at that second", async () => {
    const requested = stamp(200);
    const metadata = (await resolveIn(threeVersions(), DID, { versionTime: requested })).didDocumentMetadata;
    expect(metadata.nextUpdate).toBe(requested);
    expect(Date.parse(metadata.nextUpdate!)).not.toBeGreaterThan(Date.parse(requested));
  });

  test("whatever the time, updated (or created, for version 0) is before it, and nextUpdate is not before it", async () => {
    for (const b of [threeVersions(), twoUpdatesInOneSecond()]) {
      for (const height of [100, 200, 300, 400]) {
        for (const seconds of [-10, -1, 0, 1, 5]) {
          const requested = stamp(height, seconds);
          const result = await resolveIn(b, DID, { versionTime: requested });
          if (errorType(result) !== undefined) {
            expect(errorType(result)).toBe("NOT_FOUND");
            expect(Date.parse(requested)).toBeLessThanOrEqual(Date.parse(stamp(100)));
            continue;
          }
          const metadata = result.didDocumentMetadata;
          expect(Date.parse(metadata.updated ?? metadata.created!)).toBeLessThan(Date.parse(requested));
          if (metadata.nextUpdate !== undefined) expect(Date.parse(metadata.nextUpdate)).toBeGreaterThanOrEqual(Date.parse(requested));
          expect(metadata.nextUpdate === undefined).toBe(metadata.nextVersionId === undefined);
        }
      }
    }
  });
});

describe("two updates in the same second", () => {
  test("versionId of the first one: updated and nextUpdate are the same time", async () => {
    const metadata = (await resolveIn(twoUpdatesInOneSecond(), DID, { versionId: "1" })).didDocumentMetadata;
    expect(metadata).toMatchObject({ versionId: "1", updated: stamp(200), nextVersionId: "2", nextUpdate: stamp(200), vectorProfile: { name: "one" } });
  });

  test("versionId of the second one: nextUpdate is the time of the update after it", async () => {
    const metadata = (await resolveIn(twoUpdatesInOneSecond(), DID, { versionId: "2" })).didDocumentMetadata;
    expect(metadata).toMatchObject({ versionId: "2", updated: stamp(200), nextVersionId: "3", nextUpdate: stamp(300), vectorProfile: { name: "two" } });
  });

  test("versionTime at that second gives the version before both", async () => {
    const metadata = (await resolveIn(twoUpdatesInOneSecond(), DID, { versionTime: stamp(200) })).didDocumentMetadata;
    expect(metadata).toMatchObject({ versionId: "0", nextVersionId: "1", nextUpdate: stamp(200) });
    expect(metadata.updated).toBeUndefined();
  });

  test("versionTime one second later gives the second one; no time gives the first one", async () => {
    const b = twoUpdatesInOneSecond();
    expect((await resolveIn(b, DID, { versionTime: stamp(200, 1) })).didDocumentMetadata).toMatchObject({
      versionId: "2",
      updated: stamp(200),
      nextVersionId: "3",
      nextUpdate: stamp(300),
      vectorProfile: { name: "two" },
    });
    for (const seconds of [-100, -1, 0, 1, 2, 5, 100]) {
      const metadata = (await resolveIn(b, DID, { versionTime: stamp(200, seconds) })).didDocumentMetadata;
      expect(metadata.versionId).not.toBe("1");
    }
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

  test("one second before it: the document of version 0", async () => {
    const result = await resolveIn(invalidatedFrom150(), DID, { versionTime: stamp(150, -1) });
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).not.toBeNull();
    expect(result.didDocumentMetadata).toMatchObject({
      deactivated: true,
      versionId: "0",
      nextVersionId: "1",
      nextUpdate: stamp(200),
      vectorStatus: { effective: "active" },
    });
    expect(result.didDocumentMetadata.updated).toBeUndefined();
  });

  test.each([
    ["at the invalid-from time", stamp(150), { versionId: "0", updated: undefined, nextUpdate: stamp(200) }],
    ["after it and before version 1", stamp(150, 1), { versionId: "0", updated: undefined, nextUpdate: stamp(200) }],
    ["between version 1 and the revocation", stamp(250), { versionId: "1", updated: stamp(200), nextUpdate: stamp(300) }],
    ["at the block time of the revocation", stamp(300), { versionId: "1", updated: stamp(200), nextUpdate: stamp(300) }],
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

  test("after the revocation: no document, the revocation is the base, no nextUpdate", async () => {
    const result = await resolveIn(invalidatedFrom150(), DID, { versionTime: stamp(300, 1) });
    expect(result.didDocument).toBeNull();
    expect(result.didDocumentMetadata).toMatchObject({ versionId: "2", updated: stamp(300) });
    expect(result.didDocumentMetadata.nextUpdate).toBeUndefined();
  });

  test("versionId 0 keeps its document, because its own time is before the invalid-from time", async () => {
    const result = await resolveIn(invalidatedFrom150(), DID, { versionId: "0" });
    expect(result.didDocument).not.toBeNull();
    expect(result.didDocumentMetadata).toMatchObject({ versionId: "0", nextUpdate: stamp(200) });
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

  test("updated and nextUpdate are the version times that the versionTime rule and the version number pick", async () => {
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
          const { versionId, updated, nextVersionId, nextUpdate } = result.didDocumentMetadata;
          const hasNext = base + 1 < times.length;
          expect({ versionId, updated, nextVersionId, nextUpdate }).toEqual({
            versionId: String(base),
            updated: base > 0 ? formatTime(times[base]!) : undefined,
            nextVersionId: hasNext ? String(base + 1) : undefined,
            nextUpdate: hasNext ? formatTime(times[base + 1]!) : undefined,
          });
        }
      }),
      { numRuns: 60 },
    );
  });
});
