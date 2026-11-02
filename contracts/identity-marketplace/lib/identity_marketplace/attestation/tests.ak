//// Tests of the attestation rules: Part 2 §4.1 and the §12.1 row
//// "Attestation" (`docs/IDENTITY_REGISTRY.md`). The wiring tests and the
//// "Other purposes" tests are in `validators/attestation.ak`.
////
//// Each negative test changes one thing in a transaction that passes. A test
//// `!handler(...)` checks that the rule returns `False`. A `fail` test checks
//// that the handler fails: an invalid validity range, a datum that does not
//// decode, or a missing ancestor record. The map from the §12.1 items to
//// these tests is in `tests/attestation.md`.

use aiken/collection/list
use aiken/interval
use cardano/address
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Spend,
  Transaction,
}
use identity_marketplace/attestation/fixtures.{
  aa, anchor, att_id, att_input, att_output, att_ref, att_value, attest_tx,
  burn_redeemer, bytes, contested, existing, existing_unregistered, fee_ref,
  full_datum, hash_32, hi, identity_hash, issuer_controller, issuer_id,
  issuer_key, issuer_record, issuer_record_without_key, largest_attest_tx,
  largest_contest_tx, largest_datum, largest_existing, largest_revoke_tx,
  largest_withdraw_tx, listed, lo, minimal_datum, one_hour, other_hash_32,
  other_policy, other_script, own_hash, pkh, range, record, record_input,
  records_with_issuer, records_with_subject, revoked, seed, spend_tx, staked,
  stranger_key, subject_controller, subject_id, subject_record, test_id,
  tombstone, wallet, wallet_input, wallet_output, with_status, withdraw_redeemer,
  withdraw_tx,
}
use identity_marketplace/attestation/handlers.{
  attest, attestation_id, burn, contest, handle_mint, handle_spend, revoke_att,
  valid_content, withdraw,
}
use identity_marketplace/types.{
  Anchor, Attest, AttestationDatum, Burn, Contest, Link, RevokeAtt, Withdraw,
}
use vector_identity.{
  day_ms, days_30_ms, days_366_ms, days_90_ms, max_time_ms,
  purpose_authentication, purpose_transaction,
}
use vector_identity/types.{
  ControllerSet, Hold, IdentityDatum, KeyHash, Revoked, Subagent, Suspended,
} as identity

// ## Helpers

fn issuer_signs() -> List<ByteArray> {
  [pkh(issuer_key)]
}

fn subject_signs() -> List<ByteArray> {
  [pkh(subject_controller)]
}

fn attest_passes(tx: Transaction) -> Bool {
  attest(identity_hash, own_hash, seed(), tx)
}

/// `Attest` of `datum`, signed by the issuer key.
fn attest_with(datum: AttestationDatum) -> Bool {
  attest_passes(attest_tx(datum, issuer_signs()))
}

/// `Attest` of `datum` with `outputs`, signed by the issuer key.
fn attest_with_outputs(datum: AttestationDatum, outputs: List<Output>) -> Bool {
  attest_passes(Transaction { ..attest_tx(datum, issuer_signs()), outputs })
}

/// `Attest` of `full_datum()` with `reference_inputs`.
fn attest_with_refs(reference_inputs: List<Input>) -> Bool {
  attest_passes(
    Transaction { ..attest_tx(full_datum(), issuer_signs()), reference_inputs },
  )
}

/// The datum breaks a content rule, and `Attest` with it fails.
fn content_rejected(datum: AttestationDatum) -> Bool {
  !valid_content(datum) && !attest_with(datum)
}

fn revoke_passes(old: AttestationDatum, reason: Int, tx: Transaction) -> Bool {
  revoke_att(identity_hash, old, reason, att_ref(), tx)
}

/// `RevokeAtt { reason: 5 }` of `existing()` at `lo`, signed by `signers`.
fn revoke_tx(signers: List<ByteArray>) -> Transaction {
  spend_tx(existing(), revoked(existing(), lo, 5), signers)
}

/// `RevokeAtt { reason: 5 }` of `existing()` with `outputs`, by the issuer key.
fn revoke_with_outputs(outputs: List<Output>) -> Bool {
  revoke_passes(
    existing(),
    5,
    Transaction { ..revoke_tx(issuer_signs()), outputs },
  )
}

fn contest_passes(old: AttestationDatum, tx: Transaction) -> Bool {
  contest(identity_hash, old, att_ref(), tx)
}

/// `Contest` of `existing()` with `anchor()`, signed by `signers`.
fn contest_tx(signers: List<ByteArray>) -> Transaction {
  spend_tx(existing(), contested(existing(), anchor()), signers)
}

/// `Contest` of `existing()` with `outputs`, by the subject's controller.
fn contest_with_outputs(outputs: List<Output>) -> Bool {
  contest_passes(
    existing(),
    Transaction { ..contest_tx(subject_signs()), outputs },
  )
}

/// `Contest` of `existing()` with `reply`, by the subject's controller.
fn contest_with_anchor(reply: Anchor) -> Bool {
  contest_passes(
    existing(),
    spend_tx(existing(), contested(existing(), reply), subject_signs()),
  )
}

fn withdraw_passes(old: AttestationDatum, tx: Transaction) -> Bool {
  withdraw(identity_hash, old, att_ref(), tx)
}

fn burn_passes(tx: Transaction) -> Bool {
  burn(own_hash, tx)
}

