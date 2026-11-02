//// Tests of the delegation contract (Part 2 §5.2) and of the use checks
//// (`chain.use_delegation`). `tests/delegation.md` maps the §12.1 rows to
//// these tests.
////
//// Each attack test changes one thing in a transaction that passes in a
//// positive test.

use aiken/interval
use cardano/address
use cardano/assets
use cardano/transaction.{Input, OutputReference, Transaction, ValidityRange}
use identity_marketplace/common.{window}
use identity_marketplace/delegation/chain.{find_delegation, use_delegation}
use identity_marketplace/delegation/fixtures.{
  agent, agent_delegator, agent_id, ap3x, chain_inputs, chain_link, chain_refs,
  controller_key, delegation_hash, delegation_id, delegation_input,
  delegation_key, delegation_output, delegation_value, escrow_pattern, hash,
  identity_hash, input_at, link, new_id, now, other_hash, principal,
  principal_delegator, range, record_input, records, revoked, seed,
  staked_script_address, stranger, suspended, transaction_key, wallet_input,
  without_delegation_key,
}
use identity_marketplace/delegation/handlers.{
  delegation_mint, delegation_spend, valid_delegation,
}
use identity_marketplace/types.{
  Delegate, DelegationDatum, PrincipalKey, Undelegate, ValueLimit,
}
use vector_identity.{days_30_ms, max_time_ms}
use vector_identity/types.{IdentityDatum, Subagent} as identity

const hire: ByteArray = "marketplace.hire.v1"

// ## Delegate: builders

/// A `Delegate` transaction that mints `new_id()` with `datum`.
fn delegate_tx(
  datum: DelegationDatum,
  refs: List<Input>,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [wallet_input(seed())],
    reference_inputs: refs,
    outputs: [delegation_output(new_id(), datum)],
    mint: assets.from_asset(delegation_hash, new_id(), 1),
    extra_signatories: signers,
    validity_range: now(),
  }
}

fn mint_delegate(tx: Transaction) -> Bool {
  delegation_mint(identity_hash, Delegate { seed: seed() }, delegation_hash, tx)
}

/// Link 1 with a `PrincipalKey` delegator.
fn principal_root() -> DelegationDatum {
  link(1, principal_delegator(), None)
}

/// The principal signs; the delegate (agent 1) signs with its delegation key.
fn principal_root_tx(datum: DelegationDatum) -> Transaction {
  delegate_tx(datum, records(1, 1), [principal, hash(delegation_key(1))])
}

/// Link 1 with the delegator agent 0.
fn agent_root() -> DelegationDatum {
  link(1, agent_delegator(0), None)
}

/// The parent (link `n - 1`) of the sub-delegation of link `n`.
fn parent_of(n: Int) -> DelegationDatum {
  chain_link(n - 1, principal_delegator())
}

/// The child (link `n`) of a sub-delegation.
fn child_of(n: Int) -> DelegationDatum {
  chain_link(n, principal_delegator())
}

/// The sub-delegation of link `n` with `parent` (as `delegation_id(n - 1)`)
/// and `child`. The parent's delegate key (agent `n - 1`) and the child's
/// delegate key (agent `n`) sign.
fn sub_tx(
  n: Int,
  parent: DelegationDatum,
  child: DelegationDatum,
  agents: List<Input>,
  signers: List<ByteArray>,
) -> Transaction {
  delegate_tx(
    child,
    [delegation_input(delegation_id(n - 1), parent), ..agents],
    signers,
  )
}

fn sub_signers(n: Int) -> List<ByteArray> {
  [hash(delegation_key(n - 1)), hash(delegation_key(n))]
}

/// The sub-delegation of link 2 with the child `child`.
fn sub2(child: DelegationDatum) -> Bool {
  mint_delegate(sub_tx(2, parent_of(2), child, records(1, 2), sub_signers(2)))
}

/// The sub-delegation of link 2 with the parent `parent` and the child
/// `child`.
fn sub2_under(parent: DelegationDatum, child: DelegationDatum) -> Bool {
  mint_delegate(sub_tx(2, parent, child, records(1, 2), sub_signers(2)))
}

// ## Delegate: positive

test delegate_by_principal_key() {
  mint_delegate(principal_root_tx(principal_root()))
}

test delegate_by_agent_controller() {
  mint_delegate(
    delegate_tx(
      agent_root(),
      records(0, 1),
      [hash(controller_key(0)), hash(delegation_key(1))],
    ),
  )
}

test delegate_by_agent_delegation_key() {
  mint_delegate(
    delegate_tx(
      agent_root(),
      records(0, 1),
      [hash(delegation_key(0)), hash(delegation_key(1))],
    ),
  )
}

test delegate_sub_delegation() {
  sub2(child_of(2))
}

test delegate_sub_delegation_narrower() {
  sub2(
    DelegationDatum {
      ..child_of(2),
      actions: ["marketplace.hire.v1", "ocr.extract.*"],
      resources: [],
      not_before: parent_of(2).not_before,
      not_after: parent_of(2).not_after,
      remaining: 0,
      value: Some(
        ValueLimit { per_tx: ap3x, total: 2 * ap3x, period_ms: days_30_ms },
      ),
    },
  )
}

