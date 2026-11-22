//// The vault contract: Part 2 §5.3 of `docs/IDENTITY_REGISTRY.md`.
//// Purpose: spend. Every other purpose fails (§3.9). The rules are in
//// `identity_marketplace/vault/handlers`.

use cardano/address.{Script}
use cardano/script_context.{ScriptContext, ScriptInfo, Withdrawing}
use cardano/transaction.{OutputReference, Transaction}
use identity_marketplace/delegation/fixtures as fx
use identity_marketplace/types.{Close, Pay, VaultDatum, VaultSpend}
use identity_marketplace/vault/handlers.{vault_spend}
use identity_marketplace/vault/tests as vault_tests

validator vault(
  identity_hash: ByteArray,
  delegation_hash: ByteArray,
  escrow_hash: ByteArray,
) {
  spend(
    datum: Option<VaultDatum>,
    redeemer: VaultSpend,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(vault_datum) = datum
    vault_spend(
      identity_hash,
      delegation_hash,
      escrow_hash,
      vault_datum,
      redeemer,
      own_ref,
      self,
    )
  }

  else(_) {
    fail
  }
}

// ## Tests: wiring

test vault_spend_pay_wiring() {
  vault.spend(
    fx.identity_hash,
    fx.delegation_hash,
    fx.escrow_hash,
    Some(vault_tests.vault1()),
    Pay,
    vault_tests.vault_ref(0),
    vault_tests.pay1_tx(),
  )
}

test vault_spend_without_datum_fails() fail {
  vault.spend(
    fx.identity_hash,
    fx.delegation_hash,
    fx.escrow_hash,
    None,
    Close,
    vault_tests.vault_ref(0),
    transaction.placeholder,
  )
}

// ## Tests: other purposes (§3.9, §12.1 "Other purposes")

fn context(info: ScriptInfo) -> ScriptContext {
  let redeemer: Data = Close
  ScriptContext { transaction: transaction.placeholder, redeemer, info }
}

fn run_else(info: ScriptInfo) -> Bool {
  vault.else(
    fx.identity_hash,
    fx.delegation_hash,
    fx.escrow_hash,
    context(info),
  )
}

test vault_as_withdraw_fails() fail {
  run_else(Withdrawing(Script(fx.vault_hash)))
}