/// `existing()`, revoked at `lo`. Withdraw is allowed from `lo + 90 days`.
fn revoked_at_lo() -> AttestationDatum {
  revoked(existing(), lo, 5)
}

/// `Withdraw` of `revoked_at_lo()` at `lo + 90 days`, signed by `signers`.
fn withdraw_on_time(signers: List<ByteArray>) -> Transaction {
  withdraw_tx(revoked_at_lo(), lo + days_90_ms, signers)
}

/// A second attestation input: another token at `AA`.
fn second_attestation() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: hash_32,
      output_index: 1,
    },
    output: Output {
      ..att_output(existing()),
      value: assets.from_lovelace(5_000_000)
        |> assets.add(own_hash, other_hash_32, 1),
    },
  }
}

/// An output at `address` with 2 AP3X and no datum.
fn ap3x_output_at(address: address.Address) -> Output {
  Output { ..wallet_output(2_000_000), address }
}

/// The spent attestation input with `output` changed.
fn att_input_with(output: Output) -> Input {
  Input { ..att_input(existing()), output }
}

// ## Identifier

test attestation_id_vectors() {
  and {
    attestation_id(
      OutputReference {
        transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
        output_index: 0,
      },
    ) == #"a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9",
    attestation_id(
      OutputReference {
        transaction_id: #"abababababababababababababababababababababababababababababababab",
        output_index: 24,
      },
    ) == #"3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b",
  }
}

// ## Attest: must pass

test attest_registered_issuer() {
  attest_with(full_datum())
}

test attest_unregistered_issuer() {
  attest_with(minimal_datum())
}

test attest_via_handle_mint() {
  handle_mint(
    identity_hash,
    Attest { seed: seed() },
    own_hash,
    attest_tx(full_datum(), issuer_signs()),
  )
}

test attest_solicited_with_subject_controller() {
  let datum = AttestationDatum { ..full_datum(), solicited: True }
  attest_passes(attest_tx(datum, [pkh(issuer_key), pkh(subject_controller)]))
}

test attest_subject_tombstone() {
  attest_with_refs(records_with_subject(tombstone(subject_record())))
}

test attest_subject_suspended() {
  let subject =
    with_status(
      subject_record(),
      Suspended {
        holds: [
          Hold {
            by: ControllerSet,
            reason: 6,
            since: lo - day_ms,
            until: hi + day_ms,
          },
        ],
      },
    )
  attest_with_refs(records_with_subject(subject))
}

test attest_issuer_subagent_active() {
  let issuer =
    IdentityDatum {
      ..issuer_record(),
      endpoint: "",
      lineage: Subagent { parent: test_id(1), parent_epoch: 0, depth: 1 },
    }
  attest_with_refs(
    [
      record_input(test_id(1), record(issuer_controller, [])),
      ..records_with_issuer(issuer)
    ],
  )
}

test attest_allowed_types() {
  list.all(
    [0, 1, 2, 3, 4, 5, 15],
    fn(t) { attest_with(AttestationDatum { ..full_datum(), att_type: t }) },
  )
}

test attest_valid_until_optional_for_other_types() {
  list.all(
    [0, 1, 4, 5, 15],
    fn(t) {
      attest_with(
        AttestationDatum { ..full_datum(), att_type: t, valid_until: None },
      )
    },
  )
}

test attest_valid_until_bounds() {
  and {
    attest_with(
      AttestationDatum {
        ..full_datum(),
        valid_from: None,
        valid_until: Some(hi),
      },
    ),
    attest_with(
      AttestationDatum {
        ..full_datum(),
        valid_from: None,
        valid_until: Some(hi + days_366_ms),
      },
    ),
  }
}

test attest_valid_from_bounds() {
  and {
    attest_with(
      AttestationDatum { ..full_datum(), valid_from: Some(hi + days_30_ms) },
    ),
    attest_with(AttestationDatum { ..full_datum(), valid_from: Some(0) }),
  }
}

/// 4 links with every relation, a 256-byte or an empty locator, and the
/// lowest and highest format numbers.
test attest_limits_at_bounds() {
  let bounds = AttestationDatum { ..largest_datum(), solicited: False }
  and {
    attest_with(AttestationDatum { ..bounds, format: Some(65_535) }),
    attest_with(
      AttestationDatum { ..bounds, format: Some(0), locator: Some("") },
    ),
  }
}

test attest_deposit_above_minimum() {
  attest_with_outputs(
    full_datum(),
    [Output { ..att_output(full_datum()), value: att_value(9_000_000) }],
  )
}

test attest_with_mint_of_other_policy() {
  let tx = attest_tx(full_datum(), issuer_signs())
  attest_passes(
    Transaction {
      ..tx,
      mint: tx.mint |> assets.add(other_policy, "x", 1),
      outputs: [
        att_output(full_datum()),
        Output {
          ..wallet_output(14_000_000),
          value: assets.from_lovelace(14_000_000)
            |> assets.add(other_policy, "x", 1),
        },
      ],
    },
  )
}

test attest_range_one_hour() {
  let datum = AttestationDatum { ..full_datum(), issued_at: lo + one_hour }
  attest_passes(
    Transaction {
      ..attest_tx(datum, issuer_signs()),
      validity_range: range(lo, lo + one_hour),
    },
  )
}

// ## Attest: §12.1 attacks

test attest_no_subject_record() {
  !attest_with_refs([record_input(issuer_id, issuer_record())])
}

