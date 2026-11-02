//// Delegations as reference inputs, and the checks for the use of a delegation
//// by a dependent contract: Part 2 §5.2 of `docs/IDENTITY_REGISTRY.md`.
////
//// A delegation is authentic only when it is an output at the exact
//// delegation address (`DA`: payment credential `Script(delegation_hash)`, no
//// stake credential) that holds exactly one token of the delegation policy.
//// The delegation contract checks the datum when it mints the token, and a
//// delegation output never changes. Thus an authentic delegation has a valid
//// datum, and it is narrower than its parent: its actions, resources, period
//// and value limit are inside those of the parent.

use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Input, Transaction}
use identity_marketplace/common.{Window, at_script_address, signed_by}
use identity_marketplace/delegation/pattern.{covered}
use identity_marketplace/types.{Agent, DelegationDatum, Delegator, PrincipalKey}
use vector_identity.{
  active_key, controller_signed, effective, find_record, max_depth,
  purpose_delegation,
}
use vector_identity/types.{EffActive, IdentityDatum} as identity

/// The name of the only token of `policy` in `value`, when its quantity is
/// `quantity`. Else `None` (no token, another quantity, or two or more names).
pub fn sole_token(
  value: Value,
  policy: ByteArray,
  quantity: Int,
) -> Option<ByteArray> {
  when dict.to_pairs(assets.tokens(value, policy)) is {
    [Pair(name, q)] ->
      if q == quantity {
        Some(name)
      } else {
        None
      }
    _ -> None
  }
}

/// The delegation `id`: the first input of `refs` at exactly `DA` whose value
/// holds exactly one token of the policy `delegation_hash` in total (name
/// `id`, quantity 1), with an inline datum. The datum must decode as
/// `DelegationDatum`; the function fails when it does not. Else `None`. Pass
/// the transaction's `reference_inputs` as `refs`.
pub fn find_delegation(
  refs: List<Input>,
  delegation_hash: ByteArray,
  id: ByteArray,
) -> Option<DelegationDatum> {
  when refs is {
    [] -> None
    [input, ..rest] -> {
      let output = input.output
      if and {
        at_script_address(output, delegation_hash),
        sole_token(output.value, delegation_hash, 1) == Some(id),
      } {
        when output.datum is {
          InlineDatum(data) -> {
            expect delegation: DelegationDatum = data
            Some(delegation)
          }
          _ -> find_delegation(rest, delegation_hash, id)
        }
      } else {
        find_delegation(rest, delegation_hash, id)
      }
    }
  }
}

/// True when the agent of `record` signs for a delegation: its controller
/// signs, or a listed key with the delegation purpose signs.
pub fn agent_signed(record: IdentityDatum, tx: Transaction) -> Bool {
  or {
    controller_signed(record, tx),
    list.any(
      tx.extra_signatories,
      fn(signer) { active_key(record, signer, purpose_delegation) },
    ),
  }
}

/// Use of the delegation `id` by a dependent contract (Part 2 §5.2). The
/// function fails unless all of these conditions are true:
///
/// - the delegation and every ancestor are authentic reference inputs
///   (`find_delegation`), at most `max_depth` delegations;
/// - the delegate of each delegation has effective status Active over
///   `[w.lo, w.hi]`, and `active_key(delegate, delegate_key, delegation)`
///   still holds for each delegation. The delegate of a parent is the
///   delegator agent of its child, so each delegator agent is Active;
/// - a root delegator that is an `Agent` has effective status Active;
/// - the `delegate_key` of the delegation `id` signed;
/// - a pattern of the delegation covers `action`, and a pattern covers
///   `resource` (an empty resource list covers nothing);
/// - `[w.lo, w.hi]` is inside the period of the delegation
///   (`not_before <= lo`, `hi <= not_after`).
///
/// The patterns, the period and the value limit of the delegation `id` are
/// inside those of every ancestor (see the module documentation), so the
/// coverage and the period are checked on the delegation `id` only. The
/// function returns the datum of the delegation `id`.
///
/// Pass `w = common.window(tx.validity_range)`. Every record and delegation
/// that the checks read must be a reference input, including the ancestors of
/// subagent records (`effective`).
pub fn use_delegation(
  tx: Transaction,
  identity_hash: ByteArray,
  delegation_hash: ByteArray,
  id: ByteArray,
  action: ByteArray,
  resource: ByteArray,
  w: Window,
) -> DelegationDatum {
  let refs = tx.reference_inputs
  expect Some(delegation) = find_delegation(refs, delegation_hash, id)
  expect signed_by(tx.extra_signatories, delegation.delegate_key)
  expect covered(delegation.actions, action)
  expect covered(delegation.resources, resource)
  expect delegation.not_before <= w.lo
  expect w.hi <= delegation.not_after
  expect
    links_active(delegation, refs, identity_hash, delegation_hash, w, max_depth)
  delegation
}

/// The delegate of `delegation` is Active and still lists `delegate_key` with
/// the delegation purpose; then the same for the parent, up to the root,
/// whose `Agent` delegator is Active.
fn links_active(
  delegation: DelegationDatum,
  refs: List<Input>,
  identity_hash: ByteArray,
  delegation_hash: ByteArray,
  w: Window,
  links_left: Int,
) -> Bool {
  expect links_left > 0
  expect Some(delegate) = find_record(refs, identity_hash, delegation.delegate)
  and {
    effective(delegate, refs, identity_hash, w.lo, w.hi) == EffActive,
    active_key(delegate, delegation.delegate_key, purpose_delegation),
    when delegation.parent is {
      None ->
        root_delegator_active(delegation.delegator, refs, identity_hash, w)
      Some(parent_id) -> {
        expect Some(parent) = find_delegation(refs, delegation_hash, parent_id)
        links_active(
          parent,
          refs,
          identity_hash,
          delegation_hash,
          w,
          links_left - 1,
        )
      }
    },
  }
}

fn root_delegator_active(
  delegator: Delegator,
  refs: List<Input>,
  identity_hash: ByteArray,
  w: Window,
) -> Bool {
  when delegator is {
    PrincipalKey { .. } -> True
    Agent { id } -> {
      expect Some(record) = find_record(refs, identity_hash, id)
      effective(record, refs, identity_hash, w.lo, w.hi) == EffActive
    }
  }
}
