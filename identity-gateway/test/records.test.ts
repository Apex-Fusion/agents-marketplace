import { describe, expect, test } from "vitest";
import { CUTOFF_HEIGHT, LEGACY_OWNER, LedgerBuilder, identityDatum, idOf, legacyDatum } from "./support/ledger.js";
import { resolverFor } from "./support/resolve.js";

describe("listRecords (status-list index, Part 2 Section 8.6)", () => {
  test("ledger order of the first mint; adopted records keep their legacy index; late legacy mints and unconfirmed mints get none", async () => {
    const b = new LedgerBuilder();
    const legacyA = idOf("legacy A");
    const legacyB = idOf("legacy B");
    const adopted = idOf("adopted");
    const native = idOf("native");
    const late = idOf("late legacy");
    const fresh = idOf("unconfirmed");
    b.legacyRegister(legacyB, legacyDatum(), { height: 200, txIndex: 1, vkeys: [LEGACY_OWNER] });
    b.legacyRegister(legacyA, legacyDatum(), { height: 200, txIndex: 0, vkeys: [LEGACY_OWNER] });
    b.legacyRegister(adopted, legacyDatum(), { height: 300, vkeys: [LEGACY_OWNER] });
    b.register(native, identityDatum(), { height: 250 });
    b.legacyRegister(late, legacyDatum(), { height: CUTOFF_HEIGHT + 10, vkeys: [LEGACY_OWNER] });
    b.adopt(adopted, identityDatum(), { height: 600 });
    b.register(fresh, identityDatum(), { height: 990 });
    b.legacyDeregister(legacyB, { height: 700 });

    const list = await resolverFor(b).listRecords();
    expect(list.tip.blockHeight).toBe(1000);
    expect(list.entries.map((e) => [e.vectorId, e.origin, e.firstMint.blockHeight, e.firstMint.txIndex, e.statusListIndex])).toEqual([
      [legacyA, "legacy", 200, 0, 0],
      [legacyB, "legacy", 200, 1, 1],
      [native, "native", 250, 0, 2],
      [adopted, "adopted", 300, 0, 3],
      [fresh, "native", 990, 0, null],
    ]);
    expect(list.entries[0]!.firstMint).toMatchObject({ outputIndex: 0, slot: 2000, confirmations: 800 });
  });

  test("an asset with more than one mint takes its first mint from the asset history", async () => {
    const b = new LedgerBuilder();
    const twice = idOf("twice");
    b.legacyRegister(twice, legacyDatum(), { height: 200, vkeys: [LEGACY_OWNER] });
    b.legacyDeregister(twice, { height: 210 });
    b.legacyRegister(twice, legacyDatum(), { height: 220, vkeys: [LEGACY_OWNER] });
    const list = await resolverFor(b).listRecords();
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]!.firstMint.blockHeight).toBe(200);
  });

  test("a failed read throws", async () => {
    const b = new LedgerBuilder();
    b.chain.failing.add("policyAssets");
    await expect(resolverFor(b).listRecords()).rejects.toThrow(/503/);
  });
});
