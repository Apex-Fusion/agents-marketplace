//// Rules of the new advert contract: Part 2 §6.2 of
//// `docs/IDENTITY_REGISTRY.md`. The validator `validators/advert.ak` passes
//// every spend to `spend`.
////
//// The rules of the legacy advert (`contracts/marketplace/validators/advert.ak`)
//// stay:
////
//// - PostAdvert creates an output and runs no spend; as a spend redeemer it
////   fails;
//// - UpdateAdvert: the supplier key signs; exactly one output has the payment
////   credential of the advert input, with an inline datum that decodes as
////   `AdvertDatum`; `supplier_pkh` stays; `advertised_at` does not go down.
////   §6.2 adds: `agent_id` stays;
//// - RetireAdvert: the supplier key signs, and an output pays to the
////   supplier's key.
////
//// The contract does not check identity. The listing rule of §6.2 is checked
//// off-chain (indexer and builders).

use aiken/builtin
use aiken/collection/list
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use identity_marketplace/common.{inline_datum, signed_by}
use identity_marketplace/types.{
  Active, AdvertDatum, AdvertRedeemer, PostAdvert, RetireAdvert, Retired,
  UpdateAdvert,
}

/// Every rule of §6.2 for the spend of the advert output `own_ref`, whose
/// datum is `datum`.
pub fn spend(
  datum: AdvertDatum,
  redeemer: AdvertRedeemer,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  when redeemer is {
    PostAdvert -> False
    UpdateAdvert -> update(datum, own_ref, tx)
    RetireAdvert -> retire(datum, tx)
  }
}

/// UpdateAdvert. Fails when the number of continuing outputs is not one, or
/// when the continuing datum is not inline or does not decode as
/// `AdvertDatum` (legacy behaviour).
pub fn update(
  datum: AdvertDatum,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  expect Some(own_input) = transaction.find_input(tx.inputs, own_ref)
  let credential = own_input.output.address.payment_credential
  expect [continuing] =
    list.filter(
      tx.outputs,
      fn(output) { output.address.payment_credential == credential },
    )
  expect new_datum: AdvertDatum = inline_datum(continuing)
  and {
    signed_by(tx.extra_signatories, datum.supplier_pkh),
    new_datum.supplier_pkh == datum.supplier_pkh,
    new_datum.advertised_at >= datum.advertised_at,
    new_datum.agent_id == datum.agent_id,
  }
}

/// RetireAdvert: the supplier key signs, and at least one output has the
/// payment credential `VerificationKey(supplier_pkh)`.
pub fn retire(datum: AdvertDatum, tx: Transaction) -> Bool {
  and {
    signed_by(tx.extra_signatories, datum.supplier_pkh),
    list.any(
      tx.outputs,
      fn(output) {
        output.address.payment_credential == VerificationKey(datum.supplier_pkh)
      },
    ),
  }
}

// ## Tests
//
// The 9 tests of the legacy advert (`contracts/marketplace/validators/advert.ak`)
// are ported with the same names: the datum has `agent_id`, and an
// adversarial test asserts `False` (`!update(...)`) instead of a `fail` test
// with `expect`. Then the new tests: `agent_id` stays, and the legacy shape
// rules that the legacy tests did not cover.

const supplier_a: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const supplier_b: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const advert_script_hash: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

const detail_hash_sample: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const agent_a: ByteArray =
  #"a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9"

const agent_b: ByteArray =
  #"b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8"

fn advert_address() -> Address {
  Address {
    payment_credential: Script(advert_script_hash),
    stake_credential: None,
  }
}

fn supplier_address(pkh: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(pkh), stake_credential: None }
}

fn fresh_active_advert(supplier_pkh: ByteArray, ts: Int) -> AdvertDatum {
  AdvertDatum {
    supplier_pkh,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: 1_000_000,
    supplier_bond_lovelace: 1_000_000,
    buyer_bond_lovelace: 1_000_000,
    endpoint_url: "https://supplier.example.com/v1",
    detail_uri: "ipfs://Qm...",
    detail_hash: detail_hash_sample,
    advertised_at: ts,
    status: Active,
    agent_id: agent_a,
  }
}

