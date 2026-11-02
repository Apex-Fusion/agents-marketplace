//// Rules of the attestation contract: Part 2 §4.1 of
//// `docs/IDENTITY_REGISTRY.md`.
////
//// `AA` is the attestation address: the enterprise address of the
//// attestation script (payment credential `Script(own hash)`, no stake
//// credential). The attestation policy is the same script. An attestation is
//// authentic only when it is an output at `AA` that holds exactly one token of
//// the attestation policy.
////
//// `validators/attestation.ak` only wires these handlers. A handler returns
//// `False` when a rule does not hold. It fails when the validity range is not
//// finite or is longer than one hour, when the own input is missing, or when
//// an attestation datum does not decode.
////
//// Each handler starts with the condition `lo <= hi` on the result of
//// `common.window`. This forces the window rule before any branch: the
//// compiler moves a binding that only one branch uses into that branch, so a
//// check in the binding would not run for the other branches.
////
//// The readings of the specification that these rules use are listed in
//// `tests/attestation.md` ("Decisions"). In short: an input or an output "at
//// AA" is any input or output whose payment credential is the attestation
//// script, with any stake credential, and the one output that a rule allows
//// must also be exactly at `AA`.

use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{blake2b_224, blake2b_256}
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Redeemer, ScriptPurpose, Spend,
  Transaction,
}
use identity_marketplace/common.{
  Window, ap3x_and_token, ap3x_of, count_inputs_with_script, key_signed,
  signed_by, valid_time, valid_uint, window,
}
use identity_marketplace/types.{
  Anchor, AttActive, AttRevoked, Attest, AttestationDatum, AttestationMint,
  AttestationSpend, Burn, Contest, Link, RevokeAtt, Withdraw,
}
use vector_identity.{
  active_key, controller_signed, days_366_ms, days_90_ms, effective, find_record,
  max_time_ms, purpose_assertion,
}
use vector_identity/types.{EffActive, IdentityDatum} as identity

// ## Constants

/// The least AP3X of a new attestation output: 5 AP3X, in base units.
pub const min_deposit: Int = 5_000_000

/// The most links of an attestation.
pub const max_links: Int = 4

/// The greatest link relation: 0 supersedes, 1 depends_on, 2 corroborates,
/// 3 disputes.
pub const max_link_rel: Int = 3

/// The longest `locator` and the longest contest `uri`, in bytes.
pub const max_uri_length: Int = 256

/// The greatest CoAP Content-Format number (RFC 7252: 0..65535).
pub const max_format: Int = 65_535

// ## Handlers

/// The mint handler of the attestation policy `policy_id` (the attestation
/// script hash).
pub fn handle_mint(
  identity_hash: ByteArray,
  redeemer: AttestationMint,
  policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  when redeemer is {
    Attest { seed } -> attest(identity_hash, policy_id, seed, tx)
    Burn -> burn(policy_id, tx)
  }
}

/// The spend handler of the attestation script. `datum` is the datum of the
/// spent input `own_ref`.
pub fn handle_spend(
  identity_hash: ByteArray,
  datum: AttestationDatum,
  redeemer: AttestationSpend,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  when redeemer is {
    RevokeAtt { reason } ->
      revoke_att(identity_hash, datum, reason, own_ref, tx)
    Contest -> contest(identity_hash, datum, own_ref, tx)
    Withdraw -> withdraw(identity_hash, datum, own_ref, tx)
  }
}

