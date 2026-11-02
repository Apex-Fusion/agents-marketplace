//// Spend rules of the identity contract: Part 2 §3.5–§3.7
//// (`docs/IDENTITY_REGISTRY.md`).

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use identity_marketplace/common.{
  Window, count_inputs_with_script, key_signed, single_output_at, value_kept,
  window,
}
use identity_marketplace/config/record.{module1}
use identity_marketplace/identity/rules.{
  IdentityParams, covers, eligible_guardian, guardian_bound, has_right,
  invalid_from_ok, kept_holds, reason_ok, record_output, revoke_reasons,
  signer_ok, successor_ok, suspend_reasons, terminal, tombstone,
}
use vector_identity.{days_30_ms, days_7_ms, right_revoke, right_suspend}
use vector_identity/redeemers.{
  Actor, BumpEpoch, ByController, ByParty, ChangeController, IdentitySpend,
  Reclaim, RecoverCancel, RecoverFinalize, RecoverInit, Retire, Revoke,
  SetSuccessor, Suspend, Unsuspend, Update,
}
use vector_identity/types.{
  Active, ControllerSet, Ed25519, Hold, IdentityDatum, Key, P256, Party,
  PendingRecovery, Retired, Revoked, Signer, Status, Suspended,
}

/// The spend handler of the `identity` validator for the input `own_ref`.
///
/// For every spend (Part 2 §3.5): the validity window is finite and at most
/// one hour long; the spent input is at the exact identity address and holds
/// exactly one token `(own hash, id)`, `D` is its inline datum, and no other
/// input has payment credential `Script(own hash)`; nothing of the own policy
/// is minted or burned; exactly one output is at the identity address, a
/// record output for `id` with datum `D'`; a terminal `D` allows only
/// `Reclaim` and `SetSuccessor`. Each action then checks its row of the §3.5
/// table, and every field that it does not change stays the same.
pub fn spend_ok(
  params: IdentityParams,
  redeemer: IdentitySpend,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  let Window { lo, hi } = window(tx.validity_range)
  expect Some(own_input) = transaction.find_input(tx.inputs, own_ref)
  let input = own_input.output
  expect Address {
    payment_credential: address.Script(own),
    stake_credential: None,
  } = input.address
  expect [Pair(id, 1)] = dict.to_pairs(assets.tokens(input.value, own))
  expect InlineDatum(data) = input.datum
  expect record: IdentityDatum = data
  let m1 =
    module1(tx.reference_inputs, params.config_policy, params.config_holder)
  let output = single_output_at(tx.outputs, address.from_script(own))
  let next = record_output(output, own, id, m1)
  let signatories = tx.extra_signatories
  let controller_signed = key_signed(signatories, record.controller)
  let ok =
    fn(signer: Signer) {
      signer_ok(signer, signatories, record.controller, m1, tx.withdrawals)
    }
  let live = !terminal(record.status)
  let kept =
    fn() { value_kept(input.value, output.value) }
  // The rules for every spend are checked before the action branch, so the
  // optimizer cannot move them into some branches only.
  and {
    (lo <= hi)?,
    (count_inputs_with_script(tx.inputs, own) == 1)?,
    dict.is_empty(assets.tokens(tx.mint, own))?,
    (next.created_at == record.created_at)?,
    when redeemer is {
      Update -> and {
          live?,
          controller_signed?,
          update_ok(record, next, lo, hi, signatories, ok),
        }
      ChangeController -> and {
          live?,
          controller_signed?,
          key_signed(signatories, next.controller)?,
          (next == IdentityDatum {
            ..record,
            controller: next.controller,
            subagent_epoch: record.subagent_epoch + 1,
            pending_recovery: None,
          })?,
        }
      Suspend { actor } -> and {
          live?,
          suspend_ok(record, next, actor, lo, hi, m1, controller_signed, ok),
          kept()?,
        }
      Unsuspend { author } -> and {
          live?,
          unsuspend_ok(record, next, author, lo, ok),
          kept()?,
        }
      Revoke { actor } -> and {
          live?,
          revoke_ok(
            record,
            next,
            actor,
            id,
            own,
            lo,
            hi,
            m1,
            controller_signed,
            ok,
            tx,
          ),
          kept()?,
        }
      Retire -> {
        expect Retired { at, successor } = next.status
        and {
          live?,
          controller_signed?,
          (at == lo)?,
          when successor is {
            None -> True
            Some(s) ->
              successor_ok(s, id, own, tx.reference_inputs, signatories)?
          },
          (next == tombstone(record, next.status))?,
        }
      }
      Reclaim -> and {
          (!live)?,
          controller_signed?,
          (next == record)?,
        }
      SetSuccessor -> {
        expect Some(s) = successor_of(next.status)
        and {
          (!live)?,
          controller_signed?,
          (successor_of(record.status) == None)?,
          (next == IdentityDatum {
            ..record,
            status: with_successor(record.status, s),
          })?,
          successor_ok(s, id, own, tx.reference_inputs, signatories)?,
          kept()?,
        }
      }
      BumpEpoch -> and {
          live?,
          controller_signed?,
          (next == IdentityDatum {
            ..record,
            subagent_epoch: record.subagent_epoch + 1,
          })?,
        }
      RecoverInit { guardians } -> {
        expect Some(PendingRecovery { new_controller, effective_after }) =
          next.pending_recovery
        and {
          live?,
          (record.pending_recovery == None)?,
          (record.guardian_threshold >= 1)?,
          guardians_ok(
            guardians,
            record.parties,
            record.guardian_threshold,
            lo,
            hi,
            ok,
          ),
          (effective_after == hi + days_7_ms)?,
          key_signed(signatories, new_controller)?,
          (next == IdentityDatum {
            ..record,
            pending_recovery: next.pending_recovery,
          })?,
          kept()?,
        }
      }
      RecoverCancel { guardians } -> and {
          live?,
          (record.pending_recovery != None)?,
          guardians_ok(
            guardians,
            record.parties,
            record.guardian_threshold,
            lo,
            hi,
            ok,
          ),
          (next == IdentityDatum { ..record, pending_recovery: None })?,
          kept()?,
        }
      RecoverFinalize -> {
        expect Some(PendingRecovery { new_controller, effective_after }) =
          record.pending_recovery
        and {
          live?,
          (effective_after <= lo)?,
          (next == IdentityDatum {
            ..record,
            controller: new_controller,
            pending_recovery: None,
            subagent_epoch: record.subagent_epoch + 1,
          })?,
          kept()?,
        }
      }
    },
  }
}

