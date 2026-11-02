//// The delegation contract: Part 2 §5.2 of `docs/IDENTITY_REGISTRY.md`.
//// `validators/delegation.ak` wires these handlers; the parameter is
//// `identity_hash`. The policy ID and the script hash are equal, and `DA` is
//// the enterprise address of that hash.
////
//// - `Delegate { seed }` mints one delegation token and writes the delegation
////   output with a checked datum.
//// - `Undelegate` burns the token of the only delegation input. Its delegator,
////   or the delegator of an ancestor, signs.
//// - The spend handler accepts only `Undelegate`, so a delegation output never
////   changes. It requires the burn of the token of the spent output, and the
////   mint handler checks the burn.

use aiken/cbor
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use identity_marketplace/common.{
  Window, ap3x_and_token, at_script_address, inline_datum, signed_by,
  single_output_at, valid_time, valid_uint, window,
}
use identity_marketplace/delegation/chain.{
  agent_signed, find_delegation, sole_token,
}
use identity_marketplace/delegation/pattern.{
  narrower, valid_action_pattern, valid_resource_pattern,
}
use identity_marketplace/types.{
  Agent, Delegate, DelegationDatum, DelegationMint, Delegator, PrincipalKey,
  Undelegate, ValueLimit,
}
use vector_identity.{
  active_key, effective, find_record, max_depth, purpose_delegation,
}
use vector_identity/types.{EffActive} as identity

/// The highest `total` (and so `per_tx`) of a value limit: 10,000 AP3X in base
/// units (1 AP3X = 1,000,000 base units).
pub const max_limit_ap3x: Int = 10_000_000_000

/// The mint handler of the delegation contract.
pub fn delegation_mint(
  identity_hash: ByteArray,
  redeemer: DelegationMint,
  policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  when redeemer is {
    Delegate { seed } -> delegate(identity_hash, seed, policy_id, tx)
    Undelegate -> undelegate(identity_hash, policy_id, tx)
  }
}

/// The spend handler of the delegation contract: only `Undelegate`, and the
/// transaction burns exactly the token of the spent output. The burn makes the
/// mint handler run, and the mint handler with `Delegate` cannot burn, so the
/// `Undelegate` rules apply.
pub fn delegation_spend(
  redeemer: DelegationMint,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  when redeemer is {
    Delegate { .. } -> False
    Undelegate -> {
      expect Some(own_input) = transaction.find_input(tx.inputs, own_ref)
      expect Script(own_hash) = own_input.output.address.payment_credential
      expect Some(id) = sole_token(own_input.output.value, own_hash, 1)
      sole_token(tx.mint, own_hash, -1) == Some(id)
    }
  }
}

/// True when the datum follows the datum comments of §5.2 and the patterns
/// follow §5.1: delegator key hash 28 bytes, organisation 1..64 bytes, agent,
/// parent and delegate identifiers 32 bytes, `delegate_key` 28 bytes, 1..16
/// action patterns, 0..8 resource patterns, valid times with
/// `not_before < not_after`, `depth` 1..4, `remaining >= 0`,
/// `depth + remaining <= 4`, `purpose` 32 bytes, and a valid value limit.
pub fn valid_delegation(delegation: DelegationDatum) -> Bool {
  and {
    valid_delegator(delegation.delegator),
    optional_length(delegation.parent, 32),
    bytearray.length(delegation.delegate) == 32,
    bytearray.length(delegation.delegate_key) == 28,
    count_within(delegation.actions, 1, 16),
    list.all(delegation.actions, valid_action_pattern),
    count_within(delegation.resources, 0, 8),
    list.all(delegation.resources, valid_resource_pattern),
    valid_time(delegation.not_before),
    valid_time(delegation.not_after),
    delegation.not_before < delegation.not_after,
    delegation.depth >= 1,
    delegation.remaining >= 0,
    delegation.depth + delegation.remaining <= max_depth,
    optional_length(delegation.purpose, 32),
    when delegation.value is {
      None -> True
      Some(limit) -> valid_limit(limit)
    },
  }
}

/// `1 <= period_ms < 2^63` and `0 <= per_tx <= total <= 10,000 AP3X`.
pub fn valid_limit(limit: ValueLimit) -> Bool {
  and {
    limit.per_tx >= 0,
    limit.per_tx <= limit.total,
    limit.total <= max_limit_ap3x,
    limit.period_ms >= 1,
    valid_uint(limit.period_ms),
  }
}

// ## Delegate

fn delegate(
  identity_hash: ByteArray,
  seed: OutputReference,
  policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  let w = window(tx.validity_range)
  let id = blake2b_256(cbor.serialise(seed))
  let output = single_output_at(tx.outputs, address.from_script(policy_id))
  expect delegation: DelegationDatum = inline_datum(output)
  let refs = tx.reference_inputs
  expect Some(delegate) = find_record(refs, identity_hash, delegation.delegate)
  and {
    list.any(tx.inputs, fn(input) { input.output_reference == seed }),
    sole_token(tx.mint, policy_id, 1) == Some(id),
    ap3x_and_token(output.value, policy_id, id),
    output.reference_script == None,
    valid_delegation(delegation),
    effective(delegate, refs, identity_hash, w.lo, w.hi) == EffActive,
    active_key(delegate, delegation.delegate_key, purpose_delegation),
    signed_by(tx.extra_signatories, delegation.delegate_key),
    when delegation.parent is {
      None -> root_authorised(delegation, identity_hash, tx, w)
      Some(parent_id) ->
        sub_authorised(delegation, parent_id, identity_hash, policy_id, tx, w)
    },
  }
}

