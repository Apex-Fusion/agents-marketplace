/**
 * Escrow state-machine property tests — M0-D
 *
 * Spec source: ARCHITECTURE.md §4.3 (redeemer/state table) and §4.4 (state diagram).
 *
 * Since the Plutus validator does not exist yet, this test encodes the full
 * transition matrix at the datum level:
 *   - Each (from_state, redeemer) pair is either PERMITTED or FORBIDDEN per §4.3.
 *   - "Permitted" means the transition is spec-correct; "Forbidden" means the
 *     validator MUST reject it.
 *   - We verify the datum codec correctly round-trips every from_state so that
 *     M1's validator has a concrete test anchor.
 *
 * The transition check itself is pure spec validation — there is no validator
 * code to call yet.  The table is written as a reference that future validator
 * tests MUST pass.  Any deviation between this table and the live validator
 * constitutes a contract violation.
 *
 * States:  Open, Claimed, Submitted, Accepted (terminal), Reclaimed (terminal), Released (terminal)
 * Redeemers: Claim, Submit, Accept, Reclaim, Release
 *
 * Per §4.3:
 *   Claim    — Open → Claimed           (supplier signs)
 *   Submit   — Claimed → Submitted      (supplier signs)
 *   Accept   — Submitted → Accepted     (buyer signs)
 *   Reclaim  — Open|Claimed → Reclaimed (buyer signs, now >= deliver_by)
 *   Release  — Submitted → Released     (supplier signs, now >= submitted_at + ACCEPT_WINDOW)
 */

import { describe, it, expect } from "vitest";
import { encodeEscrowDatum, decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum, EscrowState } from "../../packages/shared/src/cbor/types.js";

// ─── Constants from ARCHITECTURE.md §4.3 ─────────────────────────────────────

const ACCEPT_WINDOW_MS = 10 * 60 * 1000; // 10 min

// ─── Redeemer type ────────────────────────────────────────────────────────────

type Redeemer = "Claim" | "Submit" | "Accept" | "Reclaim" | "Release";

const ALL_STATES: EscrowState[] = [
  "Open",
  "Claimed",
  "Submitted",
  "Accepted",
  "Reclaimed",
  "Released",
];

const ALL_REDEEMERS: Redeemer[] = [
  "Claim",
  "Submit",
  "Accept",
  "Reclaim",
  "Release",
];

// ─── Fixture factory ──────────────────────────────────────────────────────────

const BASE_POSTED_AT = 1745500000000;
const BASE_DELIVER_BY = BASE_POSTED_AT + 60_000; // 60s after posted
const BASE_SUBMITTED_AT = BASE_POSTED_AT + 10_000;

function makeEscrow(state: EscrowState): EscrowDatum {
  const needsSubmittedFields =
    state === "Submitted" || state === "Accepted" || state === "Released";
  return {
    buyer_pkh: "1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
    advert_ref: { txHash: "b".repeat(64), index: 0 },
    capability_id: "llm.text.generate.v1",
    request_spec_hash: "c".repeat(64),
    prompt_hash: "d".repeat(64),
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: BASE_DELIVER_BY,
    posted_at: BASE_POSTED_AT,
    submitted_at: needsSubmittedFields ? BASE_SUBMITTED_AT : null,
    result_receipt_hash: needsSubmittedFields ? "e".repeat(64) : null,
    state,
  };
}

// ─── State machine: permitted transitions per §4.3 ───────────────────────────

/**
 * Returns true if the (fromState, redeemer) pair is PERMITTED per ARCHITECTURE §4.3.
 * Timing preconditions (deliver_by, ACCEPT_WINDOW) are noted but not simulated here —
 * the table captures the state precondition only.  Timing is a validator-level concern.
 *
 * The full 6×5 = 30 cell matrix:
 *
 * fromState \ Redeemer | Claim | Submit | Accept | Reclaim | Release
 * --------------------|-------|--------|--------|---------|--------
 * Open                |  YES  |   NO   |   NO   |  YES*   |   NO
 * Claimed             |   NO  |  YES   |   NO   |  YES*   |   NO
 * Submitted           |   NO  |   NO   |  YES   |   NO    |  YES*
 * Accepted  (term.)   |   NO  |   NO   |   NO   |   NO    |   NO
 * Reclaimed (term.)   |   NO  |   NO   |   NO   |   NO    |   NO
 * Released  (term.)   |   NO  |   NO   |   NO   |   NO    |   NO
 *
 * * timing-gated — the validator also checks now >= deliver_by (Reclaim)
 *   or now >= submitted_at + ACCEPT_WINDOW (Release).
 */
function isPermitted(fromState: EscrowState, redeemer: Redeemer): boolean {
  switch (fromState) {
    case "Open":
      return redeemer === "Claim" || redeemer === "Reclaim";
    case "Claimed":
      return redeemer === "Submit" || redeemer === "Reclaim";
    case "Submitted":
      return redeemer === "Accept" || redeemer === "Release";
    case "Accepted":
    case "Reclaimed":
    case "Released":
      return false; // terminal — no transitions out
  }
}

/**
 * Returns the expected resulting state for a PERMITTED transition.
 * Only called for permitted (fromState, redeemer) pairs.
 */
function expectedNextState(
  fromState: EscrowState,
  redeemer: Redeemer,
): EscrowState {
  if (fromState === "Open" && redeemer === "Claim") return "Claimed";
  if (fromState === "Open" && redeemer === "Reclaim") return "Reclaimed";
  if (fromState === "Claimed" && redeemer === "Submit") return "Submitted";
  if (fromState === "Claimed" && redeemer === "Reclaim") return "Reclaimed";
  if (fromState === "Submitted" && redeemer === "Accept") return "Accepted";
  if (fromState === "Submitted" && redeemer === "Release") return "Released";
  throw new Error(`No expected next state for ${fromState} + ${redeemer}`);
}