/// `Attest { seed }`:
///
/// - the transaction spends `seed`, the attestation policy mints exactly
///   `[(attestation_id(seed), +1)]`, and no input is at `AA`;
/// - exactly one output is at `AA`: it holds the minted token, at least
///   `min_deposit` AP3X, no other asset and no reference script, and an
///   inline datum with `issued_at = hi`, `status = AttActive`,
///   `contested = None` and valid content (`valid_content`);
/// - `signed(issuer)`;
/// - the subject's record is a reference input (a live record or a
///   tombstone); when `solicited`, the subject's controller signs;
/// - with `issuer_id = Some(i)`: the record of `i` is a reference input, its
///   effective status over `[lo, hi]` is Active, and it lists the issuer key
///   with the assertion purpose.
pub fn attest(
  identity_hash: ByteArray,
  policy_id: PolicyId,
  seed: OutputReference,
  tx: Transaction,
) -> Bool {
  let Window { lo, hi } = window(tx.validity_range)
  let id = attestation_id(seed)
  and {
    lo <= hi,
    spends(tx.inputs, seed),
    dict.to_pairs(assets.tokens(tx.mint, policy_id)) == [Pair(id, 1)],
    count_inputs_with_script(tx.inputs, policy_id) == 0,
    when outputs_of_script(tx.outputs, policy_id) is {
      [output] -> and {
          output.address.stake_credential == None,
          ap3x_and_token(output.value, policy_id, id),
          ap3x_of(output.value) >= min_deposit,
          output.reference_script == None,
          when output.datum is {
            InlineDatum(data) ->
              new_attestation(identity_hash, data, tx, lo, hi)
            _ -> False
          },
        }
      _ -> False
    },
  }
}

/// `Burn` (part of `Withdraw` with `Burn`): the attestation policy mints
/// exactly one token, with quantity −1. Exactly one input has the
/// attestation script as payment credential. It is an authentic attestation
/// that holds this token, and its spend redeemer is `Withdraw`. The spend
/// handler checks the rest of `Withdraw`.
pub fn burn(policy_id: PolicyId, tx: Transaction) -> Bool {
  let Window { lo, hi } = window(tx.validity_range)
  and {
    lo <= hi,
    when dict.to_pairs(assets.tokens(tx.mint, policy_id)) is {
      [Pair(id, quantity)] ->
        when inputs_of_script(tx.inputs, policy_id) is {
          [input] -> and {
              quantity == -1,
              authentic_token(input.output, policy_id) == Some(id),
              withdrawn(tx.redeemers, input.output_reference),
            }
          _ -> False
        }
      _ -> False
    },
  }
}

/// `RevokeAtt { reason }`: the common rules (`kept`), issuer authority, and a
/// status change from `AttActive` to `AttRevoked { at: lo, reason }`. No
/// other field changes. `reason` is in `[0, 2^63)`.
pub fn revoke_att(
  identity_hash: ByteArray,
  datum: AttestationDatum,
  reason: Int,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  let Window { lo, hi } = window(tx.validity_range)
  let revoked: Data =
    AttestationDatum { ..datum, status: AttRevoked { at: lo, reason } }
  and {
    lo <= hi,
    datum.status == AttActive,
    valid_uint(reason),
    kept(own_ref, tx, fn(data) { data == revoked }),
    issuer_authority(identity_hash, datum, tx),
  }
}

/// `Contest`: the common rules (`kept`); the subject's controller signs, with
/// the subject's record as a reference input; only `contested` changes, to an
/// anchor with a 1..256-byte `uri` and a 32-byte `sha256`.
pub fn contest(
  identity_hash: ByteArray,
  datum: AttestationDatum,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  let Window { lo, hi } = window(tx.validity_range)
  and {
    lo <= hi,
    kept(
      own_ref,
      tx,
      fn(data) {
        expect contested: AttestationDatum = data
        when contested.contested is {
          Some(anchor) -> and {
              valid_anchor(anchor),
              contested == AttestationDatum { ..datum, contested: Some(anchor) },
            }
          None -> False
        }
      },
    ),
    subject_controller_signed(identity_hash, datum.subject, tx),
  }
}

/// `Withdraw` (with `Burn`): the spent input is an authentic attestation and
/// the only attestation input; the attestation policy burns exactly this
/// token (`[(id, −1)]`); the attestation can be withdrawn at `lo`
/// (`withdrawable`); issuer authority. The deposit is released.
pub fn withdraw(
  identity_hash: ByteArray,
  datum: AttestationDatum,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  let Window { lo, hi } = window(tx.validity_range)
  and {
    lo <= hi,
    withdrawable(datum, lo),
    when spent(own_ref, tx) is {
      Some(Spent { own_hash, id, .. }) ->
        dict.to_pairs(assets.tokens(tx.mint, own_hash)) == [Pair(id, -1)]
      None -> False
    },
    issuer_authority(identity_hash, datum, tx),
  }
}

