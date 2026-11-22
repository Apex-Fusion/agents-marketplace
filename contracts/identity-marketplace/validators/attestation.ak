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
use cardano/script_context.{ScriptContext, ScriptInfo, Withdrawing}
use cardano/transaction.{OutputReference, Transaction}
use identity_marketplace/attestation/fixtures.{
  att_ref, attest_tx, existing, full_datum, issuer_key, lo, own_hash, pkh,
  revoked, seed, spend_tx,
}
use identity_marketplace/attestation/handlers
use identity_marketplace/types.{
  Attest, AttestationDatum, AttestationMint, AttestationSpend, RevokeAtt,
}

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
// `mint` and `spend` pass through the validator, and a spend without the
// datum fails. The dispatch of each redeemer and the window rule have their
// tests in `identity_marketplace/attestation/tests`.

/// `Attest` of `full_datum()` by the issuer key.
fn attest_case() -> Transaction {
  attest_tx(full_datum(), [pkh(issuer_key)])
}

/// `RevokeAtt { reason: 5 }` of `existing()` by the issuer key.
fn revoke_case() -> Transaction {
  spend_tx(existing(), revoked(existing(), lo, 5), [pkh(issuer_key)])
}

test mint_attest() {
  attestation.mint(
    fixtures.identity_hash,
    Attest { seed: seed() },
    own_hash,
    attest_case(),
  )
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

test spend_revoke_att_without_datum() fail {
  attestation.spend(
    fixtures.identity_hash,
    None,
    RevokeAtt { reason: 5 },
    att_ref(),
    revoke_case(),
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