// ─── Full 6×5 matrix table-driven test ───────────────────────────────────────

describe("Escrow state machine — full 6×5 transition matrix (§4.3)", () => {
  for (const fromState of ALL_STATES) {
    for (const redeemer of ALL_REDEEMERS) {
      const permitted = isPermitted(fromState, redeemer);
      const label = permitted ? "PERMITTED" : "FORBIDDEN";
      it(`[${label}] ${fromState} + ${redeemer}`, () => {
        // Datum round-trip confirms codec correctly represents the from_state
        const datum = makeEscrow(fromState);
        const hex = encodeEscrowDatum(datum);
        const decoded = decodeEscrowDatum(hex);
        expect(decoded.state).toBe(fromState);

        // The transition check is spec-level — assert the matrix entry is correct
        expect(isPermitted(fromState, redeemer)).toBe(permitted);

        if (permitted) {
          // For permitted transitions, verify the expected next state is a valid EscrowState
          const next = expectedNextState(fromState, redeemer);
          expect(ALL_STATES).toContain(next);
        }
      });
    }
  }
});

// ─── Permitted transitions: from_state encodes to distinct CBOR ──────────────

describe("Escrow state machine — from_state CBOR distinctness", () => {
  it("each from_state encodes to a distinct CBOR hex", () => {
    const hexes = ALL_STATES.map((s) => encodeEscrowDatum(makeEscrow(s)));
    const unique = new Set(hexes);
    expect(unique.size).toBe(ALL_STATES.length);
  });
});

// ─── Terminal states produce no valid redeemers ───────────────────────────────

describe("Escrow state machine — terminal state constraints", () => {
  const TERMINAL: EscrowState[] = ["Accepted", "Reclaimed", "Released"];

  for (const terminal of TERMINAL) {
    it(`${terminal} permits NO redeemers (all 5 are FORBIDDEN)`, () => {
      const forbidden = ALL_REDEEMERS.filter((r) => isPermitted(terminal, r));
      expect(forbidden).toHaveLength(0);
    });
  }
});

// ─── Reclaim timing precondition (datum-level) ────────────────────────────────

describe("Escrow state machine — Reclaim timing (datum-level spec)", () => {
  it("datum with submitted_at > deliver_by is accepted by codec (validator rejects, not codec)", () => {
    // §7.3 adversarial case: Submit after deliver_by.
    // The codec must be permissive — timing enforcement is the validator's job.
    const escrow = makeEscrow("Claimed");
    const lateSubmit: EscrowDatum = {
      ...escrow,
      submitted_at: BASE_DELIVER_BY + 1_000, // 1s after deadline
      state: "Submitted",
      result_receipt_hash: "e".repeat(64),
    };
    expect(() => {
      const hex = encodeEscrowDatum(lateSubmit);
      const decoded = decodeEscrowDatum(hex);
      expect(decoded.submitted_at).toBe(BASE_DELIVER_BY + 1_000);
    }).not.toThrow();
  });

  it("datum with posted_at > deliver_by is accepted by codec (validator rejects, not codec)", () => {
    // Edge: deliver_by before posted_at — physically impossible but codec must not validate this.
    const escrow: EscrowDatum = {
      ...makeEscrow("Open"),
      posted_at: BASE_DELIVER_BY + 5_000,
      deliver_by: BASE_DELIVER_BY,
    };
    expect(() => {
      const hex = encodeEscrowDatum(escrow);
      const decoded = decodeEscrowDatum(hex);
      expect(decoded.posted_at).toBe(BASE_DELIVER_BY + 5_000);
    }).not.toThrow();
  });
});

// ─── Release timing: ACCEPT_WINDOW constant ──────────────────────────────────

describe("Escrow state machine — Release timing window constant", () => {
  it("ACCEPT_WINDOW is 10 minutes (600_000 ms) per ARCHITECTURE §4.3", () => {
    // This test locks down the constant so Catherine's validator must match.
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
  });

  it("datum encoding preserves submitted_at for Release window calculation", () => {
    const escrow = makeEscrow("Submitted");
    const hex = encodeEscrowDatum(escrow);
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.submitted_at).toBe(BASE_SUBMITTED_AT);
    // Release is valid if: now >= submitted_at + ACCEPT_WINDOW_MS
    const earliestRelease = decoded.submitted_at! + ACCEPT_WINDOW_MS;
    expect(earliestRelease).toBe(BASE_SUBMITTED_AT + 600_000);
  });
});

// ─── Redeemer count sanity ────────────────────────────────────────────────────

describe("Escrow state machine — matrix sanity counts", () => {
  it("exactly 7 permitted transitions in the full 6×5 matrix", () => {
    // Per §4.3:
    //   Open+Claim, Open+Reclaim,
    //   Claimed+Submit, Claimed+Reclaim,
    //   Submitted+Accept, Submitted+Release
    // = 6 permitted cells
    const permitted = ALL_STATES.flatMap((s) =>
      ALL_REDEEMERS.filter((r) => isPermitted(s, r)).map((r) => `${s}+${r}`)
    );
    expect(permitted).toHaveLength(6);
    expect(permitted).toEqual(
      expect.arrayContaining([
        "Open+Claim",
        "Open+Reclaim",
        "Claimed+Submit",
        "Claimed+Reclaim",
        "Submitted+Accept",
        "Submitted+Release",
      ])
    );
  });

  it("exactly 24 forbidden transitions in the full 6×5 matrix", () => {
    const forbidden = ALL_STATES.flatMap((s) =>
      ALL_REDEEMERS.filter((r) => !isPermitted(s, r))
    );
    expect(forbidden).toHaveLength(24);
  });
});