test delegate_sub_delegation_under_parent_without_limit() {
  sub2_under(
    DelegationDatum { ..parent_of(2), value: None },
    DelegationDatum { ..child_of(2), value: None },
  )
}

test delegate_depth_4() {
  mint_delegate(
    sub_tx(4, parent_of(4), child_of(4), records(3, 4), sub_signers(4)),
  )
}

test valid_delegation_limits() {
  let max_patterns =
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"]
  and {
    valid_delegation(
      DelegationDatum {
        ..principal_root(),
        delegator: PrincipalKey {
          hash: principal,
          organisation: Some(
            "did:web:organisation.example.org:units:research:agents:division1",
          ),
        },
        actions: ["*", ..max_patterns],
        resources: [
          "*", escrow_pattern, "https://a", "https://b", "oauth:c", "mcp:d",
          "mcp:e", "mcp:f",
        ],
        not_before: 0,
        not_after: max_time_ms,
        purpose: None,
        value: Some(
          ValueLimit {
            per_tx: 10_000 * ap3x,
            total: 10_000 * ap3x,
            period_ms: 1,
          },
        ),
      },
    ),
    valid_delegation(
      DelegationDatum { ..principal_root(), depth: 4, remaining: 0 },
    ),
    !valid_delegation(
      DelegationDatum { ..principal_root(), depth: 0, remaining: 0 },
    ),
    !valid_delegation(
      DelegationDatum { ..principal_root(), depth: 2, remaining: -1 },
    ),
    !valid_delegation(
      DelegationDatum {
        ..principal_root(),
        delegator: PrincipalKey { hash: principal, organisation: Some("") },
      },
    ),
    !valid_delegation(DelegationDatum { ..principal_root(), delegate: #"00" }),
    !valid_delegation(
      DelegationDatum { ..principal_root(), delegate_key: agent_id(1) },
    ),
    !valid_delegation(
      DelegationDatum { ..principal_root(), parent: Some(#"0102") },
    ),
  }
}

// ## Delegate: attacks

/// §12.1 Delegation: a child wider than its parent (actions).
test delegate_child_wider_actions() fail {
  sub2(
    DelegationDatum { ..child_of(2), actions: ["marketplace.*", "payments.*"] },
  )
}

test delegate_child_star_action_under_prefix() fail {
  sub2(DelegationDatum { ..child_of(2), actions: ["*"] })
}

/// §12.1 Delegation: a child wider than its parent (resources).
test delegate_child_wider_resources() fail {
  sub2(DelegationDatum { ..child_of(2), resources: ["*"] })
}

test delegate_child_resource_under_empty_parent() fail {
  sub2_under(DelegationDatum { ..parent_of(2), resources: [] }, child_of(2))
}

/// §12.1 Delegation: a child wider than its parent (period start).
test delegate_child_starts_before_parent() fail {
  sub2(
    DelegationDatum { ..child_of(2), not_before: parent_of(2).not_before - 1 },
  )
}

/// §12.1 Delegation: a child wider than its parent (period end).
test delegate_child_ends_after_parent() fail {
  sub2(DelegationDatum { ..child_of(2), not_after: parent_of(2).not_after + 1 })
}

/// §12.1 Delegation: a child wider than its parent (depth).
test delegate_child_same_depth_as_parent() fail {
  sub2(DelegationDatum { ..child_of(2), depth: 1, remaining: 0 })
}

test delegate_child_depth_skips_one() fail {
  sub2(DelegationDatum { ..child_of(2), depth: 3, remaining: 0 })
}

/// §12.1 Delegation: a child wider than its parent (remaining).
test delegate_child_wider_remaining() fail {
  sub2_under(
    DelegationDatum { ..parent_of(2), remaining: 1 },
    DelegationDatum { ..child_of(2), remaining: 1 },
  )
}

test delegate_under_parent_with_no_hops_left() fail {
  sub2_under(
    DelegationDatum { ..parent_of(2), remaining: 0 },
    DelegationDatum { ..child_of(2), remaining: 0 },
  )
}

/// §12.1 Delegation: a child wider than its parent (value: no limit).
test delegate_child_without_value_limit() fail {
  sub2(DelegationDatum { ..child_of(2), value: None })
}

/// §12.1 Delegation: a child wider than its parent (value: per_tx).
test delegate_child_higher_per_tx() fail {
  sub2(
    DelegationDatum {
      ..child_of(2),
      value: Some(
        ValueLimit {
          per_tx: 101 * ap3x,
          total: 500 * ap3x,
          period_ms: 86_400_000,
        },
      ),
    },
  )
}

/// §12.1 Delegation: a child wider than its parent (value: total).
test delegate_child_higher_total() fail {
  sub2(
    DelegationDatum {
      ..child_of(2),
      value: Some(
        ValueLimit {
          per_tx: 100 * ap3x,
          total: 501 * ap3x,
          period_ms: 86_400_000,
        },
      ),
    },
  )
}

/// §12.1 Delegation: a shorter `period_ms` than the parent's.
test delegate_child_shorter_period_ms() fail {
  sub2(
    DelegationDatum {
      ..child_of(2),
      value: Some(
        ValueLimit {
          per_tx: 100 * ap3x,
          total: 500 * ap3x,
          period_ms: 86_399_999,
        },
      ),
    },
  )
}

/// §12.1 Delegation: `oc.*` treated as covering `ocr.*`.
test delegate_oc_prefix_does_not_cover_ocr() fail {
  sub2_under(
    DelegationDatum { ..parent_of(2), actions: ["oc.*"] },
    DelegationDatum { ..child_of(2), actions: ["ocr.*"] },
  )
}

/// Positive control of the test above.
test delegate_oc_prefix_covers_oc_child() {
  sub2_under(
    DelegationDatum { ..parent_of(2), actions: ["oc.*"] },
    DelegationDatum { ..child_of(2), actions: ["oc.extract.*", "oc.read"] },
  )
}

/// §12.1 Delegation: an external pattern used as a prefix.
test delegate_external_pattern_as_prefix() fail {
  sub2_under(
    DelegationDatum { ..parent_of(2), actions: ["mcp:tools.*"] },
    DelegationDatum { ..child_of(2), actions: ["mcp:tools.read"] },
  )
}

/// Positive control of the test above.
test delegate_external_pattern_exact() {
  sub2_under(
    DelegationDatum { ..parent_of(2), actions: ["mcp:tools.*"] },
    DelegationDatum { ..child_of(2), actions: ["mcp:tools.*"] },
  )
}

/// §12.1 Delegation: `period_ms = 0`.
test delegate_period_ms_zero() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum {
        ..principal_root(),
        value: Some(ValueLimit { per_tx: ap3x, total: ap3x, period_ms: 0 }),
      },
    ),
  )
}

/// §12.1 Delegation: a delegate key without the delegation purpose.
test delegate_key_without_delegation_purpose() fail {
  mint_delegate(
    delegate_tx(
      DelegationDatum {
        ..principal_root(),
        delegate_key: hash(transaction_key(1)),
      },
      records(1, 1),
      [principal, hash(transaction_key(1))],
    ),
  )
}

/// §12.1 Delegation: a delegate key that does not sign.
test delegate_key_not_signed() fail {
  mint_delegate(
    delegate_tx(
      principal_root(),
      records(1, 1),
      [principal, hash(controller_key(1))],
    ),
  )
}

/// §12.1 Delegation: a sub-delegation without the signature of the parent's
/// delegate key. The controller of the delegator agent signs instead.
test delegate_sub_without_parent_key_signature() fail {
  mint_delegate(
    sub_tx(
      2,
      parent_of(2),
      child_of(2),
      records(1, 2),
      [hash(controller_key(1)), hash(delegation_key(2))],
    ),
  )
}

/// §12.1 Delegation: a sub-delegation signed by a parent delegate key that its
/// agent removed.
test delegate_sub_parent_key_removed() fail {
  mint_delegate(
    sub_tx(
      2,
      parent_of(2),
      child_of(2),
      [
        record_input(1, without_delegation_key(agent(1))),
        record_input(2, agent(2)),
      ],
      sub_signers(2),
    ),
  )
}

/// §12.1 Delegation: a parent token from another policy.
test delegate_parent_token_from_other_policy() fail {
  let parent =
    input_at(
      201,
      address.from_script(delegation_hash),
      assets.from_lovelace(2 * ap3x)
        |> assets.add(other_hash, delegation_id(1), 1),
      parent_of(2),
    )
  mint_delegate(
    delegate_tx(child_of(2), [parent, ..records(1, 2)], sub_signers(2)),
  )
}

/// §12.1 Delegation: a parent token at another address (stake credential).
test delegate_parent_at_staked_address() fail {
  let parent =
    input_at(
      201,
      staked_script_address(delegation_hash),
      delegation_value(delegation_id(1)),
      parent_of(2),
    )
  mint_delegate(
    delegate_tx(child_of(2), [parent, ..records(1, 2)], sub_signers(2)),
  )
}

/// §12.1 Delegation: a parent token at another address (another script).
test delegate_parent_at_other_script() fail {
  let parent =
    input_at(
      201,
      address.from_script(other_hash),
      delegation_value(delegation_id(1)),
      parent_of(2),
    )
  mint_delegate(
    delegate_tx(child_of(2), [parent, ..records(1, 2)], sub_signers(2)),
  )
}

test delegate_parent_missing() fail {
  mint_delegate(delegate_tx(child_of(2), records(1, 2), sub_signers(2)))
}

/// The delegator (agent 0, Active, its record a reference input) is not the
/// delegate of the parent (agent 1).
test delegate_sub_delegator_is_not_parent_delegate() fail {
  mint_delegate(
    sub_tx(
      2,
      parent_of(2),
      DelegationDatum { ..child_of(2), delegator: agent_delegator(0) },
      records(0, 2),
      [
        hash(delegation_key(0)),
        hash(delegation_key(1)),
        hash(delegation_key(2)),
      ],
    ),
  )
}

test delegate_sub_delegator_principal_key() fail {
  sub2(DelegationDatum { ..child_of(2), delegator: principal_delegator() })
}

test delegate_sub_delegator_suspended() fail {
  mint_delegate(
    sub_tx(
      2,
      parent_of(2),
      child_of(2),
      [record_input(1, suspended(agent(1))), record_input(2, agent(2))],
      sub_signers(2),
    ),
  )
}

test delegate_principal_not_signed() fail {
  mint_delegate(
    delegate_tx(principal_root(), records(1, 1), [hash(delegation_key(1))]),
  )
}

test delegate_agent_delegator_without_signature() fail {
  mint_delegate(
    delegate_tx(
      agent_root(),
      records(0, 1),
      [hash(transaction_key(0)), hash(delegation_key(1))],
    ),
  )
}

test delegate_agent_delegator_suspended() fail {
  mint_delegate(
    delegate_tx(
      agent_root(),
      [record_input(0, suspended(agent(0))), record_input(1, agent(1))],
      [hash(controller_key(0)), hash(delegation_key(1))],
    ),
  )
}

test delegate_agent_delegator_record_missing() fail {
  mint_delegate(
    delegate_tx(
      agent_root(),
      records(1, 1),
      [hash(controller_key(0)), hash(delegation_key(1))],
    ),
  )
}

test delegate_delegate_suspended() fail {
  mint_delegate(
    delegate_tx(
      principal_root(),
      [record_input(1, suspended(agent(1)))],
      [principal, hash(delegation_key(1))],
    ),
  )
}

test delegate_delegate_revoked() fail {
  mint_delegate(
    delegate_tx(
      principal_root(),
      [record_input(1, revoked(agent(1)))],
      [principal, hash(delegation_key(1))],
    ),
  )
}

test delegate_delegate_record_missing() fail {
  mint_delegate(
    delegate_tx(principal_root(), [], [principal, hash(delegation_key(1))]),
  )
}

test delegate_root_with_depth_two() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum { ..principal_root(), depth: 2, remaining: 0 },
    ),
  )
}