// ## Rules used by the handlers

/// The token name of the attestation that `seed` creates:
/// `blake2b_256(serialise(seed))` (the derivation of Part 1 §3.1).
pub fn attestation_id(seed: OutputReference) -> ByteArray {
  blake2b_256(cbor.serialise(seed))
}

/// Issuer authority (Part 2 §4.1). With `issuer_id = None`: `signed(issuer)`.
/// With `issuer_id = Some(i)`: the record `I` of `i` is a reference input (a
/// live record or a tombstone), and either `signed(I.controller)`, or
/// `signed(issuer)` and `I` lists the issuer key with the assertion purpose.
/// A removed issuer key thus has no authority.
pub fn issuer_authority(
  identity_hash: ByteArray,
  datum: AttestationDatum,
  tx: Transaction,
) -> Bool {
  when datum.issuer_id is {
    None -> key_signed(tx.extra_signatories, datum.issuer)
    Some(i) ->
      when find_record(tx.reference_inputs, identity_hash, i) is {
        Some(record) ->
          controller_signed(record, tx) || listed_issuer_signed(
            record,
            blake2b_224(datum.issuer),
            tx,
          )
        None -> False
      }
  }
}

/// The content rules of a new attestation datum that do not depend on the
/// transaction:
///
/// - `subject`, `issuer` and `digest` are 32 bytes; `issuer_id` and `profile`
///   are empty or 32 bytes; `envelope_sig` is empty or 64 bytes; `locator` is
///   empty or at most 256 bytes;
/// - `att_type` is 0..5 or 15 (`valid_att_type`); `format` is empty or a CoAP
///   Content-Format number (0..65535);
/// - `issued_at` is a valid time; `valid_until` and `valid_from` as
///   `valid_period`;
/// - at most 4 links, each with a relation 0..3 and a 32-byte target.
pub fn valid_content(datum: AttestationDatum) -> Bool {
  and {
    bytearray.length(datum.subject) == 32,
    bytearray.length(datum.issuer) == 32,
    optional_size(datum.issuer_id, 32),
    valid_att_type(datum.att_type),
    when datum.format is {
      None -> True
      Some(format) -> format >= 0 && format <= max_format
    },
    optional_size(datum.profile, 32),
    bytearray.length(datum.digest) == 32,
    when datum.locator is {
      None -> True
      Some(locator) -> bytearray.length(locator) <= max_uri_length
    },
    optional_size(datum.envelope_sig, 64),
    valid_time(datum.issued_at),
    valid_period(datum),
    valid_links(datum.links),
  }
}

/// 0 identity, 1 provenance, 2 software, 3 environment, 4 principal binding,
/// 5 approval, 15 other. Every other value is reserved.
pub fn valid_att_type(att_type: Int) -> Bool {
  att_type >= 0 && att_type <= 5 || att_type == 15
}

/// `valid_until` is at or after `issued_at`, at most 366 days after it, and a
/// valid time. Types 2 (software) and 3 (environment) require it.
/// `valid_from`, if set, is a valid time at or before `valid_until`.
pub fn valid_period(datum: AttestationDatum) -> Bool {
  when datum.valid_until is {
    None -> and {
        datum.att_type != 2,
        datum.att_type != 3,
        valid_from_until(datum.valid_from, max_time_ms),
      }
    Some(until) -> and {
        datum.issued_at <= until,
        until <= datum.issued_at + days_366_ms,
        valid_time(until),
        valid_from_until(datum.valid_from, until),
      }
  }
}

/// The attestation can be withdrawn at `lo`: it is revoked with
/// `at + 90 days <= lo`, or it has `valid_until + 90 days <= lo`.
pub fn withdrawable(datum: AttestationDatum, lo: Int) -> Bool {
  let revoked_long_ago =
    when datum.status is {
      AttRevoked { at, .. } -> at + days_90_ms <= lo
      AttActive -> False
    }
  revoked_long_ago || when datum.valid_until is {
    Some(until) -> until + days_90_ms <= lo
    None -> False
  }
}

