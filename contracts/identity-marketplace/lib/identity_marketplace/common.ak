//// Shared helpers for the identity marketplace validators (Part 2 §2–§6 of
//// `docs/IDENTITY_REGISTRY.md`).
////
//// Addresses: "at" an address always compares the whole address. The
//// enterprise address of a script is `address.from_script(hash)` (stdlib): the
//// script as payment credential and no stake credential. The enterprise
//// address of a key is `address.from_verification_key(pkh)`.
////
//// Several helpers are ports of `contracts/marketplace/lib/marketplace/common.ak`
//// (legacy escrow and advert). Their behaviour is unchanged.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_224}
use aiken/interval.{Finite, NegativeInfinity, PositiveInfinity}
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/certificate
use cardano/governance
use cardano/transaction.{
  Datum, InlineDatum, Input, Output, Transaction, ValidityRange,
}
use vector_identity.{max_range_ms, max_time_ms}

// ## Validity window

/// The finite bounds of a transaction's validity range (`lo`, `hi` of Part 2
/// §3.2).
pub type Window {
  lo: Int,
  hi: Int,
}

/// The validity window of a transaction: `lo` is the value of the finite lower
/// bound, `hi` the value of the finite upper bound. Fails when a bound is
/// infinite, when `hi < lo`, or when `hi - lo > max_range_ms` (one hour).
///
/// Inclusive and exclusive bounds: the function ignores the `is_inclusive`
/// flags and takes the bound values as they are. For both kinds of bound,
/// every time `t` at which the transaction can be valid satisfies
/// `lo <= t <= hi`. A rule checked against `lo` or `hi` thus holds at every
/// such `t`:
///
/// - elapsed-time checks use `lo` (`effective_after <= lo`, `at + 90 days <= lo`);
/// - a hold is in force when `until > lo`;
/// - coverage and deadlines that protect somebody else use `hi`
///   (`not_after >= hi`, `removal_after >= hi + 7 days`);
/// - `created_at`, `issued_at` and `effective_after` are computed from the
///   bound values (`hi`, `hi + 7 days`), so the transaction fixes them.
pub fn window(range: ValidityRange) -> Window {
  expect Finite(lo) = range.lower_bound.bound_type
  expect Finite(hi) = range.upper_bound.bound_type
  expect lo <= hi
  expect hi - lo <= max_range_ms
  Window { lo, hi }
}

/// True when `t` is a valid time: `0 <= t <= max_time_ms` (Part 2 §3.3).
pub fn valid_time(t: Int) -> Bool {
  t >= 0 && t <= max_time_ms
}

/// True when `n` is a valid integer that is not a time: `0 <= n < 2^63`
/// (Part 2 §3.3).
pub fn valid_uint(n: Int) -> Bool {
  n >= 0 && n < 9_223_372_036_854_775_808
}

// ## Signatures

/// True when `pkh` is a required signer (port of the legacy `signed_by`).
pub fn signed_by(
  extra_signatories: List<VerificationKeyHash>,
  pkh: VerificationKeyHash,
) -> Bool {
  list.has(extra_signatories, pkh)
}

/// `signed(pk)` of Part 2 §3.2: `blake2b_224(public_key)` is a required signer.
pub fn key_signed(
  extra_signatories: List<VerificationKeyHash>,
  public_key: ByteArray,
) -> Bool {
  list.has(extra_signatories, blake2b_224(public_key))
}

// ## Addresses, inputs and outputs

/// True when the output is at exactly the enterprise address of the script
/// `hash`: payment credential `Script(hash)` and no stake credential.
pub fn at_script_address(output: Output, hash: ByteArray) -> Bool {
  when output.address is {
    Address { payment_credential: Script(h), stake_credential: None } ->
      h == hash
    _ -> False
  }
}

/// The outputs at exactly `address`, in transaction order.
pub fn outputs_at(outputs: List<Output>, address: Address) -> List<Output> {
  list.filter(outputs, fn(output) { output.address == address })
}

