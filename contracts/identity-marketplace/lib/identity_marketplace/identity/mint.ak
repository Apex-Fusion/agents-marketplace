//// Mint rules of the identity policy: Part 2 §3.4 (`docs/IDENTITY_REGISTRY.md`).

use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use cardano/address.{VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{DatumHash, InlineDatum, NoDatum, Transaction}
use identity_marketplace/common.{
  Window, count_inputs_with_script, key_signed, single_output_at, window,
}
use identity_marketplace/config/record.{module1}
use identity_marketplace/identity/allowlist
use identity_marketplace/identity/rules.{
  IdentityParams, accountable, guardian_bound, record_output, signer_ok,
}
use vector_identity.{effective, find_record}
use vector_identity/redeemers.{Adopt, IdentityMint, Register}
use vector_identity/types.{
  Active, Ed25519, EffActive, IdentityDatum, LegacyDatum, Lineage, P256, Root,
  Subagent,
}

/// The mint handler of the `identity` validator. `own_policy` is the policy
/// being run (the identity script hash).
///
/// - `Register { seed }`: rules 1–9 of Part 2 §3.4.
/// - `Adopt { proof }`: rules 1–5 of Part 2 §3.4.
pub fn mint_ok(
  params: IdentityParams,
  redeemer: IdentityMint,
  own_policy: PolicyId,
  tx: Transaction,
) -> Bool {
  let Window { lo, hi } = window(tx.validity_range)
  let m1 =
    module1(tx.reference_inputs, params.config_policy, params.config_holder)
  and {
    // Checked before the redeemer branch, so the optimizer cannot move the
    // window check into one branch only.
    (lo <= hi)?,
    when redeemer is {
      Register { seed } -> {
        let id = blake2b_256(cbor.serialise(seed))
        let record = created_record(own_policy, id, tx, lo, hi, m1)
        and {
          (record.created_at == hi)?,
          list.any(tx.inputs, fn(input) { input.output_reference == seed })?,
          (dict.to_pairs(assets.tokens(tx.mint, own_policy)) == [Pair(id, 1)])?,
          dict.is_empty(assets.tokens(tx.mint, params.legacy_hash))?,
          lineage_ok(record.lineage, own_policy, tx, lo, hi)?,
        }
      }
      Adopt { proof } -> {
        expect [Pair(id, 1)] = dict.to_pairs(assets.tokens(tx.mint, own_policy))
        let record = created_record(own_policy, id, tx, lo, hi, m1)
        and {
          (record.lineage == Root)?,
          (dict.to_pairs(assets.tokens(tx.mint, params.legacy_hash)) == [
            Pair(id, -1),
          ])?,
          legacy_record_ok(params.legacy_hash, id, tx)?,
          allowlist.member(params.legacy_root, id, proof)?,
        }
      }
    },
  }
}

/// Rules 4–8 of `Register`, which `Adopt` shares. No input is at the identity
/// script (any stake credential). Exactly one output is at the identity
/// address: a record output for `id` with datum `D0`. `D0` is Active with no
/// pending recovery, epoch 0, `created_at = hi`, an Accountable Party that
/// covers `[lo, hi]` and the guardian bound. The controller, each listed
/// Ed25519 key and each party sign. Returns `D0`; fails otherwise.
fn created_record(
  own: ByteArray,
  id: ByteArray,
  tx: Transaction,
  lo: Int,
  hi: Int,
  m1: Option<ByteArray>,
) -> IdentityDatum {
  let output = single_output_at(tx.outputs, address.from_script(own))
  let record = record_output(output, own, id, m1)
  let signatories = tx.extra_signatories
  expect and {
      (count_inputs_with_script(tx.inputs, own) == 0)?,
      (record.status == Active)?,
      (record.pending_recovery == None)?,
      (record.subagent_epoch == 0)?,
      (record.created_at == hi)?,
      accountable(record, lo, hi)?,
      guardian_bound(record, hi)?,
      key_signed(signatories, record.controller)?,
      list.all(
        record.keys,
        fn(key) {
          when key.key_type is {
            Ed25519 -> key_signed(signatories, key.key)
            P256 -> True
          }
        },
      )?,
      list.all(
        record.parties,
        fn(party) {
          signer_ok(
            party.signer,
            signatories,
            record.controller,
            m1,
            tx.withdrawals,
          )
        },
      )?,
    }
  record
}

/// Rule 9 of `Register`. A subagent's parent record `P` is a reference input
/// (`find_record`); `P`'s controller signs; `P`'s effective status over
/// `[lo, hi]` is Active, with `P`'s ancestors as reference inputs;
/// `parent_epoch = P.subagent_epoch`; and `depth` is one more than `P`'s depth
/// (0 for `Root`).
fn lineage_ok(
  lineage: Lineage,
  own: ByteArray,
  tx: Transaction,
  lo: Int,
  hi: Int,
) -> Bool {
  when lineage is {
    Root -> True
    Subagent { parent, parent_epoch, depth } -> {
      expect Some(record) = find_record(tx.reference_inputs, own, parent)
      and {
        key_signed(tx.extra_signatories, record.controller)?,
        (effective(record, tx.reference_inputs, own, lo, hi) == EffActive)?,
        (parent_epoch == record.subagent_epoch)?,
        (depth == depth_of(record.lineage) + 1)?,
      }
    }
  }
}

fn depth_of(lineage: Lineage) -> Int {
  when lineage is {
    Root -> 0
    Subagent { depth, .. } -> depth
  }
}

/// Rule 3 of `Adopt`. Exactly one transaction input is at the exact legacy
/// address. It holds exactly one token of `legacy_hash`, named `id`. Its
/// datum (inline, or by hash from the transaction) decodes as `LegacyDatum`.
/// Its `owner` is `VerificationKey(h)`, and `h` is a required signer.
fn legacy_record_ok(
  legacy_hash: ByteArray,
  id: ByteArray,
  tx: Transaction,
) -> Bool {
  let legacy_address = address.from_script(legacy_hash)
  expect [input] =
    list.filter(tx.inputs, fn(input) { input.output.address == legacy_address })
  let output = input.output
  let data =
    when output.datum is {
      InlineDatum(data) -> data
      DatumHash(hash) -> {
        expect Some(data) = dict.get(tx.datums, hash)
        data
      }
      NoDatum -> fail @"legacy record without datum"
    }
  expect legacy: LegacyDatum = data
  expect VerificationKey(owner) = legacy.owner
  and {
    (dict.to_pairs(assets.tokens(output.value, legacy_hash)) == [Pair(id, 1)])?,
    list.has(tx.extra_signatories, owner)?,
  }
}
