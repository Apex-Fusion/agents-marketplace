/**
 * unreadable-refs.test.ts — the memory of the escrows whose datum a chain client withheld.
 *
 * The sweeper and the recovery of one-shot jobs say each such escrow one time, and ask the chain no more about it. The memory holds
 * the last MAX_UNREADABLE_REFS references and forgets the oldest first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UNREADABLE_REFS, isUnreadable, noteUnreadable, resetUnreadableForTests } from "../src/onchain/unreadable.js";

describe("the memory of unreadable escrows", () => {
  let log: ReturnType<typeof vi.spyOn>;
  const ref = (index: number): string => `${"ab".repeat(32)}#${index}`;

  beforeEach(() => {
    resetUnreadableForTests();
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
  });

  it("writes one line for a reference, and none when the same reference comes again", () => {
    expect(isUnreadable(ref(1))).toBe(false);
    noteUnreadable(ref(1), "sweeper");
    noteUnreadable(ref(1), "recovery");
    expect(isUnreadable(ref(1))).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("[gateway:sweeper]");
    expect(String(log.mock.calls[0]?.[0])).toContain(ref(1));
  });

  it("remembers 5,000 references, and forgets the oldest one when the 5,001st comes", () => {
    expect(MAX_UNREADABLE_REFS).toBe(5_000);
    for (let index = 0; index < MAX_UNREADABLE_REFS; index += 1) noteUnreadable(ref(index), "sweeper");
    expect(isUnreadable(ref(0))).toBe(true); // 5,000 references: nothing is forgotten yet
    expect(isUnreadable(ref(MAX_UNREADABLE_REFS - 1))).toBe(true);

    noteUnreadable(ref(MAX_UNREADABLE_REFS), "sweeper"); // the 5,001st
    expect(isUnreadable(ref(0))).toBe(false);
    expect(isUnreadable(ref(1))).toBe(true);
    expect(isUnreadable(ref(MAX_UNREADABLE_REFS))).toBe(true);

    log.mockClear();
    noteUnreadable(ref(0), "sweeper"); // the forgotten reference gets its line again, and the next oldest goes
    expect(log).toHaveBeenCalledTimes(1);
    expect(isUnreadable(ref(1))).toBe(false);
  });
});
