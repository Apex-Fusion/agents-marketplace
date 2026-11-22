//// The configuration record of the identity registry: Part 2 §3.8
//// (`docs/IDENTITY_REGISTRY.md`).
////
//// - `config_holder` (no parameters): every spend fails, and every other
////   purpose fails. The configuration token can never move.
//// - `config_seal` (parameters, in order: `seed`, `config_holder`): mints
////   exactly one token `identity-config`, in the transaction that spends
////   `seed`, to the exact `config_holder` enterprise address with the 28-byte
////   Module-1 hash as inline datum. It never burns. Every other purpose fails.

use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/script_context.{ScriptContext, ScriptInfo, Withdrawing}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, OutputReference, Transaction,
}
use identity_marketplace/config/record.{seal_ok, token_name}
use identity_marketplace/identity/kit

validator config_holder {
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    _own_ref: OutputReference,
    _self: Transaction,
  ) {
    False
  }

  else(_) {
    fail
  }
}

validator config_seal(seed: OutputReference, config_holder: ByteArray) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    seal_ok(seed, config_holder, policy_id, self)
  }

  else(_) {
    fail
  }
}

// ## Tests: holder spends, seal wiring and other purposes (§3.9)

fn seed() -> OutputReference {
  OutputReference {
    transaction_id: #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d",
    output_index: 2,
  }
}

fn seal_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: seed(),
        output: kit.output(
          address.from_verification_key(kit.pkh(99)),
          assets.from_lovelace(20_000_000),
          NoDatum,
        ),
      },
    ],
    outputs: [
      kit.output(
        kit.holder_address(),
        assets.from_lovelace(2_000_000)
          |> assets.add(kit.config_policy, token_name, 1),
        InlineDatum(kit.m1),
      ),
    ],
    mint: assets.from_asset(kit.config_policy, token_name, 1),
  }
}

fn context(info: ScriptInfo) -> ScriptContext {
  let redeemer: Data = 0
  ScriptContext { transaction: transaction.placeholder, redeemer, info }
}

test config_holder_spend_fails() fail {
  let redeemer: Data = 0
  config_holder.spend(
    Some(redeemer),
    redeemer,
    kit.config_input().output_reference,
    transaction.placeholder,
  )
}

test config_holder_withdraw_fails() fail {
  config_holder.else(context(Withdrawing(Script(kit.config_holder))))
}

test config_seal_mint_wiring() {
  let redeemer: Data = 0
  and {
    config_seal.mint(
      seed(),
      kit.config_holder,
      redeemer,
      kit.config_policy,
      seal_tx(),
    ),
    // The seed is not spent: the rule refuses.
    !config_seal.mint(
      seed(),
      kit.config_holder,
      redeemer,
      kit.config_policy,
      Transaction { ..seal_tx(), inputs: [kit.wallet_input()] },
    ),
  }
}

test config_seal_withdraw_fails() fail {
  config_seal.else(
    seed(),
    kit.config_holder,
    context(Withdrawing(Script(kit.config_policy))),
  )
}
