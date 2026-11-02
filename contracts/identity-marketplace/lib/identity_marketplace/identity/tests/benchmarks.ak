//// Benchmarks (Part 2 §12.4): the largest record (8 keys, 8 parties, 10
//// holds, 16 capabilities, the longest profile) through every identity
//// action, and a depth-4 subagent Register with its ancestors.
////
//// The fixtures are module constants, which the compiler evaluates at build
//// time, so the reported budgets cover the handler and almost nothing else.
//// Run `aiken check -t silent --plain-numbers -m "identity_marketplace/identity/tests/benchmarks.{..}"`
//// for numbers without trace overhead.

use aiken/cbor
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use cardano/transaction.{Transaction}
use identity_marketplace/identity/allowlist
use identity_marketplace/identity/kit.{
  bytes, controller, eight_keys_signers, full_party, hash, hi, largest,
  largest_guarded, legacy_owner, lo, module1, new_controller, other_controller,
  pkh, record_input, register_tx, signer, spend_tx, successor_id, tombstone,
  with_module1, with_refs,
}
use identity_marketplace/identity/mint.{mint_ok}
use identity_marketplace/identity/rules.{IdentityParams}
use identity_marketplace/identity/spend.{spend_ok}
use vector_identity.{day_ms, days_7_ms}
use vector_identity/redeemers.{
  Adopt, BumpEpoch, ByController, ByParty, ChangeController, IdentitySpend,
  Reclaim, RecoverCancel, RecoverFinalize, RecoverInit, Register, Retire, Revoke,
  SetSuccessor, Suspend, Unsuspend, Update,
}
use vector_identity/types.{
  Active, ControllerSet, Hold, IdentityDatum, Party, PendingRecovery, Provider,
  Retired, Revoked, Signer, Subagent, Suspended,
}

// ## Fixtures

const params: IdentityParams = kit.params()

const big: IdentityDatum = largest()

const guarded: IdentityDatum = largest_guarded()

/// The signers of every key and key party of `largest()`.
const all_signers: List<ByteArray> =
  list.concat(
    [hash(controller), ..eight_keys_signers()],
    [pkh(1), pkh(2), pkh(3), pkh(4), pkh(5), pkh(6), pkh(7)],
  )

/// A live root record with the longest profile that serves as successor.
const successor: IdentityDatum =
  IdentityDatum { ..big, controller: other_controller, status: Active }

fn holds_without(by: Signer) -> List<Hold> {
  list.filter(kit.largest_holds(), fn(h) { h.by != by && h.by != signer(8) })
}

fn with_successor_ref(tx: Transaction) -> Transaction {
  kit.signed_also(
    with_refs(tx, [record_input(30, successor_id, successor)]),
    [hash(other_controller)],
  )
}

// ### Register and Adopt

/// The largest record at creation: Active, `created_at = hi`.
const new_big: IdentityDatum =
  IdentityDatum { ..big, created_at: hi, status: Active }

const register_big_tx: Transaction =
  with_module1(register_tx(new_big, all_signers))

/// A proof of 13 nodes (an allowlist of up to 8,192 identifiers).
const long_proof: List<ByteArray> =
  list.map(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    fn(n) { blake2b_256(bytearray.push(bytes(31, 0x70), n)) },
  )

const adopt_params: IdentityParams =
  IdentityParams {
    ..params,
    legacy_root: list.foldl(
      long_proof,
      blake2b_256(kit.adopt_id),
      fn(s, x) { allowlist.node(x, s) },
    ),
  }

const adopt_big_tx: Transaction =
  with_module1(kit.adopt_tx(new_big, [legacy_owner(), ..all_signers]))

// ### Spends of the largest record

const update_next: IdentityDatum =
  IdentityDatum {
    ..big,
    description: bytes(256, 0x44),
    keys: [
      kit.ed(1, 27),
      kit.ed(2, 27),
      kit.ed(3, 27),
      kit.ed(4, 27),
      kit.ed(6, 27),
      kit.p256(1, 3),
      kit.p256(2, 3),
      kit.p256(3, 3),
    ],
    parties: list.concat(
      list.take(kit.largest_parties(), 7),
      [
        Party {
          ..full_party(Provider, signer(7), 1, False),
          removal_after: Some(hi + days_7_ms + day_ms),
        },
      ],
    ),
  }