test attest_subject_record_with_stake_credential() {
  let subject = record_input(subject_id, subject_record())
  let moved =
    Input {
      ..subject,
      output: Output {
        ..subject.output,
        address: staked(subject.output.address),
      },
    }
  !attest_with_refs([moved, record_input(issuer_id, issuer_record())])
}

test attest_issuer_not_signed() {
  !attest_passes(attest_tx(minimal_datum(), [pkh(subject_controller)]))
}

test attest_registered_issuer_not_signed() {
  !attest_passes(attest_tx(full_datum(), [pkh(issuer_controller)]))
}

test attest_issuer_key_without_assertion() {
  let issuer =
    record(
      issuer_controller,
      [listed(issuer_key, purpose_authentication + purpose_transaction)],
    )
  !attest_with_refs(records_with_issuer(issuer))
}

test attest_issuer_key_not_listed() {
  !attest_with_refs(records_with_issuer(issuer_record_without_key()))
}

test attest_issuer_record_missing() {
  !attest_with_refs([record_input(subject_id, subject_record())])
}

test attest_issuer_suspended() {
  let issuer =
    with_status(
      issuer_record(),
      Suspended {
        holds: [
          Hold {
            by: KeyHash { hash: pkh(stranger_key) },
            reason: 6,
            since: lo - day_ms,
            until: hi + day_ms,
          },
        ],
      },
    )
  !attest_with_refs(records_with_issuer(issuer))
}

test attest_issuer_unaccountable() {
  !attest_with_refs(
    records_with_issuer(IdentityDatum { ..issuer_record(), parties: [] }),
  )
}

test attest_issuer_revoked() {
  let issuer =
    with_status(
      issuer_record(),
      Revoked {
        by: ControllerSet,
        reason: 5,
        at: lo - day_ms,
        invalid_from: None,
        successor: None,
      },
    )
  !attest_with_refs(records_with_issuer(issuer))
}

test attest_issuer_parent_ended_subagents() {
  let parent =
    IdentityDatum { ..record(issuer_controller, []), subagent_epoch: 1 }
  let issuer =
    IdentityDatum {
      ..issuer_record(),
      endpoint: "",
      lineage: Subagent { parent: test_id(1), parent_epoch: 0, depth: 1 },
    }
  !attest_with_refs(
    [record_input(test_id(1), parent), ..records_with_issuer(issuer)],
  )
}

test attest_issuer_parent_missing() fail {
  let issuer =
    IdentityDatum {
      ..issuer_record(),
      endpoint: "",
      lineage: Subagent { parent: test_id(1), parent_epoch: 0, depth: 1 },
    }
  attest_with_refs(records_with_issuer(issuer))
}

test attest_solicited_without_subject_controller() {
  !attest_with(AttestationDatum { ..full_datum(), solicited: True })
}

test attest_output_foreign_asset() {
  !attest_with_outputs(
    full_datum(),
    [
      Output {
        ..att_output(full_datum()),
        value: att_value(5_000_000) |> assets.add(other_policy, "x", 1),
      },
    ],
  )
}

test attest_output_reference_script() {
  !attest_with_outputs(
    full_datum(),
    [
      Output {
        ..att_output(full_datum()),
        reference_script: Some(other_script),
      },
    ],
  )
}

test attest_output_stake_credential() {
  !attest_with_outputs(
    full_datum(),
    [Output { ..att_output(full_datum()), address: staked(aa()) }],
  )
}

test attest_extra_output_at_script_with_stake_credential() {
  !attest_with_outputs(
    full_datum(),
    [att_output(full_datum()), ap3x_output_at(staked(aa()))],
  )
}

test attest_two_outputs_at_aa() {
  !attest_with_outputs(
    full_datum(),
    [att_output(full_datum()), ap3x_output_at(aa())],
  )
}

test attest_token_outside_aa() {
  !attest_with_outputs(
    full_datum(),
    [
      Output {
        ..att_output(full_datum()),
        value: assets.from_lovelace(5_000_000),
      },
      Output {
        ..wallet_output(2_000_000),
        value: assets.from_lovelace(2_000_000)
          |> assets.add(own_hash, att_id(), 1),
      },
    ],
  )
}

test attest_issued_at_lo() {
  !attest_with(AttestationDatum { ..full_datum(), issued_at: lo })
}

test attest_issued_at_after_hi() {
  !attest_with(
    AttestationDatum {
      ..full_datum(),
      issued_at: hi + 1,
      valid_from: Some(hi + 1),
    },
  )
}

test attest_valid_until_before_issued_at() {
  content_rejected(
    AttestationDatum {
      ..full_datum(),
      valid_from: None,
      valid_until: Some(hi - 1),
    },
  )
}

test attest_valid_until_over_366_days() {
  content_rejected(
    AttestationDatum { ..full_datum(), valid_until: Some(hi + days_366_ms + 1) },
  )
}

test attest_software_without_valid_until() {
  content_rejected(
    AttestationDatum { ..full_datum(), att_type: 2, valid_until: None },
  )
}

test attest_environment_without_valid_until() {
  content_rejected(
    AttestationDatum { ..full_datum(), att_type: 3, valid_until: None },
  )
}

test attest_valid_from_after_valid_until() {
  content_rejected(
    AttestationDatum { ..full_datum(), valid_from: Some(hi + days_30_ms + 1) },
  )
}

test attest_valid_from_outside_time_range() {
  and {
    content_rejected(AttestationDatum { ..full_datum(), valid_from: Some(-1) }),
    content_rejected(
      AttestationDatum {
        ..full_datum(),
        att_type: 0,
        valid_until: None,
        valid_from: Some(max_time_ms + 1),
      },
    ),
  }
}

