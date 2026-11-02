//// The `identity` validator: Part 2 §3 (`docs/IDENTITY_REGISTRY.md`).
////
//// Parameters, in order: `legacy_hash`, `legacy_root`, `config_policy`,
//// `config_holder` (Part 2 §2). Purposes: mint and spend. Every other purpose
//// fails (§3.9). The rules live in `identity_marketplace/identity/mint` and
//// `identity_marketplace/identity/spend`; this module only wires them.

use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/certificate.{UpdateDelegateRepresentative}
use cardano/governance.{DelegateRepresentative, NicePoll, ProposalProcedure}
use cardano/script_context.{
  Proposing, Publishing, ScriptContext, ScriptInfo, Voting, Withdrawing,
}
use cardano/transaction.{OutputReference, Transaction}
use identity_marketplace/identity/kit
use identity_marketplace/identity/mint.{mint_ok}
use identity_marketplace/identity/rules.{IdentityParams}
use identity_marketplace/identity/spend.{spend_ok}
use vector_identity/redeemers.{IdentityMint, IdentitySpend, Register, Update}

validator identity(
  legacy_hash: ByteArray,
  legacy_root: ByteArray,
  config_policy: ByteArray,
  config_holder: ByteArray,
) {
  mint(redeemer: IdentityMint, policy_id: PolicyId, self: Transaction) {
    mint_ok(
      IdentityParams { legacy_hash, legacy_root, config_policy, config_holder },
      redeemer,
      policy_id,
      self,
    )
  }

  spend(
    _datum: Option<Data>,
    redeemer: IdentitySpend,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    spend_ok(
      IdentityParams { legacy_hash, legacy_root, config_policy, config_holder },
      redeemer,
      own_ref,
      self,
    )
  }

  else(_) {
    fail
  }
}

// ## Tests: wiring and other purposes (§3.9)

fn legacy_root() -> ByteArray {
  kit.params().legacy_root
}

fn context(info: ScriptInfo) -> ScriptContext {
  let redeemer: Data = 0
  ScriptContext { transaction: transaction.placeholder, redeemer, info }
}

fn other_purpose(info: ScriptInfo) -> Bool {
  identity.else(
    kit.legacy_hash,
    legacy_root(),
    kit.config_policy,
    kit.config_holder,
    context(info),
  )
}

test identity_mint_wiring() {
  identity.mint(
    kit.legacy_hash,
    legacy_root(),
    kit.config_policy,
    kit.config_holder,
    Register { seed: kit.seed() },
    kit.own,
    kit.register_tx(kit.new_record(), kit.creation_signers()),
  )
}

test identity_mint_wiring_rejects() fail {
  identity.mint(
    kit.legacy_hash,
    legacy_root(),
    kit.config_policy,
    kit.config_holder,
    Register { seed: kit.seed() },
    kit.own,
    kit.register_tx(kit.new_record(), [kit.hash(kit.controller)]),
  )
}

test identity_spend_wiring() {
  let d = kit.record()
  identity.spend(
    kit.legacy_hash,
    legacy_root(),
    kit.config_policy,
    kit.config_holder,
    None,
    Update,
    kit.record_ref(),
    kit.controller_tx(d, d),
  )
}

test identity_spend_wiring_rejects() fail {
  let d = kit.record()
  identity.spend(
    kit.legacy_hash,
    legacy_root(),
    kit.config_policy,
    kit.config_holder,
    None,
    Update,
    kit.record_ref(),
    kit.spend_tx(d, d, []),
  )
}

test identity_withdraw_fails() fail {
  other_purpose(Withdrawing(Script(kit.own)))
}

test identity_publish_fails() fail {
  other_purpose(
    Publishing {
      at: 0,
      certificate: UpdateDelegateRepresentative {
        delegate_representative: Script(kit.own),
      },
    },
  )
}

test identity_vote_fails() fail {
  other_purpose(Voting(DelegateRepresentative(Script(kit.own))))
}

test identity_propose_fails() fail {
  other_purpose(
    Proposing {
      at: 0,
      proposal_procedure: ProposalProcedure {
        deposit: 0,
        return_address: Script(kit.own),
        governance_action: NicePoll,
      },
    },
  )
}