/// The only output at exactly `address`. Fails unless exactly one output is
/// at `address` (the legacy `unique_output_to_credential`, with an exact
/// address).
pub fn single_output_at(outputs: List<Output>, address: Address) -> Output {
  expect [output] = outputs_at(outputs, address)
  output
}

/// The number of inputs whose payment credential is a script, with any stake
/// credential.
pub fn count_script_inputs(inputs: List<Input>) -> Int {
  list.count(
    inputs,
    fn(input) {
      when input.output.address.payment_credential is {
        Script(_) -> True
        VerificationKey(_) -> False
      }
    },
  )
}

/// The number of inputs whose payment credential is `Script(hash)`, with any
/// stake credential.
pub fn count_inputs_with_script(inputs: List<Input>, hash: ByteArray) -> Int {
  list.count(
    inputs,
    fn(input) { input.output.address.payment_credential == Script(hash) },
  )
}

/// The inline datum of an output. Fails when the output has no inline datum.
pub fn inline_datum(output: Output) -> Data {
  expect InlineDatum(data) = output.datum
  data
}

// ## Values

/// The AP3X amount (base units) of a value.
pub fn ap3x_of(value: Value) -> Int {
  assets.lovelace_of(value)
}

/// True when the value holds AP3X and no other asset.
pub fn ap3x_only(value: Value) -> Bool {
  assets.without_lovelace(value) == assets.zero
}

/// "Value kept" (Part 2 §3.2): the output holds at least the AP3X of the
/// input, and no other asset changes.
pub fn value_kept(input: Value, output: Value) -> Bool {
  and {
    assets.lovelace_of(output) >= assets.lovelace_of(input),
    assets.without_lovelace(output) == assets.without_lovelace(input),
  }
}

/// True when `outputs` together hold at least the quantity of every asset of
/// `due`, AP3X included.
pub fn outputs_hold(outputs: List<Output>, due: Value) -> Bool {
  assets.reduce(
    due,
    True,
    fn(policy, name, quantity, ok) {
      ok && list.foldl(
        outputs,
        0,
        fn(output, total) {
          total + assets.quantity_of(output.value, policy, name)
        },
      ) >= quantity
    },
  )
}

/// True when the value holds AP3X and exactly one other token: `(policy, name)`
/// with quantity 1.
pub fn ap3x_and_token(value: Value, policy: ByteArray, name: ByteArray) -> Bool {
  assets.without_lovelace(value) == assets.from_asset(policy, name, 1)
}

/// The AP3X in outputs whose payment credential is `VerificationKey(pkh)`,
/// with any stake credential and any datum (port of the legacy
/// `lovelace_paid_to_pkh`).
pub fn ap3x_paid_to_key(outputs: List<Output>, pkh: VerificationKeyHash) -> Int {
  list.foldl(
    outputs,
    0,
    fn(output, total) {
      if output.address.payment_credential == VerificationKey(pkh) {
        total + assets.lovelace_of(output.value)
      } else {
        total
      }
    },
  )
}

/// The AP3X in outputs at exactly `address` whose datum equals `datum`.
pub fn ap3x_paid_to_address_with_datum(
  outputs: List<Output>,
  address: Address,
  datum: Datum,
) -> Int {
  list.foldl(
    outputs,
    0,
    fn(output, total) {
      if output.address == address && output.datum == datum {
        total + assets.lovelace_of(output.value)
      } else {
        total
      }
    },
  )
}

// ## Transaction scope

/// True when the transaction mints or burns nothing and has no withdrawal,
/// certificate, vote or proposal.
pub fn no_mint_withdrawal_certificate_vote_proposal(tx: Transaction) -> Bool {
  and {
    assets.is_zero(tx.mint),
    list.is_empty(tx.withdrawals),
    list.is_empty(tx.certificates),
    list.is_empty(tx.votes),
    list.is_empty(tx.proposal_procedures),
  }
}

// ## Legacy escrow timing (kept by Part 2 §6.1)