test attest_reserved_types() {
  list.all(
    [-1, 6, 7, 14, 16, 255],
    fn(t) { content_rejected(AttestationDatum { ..full_datum(), att_type: t }) },
  )
}

test attest_format_out_of_range() {
  list.all(
    [-1, 65_536],
    fn(f) {
      content_rejected(AttestationDatum { ..full_datum(), format: Some(f) })
    },
  )
}

test attest_byte_lengths() {
  and {
    content_rejected(AttestationDatum { ..full_datum(), subject: bytes(31) }),
    content_rejected(AttestationDatum { ..full_datum(), issuer: bytes(33) }),
    content_rejected(
      AttestationDatum { ..full_datum(), issuer_id: Some(bytes(31)) },
    ),
    content_rejected(
      AttestationDatum { ..full_datum(), profile: Some(bytes(33)) },
    ),
    content_rejected(AttestationDatum { ..full_datum(), digest: bytes(31) }),
    content_rejected(
      AttestationDatum { ..full_datum(), locator: Some(bytes(257)) },
    ),
    content_rejected(
      AttestationDatum { ..full_datum(), envelope_sig: Some(bytes(63)) },
    ),
  }
}

test attest_five_links() {
  content_rejected(
    AttestationDatum {
      ..largest_datum(),
      links: [Link { rel: 1, target: hash_32 }, ..largest_datum().links],
    },
  )
}

test attest_link_limits() {
  and {
    content_rejected(
      AttestationDatum {
        ..full_datum(),
        links: [Link { rel: 0, target: bytes(31) }],
      },
    ),
    content_rejected(
      AttestationDatum {
        ..full_datum(),
        links: [Link { rel: 4, target: hash_32 }],
      },
    ),
    content_rejected(
      AttestationDatum {
        ..full_datum(),
        links: [Link { rel: -1, target: hash_32 }],
      },
    ),
  }
}

// ## Attest: scope, output and datum rules

test attest_seed_not_spent() {
  !attest_passes(
    Transaction {
      ..attest_tx(full_datum(), issuer_signs()),
      inputs: [wallet_input(fee_ref())],
    },
  )
}

test attest_name_not_from_seed() {
  let other = attestation_id(fee_ref())
  !attest_passes(
    Transaction {
      ..attest_tx(full_datum(), issuer_signs()),
      mint: assets.from_asset(own_hash, other, 1),
      outputs: [
        Output {
          ..att_output(full_datum()),
          value: assets.from_lovelace(5_000_000)
            |> assets.add(own_hash, other, 1),
        },
      ],
    },
  )
}

test attest_quantity_two() {
  !attest_passes(
    Transaction {
      ..attest_tx(full_datum(), issuer_signs()),
      mint: assets.from_asset(own_hash, att_id(), 2),
      outputs: [
        Output {
          ..att_output(full_datum()),
          value: assets.from_lovelace(5_000_000)
            |> assets.add(own_hash, att_id(), 2),
        },
      ],
    },
  )
}

test attest_second_name() {
  let tx = attest_tx(full_datum(), issuer_signs())
  !attest_passes(
    Transaction {
      ..tx,
      mint: tx.mint |> assets.add(own_hash, other_hash_32, 1),
      outputs: [
        att_output(full_datum()),
        Output {
          ..wallet_output(2_000_000),
          value: assets.from_lovelace(2_000_000)
            |> assets.add(own_hash, other_hash_32, 1),
        },
      ],
    },
  )
}

test attest_with_attestation_input() {
  !attest_passes(
    Transaction {
      ..attest_tx(full_datum(), issuer_signs()),
      inputs: [wallet_input(seed()), second_attestation()],
    },
  )
}

test attest_with_script_input_with_stake_credential() {
  let junk =
    Input { output_reference: fee_ref(), output: ap3x_output_at(staked(aa())) }
  !attest_passes(
    Transaction {
      ..attest_tx(full_datum(), issuer_signs()),
      inputs: [wallet_input(seed()), junk],
    },
  )
}

test attest_deposit_below_minimum() {
  !attest_with_outputs(
    full_datum(),
    [Output { ..att_output(full_datum()), value: att_value(4_999_999) }],
  )
}

test attest_datum_hash() {
  !attest_with_outputs(
    full_datum(),
    [Output { ..att_output(full_datum()), datum: DatumHash(hash_32) }],
  )
}

test attest_no_datum() {
  !attest_with_outputs(
    full_datum(),
    [Output { ..att_output(full_datum()), datum: NoDatum }],
  )
}

test attest_status_revoked() {
  !attest_with(revoked(full_datum(), lo, 0))
}

test attest_contested_set() {
  !attest_with(contested(full_datum(), anchor()))
}

test attest_datum_not_attestation() fail {
  attest_with_outputs(
    full_datum(),
    [
      Output {
        ..att_output(full_datum()),
        datum: InlineDatum(subject_record()),
      },
    ],
  )
}

test attest_unbounded_range() fail {
  attest_passes(
    Transaction {
      ..attest_tx(full_datum(), issuer_signs()),
      validity_range: interval.everything,
    },
  )
}

test attest_range_over_one_hour() fail {
  let datum = AttestationDatum { ..full_datum(), issued_at: lo + one_hour + 1 }
  attest_passes(
    Transaction {
      ..attest_tx(datum, issuer_signs()),
      validity_range: range(lo, lo + one_hour + 1),
    },
  )
}

