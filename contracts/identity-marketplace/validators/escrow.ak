//// The new escrow contract: Part 2 §6.1 of `docs/IDENTITY_REGISTRY.md`.
////
//// Parameter: `identity_hash`, the script hash and policy ID of the identity
//// contract. Purpose: spend. Every other purpose fails.
////
//// The rules are in `identity_marketplace/escrow/rules`. This file only
//// connects them to the validator.

use cardano/address.{Script}
use cardano/certificate
use cardano/governance
use cardano/script_context.{
  Minting, Proposing, Publishing, ScriptContext, ScriptInfo, Voting, Withdrawing,
}
use cardano/transaction.{OutputReference, Transaction}
use identity_marketplace/escrow/fixtures.{
  Case, claim_case, escrow_hash, largest_claim_case, largest_submit_case,
  other_script_hash,
}
use identity_marketplace/escrow/rules
use identity_marketplace/types.{Claim, EscrowDatum, EscrowRedeemer}

validator escrow(identity_hash: ByteArray) {
  spend(
    datum: Option<EscrowDatum>,
    redeemer: EscrowRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(escrow_datum) = datum
    rules.spend(identity_hash, escrow_datum, redeemer, own_ref, self)
  }

  else(_ctx: ScriptContext) {
    fail
  }
}

// ## Tests
//
// The rules have their tests in `identity_marketplace/escrow/ported_tests` and
// `identity_marketplace/escrow/rule_tests`. These tests call the validator:
// its wiring, the other purposes (§12.1 "Other purposes") and the §12.4
// benchmark of Claim and Submit with the largest record. The benchmark cases
// are constants, which the compiler evaluates, so the measured units are
// those of the validator alone.

const bench_claim: Case = largest_claim_case()

const bench_submit: Case = largest_submit_case()

const bench_ref: OutputReference = fixtures.own_ref()

fn context(info: ScriptInfo) -> ScriptContext {
  ScriptContext { transaction: claim_case().tx, redeemer: Claim, info }
}

test escrow_spend_runs_the_rules() {
  let case = claim_case()
  and {
    escrow.spend(
      fixtures.identity_hash,
      Some(case.datum),
      case.redeemer,
      fixtures.own_ref(),
      case.tx,
    ),
    !escrow.spend(
      fixtures.identity_hash,
      Some(case.datum),
      case.redeemer,
      fixtures.own_ref(),
      Transaction { ..case.tx, extra_signatories: [] },
    ),
  }
}

test escrow_spend_reads_records_of_the_parameter() {
  // With another identity hash, the record is not found.
  let case = claim_case()
  !escrow.spend(
    other_script_hash,
    Some(case.datum),
    case.redeemer,
    fixtures.own_ref(),
    case.tx,
  )
}

test escrow_spend_without_datum_fails() fail {
  let case = claim_case()
  escrow.spend(
    fixtures.identity_hash,
    None,
    case.redeemer,
    fixtures.own_ref(),
    case.tx,
  )
}

test bench_claim_largest_record() {
  escrow.spend(
    fixtures.identity_hash,
    Some(bench_claim.datum),
    bench_claim.redeemer,
    bench_ref,
    bench_claim.tx,
  )
}

test bench_submit_largest_record() {
  escrow.spend(
    fixtures.identity_hash,
    Some(bench_submit.datum),
    bench_submit.redeemer,
    bench_ref,
    bench_submit.tx,
  )
}

test escrow_fails_as_withdraw() fail {
  escrow.else(fixtures.identity_hash, context(Withdrawing(Script(escrow_hash))))
}

test escrow_fails_as_publish() fail {
  escrow.else(
    fixtures.identity_hash,
    context(
      Publishing {
        at: 0,
        certificate: certificate.UpdateDelegateRepresentative {
          delegate_representative: Script(escrow_hash),
        },
      },
    ),
  )
}

test escrow_fails_as_vote() fail {
  escrow.else(
    fixtures.identity_hash,
    context(Voting(governance.DelegateRepresentative(Script(escrow_hash)))),
  )
}

test escrow_fails_as_propose() fail {
  escrow.else(
    fixtures.identity_hash,
    context(
      Proposing {
        at: 0,
        proposal_procedure: governance.ProposalProcedure {
          deposit: 100_000_000_000,
          return_address: Script(escrow_hash),
          governance_action: governance.NicePoll,
        },
      },
    ),
  )
}

test escrow_fails_as_mint() fail {
  escrow.else(fixtures.identity_hash, context(Minting(escrow_hash)))
}