fn advert_input(ref: OutputReference, datum: AdvertDatum) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: advert_address(),
      value: assets.from_lovelace(2_000_000),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn advert_output(datum: AdvertDatum) -> Output {
  Output {
    address: advert_address(),
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn supplier_output(pkh: ByteArray) -> Output {
  Output {
    address: supplier_address(pkh),
    value: assets.from_lovelace(2_000_000),
    datum: NoDatum,
    reference_script: None,
  }
}

fn placeholder_ref(ix: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: ix,
  }
}

fn base_tx() -> Transaction {
  transaction.placeholder
}

/// An UpdateAdvert from `old_datum` with the given outputs, signed by
/// `supplier_a`.
fn update_tx(old_datum: AdvertDatum, outputs: List<Output>) -> Transaction {
  Transaction {
    ..base_tx(),
    inputs: [advert_input(placeholder_ref(0), old_datum)],
    outputs,
    extra_signatories: [supplier_a],
  }
}

/// The datum in the legacy layout: the 13 legacy fields, without `agent_id`.
fn legacy_layout(datum: AdvertDatum) -> Data {
  let data: Data = datum
  let Pair(_, fields) = builtin.un_constr_data(data)
  builtin.constr_data(0, list.take(fields, 13))
}

// ─── Happy: PostAdvert (off-chain shape rule) ─────────────────────────
// PostAdvert is enforced off-chain (no spend triggered at creation). This
// test asserts that a freshly constructed advert datum has the spec-required
// shape — Active status, advertised_at populated, supplier_pkh non-empty.
test post_advert_shape_is_well_formed() {
  let d = fresh_active_advert(supplier_a, 1_000_000)
  d.status == Active && d.advertised_at == 1_000_000 && d.supplier_pkh == supplier_a && d.agent_id == agent_a
}

// ─── Happy: UpdateAdvert ──────────────────────────────────────────────
test update_advert_happy_path() {
  let own_ref = placeholder_ref(0)
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let new_datum = fresh_active_advert(supplier_a, 2_000_000)
  let t =
    Transaction {
      ..base_tx(),
      inputs: [advert_input(own_ref, old_datum)],
      outputs: [advert_output(new_datum)],
      extra_signatories: [supplier_a],
    }
  update(old_datum, own_ref, t)
}

test update_advert_active_to_retired_allowed() {
  let own_ref = placeholder_ref(0)
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let new_datum =
    AdvertDatum { ..old_datum, status: Retired, advertised_at: 1_500_000 }
  let t =
    Transaction {
      ..base_tx(),
      inputs: [advert_input(own_ref, old_datum)],
      outputs: [advert_output(new_datum)],
      extra_signatories: [supplier_a],
    }
  update(old_datum, own_ref, t)
}

// ─── Adversarial: UpdateAdvert ────────────────────────────────────────
test update_advert_rejects_different_supplier() {
  let own_ref = placeholder_ref(0)
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let new_datum = fresh_active_advert(supplier_b, 2_000_000)
  let t =
    Transaction {
      ..base_tx(),
      inputs: [advert_input(own_ref, old_datum)],
      outputs: [advert_output(new_datum)],
      extra_signatories: [supplier_a],
    }
  !update(old_datum, own_ref, t)
}

test update_advert_rejects_unsigned() {
  let own_ref = placeholder_ref(0)
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let new_datum = fresh_active_advert(supplier_a, 2_000_000)
  let t =
    Transaction {
      ..base_tx(),
      inputs: [advert_input(own_ref, old_datum)],
      outputs: [advert_output(new_datum)],
      extra_signatories: [],
    }
  !update(old_datum, own_ref, t)
}

test update_advert_rejects_timestamp_regress() {
  let own_ref = placeholder_ref(0)
  let old_datum = fresh_active_advert(supplier_a, 2_000_000)
  let new_datum = fresh_active_advert(supplier_a, 1_000_000)
  let t =
    Transaction {
      ..base_tx(),
      inputs: [advert_input(own_ref, old_datum)],
      outputs: [advert_output(new_datum)],
      extra_signatories: [supplier_a],
    }
  !update(old_datum, own_ref, t)
}

// ─── Happy: RetireAdvert ──────────────────────────────────────────────
test retire_advert_happy_path() {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let t =
    Transaction {
      ..base_tx(),
      outputs: [supplier_output(supplier_a)],
      extra_signatories: [supplier_a],
    }
  retire(old_datum, t)
}

// ─── Adversarial: RetireAdvert ────────────────────────────────────────
test retire_advert_rejects_payment_to_wrong_address() {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let t =
    Transaction {
      ..base_tx(),
      outputs: [supplier_output(supplier_b)],
      extra_signatories: [supplier_a],
    }
  !retire(old_datum, t)
}

test retire_advert_rejects_unsigned() {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let t =
    Transaction {
      ..base_tx(),
      outputs: [supplier_output(supplier_a)],
      extra_signatories: [],
    }
  !retire(old_datum, t)
}

// ─── New: agent_id (§6.2) ─────────────────────────────────────────────
test update_advert_rejects_changed_agent_id() {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let new_datum = AdvertDatum { ..old_datum, agent_id: agent_b }
  !update(
    old_datum,
    placeholder_ref(0),
    update_tx(old_datum, [advert_output(new_datum)]),
  )
}

test update_advert_keeps_agent_id_with_other_changes() {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let new_datum =
    AdvertDatum {
      ..old_datum,
      price_lovelace: 2_000_000,
      endpoint_url: "https://supplier.example.com/v2",
      advertised_at: 1_000_000,
    }
  update(
    old_datum,
    placeholder_ref(0),
    update_tx(old_datum, [advert_output(new_datum)]),
  )
}

// ─── Redeemer routing ─────────────────────────────────────────────────
test post_advert_spend_rejected() {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let new_datum = fresh_active_advert(supplier_a, 2_000_000)
  let t = update_tx(old_datum, [advert_output(new_datum)])
  and {
    spend(old_datum, UpdateAdvert, placeholder_ref(0), t),
    !spend(old_datum, PostAdvert, placeholder_ref(0), t),
    spend(
      old_datum,
      RetireAdvert,
      placeholder_ref(0),
      Transaction { ..t, outputs: [supplier_output(supplier_a)] },
    ),
  }
}

// ─── Legacy shape rules ───────────────────────────────────────────────
test update_advert_rejects_two_continuing_outputs() fail {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let new_datum = fresh_active_advert(supplier_a, 2_000_000)
  update(
    old_datum,
    placeholder_ref(0),
    update_tx(old_datum, [advert_output(new_datum), advert_output(new_datum)]),
  )
}

test update_advert_rejects_missing_continuing_output() fail {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  update(
    old_datum,
    placeholder_ref(0),
    update_tx(old_datum, [supplier_output(supplier_a)]),
  )
}

test update_advert_rejects_datum_hash() fail {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  update(
    old_datum,
    placeholder_ref(0),
    update_tx(
      old_datum,
      [
        Output {
          ..advert_output(old_datum),
          datum: DatumHash(detail_hash_sample),
        },
      ],
    ),
  )
}

test update_advert_rejects_legacy_layout() fail {
  // A continuing datum without `agent_id` does not decode as `AdvertDatum`.
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  update(
    old_datum,
    placeholder_ref(0),
    update_tx(
      old_datum,
      [
        Output {
          ..advert_output(old_datum),
          datum: InlineDatum(legacy_layout(old_datum)),
        },
      ],
    ),
  )
}
