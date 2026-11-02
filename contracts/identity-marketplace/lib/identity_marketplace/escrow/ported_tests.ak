//// The 17 tests of the legacy escrow (`contracts/marketplace/validators/escrow.ak`),
//// ported to the new datum and rules (Part 2 §6.1, §12.1: "port the 17
//// current escrow tests"). Names, amounts and times are unchanged.
////
//// Changes in every test:
////
//// - the datum has `agent_id` and `refund = None`;
//// - `supplier_pkh` is the key hash of a listed Ed25519 key with the
////   transaction purpose;
//// - the transaction holds the escrow input (rule 1 counts script inputs),
////   and Claim and Submit read the agent's record as a reference input;
//// - each test runs every rule of §6.1 (`rules.spend`), not only the rules of
////   one redeemer;
//// - an adversarial test asserts `False` (`!spend(...)`) instead of a `fail`
////   test with `expect`, so a test passes only when the rules reject the
////   transaction, not when it crashes.
////
//// No test changes its expectation. `tests/escrow.md` has the details.

use cardano/transaction.{Transaction}
use identity_marketplace/common.{accept_window_ms}
use identity_marketplace/escrow/fixtures.{
  Case, buyer_bond_amt, buyer_pkh, claimed_datum, deliver_by_ms, escrow_input,
  escrow_output, open_datum, payment_amt, pkh_output, receipt_hash_32,
  receipt_hash_short, record_ref, run, stranger_pkh, submitted_at_ms,
  submitted_datum, supplier_bond_amt, supplier_pkh, validity_between,
}
use identity_marketplace/types.{
  Accept, Claim, EscrowDatum, EscrowRedeemer, Reclaim, Release, Submit,
  Submitted,
}

fn base_tx() -> Transaction {
  transaction.placeholder
}

fn spend(datum: EscrowDatum, redeemer: EscrowRedeemer, tx: Transaction) -> Bool {
  run(Case { datum, redeemer, tx })
}

// ─── Happy: Claim ─────────────────────────────────────────────────────
test claim_happy_path() {
  let old = open_datum()
  let new = claimed_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      reference_inputs: [record_ref()],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(
        deliver_by_ms - 1_000_000,
        deliver_by_ms - 500_000,
      ),
    }
  spend(old, Claim, t)
}

// ─── Happy: Submit ────────────────────────────────────────────────────
test submit_happy_path() {
  let old = claimed_datum()
  let stamp = deliver_by_ms - 500_000
  let new =
    EscrowDatum {
      ..old,
      submitted_at: Some(stamp),
      result_receipt_hash: Some(receipt_hash_32),
      state: Submitted,
    }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      reference_inputs: [record_ref()],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(deliver_by_ms - 1_000_000, stamp),
    }
  spend(old, Submit { receipt_hash: receipt_hash_32 }, t)
}

// ─── Happy: Accept ────────────────────────────────────────────────────
test accept_happy_path() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms,
      ),
    }
  spend(old, Accept, t)
}

// ─── Happy: Reclaim from Open ─────────────────────────────────────────
test reclaim_from_open_happy_path() {
  let old = open_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(buyer_pkh, payment_amt + buyer_bond_amt + supplier_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(deliver_by_ms, deliver_by_ms + 1_000_000),
    }
  spend(old, Reclaim, t)
}

// ─── Happy: Reclaim from Claimed ──────────────────────────────────────
test reclaim_from_claimed_happy_path() {
  let old = claimed_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(buyer_pkh, payment_amt + buyer_bond_amt + supplier_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(deliver_by_ms, deliver_by_ms + 1_000_000),
    }
  spend(old, Reclaim, t)
}

// ─── Happy: Release after window ──────────────────────────────────────
test release_happy_path() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(
          supplier_pkh,
          payment_amt + supplier_bond_amt + buyer_bond_amt,
        ),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(
        submitted_at_ms + accept_window_ms,
        submitted_at_ms + accept_window_ms + 1_000_000,
      ),
    }
  spend(old, Release, t)
}

