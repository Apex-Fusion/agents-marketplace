//// The attestation contract: Part 2 §4 of `docs/IDENTITY_REGISTRY.md`.
////
//// - `mint`: `Attest { seed }` and `Burn`.
//// - `spend`: `RevokeAtt { reason }`, `Contest` and `Withdraw`.
//// - Every other purpose (withdraw, publish, vote, propose) fails (§3.9).
////
//// The parameter `identity_hash` is the script hash and the policy ID of the
//// identity registry. The rules are in `identity_marketplace/attestation/handlers`.

use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/certificate.{UpdateDelegateRepresentative}
use cardano/governance.{DelegateRepresentative, NicePoll, ProposalProcedure}
use cardano/script_context.{
  Proposing, Publishing, ScriptContext, ScriptInfo, Voting, Withdrawing,
}
use cardano/transaction.{OutputReference, Transaction}
use identity_marketplace/attestation/fixtures.{
  anchor, att_ref, attest_tx, contested, existing, full_datum, issuer_key, lo,
  one_hour, own_hash, pkh, range, revoked, seed, spend_tx, subject_controller,
  withdraw_tx,
}
use identity_marketplace/attestation/handlers
use identity_marketplace/types.{
  Attest, AttestationDatum, AttestationMint, AttestationSpend, Burn, Contest,
  RevokeAtt, Withdraw,
}
use vector_identity.{days_90_ms}

validator attestation(identity_hash: ScriptHash) {
  mint(redeemer: AttestationMint, policy_id: PolicyId, self: Transaction) {
    handlers.handle_mint(identity_hash, redeemer, policy_id, self)
  }

  spend(
    datum: Option<AttestationDatum>,
    redeemer: AttestationSpend,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum
    handlers.handle_spend(identity_hash, datum, redeemer, own_ref, self)
  }

  else(_) {
    fail
  }
}

// ## Tests: wiring
//
// Each action passes through the validator. The same transaction fails
// without the spend datum or with a validity range over one hour.

/// `Attest` of `full_datum()` by the issuer key.
fn attest_case() -> Transaction {
  attest_tx(full_datum(), [pkh(issuer_key)])
}

/// `RevokeAtt { reason: 5 }` of `existing()` by the issuer key.
fn revoke_case() -> Transaction {
  spend_tx(existing(), revoked(existing(), lo, 5), [pkh(issuer_key)])
}

/// `Contest` of `existing()` by the subject's controller.
fn contest_case() -> Transaction {
  spend_tx(
    existing(),
    contested(existing(), anchor()),
    [pkh(subject_controller)],
  )
}

/// `existing()`, revoked at `lo`.
fn revoked_case() -> AttestationDatum {
  revoked(existing(), lo, 5)
}

/// `Withdraw` with `Burn` of `revoked_case()` at `lo + 90 days`.
fn withdraw_case() -> Transaction {
  withdraw_tx(revoked_case(), lo + days_90_ms, [pkh(issuer_key)])
}

/// `tx` with the validity range `[lower, lower + one hour + 1 ms]`.
fn too_long(tx: Transaction, lower: Int) -> Transaction {
  Transaction { ..tx, validity_range: range(lower, lower + one_hour + 1) }
}

test mint_attest() {
  attestation.mint(
    fixtures.identity_hash,
    Attest { seed: seed() },
    own_hash,
    attest_case(),
  )
}

test mint_burn() {
  attestation.mint(fixtures.identity_hash, Burn, own_hash, withdraw_case())
}

test spend_revoke_att() {
  attestation.spend(
    fixtures.identity_hash,
    Some(existing()),
    RevokeAtt { reason: 5 },
    att_ref(),
    revoke_case(),
  )
}

test spend_contest() {
  attestation.spend(
    fixtures.identity_hash,
    Some(existing()),
    Contest,
    att_ref(),
    contest_case(),
  )
}

test spend_withdraw() {
  attestation.spend(
    fixtures.identity_hash,
    Some(revoked_case()),
    Withdraw,
    att_ref(),
    withdraw_case(),
  )
}

test spend_revoke_att_without_datum() fail {
  attestation.spend(
    fixtures.identity_hash,
    None,
    RevokeAtt { reason: 5 },
    att_ref(),
    revoke_case(),
  )
}

test spend_contest_without_datum() fail {
  attestation.spend(
    fixtures.identity_hash,
    None,
    Contest,
    att_ref(),
    contest_case(),
  )
}

test spend_withdraw_without_datum() fail {
  attestation.spend(
    fixtures.identity_hash,
    None,
    Withdraw,
    att_ref(),
    withdraw_case(),
  )
}

test mint_attest_range_over_one_hour() fail {
  let datum = AttestationDatum { ..full_datum(), issued_at: lo + one_hour + 1 }
  attestation.mint(
    fixtures.identity_hash,
    Attest { seed: seed() },
    own_hash,
    too_long(attest_tx(datum, [pkh(issuer_key)]), lo),
  )
}

test mint_burn_range_over_one_hour() fail {
  attestation.mint(
    fixtures.identity_hash,
    Burn,
    own_hash,
    too_long(withdraw_case(), lo + days_90_ms),
  )
}

test spend_revoke_att_range_over_one_hour() fail {
  attestation.spend(
    fixtures.identity_hash,
    Some(existing()),
    RevokeAtt { reason: 5 },
    att_ref(),
    too_long(revoke_case(), lo),
  )
}

test spend_contest_range_over_one_hour() fail {
  attestation.spend(
    fixtures.identity_hash,
    Some(existing()),
    Contest,
    att_ref(),
    too_long(contest_case(), lo),
  )
}

test spend_withdraw_range_over_one_hour() fail {
  attestation.spend(
    fixtures.identity_hash,
    Some(revoked_case()),
    Withdraw,
    att_ref(),
    too_long(withdraw_case(), lo + days_90_ms),
  )
}

// ## Tests: other purposes (§3.9, §12.1 "Other purposes")

fn context(info: ScriptInfo) -> ScriptContext {
  ScriptContext { transaction: transaction.placeholder, redeemer: Void, info }
}

test purpose_withdraw_fails() fail {
  attestation.else(
    fixtures.identity_hash,
    context(Withdrawing(Script(own_hash))),
  )
}

test purpose_publish_fails() fail {
  attestation.else(
    fixtures.identity_hash,
    context(
      Publishing {
        at: 0,
        certificate: UpdateDelegateRepresentative {
          delegate_representative: Script(own_hash),
        },
      },
    ),
  )
}

test purpose_vote_fails() fail {
  attestation.else(
    fixtures.identity_hash,
    context(Voting(DelegateRepresentative(Script(own_hash)))),
  )
}

test purpose_propose_fails() fail {
  attestation.else(
    fixtures.identity_hash,
    context(
      Proposing {
        at: 0,
        proposal_procedure: ProposalProcedure {
          deposit: 0,
          return_address: Script(own_hash),
          governance_action: NicePoll,
        },
      },
    ),
  )
}