test delegate_seed_not_spent() fail {
  mint_delegate(
    Transaction {
      ..principal_root_tx(principal_root()),
      inputs: [wallet_input(OutputReference { ..seed(), output_index: 2 })],
    },
  )
}

test delegate_name_not_from_seed() fail {
  let tx = principal_root_tx(principal_root())
  mint_delegate(
    Transaction {
      ..tx,
      outputs: [delegation_output(delegation_id(7), principal_root())],
      mint: assets.from_asset(delegation_hash, delegation_id(7), 1),
    },
  )
}

test delegate_mints_quantity_two() fail {
  let tx = principal_root_tx(principal_root())
  mint_delegate(
    Transaction { ..tx, mint: assets.from_asset(delegation_hash, new_id(), 2) },
  )
}

test delegate_mints_second_name() fail {
  let tx = principal_root_tx(principal_root())
  mint_delegate(
    Transaction {
      ..tx,
      mint: tx.mint |> assets.add(delegation_hash, delegation_id(7), 1),
    },
  )
}

test delegate_output_with_foreign_asset() fail {
  let tx = principal_root_tx(principal_root())
  expect [output] = tx.outputs
  mint_delegate(
    Transaction {
      ..tx,
      outputs: [
        transaction.Output {
          ..output,
          value: output.value |> assets.add(other_hash, "x", 1),
        },
      ],
    },
  )
}