// ## RevokeAtt: must pass

test revoke_att_by_issuer_key() {
  revoke_passes(existing(), 5, revoke_tx(issuer_signs()))
}

test revoke_att_by_issuer_controller() {
  revoke_passes(existing(), 5, revoke_tx([pkh(issuer_controller)]))
}

test revoke_att_via_handle_spend() {
  handle_spend(
    identity_hash,
    existing(),
    RevokeAtt { reason: 5 },
    att_ref(),
    revoke_tx(issuer_signs()),
  )
}

test revoke_att_unregistered_issuer() {
  let old = existing_unregistered()
  revoke_passes(old, 5, spend_tx(old, revoked(old, lo, 5), issuer_signs()))
}

test revoke_att_by_controller_after_key_removal() {
  revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx([pkh(issuer_controller)]),
      reference_inputs: records_with_issuer(issuer_record_without_key()),
    },
  )
}

test revoke_att_by_controller_of_issuer_tombstone() {
  revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx([pkh(issuer_controller)]),
      reference_inputs: records_with_issuer(tombstone(issuer_record())),
    },
  )
}

test revoke_att_adds_ap3x() {
  revoke_with_outputs(
    [
      Output {
        ..att_output(revoked(existing(), lo, 5)),
        value: att_value(6_000_000),
      },
    ],
  )
}

test revoke_att_contested_attestation() {
  let old = contested(existing(), anchor())
  revoke_passes(old, 5, spend_tx(old, revoked(old, lo, 5), issuer_signs()))
}

test revoke_att_reason_bounds() {
  and {
    revoke_passes(
      existing(),
      0,
      spend_tx(existing(), revoked(existing(), lo, 0), issuer_signs()),
    ),
    revoke_passes(
      existing(),
      9_223_372_036_854_775_807,
      spend_tx(
        existing(),
        revoked(existing(), lo, 9_223_372_036_854_775_807),
        issuer_signs(),
      ),
    ),
  }
}

// ## RevokeAtt: §12.1 attacks

test revoke_att_by_removed_issuer_key() {
  !revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      reference_inputs: records_with_issuer(issuer_record_without_key()),
    },
  )
}

test revoke_att_issuer_key_without_assertion() {
  let issuer =
    record(issuer_controller, [listed(issuer_key, purpose_authentication)])
  !revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      reference_inputs: records_with_issuer(issuer),
    },
  )
}

test revoke_att_issuer_record_missing() {
  !revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      reference_inputs: [record_input(subject_id, subject_record())],
    },
  )
}

test revoke_att_unregistered_issuer_not_signed() {
  let old = existing_unregistered()
  !revoke_passes(
    old,
    5,
    spend_tx(old, revoked(old, lo, 5), [pkh(issuer_controller)]),
  )
}

test revoke_att_by_subject() {
  !revoke_passes(existing(), 5, revoke_tx(subject_signs()))
}

test revoke_att_by_stranger() {
  !revoke_passes(existing(), 5, revoke_tx([pkh(stranger_key)]))
}

test revoke_att_token_to_key_address() {
  !revoke_with_outputs(
    [Output { ..att_output(revoked(existing(), lo, 5)), address: wallet() }],
  )
}

test revoke_att_token_to_other_script() {
  !revoke_with_outputs(
    [
      Output {
        ..att_output(revoked(existing(), lo, 5)),
        address: address.from_script(other_script),
      },
    ],
  )
}

test revoke_att_output_stake_credential() {
  !revoke_with_outputs(
    [Output { ..att_output(revoked(existing(), lo, 5)), address: staked(aa()) }],
  )
}

test revoke_att_value_lowered() {
  !revoke_with_outputs(
    [
      Output {
        ..att_output(revoked(existing(), lo, 5)),
        value: att_value(4_999_999),
      },
    ],
  )
}

test revoke_att_output_foreign_asset() {
  !revoke_with_outputs(
    [
      Output {
        ..att_output(revoked(existing(), lo, 5)),
        value: att_value(5_000_000) |> assets.add(other_policy, "x", 1),
      },
    ],
  )
}

test revoke_att_output_reference_script() {
  !revoke_with_outputs(
    [
      Output {
        ..att_output(revoked(existing(), lo, 5)),
        reference_script: Some(other_script),
      },
    ],
  )
}

// ## RevokeAtt: common rules and datum

test revoke_att_output_datum_hash() {
  !revoke_with_outputs(
    [
      Output {
        ..att_output(revoked(existing(), lo, 5)),
        datum: DatumHash(hash_32),
      },
    ],
  )
}

test revoke_att_datum_not_attestation() {
  !revoke_with_outputs(
    [
      Output {
        ..att_output(revoked(existing(), lo, 5)),
        datum: InlineDatum(subject_record()),
      },
    ],
  )
}

test revoke_att_two_outputs_at_aa() {
  !revoke_with_outputs(
    [att_output(revoked(existing(), lo, 5)), ap3x_output_at(aa())],
  )
}

test revoke_att_two_attestation_inputs() {
  !revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      inputs: [
        att_input(existing()),
        second_attestation(),
        wallet_input(fee_ref()),
      ],
    },
  )
}

test revoke_att_input_without_token() {
  let input =
    att_input_with(
      Output {
        ..att_output(existing()),
        value: assets.from_lovelace(5_000_000),
      },
    )
  !revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      inputs: [input, wallet_input(fee_ref())],
    },
  )
}

