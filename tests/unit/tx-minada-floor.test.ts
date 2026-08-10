/**
 * tx-minada-floor.test.ts — the escrow min-ada floor.
 *
 * The escrow output locks payment + both bonds and the validator requires
 * exact value preservation (value_equal) on Claim and Submit. Submit grows
 * the inline datum (submitted_at None->Some, result_receipt_hash None->Some
 * 32 bytes), so the lovelace locked at POST time must already cover min-ada
 * for the Submitted state. A capability_id long enough to push the
 * Submitted output's min-ada past the economic total made lucid bump the
 * continuing output, value_equal failed, and the validator errored with no
 * traces — so escrows with short capability ids settled and long ones never
 * could. escrowLockFloor closes that by locking the max of the economic
 * total and the Submitted-state min-ada plus a margin.
 */

import { describe, it, expect } from "vitest";
import {
  escrowLockFloor,
  minAdaForEscrowDatum,
} from "../../packages/shared/src/tx/internal/minAdaFloor.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";

function openDatum(capabilityId: string): EscrowDatum {
  return {
    buyer_pkh: "3b2fdaed0398485ff35887fb7d0ad2025348864407854f7831dc6a55",
    supplier_pkh: "401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
    advert_ref: { txHash: "a6".repeat(32), index: 0 },
    capability_id: capabilityId,
    request_spec_hash: "1b".repeat(32),
    prompt_hash: "23".repeat(32),
    payment_lovelace: 200_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: 1_786_105_955_257,
    posted_at: 1_786_105_625_257,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };
}

const ECONOMIC_TOTAL = 2_200_000n; // 0.2 payment + 1.0 + 1.0 bonds

describe("escrowLockFloor", () => {
  it("barely lifts a short-capability escrow (margin only, no capability-driven bump)", () => {
    // The 20-byte chat capability's Submitted-state min-ada is ~2.15M, under
    // the 2.2M economic total; only the safety margin nudges the lock, so it
    // stays within a fraction of a percent of payment + bonds.
    const datum = openDatum("llm.text.generate.v1");
    const floor = escrowLockFloor(datum, ECONOMIC_TOTAL);
    expect(floor).toBeGreaterThanOrEqual(ECONOMIC_TOTAL);
    expect(floor).toBeLessThan(ECONOMIC_TOTAL + 100_000n); // << the OCR lift
  });

  it("raises a long-capability escrow above the economic total", () => {
    // The 33-byte OCR capability that could not settle: its Submitted-state
    // output needs more than 2.2M, so the floor must lift the lock.
    const datum = openDatum("ocr.page.extract.chandra-ocr-2.v1");
    const floor = escrowLockFloor(datum, ECONOMIC_TOTAL);
    expect(floor).toBeGreaterThan(ECONOMIC_TOTAL);
    // The locked value must satisfy the Submitted-state min-ada it is sized for.
    const submitted: EscrowDatum = {
      ...datum,
      submitted_at: datum.deliver_by,
      result_receipt_hash: "ff".repeat(32),
      state: "Submitted",
    };
    expect(floor).toBeGreaterThanOrEqual(minAdaForEscrowDatum(submitted, floor));
  });

  it("never returns less than the economic total", () => {
    for (const cap of ["a", "x".repeat(64), "tts.speak.v1"]) {
      expect(escrowLockFloor(openDatum(cap), ECONOMIC_TOTAL)).toBeGreaterThanOrEqual(
        ECONOMIC_TOTAL,
      );
    }
  });

  it("the floor is monotonic in capability-id length", () => {
    const short = escrowLockFloor(openDatum("a.b.v1"), ECONOMIC_TOTAL);
    const long = escrowLockFloor(openDatum("a.very.long.capability.id.that.keeps.going.v1"), ECONOMIC_TOTAL);
    expect(long).toBeGreaterThanOrEqual(short);
  });
});