/// The buyer's acceptance window after `submitted_at`: 10 minutes (legacy
/// escrow).
pub const accept_window_ms: Int = 600_000

/// True when every time in the range is at or before `deadline` (port of the
/// legacy `before_or_at`). An exclusive upper bound `u` allows `u <= deadline + 1`.
pub fn before_or_at(range: ValidityRange, deadline: Int) -> Bool {
  when range.upper_bound.bound_type is {
    Finite(upper) ->
      if range.upper_bound.is_inclusive {
        upper <= deadline
      } else {
        upper <= deadline + 1
      }
    NegativeInfinity -> True
    PositiveInfinity -> False
  }
}

/// True when every time in the range is at or after `threshold` (port of the
/// legacy `after_or_at`). An exclusive lower bound `l` allows
/// `l >= threshold - 1`.
pub fn after_or_at(range: ValidityRange, threshold: Int) -> Bool {
  when range.lower_bound.bound_type is {
    Finite(lower) ->
      if range.lower_bound.is_inclusive {
        lower >= threshold
      } else {
        lower >= threshold - 1
      }
    PositiveInfinity -> True
    NegativeInfinity -> False
  }
}

// ## Tests

const test_script_hash: ByteArray =
  #"3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c"

const test_other_script_hash: ByteArray =
  #"4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d"

const test_pkh: ByteArray =
  #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e"

const test_other_pkh: ByteArray =
  #"6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f"

const test_public_key: ByteArray =
  #"7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a"

const test_tx_id: ByteArray =
  #"8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b"

const test_lo: Int = 1_793_577_600_000

fn bounded(
  lower: Int,
  lower_inclusive: Bool,
  upper: Int,
  upper_inclusive: Bool,
) -> ValidityRange {
  interval.Interval {
    lower_bound: interval.IntervalBound {
      bound_type: Finite(lower),
      is_inclusive: lower_inclusive,
    },
    upper_bound: interval.IntervalBound {
      bound_type: Finite(upper),
      is_inclusive: upper_inclusive,
    },
  }
}

fn staked_script_address(hash: ByteArray) -> Address {
  address.from_script(hash) |> address.with_delegation_key(test_other_pkh)
}

fn output_to(address: Address, lovelace: Int, datum: Datum) -> Output {
  Output {
    address,
    value: assets.from_lovelace(lovelace),
    datum,
    reference_script: None,
  }
}

fn input_from(address: Address) -> Input {
  Input {
    output_reference: transaction.OutputReference {
      transaction_id: test_tx_id,
      output_index: 0,
    },
    output: output_to(address, 2_000_000, transaction.NoDatum),
  }
}

fn token_value(lovelace: Int, quantity: Int) -> Value {
  assets.from_lovelace(lovelace)
    |> assets.add(test_script_hash, test_tx_id, quantity)
}

// ### window

test window_inclusive_bounds() {
  window(interval.between(test_lo, test_lo + 600_000)) == Window {
    lo: test_lo,
    hi: test_lo + 600_000,
  }
}

test window_exclusive_bounds_give_values() {
  window(interval.entirely_between(test_lo, test_lo + 600_000)) == Window {
    lo: test_lo,
    hi: test_lo + 600_000,
  }
}

test window_mixed_bounds_give_values() {
  window(bounded(test_lo, True, test_lo + 1_000, False)) == Window {
    lo: test_lo,
    hi: test_lo + 1_000,
  }
}

test window_single_point() {
  window(interval.between(test_lo, test_lo)) == Window {
    lo: test_lo,
    hi: test_lo,
  }
}

test window_one_hour_passes() {
  window(interval.between(test_lo, test_lo + max_range_ms)).hi == test_lo + 3_600_000
}

test window_over_one_hour_fails() fail {
  window(interval.between(test_lo, test_lo + max_range_ms + 1)).lo == test_lo
}

test window_infinite_lower_fails() fail {
  window(interval.before(test_lo)).hi == test_lo
}

