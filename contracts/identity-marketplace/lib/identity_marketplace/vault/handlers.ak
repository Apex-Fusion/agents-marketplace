//// The vault contract: Part 2 §5.3 of `docs/IDENTITY_REGISTRY.md`.
//// `validators/vault.ak` wires this handler; the parameters are
//// `identity_hash`, `delegation_hash` and `escrow_hash`. `VA` is the
//// enterprise address of the vault script.
////
//// - `Pay`: the delegate of the vault's delegation moves AP3X from a `Live`
////   vault output into new escrows whose refunds return to `VA` as `Returned`
////   outputs, within the value limit of the delegation.
//// - `Close`: the owner takes `Live` and `Returned` outputs, also after
////   `Undelegate`.

use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use identity_marketplace/common.{
  ap3x_of, ap3x_only, count_script_inputs, inline_datum,
  no_mint_withdrawal_certificate_vote_proposal, signed_by, single_output_at,
  window,
}
use identity_marketplace/delegation/chain.{use_delegation}
use identity_marketplace/types.{
  Agent, Close, Delegator, EscrowDatum, Live, Open, Pay, PrincipalKey, Refund,
  Returned, VaultDatum, VaultSpend,
}
use vector_identity.{controller_signed, days_7_ms, find_record}

/// The action of vault payments (§5.1).
pub const hire_action: ByteArray = "marketplace.hire.v1"

/// The highest payment + buyer bond + supplier bond of one escrow: 10,000 AP3X
/// in base units (1 AP3X = 1,000,000 base units).
pub const max_job_ap3x: Int = 10_000_000_000

/// The resource of vault payments: `script:<escrow_hash>`, with the hash in
/// lowercase hexadecimal (§5.1).
pub fn escrow_resource(escrow_hash: ByteArray) -> ByteArray {
  bytearray.concat(
    "script:",
    bytearray.foldr(
      escrow_hash,
      #"",
      fn(byte, hex) {
        hex
          |> bytearray.push(hex_digit(byte % 16))
          |> bytearray.push(hex_digit(byte / 16))
      },
    ),
  )
}

/// The lowercase hexadecimal digit (`0-9`, `a-f`) of `n` (0..15).
fn hex_digit(n: Int) -> Int {
  if n < 10 {
    n + 48
  } else {
    n + 87
  }
}

/// The spend handler of the vault contract.
pub fn vault_spend(
  identity_hash: ByteArray,
  delegation_hash: ByteArray,
  escrow_hash: ByteArray,
  datum: VaultDatum,
  redeemer: VaultSpend,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  when redeemer is {
    Pay ->
      when datum is {
        Live { owner, delegation, spent, period_start } ->
          pay(
            identity_hash,
            delegation_hash,
            escrow_hash,
            owner,
            delegation,
            spent,
            period_start,
            own_ref,
            tx,
          )
        Returned { .. } -> False
      }
    Close ->
      when datum is {
        Live { owner, .. } -> owner_signed(owner, identity_hash, tx)
        Returned { owner } -> owner_signed(owner, identity_hash, tx)
      }
  }
}

// ## Pay

