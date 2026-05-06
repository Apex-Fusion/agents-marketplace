//// AdvertScript — supplier advertisement registry.
////
//// ARCHITECTURE.md §4.1. Three logical operations on an advert UTxO:
////
////   PostAdvert    — Create a fresh advert UTxO with status: Active.
////                   This is a CREATION event; spending validators do not
////                   run on output creation. PostAdvert is enforced
////                   OFF-CHAIN by M1-B's tx builder (datum shape, signer).
////                   We declare it as a redeemer constructor for symmetry
////                   with the TS side, but the on-chain `spend` handler
////                   does not see it.
////
////   UpdateAdvert  — Spend an existing advert UTxO and produce a new one
////                   at the same script address. Same supplier_pkh in old
////                   and new datum; new advertised_at >= old advertised_at;
////                   status may flip Active <-> Retired or stay; signed by
////                   supplier_pkh.
////
////   RetireAdvert  — Spend the advert UTxO; produce an output to the
////                   supplier's wallet (verification-key payment cred).
////                   Returns the deposit. Signed by supplier_pkh.
////
//// Cross-spec note: ARCHITECTURE.md does not require the new advert UTxO
//// after `UpdateAdvert` to preserve any specific value, only that it remain
//// at the same script address. We do NOT enforce a value-preservation rule
//// here — the tx builder (M1-B) is responsible for choosing a deposit.

use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, find_input,
}
use marketplace/common.{
  output_paid_to_pkh, signed_by, unique_output_to_credential,
}
use marketplace/types.{
  Active, AdvertDatum, AdvertRedeemer, PostAdvert, Retired, RetireAdvert,
  UpdateAdvert,
}

validator advert {
  spend(
    datum: Option<AdvertDatum>,
    redeemer: AdvertRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(old_datum) = datum

    when redeemer is {
      // PostAdvert is a creation-event rule and cannot occur as a spend
      // redeemer — there is nothing to spend at creation. If it ever shows
      // up here, the tx is malformed and we reject.
      PostAdvert -> False

      UpdateAdvert -> handle_update(old_datum, own_ref, self)

      RetireAdvert -> handle_retire(old_datum, self)
    }
  }
}

// ─── UpdateAdvert ────────────────────────────────────────────────────

fn handle_update(
  old_datum: AdvertDatum,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  // Find our own input to learn its address (we re-bind to that same
  // address on output).
  expect Some(own_input) = find_input(self.inputs, own_ref)
  let own_credential = own_input.output.address.payment_credential

  // Exactly one continuing output to the same script credential.
  let continuing = unique_output_to_credential(self.outputs, own_credential)

  // The new datum must be inline and parse as an AdvertDatum.
  expect new_datum: AdvertDatum = inline_datum_of(continuing)

  let signer_ok = signed_by(self.extra_signatories, old_datum.supplier_pkh)
  let supplier_unchanged = new_datum.supplier_pkh == old_datum.supplier_pkh
  let timestamp_monotonic = new_datum.advertised_at >= old_datum.advertised_at

  signer_ok && supplier_unchanged && timestamp_monotonic
}

// ─── RetireAdvert ────────────────────────────────────────────────────

fn handle_retire(old_datum: AdvertDatum, self: Transaction) -> Bool {
  // Signed by the supplier.
  let signer_ok = signed_by(self.extra_signatories, old_datum.supplier_pkh)

  // At least one output pays back to the supplier's wallet (verification-key
  // payment credential). We don't require a specific amount — the deposit
  // size is M1-B's policy choice, and locking it here would couple the
  // validator to a TS-side constant.
  let returns_to_supplier =
    output_to_supplier_present(self.outputs, old_datum.supplier_pkh)

  signer_ok && returns_to_supplier
}

fn output_to_supplier_present(
  outputs: List<Output>,
  supplier_pkh: ByteArray,
) -> Bool {
  when outputs is {
    [] -> False
    [head, ..tail] ->
      if output_paid_to_pkh(head, supplier_pkh) {
        True
      } else {
        output_to_supplier_present(tail, supplier_pkh)
      }
  }
}

// ─── Datum extraction ────────────────────────────────────────────────

fn inline_datum_of(output: Output) -> Data {
  when output.datum is {
    InlineDatum(d) -> d
    _ -> fail @"continuing advert output must carry an inline datum"
  }
}

// ─── Tests ───────────────────────────────────────────────────────────
//
// Aiken `test` blocks below cover the happy and adversarial paths called
// out in the M1-A brief and ARCHITECTURE.md §7.3.

const supplier_a: ByteArray = #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const supplier_b: ByteArray = #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const advert_script_hash: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

const detail_hash_sample: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

fn advert_address() -> Address {
  Address {
    payment_credential: Script(advert_script_hash),
    stake_credential: None,
  }
}

fn supplier_address(pkh: ByteArray) -> Address {
  Address {
    payment_credential: VerificationKey(pkh),
    stake_credential: None,
  }
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

// ─── Happy: PostAdvert (off-chain shape rule) ─────────────────────────
// PostAdvert is enforced off-chain (no spend triggered at creation). This
// test asserts that a freshly constructed advert datum has the spec-required
// shape — Active status, advertised_at populated, supplier_pkh non-empty.
test post_advert_shape_is_well_formed() {
  let d = fresh_active_advert(supplier_a, 1_000_000)
  d.status == Active && d.advertised_at == 1_000_000 && d.supplier_pkh == supplier_a
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
  handle_update(old_datum, own_ref, t)
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
  handle_update(old_datum, own_ref, t)
}

// ─── Adversarial: UpdateAdvert ────────────────────────────────────────
test update_advert_rejects_different_supplier() fail {
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
  expect handle_update(old_datum, own_ref, t)
  True
}

test update_advert_rejects_unsigned() fail {
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
  expect handle_update(old_datum, own_ref, t)
  True
}

test update_advert_rejects_timestamp_regress() fail {
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
  expect handle_update(old_datum, own_ref, t)
  True
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
  handle_retire(old_datum, t)
}

// ─── Adversarial: RetireAdvert ────────────────────────────────────────
test retire_advert_rejects_payment_to_wrong_address() fail {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let t =
    Transaction {
      ..base_tx(),
      outputs: [supplier_output(supplier_b)],
      extra_signatories: [supplier_a],
    }
  expect handle_retire(old_datum, t)
  True
}

test retire_advert_rejects_unsigned() fail {
  let old_datum = fresh_active_advert(supplier_a, 1_000_000)
  let t =
    Transaction {
      ..base_tx(),
      outputs: [supplier_output(supplier_a)],
      extra_signatories: [],
    }
  expect handle_retire(old_datum, t)
  True
}