test window_infinite_upper_fails() fail {
  window(interval.after(test_lo)).lo == test_lo
}

test window_unbounded_fails() fail {
  window(interval.everything).lo == 0
}

test window_reversed_fails() fail {
  window(bounded(test_lo + 1, True, test_lo, True)).lo == test_lo + 1
}

// ### valid_time, valid_uint

test valid_time_bounds() {
  and {
    valid_time(0),
    valid_time(max_time_ms),
    !valid_time(max_time_ms + 1),
    !valid_time(-1),
  }
}

test valid_uint_bounds() {
  and {
    valid_uint(0),
    valid_uint(9_223_372_036_854_775_807),
    !valid_uint(9_223_372_036_854_775_808),
    !valid_uint(-1),
  }
}

// ### Signatures

test signed_by_listed_signer() {
  signed_by([test_other_pkh, test_pkh], test_pkh)
}

test signed_by_missing_signer() {
  !signed_by([test_other_pkh], test_pkh)
}

test key_signed_by_key_hash() {
  key_signed([test_pkh, blake2b_224(test_public_key)], test_public_key)
}

test key_signed_needs_key_hash() {
  !key_signed([test_public_key, test_pkh], test_public_key)
}

// ### Addresses, inputs and outputs

test at_script_address_exact() {
  at_script_address(
    output_to(
      address.from_script(test_script_hash),
      2_000_000,
      transaction.NoDatum,
    ),
    test_script_hash,
  )
}

test at_script_address_rejects_other_addresses() {
  and {
    !at_script_address(
      output_to(
        staked_script_address(test_script_hash),
        2_000_000,
        transaction.NoDatum,
      ),
      test_script_hash,
    ),
    !at_script_address(
      output_to(
        address.from_script(test_other_script_hash),
        2_000_000,
        transaction.NoDatum,
      ),
      test_script_hash,
    ),
    !at_script_address(
      output_to(
        address.from_verification_key(test_script_hash),
        2_000_000,
        transaction.NoDatum,
      ),
      test_script_hash,
    ),
  }
}

test outputs_at_exact_address() {
  let target = address.from_script(test_script_hash)
  let first = output_to(target, 2_000_000, transaction.NoDatum)
  let second = output_to(target, 3_000_000, transaction.NoDatum)
  let outputs =
    [
      first,
      output_to(
        staked_script_address(test_script_hash),
        4_000_000,
        transaction.NoDatum,
      ),
      second,
    ]
  outputs_at(outputs, target) == [first, second]
}

test single_output_at_one() {
  let target = address.from_script(test_script_hash)
  let only = output_to(target, 2_000_000, transaction.NoDatum)
  let outputs =
    [
      output_to(
        staked_script_address(test_script_hash),
        4_000_000,
        transaction.NoDatum,
      ),
      only,
    ]
  single_output_at(outputs, target) == only
}

test single_output_at_none_fails() fail {
  let outputs =
    [
      output_to(
        staked_script_address(test_script_hash),
        2_000_000,
        transaction.NoDatum,
      ),
    ]
  single_output_at(outputs, address.from_script(test_script_hash)).value == assets.zero
}

test single_output_at_two_fails() fail {
  let target = address.from_script(test_script_hash)
  let outputs =
    [
      output_to(target, 2_000_000, transaction.NoDatum),
      output_to(target, 2_000_000, transaction.NoDatum),
    ]
  single_output_at(outputs, target).value == assets.zero
}

test count_script_inputs_any_script() {
  let inputs =
    [
      input_from(address.from_script(test_script_hash)),
      input_from(address.from_verification_key(test_pkh)),
      input_from(staked_script_address(test_other_script_hash)),
    ]
  count_script_inputs(inputs) == 2
}

test count_inputs_with_script_any_stake() {
  let inputs =
    [
      input_from(address.from_script(test_script_hash)),
      input_from(staked_script_address(test_script_hash)),
      input_from(address.from_script(test_other_script_hash)),
      input_from(address.from_verification_key(test_script_hash)),
    ]
  and {
    count_inputs_with_script(inputs, test_script_hash) == 2,
    count_inputs_with_script(inputs, test_pkh) == 0,
  }
}

