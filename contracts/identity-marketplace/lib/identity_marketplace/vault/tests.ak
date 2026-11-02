//// Tests of the vault contract (Part 2 §5.3). `tests/delegation.md` maps the
//// §12.1 rows to these tests.
////
//// The principal vault (`vault1`) belongs to the principal of the chain of
//// depth 1; agent 1 is its delegate. The agent vault (`vault4`) belongs to
//// agent 3, the delegator of link 4 of the chain of depth 4 whose root
//// delegator is agent 0; agent 4 is its delegate. Each attack test changes
//// one thing in a transaction that passes in a positive test.

use aiken/collection/list
use aiken/interval
use cardano/address.{Address, Script}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use identity_marketplace/delegation/fixtures.{
  agent, agent_delegator, agent_id, ap3x, chain_link, chain_refs, controller_key,
  delegation_hash, delegation_id, delegation_input, delegation_key, escrow_hash,
  escrow_pattern, hash, hi, identity_hash, lo, now, other_hash, principal,
  principal_delegator, range, record_input, records, seed, staked_script_address,
  stranger, suspended, vault_hash, wallet_input, without_delegation_key,
}
use identity_marketplace/delegation/pattern.{covers, valid_action_pattern}
use identity_marketplace/types.{
  Claimed, Close, DelegationDatum, Delegator, EscrowDatum, Live, Open, Pay,
  PrincipalKey, Refund, Returned, VaultDatum,
}
use identity_marketplace/vault/handlers.{
  escrow_resource, hire_action, max_job_ap3x, vault_spend,
}
use vector_identity.{day_ms, days_7_ms}

/// The vault funds: 1,000 AP3X.
const funds: Int = 1_000_000_000

/// The period start of the vaults: `lo` - 1 hour (the current period).
const start: Int = 1_793_574_000_000

// ## Builders

fn vault_address() -> Address {
  address.from_script(vault_hash)
}

pub fn vault_ref(n: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
    output_index: n,
  }
}