// ─── Adversarial: Claim ───────────────────────────────────────────────
test claim_rejects_non_supplier() {
  let old = open_datum()
  let new = claimed_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      reference_inputs: [record_ref()],
      outputs: [escrow_output(new)],
      extra_signatories: [stranger_pkh],
      validity_range: validity_between(
        deliver_by_ms - 1_000_000,
        deliver_by_ms - 500_000,
      ),
    }
  !spend(old, Claim, t)
}

test claim_rejects_after_deliver_by() {
  let old = open_datum()
  let new = claimed_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      reference_inputs: [record_ref()],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      // Upper bound past deliver_by — must reject.
      validity_range: validity_between(
        deliver_by_ms - 1_000,
        deliver_by_ms + 1_000,
      ),
    }
  !spend(old, Claim, t)
}

// ─── Adversarial: Submit ──────────────────────────────────────────────
test submit_rejects_no_receipt_hash() {
  let old = claimed_datum()
  let stamp = deliver_by_ms - 500_000
  // New datum reaches state Submitted but result_receipt_hash is None.
  let new =
    EscrowDatum {
      ..old,
      submitted_at: Some(stamp),
      result_receipt_hash: None,
      state: Submitted,
    }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      reference_inputs: [record_ref()],
      // The continuing datum must record Some(receipt_hash).
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(deliver_by_ms - 1_000_000, stamp),
    }
  !spend(old, Submit { receipt_hash: receipt_hash_32 }, t)
}

test submit_rejects_short_receipt_hash() {
  let old = claimed_datum()
  let stamp = deliver_by_ms - 500_000
  let new =
    EscrowDatum {
      ..old,
      submitted_at: Some(stamp),
      result_receipt_hash: Some(receipt_hash_short),
      state: Submitted,
    }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      reference_inputs: [record_ref()],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(deliver_by_ms - 1_000_000, stamp),
    }
  !spend(old, Submit { receipt_hash: receipt_hash_short }, t)
}

test submit_rejects_double_submit() {
  // Old state is already Submitted — double-submit attempt.
  let old = submitted_datum()
  let stamp = deliver_by_ms - 500_000
  let new =
    EscrowDatum {
      ..old,
      submitted_at: Some(stamp),
      result_receipt_hash: Some(receipt_hash_32),
      state: Submitted,
    }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      reference_inputs: [record_ref()],
      outputs: [escrow_output(new)],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(deliver_by_ms - 1_000_000, stamp),
    }
  !spend(old, Submit { receipt_hash: receipt_hash_32 }, t)
}

// ─── Adversarial: Accept ──────────────────────────────────────────────
test accept_rejects_non_buyer() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms,
      ),
    }
  !spend(old, Accept, t)
}

test accept_rejects_after_window() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      // Validity range strictly after the window — must reject.
      validity_range: validity_between(
        submitted_at_ms + accept_window_ms + 1,
        submitted_at_ms + accept_window_ms + 1_000,
      ),
    }
  !spend(old, Accept, t)
}

test accept_rejects_supplier_shorted() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        // Supplier short-paid by 1 lovelace.
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt - 1),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms,
      ),
    }
  !spend(old, Accept, t)
}

test accept_rejects_buyer_shorted() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        // Buyer short-paid by 1 lovelace.
        pkh_output(buyer_pkh, buyer_bond_amt - 1),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms,
      ),
    }
  !spend(old, Accept, t)
}

// ─── Adversarial: Reclaim ─────────────────────────────────────────────
test reclaim_rejects_before_deliver_by() {
  let old = open_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(buyer_pkh, payment_amt + buyer_bond_amt + supplier_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: validity_between(
        deliver_by_ms - 1_000_000,
        deliver_by_ms - 1,
      ),
    }
  !spend(old, Reclaim, t)
}

// ─── Adversarial: Release ─────────────────────────────────────────────
test release_rejects_before_window() {
  let old = submitted_datum()
  let t =
    Transaction {
      ..base_tx(),
      inputs: [escrow_input(old)],
      outputs: [
        pkh_output(
          supplier_pkh,
          payment_amt + supplier_bond_amt + buyer_bond_amt,
        ),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: validity_between(
        submitted_at_ms + 1,
        submitted_at_ms + accept_window_ms - 1,
      ),
    }
  !spend(old, Release, t)
}