const update_tx: Transaction =
  spend_tx(big, update_next, [hash(controller), hash(kit.ed_key(6))])

const change_controller_tx: Transaction =
  spend_tx(
    big,
    IdentityDatum { ..big, controller: new_controller, subagent_epoch: 1 },
    [hash(controller), hash(new_controller)],
  )

const suspend_tx: Transaction =
  spend_tx(
    big,
    IdentityDatum {
      ..big,
      status: Suspended {
        holds: list.concat(
          holds_without(signer(1)),
          [
            Hold {
              by: signer(1),
              reason: 9,
              since: lo,
              until: lo + 30 * day_ms,
            },
          ],
        ),
      },
    },
    [pkh(1)],
  )

const suspend_module1_tx: Transaction =
  with_module1(
    spend_tx(
      big,
      IdentityDatum {
        ..big,
        status: Suspended {
          holds: list.concat(
            holds_without(module1()),
            [
              Hold {
                by: module1(),
                reason: 64,
                since: lo,
                until: lo + 30 * day_ms,
              },
            ],
          ),
        },
      },
      [],
    ),
  )

const unsuspend_tx: Transaction =
  spend_tx(
    big,
    IdentityDatum {
      ..big,
      status: Suspended { holds: holds_without(signer(1)) },
    },
    [pkh(1)],
  )

const revoke_tx: Transaction =
  with_successor_ref(
    spend_tx(
      big,
      tombstone(
        big,
        Revoked {
          by: ControllerSet,
          reason: 1,
          at: lo,
          invalid_from: Some(lo),
          successor: Some(successor_id),
        },
      ),
      [hash(controller)],
    ),
  )

const revoke_module1_tx: Transaction =
  with_module1(
    spend_tx(
      big,
      tombstone(
        big,
        Revoked {
          by: module1(),
          reason: 64,
          at: lo,
          invalid_from: None,
          successor: None,
        },
      ),
      [],
    ),
  )

const retire_tx: Transaction =
  with_successor_ref(
    spend_tx(
      big,
      tombstone(big, Retired { at: lo, successor: Some(successor_id) }),
      [hash(controller)],
    ),
  )

const ended: IdentityDatum =
  tombstone(
    big,
    Revoked {
      by: signer(1),
      reason: 3,
      at: lo - day_ms,
      invalid_from: None,
      successor: None,
    },
  )

const reclaim_tx: Transaction =
  kit.output_ap3x(spend_tx(ended, ended, [hash(controller)]), 1_500_000)

const set_successor_tx: Transaction =
  with_successor_ref(
    spend_tx(
      ended,
      IdentityDatum {
        ..ended,
        status: Revoked {
          by: signer(1),
          reason: 3,
          at: lo - day_ms,
          invalid_from: None,
          successor: Some(successor_id),
        },
      },
      [hash(controller)],
    ),
  )

const bump_tx: Transaction =
  spend_tx(big, IdentityDatum { ..big, subagent_epoch: 1 }, [hash(controller)])

const pending: Option<PendingRecovery> =
  Some(PendingRecovery { new_controller, effective_after: hi + days_7_ms })

const recover_init_tx: Transaction =
  spend_tx(
    guarded,
    IdentityDatum { ..guarded, pending_recovery: pending },
    [pkh(11), pkh(12), pkh(13), hash(new_controller)],
  )

const guarded_pending: IdentityDatum =
  IdentityDatum {
    ..guarded,
    pending_recovery: Some(
      PendingRecovery { new_controller, effective_after: lo },
    ),
  }

const recover_cancel_tx: Transaction =
  spend_tx(guarded_pending, guarded, [pkh(11), pkh(12), pkh(13)])