fn vault_output(datum: VaultDatum, amount: Int) -> Output {
  Output {
    address: vault_address(),
    value: assets.from_lovelace(amount),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn vault_input(n: Int, datum: VaultDatum, amount: Int) -> Input {
  Input { output_reference: vault_ref(n), output: vault_output(datum, amount) }
}

/// The refund of the escrows of `owner`'s vault.
fn refund_to(owner: Delegator) -> Option<Refund> {
  let returned: Data = Returned { owner }
  Some(Refund { address: vault_address(), datum: Some(returned) })
}

/// A new escrow for `buyer` with the refund to `owner`'s vault, `payment` and
/// two bonds of 1 AP3X.
fn job(buyer: ByteArray, owner: Delegator, payment: Int) -> EscrowDatum {
  EscrowDatum {
    buyer_pkh: buyer,
    supplier_pkh: #"5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b",
    advert_ref: OutputReference {
      transaction_id: #"adadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad",
      output_index: 0,
    },
    capability_id: "ocr.extract.v1",
    request_spec_hash: #"1111111111111111111111111111111111111111111111111111111111111111",
    prompt_hash: #"2222222222222222222222222222222222222222222222222222222222222222",
    payment_lovelace: payment,
    buyer_bond_lovelace: ap3x,
    supplier_bond_lovelace: ap3x,
    deliver_by: hi + days_7_ms,
    posted_at: hi,
    submitted_at: None,
    result_receipt_hash: None,
    state: Open,
    agent_id: agent_id(9),
    refund: refund_to(owner),
  }
}

fn escrow_output(datum: EscrowDatum, amount: Int) -> Output {
  Output {
    address: address.from_script(escrow_hash),
    value: assets.from_lovelace(amount),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn pay(datum: VaultDatum, tx: Transaction) -> Bool {
  vault_spend(
    identity_hash,
    delegation_hash,
    escrow_hash,
    datum,
    Pay,
    vault_ref(0),
    tx,
  )
}

fn close(datum: VaultDatum, n: Int, tx: Transaction) -> Bool {
  vault_spend(
    identity_hash,
    delegation_hash,
    escrow_hash,
    datum,
    Close,
    vault_ref(n),
    tx,
  )
}

// ### The principal vault (depth 1)

fn owner1() -> Delegator {
  principal_delegator()
}

fn buyer1() -> ByteArray {
  hash(delegation_key(1))
}

fn live1(spent: Int, period_start: Int) -> VaultDatum {
  Live { owner: owner1(), delegation: delegation_id(1), spent, period_start }
}

pub fn vault1() -> VaultDatum {
  live1(0, start)
}

/// The escrow of the standard payment: 38 AP3X payment + 2 AP3X bonds.
fn job1() -> EscrowDatum {
  job(buyer1(), owner1(), 38 * ap3x)
}

fn escrow1(datum: EscrowDatum) -> Output {
  escrow_output(datum, 40 * ap3x)
}

/// The continuing output of a payment of `amount` with the new `spent` and
/// `period_start`.
fn continuing1(spent: Int, period_start: Int, amount: Int) -> Output {
  vault_output(live1(spent, period_start), funds - amount)
}

/// The standard payment: 40 AP3X from `vault1` into one escrow.
pub fn pay1_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [wallet_input(seed()), vault_input(0, vault1(), funds)],
    reference_inputs: chain_refs(1, owner1()),
    outputs: [continuing1(40 * ap3x, start, 40 * ap3x), escrow1(job1())],
    extra_signatories: [buyer1()],
    validity_range: now(),
  }
}

/// The standard payment with other outputs.
fn pay1_with(outputs: List<Output>) -> Bool {
  pay(vault1(), Transaction { ..pay1_tx(), outputs })
}

/// The standard payment with another escrow output.
fn pay1_escrow(escrow: Output) -> Bool {
  pay1_with([continuing1(40 * ap3x, start, 40 * ap3x), escrow])
}

/// The standard payment from a vault with the datum `datum`, with the
/// continuing output `continuing`.
fn pay1_from(datum: VaultDatum, continuing: Output) -> Bool {
  pay(
    datum,
    Transaction {
      ..pay1_tx(),
      inputs: [wallet_input(seed()), vault_input(0, datum, funds)],
      outputs: [continuing, escrow1(job1())],
    },
  )
}

/// The standard payment with other reference inputs.
fn pay1_refs(refs: List<Input>) -> Bool {
  pay(vault1(), Transaction { ..pay1_tx(), reference_inputs: refs })
}

/// The standard payment with link 1 replaced by `datum`.
fn pay1_link(datum: DelegationDatum) -> Bool {
  pay1_refs([delegation_input(delegation_id(1), datum), ..records(1, 1)])
}

// ### The agent vault (depth 4)

fn owner4() -> Delegator {
  agent_delegator(3)
}

fn buyer4() -> ByteArray {
  hash(delegation_key(4))
}

fn vault4() -> VaultDatum {
  Live {
    owner: owner4(),
    delegation: delegation_id(4),
    spent: 0,
    period_start: start,
  }
}

/// A payment from `vault4` into `escrows` escrows of 20 AP3X each.
fn pay4_tx(escrows: Int) -> Transaction {
  let amount = escrows * 20 * ap3x
  Transaction {
    ..transaction.placeholder,
    inputs: [wallet_input(seed()), vault_input(0, vault4(), funds)],
    reference_inputs: chain_refs(4, agent_delegator(0)),
    outputs: [
      vault_output(
        Live {
          owner: owner4(),
          delegation: delegation_id(4),
          spent: amount,
          period_start: start,
        },
        funds - amount,
      ),
      ..list.repeat(
        escrow_output(job(buyer4(), owner4(), 18 * ap3x), 20 * ap3x),
        escrows,
      )
    ],
    extra_signatories: [buyer4()],
    validity_range: now(),
  }
}

// ## Constants

test hire_action_and_escrow_resource() {
  and {
    hire_action == "marketplace.hire.v1",
    valid_action_pattern(hire_action),
    covers("marketplace.*", hire_action),
    escrow_resource(escrow_hash) == escrow_pattern,
    escrow_resource(#"00112233445566778899aabbccddeeff00112233445566778899aabb") == "script:00112233445566778899aabbccddeeff00112233445566778899aabb",
    max_job_ap3x == 10_000 * ap3x,
  }
}

// ## Pay: positive

test pay_one_escrow() {
  pay(vault1(), pay1_tx())
}

test pay_several_escrows() {
  pay1_with(
    [
      continuing1(40 * ap3x, start, 40 * ap3x),
      escrow_output(job(buyer1(), owner1(), 8 * ap3x), 10 * ap3x),
      escrow_output(job(buyer1(), owner1(), 18 * ap3x), 20 * ap3x),
      escrow_output(job(buyer1(), owner1(), 8 * ap3x), 10 * ap3x),
    ],
  )
}

test pay_amount_equal_to_per_tx() {
  pay1_with(
    [
      continuing1(100 * ap3x, start, 100 * ap3x),
      escrow_output(job(buyer1(), owner1(), 98 * ap3x), 100 * ap3x),
    ],
  )
}

test pay_up_to_total() {
  pay1_from(live1(460 * ap3x, start), continuing1(500 * ap3x, start, 40 * ap3x))
}

/// The period of `lo - 1 day + 1` has not ended at `lo`: `spent` grows.
test pay_same_period_until_its_end() {
  let period_start = lo - day_ms + 1
  pay1_from(
    live1(460 * ap3x, period_start),
    continuing1(500 * ap3x, period_start, 40 * ap3x),
  )
}

/// `lo >= period_start + period_ms`: a new period starts at `hi`.
test pay_new_period() {
  pay1_from(
    live1(490 * ap3x, lo - 2 * day_ms),
    continuing1(40 * ap3x, hi, 40 * ap3x),
  )
}

test pay_new_period_at_its_first_time() {
  pay1_from(
    live1(490 * ap3x, lo - day_ms),
    continuing1(40 * ap3x, hi, 40 * ap3x),
  )
}

/// An escrow funded above the amount by a wallet input, up to the cap.
test pay_escrow_at_cap() {
  pay1_escrow(
    escrow_output(
      EscrowDatum { ..job1(), payment_lovelace: max_job_ap3x - 2 * ap3x },
      max_job_ap3x,
    ),
  )
}

test pay_escrow_deliver_by_at_7_days() {
  pay1_escrow(escrow1(EscrowDatum { ..job1(), deliver_by: hi + days_7_ms }))
}

/// §12.4 benchmark: a depth-4 delegation chain (root delegator agent 0, 9
/// reference inputs) used by a vault payment with three escrow outputs.
test pay_depth_4_chain_three_escrows() {
  pay(vault4(), pay4_tx(3))
}

/// The same with five escrow outputs.
test pay_depth_4_chain_five_escrows() {
  pay(vault4(), pay4_tx(5))
}

/// The cost of the transaction fixture of the benchmark alone, without the
/// handler (subtract it from the benchmark).
test pay_depth_4_fixture_only() {
  let tx = pay4_tx(3)
  and {
    list.length(tx.reference_inputs) == 9,
    list.length(tx.outputs) == 4,
    tx.extra_signatories == [buyer4()],
  }
}

// ## Pay: attacks

/// §12.1 Vault: Pay without the delegate key.
test pay_without_delegate_key() fail {
  pay(vault1(), Transaction { ..pay1_tx(), extra_signatories: [] })
}

test pay_signed_by_owner_not_delegate() fail {
  pay(vault1(), Transaction { ..pay1_tx(), extra_signatories: [principal] })
}

/// §12.1 Vault: pay above `per_tx`.
test pay_above_per_tx() fail {
  pay1_with(
    [
      continuing1(101 * ap3x, start, 101 * ap3x),
      escrow_output(job(buyer1(), owner1(), 99 * ap3x), 101 * ap3x),
    ],
  )
}

/// §12.1 Vault: pay above `total`.
test pay_above_total() fail {
  pay1_from(live1(461 * ap3x, start), continuing1(501 * ap3x, start, 40 * ap3x))
}

/// §12.1 Vault: a new period that starts before `hi`.
test pay_new_period_starts_before_hi() fail {
  pay1_from(
    live1(490 * ap3x, lo - 2 * day_ms),
    continuing1(40 * ap3x, lo, 40 * ap3x),
  )
}

test pay_new_period_keeps_old_spent() fail {
  pay1_from(
    live1(300 * ap3x, lo - 2 * day_ms),
    continuing1(340 * ap3x, lo - 2 * day_ms, 40 * ap3x),
  )
}

test pay_restarts_period_too_early() fail {
  let period_start = lo - day_ms + 1
  pay1_from(
    live1(460 * ap3x, period_start),
    continuing1(40 * ap3x, hi, 40 * ap3x),
  )
}

/// §12.1 Vault: pay to an escrow that is not Open.
test pay_escrow_not_open() fail {
  pay1_escrow(escrow1(EscrowDatum { ..job1(), state: Claimed }))
}

test pay_escrow_with_submitted_at() fail {
  pay1_escrow(escrow1(EscrowDatum { ..job1(), submitted_at: Some(hi) }))
}

test pay_escrow_with_receipt_hash() fail {
  pay1_escrow(
    escrow1(
      EscrowDatum {
        ..job1(),
        result_receipt_hash: Some(
          #"3333333333333333333333333333333333333333333333333333333333333333",
        ),
      },
    ),
  )
}

/// §12.1 Vault: pay to an escrow not at the exact escrow address (stake
/// credential).
test pay_escrow_with_stake_credential() fail {
  pay1_escrow(
    Output { ..escrow1(job1()), address: staked_script_address(escrow_hash) },
  )
}

/// §12.1 Vault: pay to an escrow not at the exact escrow address (another
/// script).
test pay_escrow_at_other_script() fail {
  pay1_escrow(
    Output { ..escrow1(job1()), address: address.from_script(other_hash) },
  )
}

/// §12.1 Vault: pay to an escrow above the cap.
test pay_escrow_above_cap() fail {
  pay1_escrow(
    escrow_output(
      EscrowDatum { ..job1(), payment_lovelace: max_job_ap3x - 2 * ap3x + 1 },
      max_job_ap3x + 1,
    ),
  )
}

/// §12.1 Vault: pay to an escrow that is not fully funded.
test pay_escrow_not_fully_funded() fail {
  pay1_escrow(
    escrow1(EscrowDatum { ..job1(), payment_lovelace: 38 * ap3x + 1 }),
  )
}

/// §12.1 Vault: pay to an escrow with `deliver_by` beyond 7 days.
test pay_escrow_deliver_by_beyond_7_days() fail {
  pay1_escrow(escrow1(EscrowDatum { ..job1(), deliver_by: hi + days_7_ms + 1 }))
}

/// §12.1 Vault: pay to an escrow without the vault refund.
test pay_escrow_without_vault_refund() fail {
  pay1_escrow(escrow1(EscrowDatum { ..job1(), refund: None }))
}

test pay_escrow_refund_to_owner_key() fail {
  pay1_escrow(
    escrow1(
      EscrowDatum {
        ..job1(),
        refund: Some(
          Refund {
            address: address.from_verification_key(principal),
            datum: None,
          },
        ),
      },
    ),
  )
}

test pay_escrow_refund_for_other_owner() fail {
  pay1_escrow(
    escrow1(
      EscrowDatum {
        ..job1(),
        refund: refund_to(PrincipalKey { hash: stranger, organisation: None }),
      },
    ),
  )
}

test pay_escrow_refund_with_live_datum() fail {
  let live: Data = vault1()
  pay1_escrow(
    escrow1(
      EscrowDatum {
        ..job1(),
        refund: Some(Refund { address: vault_address(), datum: Some(live) }),
      },
    ),
  )
}

/// §12.1 Vault: pay to an escrow with another buyer key.
test pay_escrow_other_buyer_key() fail {
  pay1_escrow(escrow1(EscrowDatum { ..job1(), buyer_pkh: principal }))
}

test pay_escrow_with_foreign_asset() fail {
  let output = escrow1(job1())
  pay1_escrow(
    Output { ..output, value: output.value |> assets.add(other_hash, "x", 1) },
  )
}

test pay_escrow_with_reference_script() fail {
  pay1_escrow(Output { ..escrow1(job1()), reference_script: Some(other_hash) })
}

test pay_escrow_with_datum_hash() fail {
  pay1_escrow(
    Output {
      ..escrow1(job1()),
      datum: transaction.DatumHash(
        #"3333333333333333333333333333333333333333333333333333333333333333",
      ),
    },
  )
}

/// Decision: a negative payment or bond does not count against the cap.
test pay_escrow_negative_bond() fail {
  pay1_escrow(
    escrow1(
      EscrowDatum {
        ..job1(),
        payment_lovelace: 48 * ap3x,
        buyer_bond_lovelace: -10 * ap3x,
      },
    ),
  )
}

test pay_escrows_hold_less_than_amount() fail {
  pay1_with(
    [
      continuing1(40 * ap3x, start, 40 * ap3x),
      escrow_output(job(buyer1(), owner1(), 28 * ap3x), 30 * ap3x),
    ],
  )
}

/// §12.1 Vault: a second script input.
test pay_second_script_input() fail {
  let tx = pay1_tx()
  let other =
    Input {
      output_reference: vault_ref(5),
      output: Output {
        ..escrow1(job1()),
        address: address.from_script(other_hash),
      },
    }
  pay(vault1(), Transaction { ..tx, inputs: [other, ..tx.inputs] })
}

test pay_two_vault_inputs() fail {
  let tx = pay1_tx()
  pay(
    vault1(),
    Transaction { ..tx, inputs: [vault_input(1, vault1(), funds), ..tx.inputs] },
  )
}

/// §12.1 Vault: Pay from a `Returned` output.
test pay_from_returned() {
  let returned = Returned { owner: owner1() }
  !pay(
    returned,
    Transaction {
      ..pay1_tx(),
      inputs: [wallet_input(seed()), vault_input(0, returned, funds)],
    },
  )
}

test pay_with_mint() fail {
  pay(
    vault1(),
    Transaction { ..pay1_tx(), mint: assets.from_asset(other_hash, "x", 1) },
  )
}

test pay_with_withdrawal() fail {
  pay(
    vault1(),
    Transaction { ..pay1_tx(), withdrawals: [Pair(Script(other_hash), 0)] },
  )
}

test pay_with_unbounded_range() fail {
  pay(
    vault1(),
    Transaction { ..pay1_tx(), validity_range: interval.everything },
  )
}

test pay_with_range_over_one_hour() fail {
  pay(
    vault1(),
    Transaction { ..pay1_tx(), validity_range: range(lo, lo + 3_600_001) },
  )
}

/// Decision: Pay needs a vault input with AP3X only.
test pay_vault_input_with_token() fail {
  let input = vault_input(0, vault1(), funds)
  let with_token =
    Input {
      ..input,
      output: Output {
        ..input.output,
        value: input.output.value |> assets.add(other_hash, "x", 1),
      },
    }
  pay(
    vault1(),
    Transaction { ..pay1_tx(), inputs: [wallet_input(seed()), with_token] },
  )
}

test pay_delegator_is_not_owner() fail {
  let owner = PrincipalKey { hash: stranger, organisation: None }
  let datum =
    Live { owner, delegation: delegation_id(1), spent: 0, period_start: start }
  pay(
    datum,
    Transaction {
      ..pay1_tx(),
      inputs: [wallet_input(seed()), vault_input(0, datum, funds)],
      outputs: [
        vault_output(
          Live {
            owner,
            delegation: delegation_id(1),
            spent: 40 * ap3x,
            period_start: start,
          },
          funds - 40 * ap3x,
        ),
        escrow1(job(buyer1(), owner, 38 * ap3x)),
      ],
    },
  )
}

test pay_delegation_without_value_limit() fail {
  pay1_link(DelegationDatum { ..chain_link(1, owner1()), value: None })
}

test pay_delegation_without_hire_action() fail {
  pay1_link(DelegationDatum { ..chain_link(1, owner1()), actions: ["ocr.*"] })
}

test pay_delegation_for_other_escrow_script() fail {
  pay1_link(
    DelegationDatum {
      ..chain_link(1, owner1()),
      resources: [
        "script:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
      ],
    },
  )
}

/// Positive control of the delegation tests above.
test pay_delegation_with_exact_action_and_star_resource() {
  pay1_link(
    DelegationDatum {
      ..chain_link(1, owner1()),
      actions: ["marketplace.hire.v1"],
      resources: ["*"],
    },
  )
}

test pay_after_undelegate() fail {
  pay1_refs(records(1, 1))
}

test pay_after_delegate_key_removed() fail {
  pay1_refs(
    [
      delegation_input(delegation_id(1), chain_link(1, owner1())),
      record_input(1, without_delegation_key(agent(1))),
    ],
  )
}

test pay_delegate_suspended() fail {
  pay1_refs(
    [
      delegation_input(delegation_id(1), chain_link(1, owner1())),
      record_input(1, suspended(agent(1))),
    ],
  )
}

/// The window ends after the period of the delegation. A new vault period
/// starts, so the continuing datum has `period_start = hi`.
test pay_after_delegation_period() fail {
  let datum = chain_link(1, owner1())
  pay(
    vault1(),
    Transaction {
      ..pay1_tx(),
      outputs: [
        continuing1(40 * ap3x, datum.not_after + 1, 40 * ap3x),
        escrow1(job1()),
      ],
      validity_range: range(datum.not_after - 600_000, datum.not_after + 1),
    },
  )
}

/// Positive control of the test above: the last window inside the period.
test pay_at_end_of_delegation_period() {
  let datum = chain_link(1, owner1())
  pay(
    vault1(),
    Transaction {
      ..pay1_tx(),
      outputs: [
        continuing1(40 * ap3x, datum.not_after, 40 * ap3x),
        escrow1(job1()),
      ],
      validity_range: range(datum.not_after - 600_000, datum.not_after),
    },
  )
}

test pay_continuing_output_with_token() fail {
  let output = continuing1(40 * ap3x, start, 40 * ap3x)
  pay1_with(
    [
      Output { ..output, value: output.value |> assets.add(other_hash, "x", 1) },
      escrow1(job1()),
    ],
  )
}

test pay_continuing_output_with_reference_script() fail {
  pay1_with(
    [
      Output {
        ..continuing1(40 * ap3x, start, 40 * ap3x),
        reference_script: Some(other_hash),
      },
      escrow1(job1()),
    ],
  )
}

test pay_continuing_output_at_staked_address() fail {
  pay1_with(
    [
      Output {
        ..continuing1(40 * ap3x, start, 40 * ap3x),
        address: staked_script_address(vault_hash),
      },
      escrow1(job1()),
    ],
  )
}

test pay_two_vault_outputs() fail {
  pay1_with(
    [
      continuing1(40 * ap3x, start, 40 * ap3x),
      vault_output(Returned { owner: owner1() }, 2 * ap3x),
      escrow1(job1()),
    ],
  )
}

test pay_continuing_datum_other_delegation() fail {
  pay1_with(
    [
      vault_output(
        Live {
          owner: owner1(),
          delegation: delegation_id(2),
          spent: 40 * ap3x,
          period_start: start,
        },
        funds - 40 * ap3x,
      ),
      escrow1(job1()),
    ],
  )
}

test pay_continuing_datum_lower_spent() fail {
  pay1_with([continuing1(39 * ap3x, start, 40 * ap3x), escrow1(job1())])
}

/// Decision: Pay moves a positive amount.
test pay_zero_amount() fail {
  pay1_with([continuing1(0, start, 0), escrow1(job1())])
}

test pay_adds_funds() fail {
  pay1_with([continuing1(-10 * ap3x, start, -10 * ap3x), escrow1(job1())])
}

// ## Close

fn close_tx(
  inputs: List<Input>,
  refs: List<Input>,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs,
    reference_inputs: refs,
    extra_signatories: signers,
  }
}

test close_live_by_principal() {
  close(
    vault1(),
    0,
    close_tx([vault_input(0, vault1(), funds)], [], [principal]),
  )
}

test close_returned_by_principal() {
  let returned = Returned { owner: owner1() }
  close(
    returned,
    0,
    close_tx([vault_input(0, returned, funds)], [], [principal]),
  )
}

test close_live_by_agent_controller() {
  close(
    vault4(),
    0,
    close_tx(
      [vault_input(0, vault4(), funds)],
      records(3, 3),
      [hash(controller_key(3))],
    ),
  )
}

test close_returned_by_agent_controller() {
  let returned = Returned { owner: owner4() }
  close(
    returned,
    0,
    close_tx(
      [vault_input(0, returned, funds)],
      records(3, 3),
      [hash(controller_key(3))],
    ),
  )
}

/// Several vault inputs close in one transaction; the funds go anywhere.
test close_several_vault_inputs() {
  let returned = Returned { owner: owner1() }
  let tx =
    Transaction {
      ..close_tx(
        [vault_input(0, vault1(), funds), vault_input(1, returned, 5 * ap3x)],
        [],
        [principal],
      ),
      outputs: [
        Output {
          address: address.from_verification_key(stranger),
          value: assets.from_lovelace(funds + 5 * ap3x),
          datum: transaction.NoDatum,
          reference_script: None,
        },
      ],
    }
  close(vault1(), 0, tx) && close(returned, 1, tx)
}

/// §12.1 Vault, must pass: Close after Undelegate. No delegation is a
/// reference input, and the delegation of the vault no longer exists.
test close_after_undelegate() {
  close(
    vault4(),
    0,
    close_tx(
      [vault_input(0, vault4(), funds)],
      records(3, 3),
      [hash(controller_key(3))],
    ),
  ) && close(
    vault1(),
    0,
    close_tx([vault_input(0, vault1(), funds)], [], [principal]),
  )
}

/// §12.1 Vault: Close by anybody but the owner (a stranger).
test close_by_stranger() {
  !close(
    vault1(),
    0,
    close_tx([vault_input(0, vault1(), funds)], [], [stranger]),
  )
}

/// §12.1 Vault: Close by anybody but the owner (the delegate). §12.3: the
/// delegate cannot spend a `Returned` output.
test close_by_delegate() {
  let returned = Returned { owner: owner1() }
  and {
    !close(
      vault1(),
      0,
      close_tx(
        [vault_input(0, vault1(), funds)],
        chain_refs(1, owner1()),
        [buyer1(), hash(controller_key(1))],
      ),
    ),
    !close(
      returned,
      0,
      close_tx(
        [vault_input(0, returned, funds)],
        chain_refs(1, owner1()),
        [buyer1(), hash(controller_key(1))],
      ),
    ),
  }
}

/// §12.1 Vault: Close by anybody but the owner (a delegation key of the owner
/// agent, not its controller).
test close_agent_by_delegation_key() {
  !close(
    vault4(),
    0,
    close_tx(
      [vault_input(0, vault4(), funds)],
      records(3, 3),
      [hash(delegation_key(3))],
    ),
  )
}

test close_agent_without_record() {
  !close(
    vault4(),
    0,
    close_tx([vault_input(0, vault4(), funds)], [], [hash(controller_key(3))]),
  )
}

test close_agent_with_other_record() {
  !close(
    vault4(),
    0,
    close_tx(
      [vault_input(0, vault4(), funds)],
      [record_input(4, agent(3))],
      [hash(controller_key(3))],
    ),
  )
}