// ## Update (§3.6)

/// The Update rules of Part 2 §3.6 for `D = record` and `D' = next`.
fn update_ok(
  record: IdentityDatum,
  next: IdentityDatum,
  lo: Int,
  hi: Int,
  signatories: List<VerificationKeyHash>,
  ok: fn(Signer) -> Bool,
) -> Bool {
  and {
    (next.controller == record.controller)?,
    (next.lineage == record.lineage)?,
    (next.subagent_epoch == record.subagent_epoch)?,
    (next.created_at == record.created_at)?,
    (next.status == record.status)?,
    // A threshold of 0 clears a pending recovery (the valid datum requires
    // it); no other Update changes it.
    (next.guardian_threshold == 0 || next.pending_recovery == record.pending_recovery)?,
    keys_ok(record.keys, next.keys, signatories)?,
    matched_parties_ok(next.parties, record.parties, -1, False, hi, ok)?,
    removed_parties_ok(record.parties, next.parties, lo, ok)?,
    or {
      and {
        next.parties == record.parties,
        next.guardian_threshold == record.guardian_threshold,
      },
      guardian_bound(next, hi)?,
    },
  }
}

/// Keys: a kept key (same key bytes) keeps its type, purposes and proof. Each
/// new Ed25519 key signs. Each new P-256 key carries `pop` (the valid datum
/// checks its length). Any key can leave the list.
fn keys_ok(
  old: List<Key>,
  new: List<Key>,
  signatories: List<VerificationKeyHash>,
) -> Bool {
  list.all(
    new,
    fn(key) {
      when list.find(old, fn(other) { other.key == key.key }) is {
        Some(other) -> other == key
        None ->
          when key.key_type is {
            Ed25519 -> key_signed(signatories, key.key)
            P256 -> key.pop != None
          }
      }
    },
  )
}

