//// The delegation contract: Part 2 §5.2 of `docs/IDENTITY_REGISTRY.md`.
//// Purposes: mint and spend. Every other purpose fails (§3.9). The rules are in
//// `identity_marketplace/delegation/handlers`.

use cardano/address.{Script, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/certificate.{DelegateBlockProduction, DelegateCredential}
use cardano/governance.{NicePoll, ProposalProcedure, StakePool}
use cardano/script_context.{
  Proposing, Publishing, ScriptContext, ScriptInfo, Voting, Withdrawing,
}
use cardano/transaction.{Input, OutputReference, Transaction}
use identity_marketplace/delegation/fixtures as fx
use identity_marketplace/delegation/handlers.{delegation_mint, delegation_spend}
use identity_marketplace/types.{Delegate, DelegationMint, Undelegate}

validator delegation(identity_hash: ByteArray) {
  mint(redeemer: DelegationMint, policy_id: PolicyId, self: Transaction) {
    delegation_mint(identity_hash, redeemer, policy_id, self)
  }

  spend(
    _datum: Option<Data>,
    redeemer: DelegationMint,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    delegation_spend(redeemer, own_ref, self)
  }

  else(_) {
    fail
  }
}

// ## Tests: wiring

test delegation_mint_delegate_wiring() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [fx.wallet_input(fx.seed())],
      reference_inputs: fx.records(1, 1),
      outputs: [
        fx.delegation_output(
          fx.new_id(),
          fx.link(1, fx.principal_delegator(), None),
        ),
      ],
      mint: assets.from_asset(fx.delegation_hash, fx.new_id(), 1),
      extra_signatories: [fx.principal, fx.hash(fx.delegation_key(1))],
      validity_range: fx.now(),
    }
  delegation.mint(
    fx.identity_hash,
    Delegate { seed: fx.seed() },
    fx.delegation_hash,
    tx,
  )
}

test delegation_spend_and_mint_undelegate_wiring() {
  let own_ref =
    OutputReference {
      transaction_id: #"7777777777777777777777777777777777777777777777777777777777777777",
      output_index: 1,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: own_ref,
          output: fx.delegation_output(
            fx.delegation_id(1),
            fx.link(1, fx.principal_delegator(), None),
          ),
        },
      ],
      mint: assets.from_asset(fx.delegation_hash, fx.delegation_id(1), -1),
      extra_signatories: [fx.principal],
      validity_range: fx.now(),
    }
  and {
    delegation.spend(fx.identity_hash, None, Undelegate, own_ref, tx),
    delegation.mint(fx.identity_hash, Undelegate, fx.delegation_hash, tx),
  }
}

// ## Tests: other purposes (§3.9, §12.1 "Other purposes")

fn context(info: ScriptInfo) -> ScriptContext {
  let redeemer: Data = Undelegate
  ScriptContext { transaction: transaction.placeholder, redeemer, info }
}

test delegation_as_withdraw_fails() fail {
  delegation.else(
    fx.identity_hash,
    context(Withdrawing(Script(fx.delegation_hash))),
  )
}

test delegation_as_publish_fails() fail {
  delegation.else(
    fx.identity_hash,
    context(
      Publishing {
        at: 0,
        certificate: DelegateCredential {
          credential: Script(fx.delegation_hash),
          delegate: DelegateBlockProduction { stake_pool: fx.delegation_hash },
        },
      },
    ),
  )
}

test delegation_as_vote_fails() fail {
  delegation.else(
    fx.identity_hash,
    context(Voting(StakePool(fx.delegation_hash))),
  )
}

test delegation_as_propose_fails() fail {
  delegation.else(
    fx.identity_hash,
    context(
      Proposing {
        at: 0,
        proposal_procedure: ProposalProcedure {
          deposit: 0,
          return_address: VerificationKey(fx.delegation_hash),
          governance_action: NicePoll,
        },
      },
    ),
  )
}