test inline_datum_returns_data() {
  let output =
    output_to(
      address.from_script(test_script_hash),
      2_000_000,
      InlineDatum(test_tx_id),
    )
  let expected: Data = test_tx_id
  inline_datum(output) == expected
}

test inline_datum_rejects_datum_hash() fail {
  let output =
    output_to(
      address.from_script(test_script_hash),
      2_000_000,
      transaction.DatumHash(test_tx_id),
    )
  let expected: Data = test_tx_id
  inline_datum(output) == expected
}

test inline_datum_rejects_no_datum() fail {
  let output =
    output_to(
      address.from_script(test_script_hash),
      2_000_000,
      transaction.NoDatum,
    )
  let expected: Data = test_tx_id
  inline_datum(output) == expected
}

// ### Values

test ap3x_of_value() {
  ap3x_of(token_value(7_000_000, 1)) == 7_000_000
}

test ap3x_only_values() {
  and {
    ap3x_only(assets.from_lovelace(2_000_000)),
    !ap3x_only(token_value(2_000_000, 1)),
  }
}

test value_kept_cases() {
  let input = token_value(10_000_000, 1)
  and {
    value_kept(input, token_value(10_000_000, 1)),
    value_kept(input, token_value(12_000_000, 1)),
    !value_kept(input, token_value(9_999_999, 1)),
    !value_kept(input, assets.from_lovelace(20_000_000)),
    !value_kept(input, token_value(10_000_000, 2)),
    !value_kept(
      input,
      token_value(10_000_000, 1) |> assets.add(test_other_script_hash, #"01", 1),
    ),
  }
}

test ap3x_and_token_cases() {
  and {
    ap3x_and_token(token_value(5_000_000, 1), test_script_hash, test_tx_id),
    !ap3x_and_token(token_value(5_000_000, 2), test_script_hash, test_tx_id),
    !ap3x_and_token(token_value(5_000_000, 1), test_script_hash, #"01"),
    !ap3x_and_token(
      token_value(5_000_000, 1),
      test_other_script_hash,
      test_tx_id,
    ),
    !ap3x_and_token(
      assets.from_lovelace(5_000_000),
      test_script_hash,
      test_tx_id,
    ),
    !ap3x_and_token(
      token_value(5_000_000, 1) |> assets.add(test_script_hash, #"01", 1),
      test_script_hash,
      test_tx_id,
    ),
    !ap3x_and_token(
      token_value(5_000_000, 1) |> assets.add(test_other_script_hash, #"01", 1),
      test_script_hash,
      test_tx_id,
    ),
  }
}

test ap3x_paid_to_key_any_stake() {
  let outputs =
    [
      output_to(
        address.from_verification_key(test_pkh),
        1_000_000,
        transaction.NoDatum,
      ),
      output_to(
        address.from_verification_key(test_pkh)
          |> address.with_delegation_key(test_other_pkh),
        2_000_000,
        InlineDatum(1),
      ),
      output_to(address.from_script(test_pkh), 4_000_000, transaction.NoDatum),
      output_to(
        address.from_verification_key(test_other_pkh),
        8_000_000,
        transaction.NoDatum,
      ),
    ]
  ap3x_paid_to_key(outputs, test_pkh) == 3_000_000
}

test ap3x_paid_to_address_with_datum_exact() {
  let target = staked_script_address(test_script_hash)
  let outputs =
    [
      output_to(target, 1_000_000, InlineDatum(1)),
      output_to(target, 2_000_000, InlineDatum(2)),
      output_to(target, 4_000_000, transaction.NoDatum),
      output_to(
        address.from_script(test_script_hash),
        8_000_000,
        InlineDatum(1),
      ),
      output_to(target, 16_000_000, InlineDatum(1)),
    ]
  and {
    ap3x_paid_to_address_with_datum(outputs, target, InlineDatum(1)) == 17_000_000,
    ap3x_paid_to_address_with_datum(outputs, target, transaction.NoDatum) == 4_000_000,
  }
}

test outputs_hold_cases() {
  let target = address.from_verification_key(test_pkh)
  let paid =
    fn(value) { Output { ..output_to(target, 0, InlineDatum(1)), value } }
  let due = token_value(10_000_000, 2)
  and {
    // One output, or the sum over several outputs.
    outputs_hold([paid(due)], due),
    outputs_hold(
      [paid(token_value(4_000_000, 1)), paid(token_value(6_000_000, 1))],
      due,
    ),
    outputs_hold(
      [
        paid(
          token_value(10_000_001, 3)
            |> assets.add(test_other_script_hash, #"01", 1),
        ),
      ],
      due,
    ),
    // Short of AP3X or of a token.
    !outputs_hold([paid(token_value(9_999_999, 2))], due),
    !outputs_hold([paid(token_value(10_000_000, 1))], due),
    !outputs_hold([paid(assets.from_lovelace(20_000_000))], due),
    !outputs_hold([], due),
    // AP3X only.
    outputs_hold([paid(assets.from_lovelace(5))], assets.from_lovelace(5)),
    !outputs_hold([paid(assets.from_lovelace(4))], assets.from_lovelace(5)),
    outputs_hold([], assets.zero),
  }
}

// ### Transaction scope

test no_actions_on_plain_transaction() {
  no_mint_withdrawal_certificate_vote_proposal(transaction.placeholder)
}

test no_actions_rejects_mint() {
  !no_mint_withdrawal_certificate_vote_proposal(
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(test_script_hash, #"01", 1),
    },
  )
}

test no_actions_rejects_withdrawal() {
  !no_mint_withdrawal_certificate_vote_proposal(
    Transaction {
      ..transaction.placeholder,
      withdrawals: [Pair(Script(test_script_hash), 0)],
    },
  )
}

test no_actions_rejects_certificate() {
  !no_mint_withdrawal_certificate_vote_proposal(
    Transaction {
      ..transaction.placeholder,
      certificates: [
        certificate.UpdateDelegateRepresentative {
          delegate_representative: VerificationKey(test_pkh),
        },
      ],
    },
  )
}

test no_actions_rejects_vote() {
  !no_mint_withdrawal_certificate_vote_proposal(
    Transaction {
      ..transaction.placeholder,
      votes: [
        Pair(
          governance.StakePool(test_pkh),
          [
            Pair(
              governance.GovernanceActionId {
                transaction: test_tx_id,
                proposal_procedure: 0,
              },
              governance.Yes,
            ),
          ],
        ),
      ],
    },
  )
}

test no_actions_rejects_proposal() {
  !no_mint_withdrawal_certificate_vote_proposal(
    Transaction {
      ..transaction.placeholder,
      proposal_procedures: [
        governance.ProposalProcedure {
          deposit: 100_000_000_000,
          return_address: VerificationKey(test_pkh),
          governance_action: governance.NicePoll,
        },
      ],
    },
  )
}

// ### Legacy escrow timing

test before_or_at_bounds() {
  and {
    before_or_at(bounded(0, True, 100, True), 100),
    !before_or_at(bounded(0, True, 101, True), 100),
    before_or_at(bounded(0, True, 101, False), 100),
    !before_or_at(bounded(0, True, 102, False), 100),
    before_or_at(interval.before(100), 100),
    !before_or_at(interval.after(0), 100),
  }
}

test after_or_at_bounds() {
  and {
    after_or_at(bounded(100, True, 200, True), 100),
    !after_or_at(bounded(99, True, 200, True), 100),
    after_or_at(bounded(99, False, 200, True), 100),
    !after_or_at(bounded(98, False, 200, True), 100),
    after_or_at(interval.after(100), 100),
    !after_or_at(interval.before(200), 100),
  }
}