/// Parties of `D'` in order. A party is matched to the party of `D` with the
/// same role and signer. Matched parties keep their order (strictly
/// increasing index in `D`), and new parties come last. A matched party is
/// equal to its match, or differs only by a removal notice of at least 7 days
/// from `hi`, or signs. A new party signs (appointment).
fn matched_parties_ok(
  new: List<Party>,
  old: List<Party>,
  last: Int,
  appointed: Bool,
  hi: Int,
  ok: fn(Signer) -> Bool,
) -> Bool {
  when new is {
    [] -> True
    [party, ..rest] ->
      when find_match(old, party, 0) is {
        Some((index, match)) -> and {
            !appointed,
            index > last,
            party == match || notice_given(match, party, hi) || ok(party.signer),
            matched_parties_ok(rest, old, index, False, hi, ok),
          }
        None -> and {
            ok(party.signer),
            matched_parties_ok(rest, old, last, True, hi, ok),
          }
      }
  }
}

/// Each party of `D` without a match in `D'` signs, or its removal notice
/// has passed (`removal_after = Some(t)` with `t <= lo`).
fn removed_parties_ok(
  old: List<Party>,
  new: List<Party>,
  lo: Int,
  ok: fn(Signer) -> Bool,
) -> Bool {
  list.all(
    old,
    fn(party) {
      or {
        list.any(new, fn(other) { same_party(other, party) }),
        when party.removal_after is {
          Some(t) -> t <= lo
          None -> False
        },
        ok(party.signer),
      }
    },
  )
}

fn same_party(left: Party, right: Party) -> Bool {
  left.role == right.role && left.signer == right.signer
}

/// The index and the party of `old` with the same role and signer as `party`.
fn find_match(
  old: List<Party>,
  party: Party,
  index: Int,
) -> Option<(Int, Party)> {
  when old is {
    [] -> None
    [other, ..rest] ->
      if same_party(other, party) {
        Some((index, other))
      } else {
        find_match(rest, party, index + 1)
      }
  }
}

/// `party` equals `match` except that `removal_after` goes from empty to
/// `Some(t)` with `t >= hi + 7 days`.
fn notice_given(match: Party, party: Party, hi: Int) -> Bool {
  when (match.removal_after, party.removal_after) is {
    (None, Some(t)) -> and {
        t >= hi + days_7_ms,
        party == Party { ..match, removal_after: party.removal_after },
      }
    _ -> False
  }
}

// ## Holds (§3.5 Suspend and Unsuspend)

/// `Suspend { actor }`. `ByController`: the controller signs; the author is
/// `ControllerSet`. `ByParty { index }`: that party has the suspend right,
/// covers and signs; the author is its signer. `D'.status` is `Suspended`
/// with the holds of `D` that `kept_holds` keeps, then the new hold
/// `{ by: author, reason, since: lo, until }` with `hi < until <= lo + 30 days`
/// and an allowed reason.
fn suspend_ok(
  record: IdentityDatum,
  next: IdentityDatum,
  actor: Actor,
  lo: Int,
  hi: Int,
  m1: Option<ByteArray>,
  controller_signed: Bool,
  ok: fn(Signer) -> Bool,
) -> Bool {
  let (author, authorised) =
    acting(record, actor, right_suspend, lo, hi, controller_signed, ok)
  expect Suspended { holds } = next.status
  expect Some(hold) = list.last(holds)
  and {
    authorised?,
    (hold.by == author)?,
    (hold.since == lo)?,
    (hold.until > hi)?,
    (hold.until <= lo + days_30_ms)?,
    reason_ok(hold.reason, suspend_reasons, author, m1)?,
    (holds == list.concat(
      kept_holds(holds_of(record.status), record.parties, lo, author),
      [hold],
    ))?,
    (next == IdentityDatum { ..record, status: next.status })?,
  }
}

/// `Unsuspend { author }`. `D` has a hold by `author`, and `ok(author)`.
/// `D'.status` keeps the holds of `D` that `kept_holds` keeps; it is `Active`
/// when none remains.
fn unsuspend_ok(
  record: IdentityDatum,
  next: IdentityDatum,
  author: Signer,
  lo: Int,
  ok: fn(Signer) -> Bool,
) -> Bool {
  let holds = holds_of(record.status)
  let status =
    when kept_holds(holds, record.parties, lo, author) is {
      [] -> Active
      remaining -> Suspended { holds: remaining }
    }
  and {
    list.any(holds, fn(hold) { hold.by == author })?,
    ok(author)?,
    (next == IdentityDatum { ..record, status })?,
  }
}