test delegate_output_with_reference_script() fail {
  let tx = principal_root_tx(principal_root())
  expect [output] = tx.outputs
  mint_delegate(
    Transaction {
      ..tx,
      outputs: [
        transaction.Output { ..output, reference_script: Some(other_hash) },
      ],
    },
  )
}

test delegate_output_with_datum_hash() fail {
  let tx = principal_root_tx(principal_root())
  expect [output] = tx.outputs
  mint_delegate(
    Transaction {
      ..tx,
      outputs: [
        transaction.Output { ..output, datum: transaction.DatumHash(new_id()) },
      ],
    },
  )
}

test delegate_token_leaves_delegation_address() fail {
  let tx = principal_root_tx(principal_root())
  expect [output] = tx.outputs
  mint_delegate(
    Transaction {
      ..tx,
      outputs: [
        transaction.Output {
          ..output,
          address: staked_script_address(delegation_hash),
        },
      ],
    },
  )
}

test delegate_two_outputs_at_delegation_address() fail {
  let tx = principal_root_tx(principal_root())
  mint_delegate(
    Transaction {
      ..tx,
      outputs: [
        delegation_output(new_id(), principal_root()),
        transaction.Output {
          address: address.from_script(delegation_hash),
          value: assets.from_lovelace(2 * ap3x),
          datum: transaction.InlineDatum(principal_root()),
          reference_script: None,
        },
      ],
    },
  )
}