// ## Internal helpers

/// The spent attestation: the output of the own input, the attestation script
/// hash and the token name.
type Spent {
  output: Output,
  own_hash: ByteArray,
  id: ByteArray,
}

/// The spent input, when it is an authentic attestation (`authentic_token`)
/// and the only input whose payment credential is the attestation script.
/// Fails when `own_ref` is not an input or is not locked by a script.
fn spent(own_ref: OutputReference, tx: Transaction) -> Option<Spent> {
  expect Some(own_input) = transaction.find_input(tx.inputs, own_ref)
  let output = own_input.output
  expect Script(own_hash) = output.address.payment_credential
  when authentic_token(output, own_hash) is {
    Some(id) ->
      if count_inputs_with_script(tx.inputs, own_hash) == 1 {
        Some(Spent { output, own_hash, id })
      } else {
        None
      }
    None -> None
  }
}

/// The common rules of `RevokeAtt` and `Contest`:
///
/// - the spent input is an authentic attestation and the only attestation
///   input (`spent`);
/// - the attestation policy mints and burns nothing;
/// - exactly one output has the attestation script as payment credential; it
///   is exactly at `AA`, holds the same token, at least the input's AP3X and
///   no other asset, has no reference script, and has an inline datum that
///   `datum_ok` accepts.
fn kept(
  own_ref: OutputReference,
  tx: Transaction,
  datum_ok: fn(Data) -> Bool,
) -> Bool {
  when spent(own_ref, tx) is {
    Some(Spent { output: input, own_hash, id }) ->
      when outputs_of_script(tx.outputs, own_hash) is {
        [output] -> and {
            dict.is_empty(assets.tokens(tx.mint, own_hash)),
            output.address.stake_credential == None,
            ap3x_and_token(output.value, own_hash, id),
            ap3x_of(output.value) >= ap3x_of(input.value),
            output.reference_script == None,
            when output.datum is {
              InlineDatum(data) -> datum_ok(data)
              _ -> False
            },
          }
        _ -> False
      }
    None -> False
  }
}

/// The datum rules of `Attest` for the inline datum `data` of the new output.
/// `data` decodes as `AttestationDatum` (else the transaction fails), with
/// `issued_at = hi`, `status = AttActive`, `contested = None` and valid
/// content. The issuer key signs. The subject's record is a reference input,
/// and its controller signs a solicited attestation. A registered issuer's
/// record is Active over `[lo, hi]` and lists the issuer key with the
/// assertion purpose.
fn new_attestation(
  identity_hash: ByteArray,
  data: Data,
  tx: Transaction,
  lo: Int,
  hi: Int,
) -> Bool {
  expect datum: AttestationDatum = data
  let issuer_hash = blake2b_224(datum.issuer)
  and {
    datum.issued_at == hi,
    datum.status == AttActive,
    datum.contested == None,
    valid_content(datum),
    signed_by(tx.extra_signatories, issuer_hash),
    subject_accepts(identity_hash, datum, tx),
    registered_issuer_active(identity_hash, datum, issuer_hash, tx, lo, hi),
  }
}

/// The token name of an authentic attestation output: the output is exactly
/// at `AA` (the enterprise address of `own_hash`) and holds exactly one token
/// of the policy `own_hash`, with quantity 1.
fn authentic_token(output: Output, own_hash: ByteArray) -> Option<ByteArray> {
  when dict.to_pairs(assets.tokens(output.value, own_hash)) is {
    [Pair(id, 1)] ->
      if output.address == address.from_script(own_hash) {
        Some(id)
      } else {
        None
      }
    _ -> None
  }
}

/// The subject's record is a reference input (a live record or a tombstone).
/// When the attestation is solicited, the subject's controller signs.
fn subject_accepts(
  identity_hash: ByteArray,
  datum: AttestationDatum,
  tx: Transaction,
) -> Bool {
  when find_record(tx.reference_inputs, identity_hash, datum.subject) is {
    Some(subject) -> !datum.solicited || controller_signed(subject, tx)
    None -> False
  }
}