fn holds_of(status: Status) -> List<Hold> {
  when status is {
    Suspended { holds } -> holds
    _ -> []
  }
}

// ## Revoke (§3.5, §3.7)

/// `Revoke { actor }`. `ByController`: the controller signs, `by =
/// ControllerSet`, a successor is allowed. `ByParty { index }`: the revoke
/// right, `covers`, `ok(signer)`, `by = signer`, no successor. `D'` is the
/// tombstone of `D` with `Revoked { by, reason, at: lo, invalid_from,
/// successor }`, an allowed reason and a valid `invalid_from`.
fn revoke_ok(
  record: IdentityDatum,
  next: IdentityDatum,
  actor: Actor,
  id: ByteArray,
  own: ByteArray,
  lo: Int,
  hi: Int,
  m1: Option<ByteArray>,
  controller_signed: Bool,
  ok: fn(Signer) -> Bool,
  tx: Transaction,
) -> Bool {
  let (author, authorised) =
    acting(record, actor, right_revoke, lo, hi, controller_signed, ok)
  expect Revoked { by, reason, at, invalid_from, successor } = next.status
  and {
    authorised?,
    (by == author)?,
    (at == lo)?,
    reason_ok(reason, revoke_reasons, author, m1)?,
    invalid_from_ok(invalid_from, reason, record.created_at, lo)?,
    when successor is {
      None -> True
      Some(s) -> and {
          (actor == ByController)?,
          successor_ok(s, id, own, tx.reference_inputs, tx.extra_signatories)?,
        }
    },
    (next == tombstone(record, next.status))?,
  }
}

/// The author of a `Suspend` or a `Revoke` and whether it may act.
/// `ByController`: `ControllerSet`, when the controller signs. `ByParty`: the
/// party's signer, when the party has `right`, covers `[lo, hi]` and
/// `ok(signer)`.
fn acting(
  record: IdentityDatum,
  actor: Actor,
  right: Int,
  lo: Int,
  hi: Int,
  controller_signed: Bool,
  ok: fn(Signer) -> Bool,
) -> (Signer, Bool) {
  when actor is {
    ByController -> (ControllerSet, controller_signed)
    ByParty { index } -> {
      expect Some(party) = list.at(record.parties, index)
      (party.signer, and {
          has_right(party.rights, right),
          covers(party, lo, hi),
          ok(party.signer),
        })
    }
  }
}

// ## Successors (§3.7)

fn successor_of(status: Status) -> Option<ByteArray> {
  when status is {
    Revoked { successor, .. } -> successor
    Retired { successor, .. } -> successor
    _ -> None
  }
}

fn with_successor(status: Status, s: ByteArray) -> Status {
  when status is {
    Revoked { by, reason, at, invalid_from, .. } ->
      Revoked { by, reason, at, invalid_from, successor: Some(s) }
    Retired { at, .. } -> Retired { at, successor: Some(s) }
    _ -> fail @"not a tombstone"
  }
}

// ## Recovery (§3.5)

/// `guardians` holds indices of eligible guardians (role Guardian, the recover
/// right, `covers`) with distinct signers, at least `threshold` of them, and
/// each signs. Distinct signers also make the indices distinct.
fn guardians_ok(
  indices: List<Int>,
  parties: List<Party>,
  threshold: Int,
  lo: Int,
  hi: Int,
  ok: fn(Signer) -> Bool,
) -> Bool {
  let chosen =
    list.map(
      indices,
      fn(index) {
        expect Some(party) = list.at(parties, index)
        party
      },
    )
  and {
    (list.length(chosen) >= threshold)?,
    list.all(
      chosen,
      fn(party) { eligible_guardian(party, lo, hi) && ok(party.signer) },
    )?,
    distinct_signers(chosen)?,
  }
}

fn distinct_signers(parties: List<Party>) -> Bool {
  when parties is {
    [] -> True
    [party, ..rest] -> and {
        !list.any(rest, fn(other) { other.signer == party.signer }),
        distinct_signers(rest),
      }
  }
}