test delegate_invalid_action_pattern() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum { ..principal_root(), actions: ["Ocr.*"] },
    ),
  )
}

test delegate_invalid_resource_pattern() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum { ..principal_root(), resources: ["ocr.extract"] },
    ),
  )
}

test delegate_without_actions() fail {
  mint_delegate(
    principal_root_tx(DelegationDatum { ..principal_root(), actions: [] }),
  )
}

test delegate_seventeen_actions() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum {
        ..principal_root(),
        actions: [
          "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n",
          "o", "p", "q",
        ],
      },
    ),
  )
}

test delegate_nine_resources() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum {
        ..principal_root(),
        resources: [
          "*", escrow_pattern, "https://a", "https://b", "oauth:c", "mcp:d",
          "mcp:e", "mcp:f", "mcp:g",
        ],
      },
    ),
  )
}

test delegate_empty_period() fail {
  let datum = principal_root()
  mint_delegate(
    principal_root_tx(DelegationDatum { ..datum, not_after: datum.not_before }),
  )
}

test delegate_time_after_year_9999() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum { ..principal_root(), not_after: max_time_ms + 1 },
    ),
  )
}

test delegate_negative_time() fail {
  mint_delegate(
    principal_root_tx(DelegationDatum { ..principal_root(), not_before: -1 }),
  )
}

test delegate_total_above_cap() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum {
        ..principal_root(),
        value: Some(
          ValueLimit {
            per_tx: ap3x,
            total: 10_000 * ap3x + 1,
            period_ms: 86_400_000,
          },
        ),
      },
    ),
  )
}

test delegate_per_tx_above_total() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum {
        ..principal_root(),
        value: Some(
          ValueLimit { per_tx: 2 * ap3x, total: ap3x, period_ms: 86_400_000 },
        ),
      },
    ),
  )
}

test delegate_organisation_too_long() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum {
        ..principal_root(),
        delegator: PrincipalKey {
          hash: principal,
          organisation: Some(
            "did:web:organisation.example.org:units:research:agents:division10",
          ),
        },
      },
    ),
  )
}

test delegate_purpose_not_32_bytes() fail {
  mint_delegate(
    principal_root_tx(
      DelegationDatum { ..principal_root(), purpose: Some(#"00") },
    ),
  )
}

test delegate_unbounded_range() fail {
  mint_delegate(
    Transaction {
      ..principal_root_tx(principal_root()),
      validity_range: interval.everything,
    },
  )
}

test delegate_range_over_one_hour() fail {
  mint_delegate(
    Transaction {
      ..principal_root_tx(principal_root()),
      validity_range: range(1_793_577_600_000, 1_793_581_200_001),
    },
  )
}

// ## Spend

fn spent_ref(n: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"7777777777777777777777777777777777777777777777777777777777777777",
    output_index: n,
  }
}

/// Link `n` with `datum` as a spent input.
fn spent_link(n: Int, datum: DelegationDatum) -> Input {
  Input {
    output_reference: spent_ref(n),
    output: delegation_output(delegation_id(n), datum),
  }
}

fn burn(id: ByteArray) -> assets.Value {
  assets.from_asset(delegation_hash, id, -1)
}

/// An `Undelegate` transaction that spends `spent` and burns `burned`.
fn undelegate_tx(
  spent: Input,
  refs: List<Input>,
  signers: List<ByteArray>,
  burned: assets.Value,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [wallet_input(seed()), spent],
    reference_inputs: refs,
    mint: burned,
    extra_signatories: signers,
    validity_range: now(),
  }
}

fn mint_undelegate(tx: Transaction) -> Bool {
  delegation_mint(identity_hash, Undelegate, delegation_hash, tx)
}

/// Undelegate of link 1 (principal delegator), signed by the principal.
fn principal_undelegate_tx() -> Transaction {
  undelegate_tx(
    spent_link(1, principal_root()),
    [],
    [principal],
    burn(delegation_id(1)),
  )
}

test spend_undelegate_burns_own_token() {
  delegation_spend(Undelegate, spent_ref(1), principal_undelegate_tx())
}

/// §12.1 Delegation: a change to a delegation output (spend redeemer
/// `Delegate`).
test spend_rejects_delegate_redeemer() {
  !delegation_spend(
    Delegate { seed: seed() },
    spent_ref(1),
    principal_undelegate_tx(),
  )
}

/// §12.1 Delegation: a change to a delegation output (the token moves to a
/// new output with another datum, without a burn).
test spend_change_without_burn() {
  let tx =
    Transaction {
      ..principal_undelegate_tx(),
      outputs: [
        delegation_output(
          delegation_id(1),
          DelegationDatum { ..principal_root(), actions: ["*"] },
        ),
      ],
      mint: assets.zero,
    }
  !delegation_spend(Undelegate, spent_ref(1), tx)
}