/// With `issuer_id = Some(i)`: the record of `i` is a reference input, it
/// lists the issuer key with the assertion purpose, and its effective status
/// over `[lo, hi]` is Active. True with `issuer_id = None`.
fn registered_issuer_active(
  identity_hash: ByteArray,
  datum: AttestationDatum,
  issuer_hash: ByteArray,
  tx: Transaction,
  lo: Int,
  hi: Int,
) -> Bool {
  when datum.issuer_id is {
    None -> True
    Some(i) ->
      when find_record(tx.reference_inputs, identity_hash, i) is {
        Some(record) -> and {
            active_key(record, issuer_hash, purpose_assertion),
            effective(record, tx.reference_inputs, identity_hash, lo, hi) == EffActive,
          }
        None -> False
      }
  }
}

/// `signed(issuer)` and `active_key(record, blake2b_224(issuer), assertion)`.
fn listed_issuer_signed(
  record: IdentityDatum,
  issuer_hash: ByteArray,
  tx: Transaction,
) -> Bool {
  and {
    signed_by(tx.extra_signatories, issuer_hash),
    active_key(record, issuer_hash, purpose_assertion),
  }
}

/// The subject's record is a reference input (a live record or a tombstone),
/// and its controller signs.
fn subject_controller_signed(
  identity_hash: ByteArray,
  subject: ByteArray,
  tx: Transaction,
) -> Bool {
  when find_record(tx.reference_inputs, identity_hash, subject) is {
    Some(record) -> controller_signed(record, tx)
    None -> False
  }
}

/// True when the spend redeemer of `ref` is `Withdraw`.
fn withdrawn(
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  ref: OutputReference,
) -> Bool {
  let withdraw_redeemer: Data = Withdraw
  pairs.get_first(redeemers, Spend(ref)) == Some(withdraw_redeemer)
}

/// `valid_from` is empty, or a valid time at or before `limit`.
fn valid_from_until(valid_from: Option<Int>, limit: Int) -> Bool {
  when valid_from is {
    None -> True
    Some(from) -> valid_time(from) && from <= limit
  }
}

/// At most `max_links` links; each relation is 0..3 and each target is 32
/// bytes (the token name of another attestation).
fn valid_links(links: List<Link>) -> Bool {
  and {
    list.length(links) <= max_links,
    list.all(
      links,
      fn(link) {
        and {
          link.rel >= 0,
          link.rel <= max_link_rel,
          bytearray.length(link.target) == 32,
        }
      },
    ),
  }
}

/// `uri` is 1..256 bytes and `sha256` is 32 bytes.
fn valid_anchor(anchor: Anchor) -> Bool {
  let uri_length = bytearray.length(anchor.uri)
  and {
    uri_length >= 1,
    uri_length <= max_uri_length,
    bytearray.length(anchor.sha256) == 32,
  }
}

/// `None`, or `Some(bytes)` with exactly `size` bytes.
fn optional_size(value: Option<ByteArray>, size: Int) -> Bool {
  when value is {
    None -> True
    Some(bytes) -> bytearray.length(bytes) == size
  }
}

/// True when `seed` is a transaction input.
fn spends(inputs: List<Input>, seed: OutputReference) -> Bool {
  list.any(inputs, fn(input) { input.output_reference == seed })
}

/// The outputs whose payment credential is `Script(hash)`, with any stake
/// credential.
fn outputs_of_script(outputs: List<Output>, hash: ByteArray) -> List<Output> {
  list.filter(
    outputs,
    fn(output) { output.address.payment_credential == Script(hash) },
  )
}

/// The inputs whose payment credential is `Script(hash)`, with any stake
/// credential.
fn inputs_of_script(inputs: List<Input>, hash: ByteArray) -> List<Input> {
  list.filter(
    inputs,
    fn(input) { input.output.address.payment_credential == Script(hash) },
  )
}