/// A delegation without a parent: `depth = 1`, and a `PrincipalKey` signs, or
/// the `Agent` is Active and its controller or a listed key with the
/// delegation purpose signs.
fn root_authorised(
  delegation: DelegationDatum,
  identity_hash: ByteArray,
  tx: Transaction,
  w: Window,
) -> Bool {
  delegation.depth == 1 && when delegation.delegator is {
    PrincipalKey { hash, .. } -> signed_by(tx.extra_signatories, hash)
    Agent { id } -> {
      let refs = tx.reference_inputs
      expect Some(record) = find_record(refs, identity_hash, id)
      and {
        effective(record, refs, identity_hash, w.lo, w.hi) == EffActive,
        agent_signed(record, tx),
      }
    }
  }
}

/// A delegation with a parent: the authentic parent is a reference input, its
/// delegate is the delegator agent, its `remaining >= 1`, and its
/// `delegate_key` signs and is still a delegation key of that agent, which is
/// Active. The child is narrower than the parent.
fn sub_authorised(
  delegation: DelegationDatum,
  parent_id: ByteArray,
  identity_hash: ByteArray,
  policy_id: PolicyId,
  tx: Transaction,
  w: Window,
) -> Bool {
  let refs = tx.reference_inputs
  expect Some(parent) = find_delegation(refs, policy_id, parent_id)
  expect Agent { id } = delegation.delegator
  expect Some(record) = find_record(refs, identity_hash, id)
  and {
    parent.delegate == id,
    parent.remaining >= 1,
    signed_by(tx.extra_signatories, parent.delegate_key),
    effective(record, refs, identity_hash, w.lo, w.hi) == EffActive,
    active_key(record, parent.delegate_key, purpose_delegation),
    narrower(delegation.actions, parent.actions),
    narrower(delegation.resources, parent.resources),
    parent.not_before <= delegation.not_before,
    delegation.not_after <= parent.not_after,
    delegation.depth == parent.depth + 1,
    delegation.remaining <= parent.remaining - 1,
    value_within(delegation.value, parent.value),
  }
}

/// When the parent has a value limit, the child has one with `per_tx` and
/// `total` at most the parent's values and `period_ms` at least the parent's.
fn value_within(child: Option<ValueLimit>, parent: Option<ValueLimit>) -> Bool {
  when parent is {
    None -> True
    Some(p) ->
      when child is {
        None -> False
        Some(c) -> and {
            c.per_tx <= p.per_tx,
            c.total <= p.total,
            c.period_ms >= p.period_ms,
          }
      }
  }
}

// ## Undelegate

fn undelegate(
  identity_hash: ByteArray,
  policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  let w = window(tx.validity_range)
  expect [input] =
    list.filter(
      tx.inputs,
      fn(input) { input.output.address.payment_credential == Script(policy_id) },
    )
  expect Some(id) = sole_token(input.output.value, policy_id, 1)
  expect delegation: DelegationDatum = inline_datum(input.output)
  and {
    // Uses `w` before the other conditions, so the window rule of §5.2
    // (finite bounds, `hi - lo <= 1 hour`) holds for every Undelegate.
    w.lo <= w.hi,
    at_script_address(input.output, policy_id),
    sole_token(tx.mint, policy_id, -1) == Some(id),
    revoker_signed(delegation, identity_hash, policy_id, tx, max_depth),
  }
}

/// True when the delegator of `delegation` signs, or the delegator of an
/// ancestor (the ancestors are authentic reference inputs).
fn revoker_signed(
  delegation: DelegationDatum,
  identity_hash: ByteArray,
  policy_id: PolicyId,
  tx: Transaction,
  links_left: Int,
) -> Bool {
  if delegator_signed(delegation.delegator, identity_hash, tx) {
    True
  } else {
    when delegation.parent is {
      None -> False
      Some(parent_id) ->
        links_left > 1 && when
          find_delegation(tx.reference_inputs, policy_id, parent_id)
        is {
          Some(parent) ->
            revoker_signed(parent, identity_hash, policy_id, tx, links_left - 1)
          None -> False
        }
    }
  }
}

/// A `PrincipalKey` signs, or the agent's controller or a listed key with the
/// delegation purpose signs (the agent's record is a reference input).
fn delegator_signed(
  delegator: Delegator,
  identity_hash: ByteArray,
  tx: Transaction,
) -> Bool {
  when delegator is {
    PrincipalKey { hash, .. } -> signed_by(tx.extra_signatories, hash)
    Agent { id } ->
      when find_record(tx.reference_inputs, identity_hash, id) is {
        Some(record) -> agent_signed(record, tx)
        None -> False
      }
  }
}

// ## Internal helpers

fn valid_delegator(delegator: Delegator) -> Bool {
  when delegator is {
    PrincipalKey { hash, organisation } ->
      bytearray.length(hash) == 28 && when organisation is {
        None -> True
        Some(name) -> {
          let n = bytearray.length(name)
          n >= 1 && n <= 64
        }
      }
    Agent { id } -> bytearray.length(id) == 32
  }
}

fn optional_length(bytes: Option<ByteArray>, n: Int) -> Bool {
  when bytes is {
    None -> True
    Some(b) -> bytearray.length(b) == n
  }
}

fn count_within(items: List<a>, min: Int, max: Int) -> Bool {
  let n = list.length(items)
  n >= min && n <= max
}