/// `Pay` from a `Live` output (§5.3):
///
/// - scope: `hi - lo <= 1 hour`, the vault input is the only script input,
///   no mint, withdrawal, certificate, vote or proposal;
/// - the delegation `delegation` passes the use checks of §5.2 for the action
///   `marketplace.hire.v1` and the resource `script:<escrow_hash>`, its
///   delegator is `owner`, and it has a value limit;
/// - amount = the input AP3X minus the AP3X of the continuing output;
///   `0 < amount <= per_tx`;
/// - when `lo >= period_start + period_ms`, a new period starts with
///   `period_start = hi` and `spent = amount`; else `spent` grows by the
///   amount; the new `spent <= total`;
/// - the escrow outputs together hold at least the amount, and each passes
///   `valid_escrow_output`;
/// - exactly one output is at `VA`, with AP3X only, no reference script and
///   the datum `Live { owner, delegation, spent, period_start }` with the new
///   values.
///
/// The vault input must hold AP3X only.
fn pay(
  identity_hash: ByteArray,
  delegation_hash: ByteArray,
  escrow_hash: ByteArray,
  owner: Delegator,
  delegation: ByteArray,
  spent: Int,
  period_start: Int,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  let w = window(tx.validity_range)
  expect Some(own_input) = transaction.find_input(tx.inputs, own_ref)
  expect Script(vault_hash) = own_input.output.address.payment_credential
  let vault_address = address.from_script(vault_hash)
  let leaf =
    use_delegation(
      tx,
      identity_hash,
      delegation_hash,
      delegation,
      hire_action,
      escrow_resource(escrow_hash),
      w,
    )
  expect Some(limit) = leaf.value
  let continuing = single_output_at(tx.outputs, vault_address)
  let amount = ap3x_of(own_input.output.value) - ap3x_of(continuing.value)
  let (new_spent, new_period_start) =
    if w.lo >= period_start + limit.period_ms {
      (amount, w.hi)
    } else {
      (spent + amount, period_start)
    }
  let returned: Data = Returned { owner }
  let refund = Some(Refund { address: vault_address, datum: Some(returned) })
  let next: Data =
    Live { owner, delegation, spent: new_spent, period_start: new_period_start }
  and {
    count_script_inputs(tx.inputs) == 1,
    no_mint_withdrawal_certificate_vote_proposal(tx),
    ap3x_only(own_input.output.value),
    leaf.delegator == owner,
    amount > 0,
    amount <= limit.per_tx,
    new_spent <= limit.total,
    ap3x_only(continuing.value),
    continuing.reference_script == None,
    continuing.datum == InlineDatum(next),
    escrow_total(tx.outputs, escrow_hash, leaf.delegate_key, refund, w.hi) >= amount,
  }
}

/// The AP3X of the outputs whose payment credential is `Script(escrow_hash)`.
/// The function fails unless each of them passes `valid_escrow_output`.
fn escrow_total(
  outputs: List<Output>,
  escrow_hash: ByteArray,
  buyer: ByteArray,
  refund: Option<Refund>,
  hi: Int,
) -> Int {
  list.foldl(
    outputs,
    0,
    fn(output, total) {
      if output.address.payment_credential == Script(escrow_hash) {
        expect valid_escrow_output(output, buyer, refund, hi)
        total + ap3x_of(output.value)
      } else {
        total
      }
    },
  )
}

/// An escrow output of a vault payment (§5.3): at exactly the escrow address
/// (no stake credential), AP3X only, no reference script, and an inline new
/// escrow datum (§6.1) with state Open, `submitted_at = None`,
/// `result_receipt_hash = None`, `buyer_pkh = buyer` (the delegate key), the
/// vault refund, `0 <= payment, buyer bond, supplier bond`, payment + buyer
/// bond + supplier bond at most 10,000 AP3X and exactly the output's AP3X, and
/// `deliver_by <= hi + 7 days`.
///
/// The job equals the output's AP3X (decision of 2026-11-02): Accept and
/// Release check only the job amounts, so with this rule the whole escrow
/// value follows the escrow rules, and a refund returns all of it to `VA`.
/// Builders put a min-UTxO top-up into the buyer bond.
fn valid_escrow_output(
  output: Output,
  buyer: ByteArray,
  refund: Option<Refund>,
  hi: Int,
) -> Bool {
  expect escrow: EscrowDatum = inline_datum(output)
  let job =
    escrow.payment_lovelace + escrow.buyer_bond_lovelace + escrow.supplier_bond_lovelace
  and {
    output.address.stake_credential == None,
    ap3x_only(output.value),
    output.reference_script == None,
    escrow.state == Open,
    escrow.submitted_at == None,
    escrow.result_receipt_hash == None,
    escrow.buyer_pkh == buyer,
    escrow.refund == refund,
    escrow.payment_lovelace >= 0,
    escrow.buyer_bond_lovelace >= 0,
    escrow.supplier_bond_lovelace >= 0,
    job <= max_job_ap3x,
    job == ap3x_of(output.value),
    escrow.deliver_by <= hi + days_7_ms,
  }
}

// ## Close

/// The owner signs: the `PrincipalKey`, or the agent's controller with the
/// agent's record as a reference input.
fn owner_signed(
  owner: Delegator,
  identity_hash: ByteArray,
  tx: Transaction,
) -> Bool {
  when owner is {
    PrincipalKey { hash, .. } -> signed_by(tx.extra_signatories, hash)
    Agent { id } ->
      when find_record(tx.reference_inputs, identity_hash, id) is {
        Some(record) -> controller_signed(record, tx)
        None -> False
      }
  }
}