test revoke_att_input_with_stake_credential() {
  let input =
    att_input_with(Output { ..att_output(existing()), address: staked(aa()) })
  !revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      inputs: [input, wallet_input(fee_ref())],
    },
  )
}

test revoke_att_with_mint_of_own_policy() {
  !revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      mint: assets.from_asset(own_hash, other_hash_32, 1),
    },
  )
}

test revoke_att_changes_other_field() {
  let new =
    AttestationDatum { ..revoked(existing(), lo, 5), digest: other_hash_32 }
  !revoke_passes(existing(), 5, spend_tx(existing(), new, issuer_signs()))
}

test revoke_att_at_not_lo() {
  !revoke_passes(
    existing(),
    5,
    spend_tx(existing(), revoked(existing(), hi, 5), issuer_signs()),
  )
}

test revoke_att_reason_not_redeemer_reason() {
  !revoke_passes(
    existing(),
    5,
    spend_tx(existing(), revoked(existing(), lo, 4), issuer_signs()),
  )
}

test revoke_att_reason_out_of_range() {
  and {
    !revoke_passes(
      existing(),
      -1,
      spend_tx(existing(), revoked(existing(), lo, -1), issuer_signs()),
    ),
    !revoke_passes(
      existing(),
      9_223_372_036_854_775_808,
      spend_tx(
        existing(),
        revoked(existing(), lo, 9_223_372_036_854_775_808),
        issuer_signs(),
      ),
    ),
  }
}

test revoke_att_already_revoked() {
  let old = revoked(existing(), lo - day_ms, 5)
  !revoke_passes(
    old,
    5,
    spend_tx(old, revoked(existing(), lo, 5), issuer_signs()),
  )
}

test revoke_att_range_over_one_hour() fail {
  revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      validity_range: range(lo, lo + one_hour + 1),
    },
  )
}

test revoke_att_unbounded_range() fail {
  revoke_passes(
    existing(),
    5,
    Transaction {
      ..revoke_tx(issuer_signs()),
      validity_range: interval.after(lo),
    },
  )
}

// ## Contest: must pass

test contest_by_subject_controller() {
  contest_passes(existing(), contest_tx(subject_signs()))
}

test contest_via_handle_spend() {
  handle_spend(
    identity_hash,
    existing(),
    Contest,
    att_ref(),
    contest_tx(subject_signs()),
  )
}

test contest_replaces_anchor() {
  let old = contested(existing(), Anchor { uri: "a", sha256: hash_32 })
  contest_passes(old, spend_tx(old, contested(old, anchor()), subject_signs()))
}

test contest_revoked_attestation() {
  let old = revoked(existing(), lo - day_ms, 5)
  contest_passes(old, spend_tx(old, contested(old, anchor()), subject_signs()))
}

test contest_unregistered_issuer() {
  let old = existing_unregistered()
  contest_passes(old, spend_tx(old, contested(old, anchor()), subject_signs()))
}

test contest_uri_bounds() {
  and {
    contest_with_anchor(Anchor { uri: bytes(1), sha256: hash_32 }),
    contest_with_anchor(Anchor { uri: bytes(256), sha256: hash_32 }),
  }
}

test contest_subject_tombstone() {
  contest_passes(
    existing(),
    Transaction {
      ..contest_tx(subject_signs()),
      reference_inputs: records_with_subject(tombstone(subject_record())),
    },
  )
}

// ## Contest: §12.1 attacks

test contest_by_issuer() {
  !contest_passes(existing(), contest_tx(issuer_signs()))
}

test contest_by_issuer_controller() {
  !contest_passes(existing(), contest_tx([pkh(issuer_controller)]))
}

test contest_no_subject_record() {
  !contest_passes(
    existing(),
    Transaction {
      ..contest_tx(subject_signs()),
      reference_inputs: [record_input(issuer_id, issuer_record())],
    },
  )
}

test contest_token_to_key_address() {
  !contest_with_outputs(
    [
      Output {
        ..att_output(contested(existing(), anchor())),
        address: wallet(),
      },
    ],
  )
}

test contest_value_lowered() {
  !contest_with_outputs(
    [
      Output {
        ..att_output(contested(existing(), anchor())),
        value: att_value(4_999_999),
      },
    ],
  )
}

test contest_output_stake_credential() {
  !contest_with_outputs(
    [
      Output {
        ..att_output(contested(existing(), anchor())),
        address: staked(aa()),
      },
    ],
  )
}

test contest_output_foreign_asset() {
  !contest_with_outputs(
    [
      Output {
        ..att_output(contested(existing(), anchor())),
        value: att_value(5_000_000) |> assets.add(other_policy, "x", 1),
      },
    ],
  )
}

test contest_output_reference_script() {
  !contest_with_outputs(
    [
      Output {
        ..att_output(contested(existing(), anchor())),
        reference_script: Some(other_script),
      },
    ],
  )
}

// ## Contest: common rules and datum

test contest_changes_status() {
  !contest_passes(
    existing(),
    spend_tx(
      existing(),
      revoked(contested(existing(), anchor()), lo, 5),
      subject_signs(),
    ),
  )
}

test contest_changes_other_field() {
  !contest_passes(
    existing(),
    spend_tx(
      existing(),
      AttestationDatum { ..contested(existing(), anchor()), locator: None },
      subject_signs(),
    ),
  )
}

test contest_removes_anchor() {
  let old = contested(existing(), anchor())
  !contest_passes(old, spend_tx(old, existing(), subject_signs()))
}