const recover_finalize_tx: Transaction =
  spend_tx(
    guarded_pending,
    IdentityDatum { ..guarded, controller: new_controller, subagent_epoch: 1 },
    [],
  )

// ### Depth-4 subagent with its ancestors

fn ancestor_id(n: Int) -> ByteArray {
  kit.chain_id(n)
}

/// An ancestor at `depth` (0 = root): the largest record with lapsed holds,
/// controlled by `other_controller`.
fn ancestor(depth: Int) -> IdentityDatum {
  let lapsed =
    list.map(
      kit.largest_holds(),
      fn(h) { Hold { ..h, since: lo - 8 * day_ms, until: lo - day_ms } },
    )
  let base =
    IdentityDatum {
      ..big,
      controller: other_controller,
      status: Suspended { holds: lapsed },
    }
  if depth == 0 {
    base
  } else {
    IdentityDatum {
      ..base,
      endpoint: "",
      lineage: Subagent {
        parent: ancestor_id(depth - 1),
        parent_epoch: 0,
        depth,
      },
    }
  }
}

const subagent_tx: Transaction =
  with_refs(
    with_module1(
      register_tx(
        IdentityDatum {
          ..new_big,
          endpoint: "",
          lineage: Subagent {
            parent: ancestor_id(3),
            parent_epoch: 0,
            depth: 4,
          },
        },
        [hash(other_controller), ..all_signers],
      ),
    ),
    [
      record_input(13, ancestor_id(3), ancestor(3)),
      record_input(12, ancestor_id(2), ancestor(2)),
      record_input(11, ancestor_id(1), ancestor(1)),
      record_input(10, ancestor_id(0), ancestor(0)),
    ],
  )

// ## Benchmarks

fn spend(redeemer: IdentitySpend, tx: Transaction) -> Bool {
  spend_ok(params, redeemer, kit.record_ref(), tx)
}

test bench_register_largest() {
  mint_ok(params, Register { seed: kit.seed() }, kit.own, register_big_tx)
}

test bench_adopt_largest() {
  mint_ok(adopt_params, Adopt { proof: long_proof }, kit.own, adopt_big_tx)
}

test bench_register_subagent_depth_4() {
  mint_ok(params, Register { seed: kit.seed() }, kit.own, subagent_tx)
}

test bench_update_largest() {
  spend(Update, update_tx)
}

test bench_change_controller_largest() {
  spend(ChangeController, change_controller_tx)
}

test bench_suspend_largest() {
  spend(Suspend { actor: ByParty { index: 1 } }, suspend_tx)
}

test bench_suspend_by_module1_largest() {
  spend(Suspend { actor: ByParty { index: 0 } }, suspend_module1_tx)
}

test bench_unsuspend_largest() {
  spend(Unsuspend { author: signer(1) }, unsuspend_tx)
}

test bench_revoke_largest() {
  spend(Revoke { actor: ByController }, revoke_tx)
}

test bench_revoke_by_module1_largest() {
  spend(Revoke { actor: ByParty { index: 0 } }, revoke_module1_tx)
}

test bench_retire_largest() {
  spend(Retire, retire_tx)
}

test bench_reclaim_largest() {
  spend(Reclaim, reclaim_tx)
}

test bench_set_successor_largest() {
  spend(SetSuccessor, set_successor_tx)
}

test bench_bump_epoch_largest() {
  spend(BumpEpoch, bump_tx)
}

test bench_recover_init_largest() {
  spend(RecoverInit { guardians: [5, 6, 7] }, recover_init_tx)
}

test bench_recover_cancel_largest() {
  spend(RecoverCancel { guardians: [5, 6, 7] }, recover_cancel_tx)
}

test bench_recover_finalize_largest() {
  spend(RecoverFinalize, recover_finalize_tx)
}

// ## Sizes (CBOR of the inline datum, in bytes)

test largest_datum_size() {
  bytearray.length(cbor.serialise(big)) == 3975
}

test largest_tombstone_size() {
  bytearray.length(cbor.serialise(ended)) == 181
}