test spend_burn_of_another_token() {
  let tx =
    Transaction { ..principal_undelegate_tx(), mint: burn(delegation_id(7)) }
  !delegation_spend(Undelegate, spent_ref(1), tx)
}

// ## Undelegate

test undelegate_by_principal_key() {
  mint_undelegate(principal_undelegate_tx())
}

test undelegate_by_agent_controller() {
  mint_undelegate(
    undelegate_tx(
      spent_link(1, agent_root()),
      records(0, 0),
      [hash(controller_key(0))],
      burn(delegation_id(1)),
    ),
  )
}

test undelegate_by_agent_delegation_key() {
  mint_undelegate(
    undelegate_tx(
      spent_link(1, agent_root()),
      records(0, 0),
      [hash(delegation_key(0))],
      burn(delegation_id(1)),
    ),
  )
}

/// The principal of link 1 undelegates link 3 (ancestors as reference
/// inputs).
test undelegate_by_root_principal_of_ancestor() {
  mint_undelegate(
    undelegate_tx(
      spent_link(3, child_of(3)),
      chain_inputs(2, principal_delegator()),
      [principal],
      burn(delegation_id(3)),
    ),
  )
}

/// The delegator agent of link 2 (agent 1) undelegates link 3.
test undelegate_by_ancestor_agent_controller() {
  mint_undelegate(
    undelegate_tx(
      spent_link(3, child_of(3)),
      [
        delegation_input(delegation_id(2), child_of(2)),
        record_input(1, agent(1)),
      ],
      [hash(controller_key(1))],
      burn(delegation_id(3)),
    ),
  )
}

/// A suspended or revoked delegator can still undelegate.
test undelegate_by_revoked_agent_controller() {
  mint_undelegate(
    undelegate_tx(
      spent_link(1, agent_root()),
      [record_input(0, revoked(agent(0)))],
      [hash(controller_key(0))],
      burn(delegation_id(1)),
    ),
  )
}

/// §12.1 Delegation: Undelegate by a stranger.
test undelegate_by_stranger() fail {
  mint_undelegate(
    Transaction { ..principal_undelegate_tx(), extra_signatories: [stranger] },
  )
}

test undelegate_by_delegate() fail {
  mint_undelegate(
    undelegate_tx(
      spent_link(1, principal_root()),
      records(1, 1),
      [hash(delegation_key(1)), hash(controller_key(1))],
      burn(delegation_id(1)),
    ),
  )
}

test undelegate_by_agent_key_without_delegation_purpose() fail {
  mint_undelegate(
    undelegate_tx(
      spent_link(1, agent_root()),
      records(0, 0),
      [hash(transaction_key(0))],
      burn(delegation_id(1)),
    ),
  )
}

test undelegate_agent_record_missing() fail {
  mint_undelegate(
    undelegate_tx(
      spent_link(1, agent_root()),
      [],
      [hash(controller_key(0))],
      burn(delegation_id(1)),
    ),
  )
}

test undelegate_ancestor_not_reference_input() fail {
  mint_undelegate(
    undelegate_tx(
      spent_link(3, child_of(3)),
      [delegation_input(delegation_id(2), child_of(2))],
      [principal],
      burn(delegation_id(3)),
    ),
  )
}

test undelegate_two_delegation_inputs() fail {
  let tx = principal_undelegate_tx()
  mint_undelegate(
    Transaction {
      ..tx,
      inputs: [spent_link(2, child_of(2)), ..tx.inputs],
      mint: tx.mint |> assets.add(delegation_hash, delegation_id(2), -1),
    },
  )
}

test undelegate_burns_another_token() fail {
  mint_undelegate(
    Transaction { ..principal_undelegate_tx(), mint: burn(delegation_id(7)) },
  )
}

test undelegate_burns_quantity_two() fail {
  mint_undelegate(
    Transaction {
      ..principal_undelegate_tx(),
      mint: assets.from_asset(delegation_hash, delegation_id(1), -2),
    },
  )
}

test undelegate_unbounded_range() fail {
  mint_undelegate(
    Transaction {
      ..principal_undelegate_tx(),
      validity_range: interval.everything,
    },
  )
}

test undelegate_range_over_one_hour() fail {
  mint_undelegate(
    Transaction {
      ..principal_undelegate_tx(),
      validity_range: range(1_793_577_600_000, 1_793_581_200_001),
    },
  )
}

// ## Use by a dependent contract

fn use_tx(
  refs: List<Input>,
  signers: List<ByteArray>,
  validity: ValidityRange,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    reference_inputs: refs,
    extra_signatories: signers,
    validity_range: validity,
  }
}

fn use_link(
  tx: Transaction,
  id: ByteArray,
  action: ByteArray,
  resource: ByteArray,
) -> DelegationDatum {
  use_delegation(
    tx,
    identity_hash,
    delegation_hash,
    id,
    action,
    resource,
    window(tx.validity_range),
  )
}

