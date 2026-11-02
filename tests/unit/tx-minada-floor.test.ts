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
 *
 * The new escrow (Part 2 §6.1) adds agent_id and refund to the datum. Its
 * floor is checked against the exact ledger minimum (CML) of the escrow
 * output at the new escrow address.
 */

import { describe, it, expect } from "vitest";
import { CML } from "@lucid-evolution/lucid";
import {
  escrowLockFloor,
  minAdaForEscrowDatum,
} from "../../packages/shared/src/tx/internal/minAdaFloor.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import {
  encodeIdentityEscrowDatum,
  type IdentityEscrowDatum,
  type Refund,
} from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";

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

// ─── New escrow (16-field datum, Part 2 §6.1) ──────────────────────────

const BUYER_KEY = { type: "VerificationKey", hash: "3b2fdaed0398485ff35887fb7d0ad2025348864407854f7831dc6a55" } as const;

/** Post builders set refund = the buyer's own address with no datum (Part 2 §6.5). */
const ENTERPRISE_REFUND: Refund = { address: { paymentCredential: BUYER_KEY, stakeCredential: null }, datum: null };
const BASE_REFUND: Refund = {
  address: {
    paymentCredential: BUYER_KEY,
    stakeCredential: { type: "Inline", credential: { type: "VerificationKey", hash: "5a".repeat(28) } },
  },
  datum: null,
};
/** A refund with an inline datum, as a vault payment sets it (Part 2 §5.3). */
const DATUM_REFUND: Refund = { ...BASE_REFUND, datum: { kind: "constr", index: 1n, fields: [{ kind: "bytes", hex: "7e".repeat(32) }] } };

function identityDatum(capabilityId: string, refund: Refund | null): IdentityEscrowDatum {
  return { ...openDatum(capabilityId), agent_id: "a1".repeat(32), refund };
}

/** The exact ledger minimum (Babbage/Conway: (160 + output bytes) × coinsPerUtxoByte) of the escrow output. */
function ledgerMinimum(datum: IdentityEscrowDatum, lovelace: bigint): bigint {
  const output = CML.TransactionOutput.new(
    CML.Address.from_bech32(testIdentityBlueprint().escrowScriptAddress(1)),
    CML.Value.from_coin(lovelace),
    CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(encodeIdentityEscrowDatum(datum))),
  );
  return CML.min_ada_required(output, 4310n);
}

describe("escrowLockFloor, 16-field datum", () => {
  it("agent_id and refund raise the floor above the 14-field floor", () => {
    for (const refund of [null, ENTERPRISE_REFUND, BASE_REFUND]) {
      const legacy = openDatum("ocr.page.extract.chandra-ocr-2.v1");
      const identity = identityDatum(legacy.capability_id, refund);
      expect(minAdaForEscrowDatum(identity, ECONOMIC_TOTAL)).toBeGreaterThan(minAdaForEscrowDatum(legacy, ECONOMIC_TOTAL));
      expect(escrowLockFloor(identity, ECONOMIC_TOTAL)).toBeGreaterThan(escrowLockFloor(legacy, ECONOMIC_TOTAL));
    }
  });

  it("covers the exact ledger minimum of the Submitted output at the new escrow address", () => {
    for (const capabilityId of ["llm.text.generate.v1", "ocr.page.extract.chandra-ocr-2.v1", "x".repeat(64)]) {
      for (const refund of [null, ENTERPRISE_REFUND, BASE_REFUND, DATUM_REFUND]) {
        for (const total of [ECONOMIC_TOTAL, 4_000_000n]) {
          const open = identityDatum(capabilityId, refund);
          const floor = escrowLockFloor(open, total);
          expect(floor).toBeGreaterThanOrEqual(total);
          // Claim and Submit keep the value, so the Open lock must cover the largest state.
          const submitted: IdentityEscrowDatum = {
            ...open,
            submitted_at: open.deliver_by,
            result_receipt_hash: "ff".repeat(32),
            state: "Submitted",
          };
          expect(floor).toBeGreaterThanOrEqual(ledgerMinimum(submitted, floor));
          expect(floor).toBeGreaterThanOrEqual(ledgerMinimum(open, floor));
        }
      }
    }
  });
});