test contest_anchor_limits() {
  and {
    !contest_with_anchor(Anchor { uri: "", sha256: hash_32 }),
    !contest_with_anchor(Anchor { uri: bytes(257), sha256: hash_32 }),
    !contest_with_anchor(Anchor { uri: bytes(10), sha256: bytes(31) }),
    !contest_with_anchor(Anchor { uri: bytes(10), sha256: bytes(33) }),
  }
}

test contest_with_burn_of_own_policy() {
  !contest_passes(
    existing(),
    Transaction {
      ..contest_tx(subject_signs()),
      mint: assets.from_asset(own_hash, other_hash_32, -1),
    },
  )
}

test contest_two_attestation_inputs() {
  !contest_passes(
    existing(),
    Transaction {
      ..contest_tx(subject_signs()),
      inputs: [
        att_input(existing()),
        second_attestation(),
        wallet_input(fee_ref()),
      ],
    },
  )
}

test contest_input_without_token() {
  let input =
    att_input_with(
      Output {
        ..att_output(existing()),
        value: assets.from_lovelace(5_000_000),
      },
    )
  !contest_passes(
    existing(),
    Transaction {
      ..contest_tx(subject_signs()),
      inputs: [input, wallet_input(fee_ref())],
    },
  )
}

test contest_input_with_stake_credential() {
  let input =
    att_input_with(Output { ..att_output(existing()), address: staked(aa()) })
  !contest_passes(
    existing(),
    Transaction {
      ..contest_tx(subject_signs()),
      inputs: [input, wallet_input(fee_ref())],
    },
  )
}

test contest_two_outputs_at_aa() {
  !contest_with_outputs(
    [att_output(contested(existing(), anchor())), ap3x_output_at(aa())],
  )
}

test contest_output_datum_hash() {
  !contest_with_outputs(
    [
      Output {
        ..att_output(contested(existing(), anchor())),
        datum: DatumHash(hash_32),
      },
    ],
  )
}

test contest_datum_not_attestation() fail {
  contest_with_outputs(
    [Output { ..att_output(existing()), datum: InlineDatum(subject_record()) }],
  )
}

test contest_unbounded_range() fail {
  contest_passes(
    existing(),
    Transaction {
      ..contest_tx(subject_signs()),
      validity_range: interval.before(hi),
    },
  )
}

test contest_range_over_one_hour() fail {
  contest_passes(
    existing(),
    Transaction {
      ..contest_tx(subject_signs()),
      validity_range: range(lo, lo + one_hour + 1),
    },
  )
}

// ## Withdraw and Burn: must pass

test withdraw_after_revocation() {
  withdraw_passes(revoked_at_lo(), withdraw_on_time(issuer_signs()))
}

test withdraw_after_expiry() {
  withdraw_passes(
    existing(),
    withdraw_tx(existing(), lo + days_30_ms + days_90_ms, issuer_signs()),
  )
}

test withdraw_revoked_before_expiry() {
  let old =
    revoked(
      AttestationDatum {
        ..existing(),
        valid_until: Some(lo + days_366_ms - days_30_ms),
      },
      lo,
      5,
    )
  withdraw_passes(old, withdraw_tx(old, lo + days_90_ms, issuer_signs()))
}

test withdraw_via_handle_spend() {
  handle_spend(
    identity_hash,
    revoked_at_lo(),
    Withdraw,
    att_ref(),
    withdraw_on_time(issuer_signs()),
  )
}

test withdraw_by_issuer_controller() {
  withdraw_passes(revoked_at_lo(), withdraw_on_time([pkh(issuer_controller)]))
}

test withdraw_unregistered_issuer() {
  let old = revoked(existing_unregistered(), lo, 5)
  withdraw_passes(old, withdraw_tx(old, lo + days_90_ms, issuer_signs()))
}

test burn_with_withdraw() {
  burn_passes(withdraw_on_time(issuer_signs()))
}

test burn_via_handle_mint() {
  handle_mint(identity_hash, Burn, own_hash, withdraw_on_time(issuer_signs()))
}

// ## Withdraw and Burn: §12.1 attacks

test withdraw_by_removed_issuer_key() {
  !withdraw_passes(
    revoked_at_lo(),
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      reference_inputs: records_with_issuer(issuer_record_without_key()),
    },
  )
}

test withdraw_issuer_record_missing() {
  !withdraw_passes(
    revoked_at_lo(),
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      reference_inputs: [record_input(subject_id, subject_record())],
    },
  )
}

test withdraw_by_subject() {
  !withdraw_passes(revoked_at_lo(), withdraw_on_time(subject_signs()))
}

test withdraw_revoked_before_90_days() {
  !withdraw_passes(
    revoked_at_lo(),
    withdraw_tx(revoked_at_lo(), lo + days_90_ms - 1, issuer_signs()),
  )
}

test withdraw_expired_before_90_days() {
  !withdraw_passes(
    existing(),
    withdraw_tx(existing(), lo + days_30_ms + days_90_ms - 1, issuer_signs()),
  )
}

test withdraw_active_without_valid_until() {
  let old = AttestationDatum { ..existing(), att_type: 0, valid_until: None }
  !withdraw_passes(old, withdraw_tx(old, lo + 10 * days_366_ms, issuer_signs()))
}