/// The reference inputs of the principal chain of depth 2, with the records
/// `first` (agent 1) and `second` (agent 2).
fn depth2_refs(first: IdentityDatum, second: IdentityDatum) -> List<Input> {
  [
    delegation_input(delegation_id(2), child_of(2)),
    delegation_input(delegation_id(1), child_of(1)),
    record_input(1, first),
    record_input(2, second),
  ]
}

/// Use of link 2 for the hire action and the escrow resource; the delegate
/// key of agent 2 signs.
fn use_depth2(refs: List<Input>) -> DelegationDatum {
  use_link(
    use_tx(refs, [hash(delegation_key(2))], now()),
    delegation_id(2),
    hire,
    escrow_pattern,
  )
}

/// A root delegation (link 1, principal delegator) with `datum`, used for
/// `action` and `resource`.
fn use_root(
  datum: DelegationDatum,
  action: ByteArray,
  resource: ByteArray,
) -> DelegationDatum {
  use_link(
    use_tx(
      [delegation_input(delegation_id(1), datum), ..records(1, 1)],
      [hash(delegation_key(1))],
      now(),
    ),
    delegation_id(1),
    action,
    resource,
  )
}

test use_depth_1_principal() {
  use_root(principal_root(), hire, escrow_pattern) == principal_root()
}

/// Agent 1 as a subagent of agent 5, created under the parent epoch 0.
fn subagent_1() -> IdentityDatum {
  IdentityDatum {
    ..agent(1),
    endpoint: "",
    lineage: Subagent { parent: agent_id(5), parent_epoch: 0, depth: 1 },
  }
}

/// Use of link 1 (principal delegator) whose delegate, agent 1, is the
/// subagent `subagent_1()`; `parents` are the other identity records.
fn use_by_subagent(parents: List<Input>) -> DelegationDatum {
  use_link(
    use_tx(
      [
        delegation_input(delegation_id(1), principal_root()),
        record_input(1, subagent_1()),
        ..parents
      ],
      [hash(delegation_key(1))],
      now(),
    ),
    delegation_id(1),
    hire,
    escrow_pattern,
  )
}

test use_by_subagent_delegate() {
  use_by_subagent(records(5, 5)) == principal_root()
}

/// The parent record of a subagent delegate must be a reference input.
test use_by_subagent_delegate_without_parent_record() fail {
  use_by_subagent([]) == principal_root()
}

/// A subagent delegate under an old epoch of its parent is Revoked.
test use_by_subagent_delegate_after_epoch_bump() fail {
  use_by_subagent(
    [record_input(5, IdentityDatum { ..agent(5), subagent_epoch: 1 })],
  ) == principal_root()
}

test use_depth_2_principal() {
  use_depth2(depth2_refs(agent(1), agent(2))) == child_of(2)
}

test use_depth_4_agent_root() {
  let tx =
    use_tx(chain_refs(4, agent_delegator(0)), [hash(delegation_key(4))], now())
  use_link(tx, delegation_id(4), hire, escrow_pattern) == chain_link(
    4,
    agent_delegator(0),
  )
}

test use_at_period_start() {
  let datum = principal_root()
  let tx =
    use_tx(
      [delegation_input(delegation_id(1), datum), ..records(1, 1)],
      [hash(delegation_key(1))],
      range(datum.not_before, datum.not_before + 3_600_000),
    )
  use_link(tx, delegation_id(1), hire, escrow_pattern) == datum
}

test use_at_period_end() {
  let datum = principal_root()
  let tx =
    use_tx(
      [delegation_input(delegation_id(1), datum), ..records(1, 1)],
      [hash(delegation_key(1))],
      range(datum.not_after - 3_600_000, datum.not_after),
    )
  use_link(tx, delegation_id(1), hire, escrow_pattern) == datum
}

test use_finds_delegation() {
  find_delegation(
    chain_inputs(3, principal_delegator()),
    delegation_hash,
    delegation_id(2),
  ) == Some(child_of(2))
}

/// §12.1 Delegation: use after the parent's Undelegate.
test use_after_parent_undelegate() fail {
  use_depth2(
    [
      delegation_input(delegation_id(2), child_of(2)),
      record_input(1, agent(1)),
      record_input(2, agent(2)),
    ],
  ) == child_of(2)
}

/// §12.1 Delegation: use with a delegate key that the delegate removed.
test use_with_removed_delegate_key() fail {
  use_depth2(depth2_refs(agent(1), without_delegation_key(agent(2)))) == child_of(
    2,
  )
}

/// Decision: a sub-delegation stops when the agent above it removes the key
/// that its parent delegation names.
test use_after_intermediate_key_removal() fail {
  use_depth2(depth2_refs(without_delegation_key(agent(1)), agent(2))) == child_of(
    2,
  )
}

test use_delegate_key_not_signed() fail {
  use_link(
    use_tx(depth2_refs(agent(1), agent(2)), [hash(controller_key(2))], now()),
    delegation_id(2),
    hire,
    escrow_pattern,
  ) == child_of(2)
}

test use_delegate_suspended() fail {
  use_depth2(depth2_refs(agent(1), suspended(agent(2)))) == child_of(2)
}

test use_delegate_record_missing() fail {
  use_depth2(
    [
      delegation_input(delegation_id(2), child_of(2)),
      delegation_input(delegation_id(1), child_of(1)),
      record_input(1, agent(1)),
    ],
  ) == child_of(2)
}

test use_intermediate_delegator_revoked() fail {
  use_depth2(depth2_refs(revoked(agent(1)), agent(2))) == child_of(2)
}

test use_intermediate_delegator_suspended() fail {
  use_depth2(depth2_refs(suspended(agent(1)), agent(2))) == child_of(2)
}

test use_root_agent_suspended() fail {
  let refs =
    [
      delegation_input(delegation_id(1), agent_root()),
      record_input(0, suspended(agent(0))),
      record_input(1, agent(1)),
    ]
  use_link(
    use_tx(refs, [hash(delegation_key(1))], now()),
    delegation_id(1),
    hire,
    escrow_pattern,
  ) == agent_root()
}

test use_action_not_covered() fail {
  use_root(principal_root(), "payments.send.v1", escrow_pattern) == principal_root()
}

test use_resource_not_covered() fail {
  use_root(
    principal_root(),
    hire,
    "script:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
  ) == principal_root()
}

test use_empty_resource_list() fail {
  let datum = DelegationDatum { ..principal_root(), resources: [] }
  use_root(datum, hire, escrow_pattern) == datum
}

/// §12.1 Delegation: `oc.*` treated as covering `ocr.*` (at use).
test use_oc_prefix_for_ocr_action() fail {
  let datum = DelegationDatum { ..principal_root(), actions: ["oc.*"] }
  use_root(datum, "ocr.extract", escrow_pattern) == datum
}

/// Positive control of the test above.
test use_oc_prefix_for_oc_action() {
  let datum = DelegationDatum { ..principal_root(), actions: ["oc.*"] }
  use_root(datum, "oc.extract", escrow_pattern) == datum
}

/// §12.1 Delegation: an external pattern used as a prefix (at use).
test use_external_pattern_as_prefix() fail {
  let datum = DelegationDatum { ..principal_root(), actions: ["mcp:tools.*"] }
  use_root(datum, "mcp:tools.read", escrow_pattern) == datum
}

test use_before_period() fail {
  let datum = principal_root()
  let tx =
    use_tx(
      [delegation_input(delegation_id(1), datum), ..records(1, 1)],
      [hash(delegation_key(1))],
      range(datum.not_before - 1, datum.not_before + 600_000),
    )
  use_link(tx, delegation_id(1), hire, escrow_pattern) == datum
}

test use_after_period() fail {
  let datum = principal_root()
  let tx =
    use_tx(
      [delegation_input(delegation_id(1), datum), ..records(1, 1)],
      [hash(delegation_key(1))],
      range(datum.not_after - 600_000, datum.not_after + 1),
    )
  use_link(tx, delegation_id(1), hire, escrow_pattern) == datum
}

test use_delegation_from_other_policy() fail {
  let fake =
    input_at(
      201,
      address.from_script(delegation_hash),
      assets.from_lovelace(2 * ap3x)
        |> assets.add(other_hash, delegation_id(1), 1),
      principal_root(),
    )
  use_link(
    use_tx([fake, ..records(1, 1)], [hash(delegation_key(1))], now()),
    delegation_id(1),
    hire,
    escrow_pattern,
  ) == principal_root()
}

test use_delegation_with_second_token() fail {
  let fake =
    input_at(
      201,
      address.from_script(delegation_hash),
      delegation_value(delegation_id(1))
        |> assets.add(delegation_hash, delegation_id(7), 1),
      principal_root(),
    )
  use_link(
    use_tx([fake, ..records(1, 1)], [hash(delegation_key(1))], now()),
    delegation_id(1),
    hire,
    escrow_pattern,
  ) == principal_root()
}

test use_parent_at_staked_address() fail {
  let parent =
    input_at(
      201,
      staked_script_address(delegation_hash),
      delegation_value(delegation_id(1)),
      child_of(1),
    )
  use_depth2(
    [
      delegation_input(delegation_id(2), child_of(2)),
      parent,
      record_input(1, agent(1)),
      record_input(2, agent(2)),
    ],
  ) == child_of(2)
}

test use_delegation_as_spent_input() fail {
  let tx =
    Transaction {
      ..use_tx(records(1, 1), [hash(delegation_key(1))], now()),
      inputs: [
        Input {
          output_reference: spent_ref(1),
          output: delegation_output(delegation_id(1), principal_root()),
        },
      ],
    }
  use_link(tx, delegation_id(1), hire, escrow_pattern) == principal_root()
}

test use_with_unbounded_range() fail {
  use_link(
    use_tx(
      [delegation_input(delegation_id(1), principal_root()), ..records(1, 1)],
      [hash(delegation_key(1))],
      interval.everything,
    ),
    delegation_id(1),
    hire,
    escrow_pattern,
  ) == principal_root()
}