test withdraw_burn_of_two_tokens_with_one_input() {
  let tx = withdraw_on_time(issuer_signs())
  let two =
    Transaction {
      ..tx,
      mint: tx.mint |> assets.add(own_hash, other_hash_32, -1),
    }
  and {
    !withdraw_passes(revoked_at_lo(), two),
    !burn_passes(two),
  }
}

test withdraw_two_inputs_one_burn() {
  let tx = withdraw_on_time(issuer_signs())
  let two =
    Transaction {
      ..tx,
      inputs: [
        att_input(revoked_at_lo()),
        second_attestation(),
        wallet_input(fee_ref()),
      ],
    }
  and {
    !withdraw_passes(revoked_at_lo(), two),
    !burn_passes(two),
  }
}

test withdraw_two_inputs_two_burns() {
  let tx = withdraw_on_time(issuer_signs())
  let two =
    Transaction {
      ..tx,
      inputs: [
        att_input(revoked_at_lo()),
        second_attestation(),
        wallet_input(fee_ref()),
      ],
      mint: tx.mint |> assets.add(own_hash, other_hash_32, -1),
      redeemers: [
        Pair(Spend(second_attestation().output_reference), withdraw_redeemer()),
        ..tx.redeemers
      ],
    }
  and {
    !withdraw_passes(revoked_at_lo(), two),
    !burn_passes(two),
  }
}

test withdraw_without_burn() {
  !withdraw_passes(
    revoked_at_lo(),
    Transaction { ..withdraw_on_time(issuer_signs()), mint: assets.zero },
  )
}

test withdraw_burn_of_other_token() {
  let tx =
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      mint: assets.from_asset(own_hash, other_hash_32, -1),
    }
  and {
    !withdraw_passes(revoked_at_lo(), tx),
    !burn_passes(tx),
  }
}

test withdraw_burn_quantity_two() {
  let tx =
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      mint: assets.from_asset(own_hash, att_id(), -2),
    }
  and {
    !withdraw_passes(revoked_at_lo(), tx),
    !burn_passes(tx),
  }
}

test burn_with_other_spend_redeemer() {
  let tx = withdraw_on_time(issuer_signs())
  let revoke: Data = RevokeAtt { reason: 5 }
  let contest_redeemer: Data = Contest
  and {
    !burn_passes(
      Transaction {
        ..tx,
        redeemers: [
          Pair(transaction.Mint(own_hash), burn_redeemer()),
          Pair(Spend(att_ref()), revoke),
        ],
      },
    ),
    !burn_passes(
      Transaction {
        ..tx,
        redeemers: [
          Pair(transaction.Mint(own_hash), burn_redeemer()),
          Pair(Spend(att_ref()), contest_redeemer),
        ],
      },
    ),
  }
}

test burn_without_spend_redeemer() {
  !burn_passes(
    Transaction { ..withdraw_on_time(issuer_signs()), redeemers: [] },
  )
}

test burn_with_positive_quantity() {
  !burn_passes(
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      mint: assets.from_asset(own_hash, att_id(), 1),
    },
  )
}

test burn_without_attestation_input() {
  !burn_passes(
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      inputs: [wallet_input(fee_ref())],
    },
  )
}

test withdraw_input_with_stake_credential() {
  let input =
    att_input_with(
      Output { ..att_output(revoked_at_lo()), address: staked(aa()) },
    )
  let tx =
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      inputs: [input, wallet_input(fee_ref())],
    }
  and {
    !withdraw_passes(revoked_at_lo(), tx),
    !burn_passes(tx),
  }
}

test withdraw_input_without_token() {
  let input =
    att_input_with(
      Output {
        ..att_output(revoked_at_lo()),
        value: assets.from_lovelace(5_000_000),
      },
    )
  let tx =
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      inputs: [input, wallet_input(fee_ref())],
    }
  and {
    !withdraw_passes(revoked_at_lo(), tx),
    !burn_passes(tx),
  }
}

test withdraw_range_over_one_hour() fail {
  withdraw_passes(
    revoked_at_lo(),
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      validity_range: range(lo + days_90_ms, lo + days_90_ms + one_hour + 1),
    },
  )
}

test withdraw_unbounded_range() fail {
  withdraw_passes(
    revoked_at_lo(),
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      validity_range: interval.after(lo + days_90_ms),
    },
  )
}

test burn_unbounded_range() fail {
  burn_passes(
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      validity_range: interval.after(lo + days_90_ms),
    },
  )
}

test burn_range_over_one_hour() fail {
  burn_passes(
    Transaction {
      ..withdraw_on_time(issuer_signs()),
      validity_range: range(lo + days_90_ms, lo + days_90_ms + one_hour + 1),
    },
  )
}

// ## Largest cases (budget)
//
// The transactions are compile-time constants, so these budgets show the
// cost of the rules: a depth-4 subagent issuer with 8 keys (the issuer key
// last), 8 parties and 16 capabilities, its four ancestors, a large subject
// record, 4 links and 256-byte locator and anchor.

test largest_attest() {
  attest(identity_hash, own_hash, seed(), largest_attest_tx)
}

test largest_revoke_att() {
  revoke_att(identity_hash, largest_existing(), 5, att_ref(), largest_revoke_tx)
}

test largest_contest() {
  contest(identity_hash, largest_existing(), att_ref(), largest_contest_tx)
}

test largest_withdraw() {
  withdraw(
    identity_hash,
    revoked(largest_existing(), lo, 5),
    att_ref(),
    largest_withdraw_tx,
  )
}

test largest_burn() {
  burn(own_hash, largest_withdraw_tx)
}
