//// Test data for the escrow tests. Only tests use this module.
////
//// The amounts and times are those of the legacy escrow tests
//// (`contracts/marketplace/validators/escrow.ak`). The supplier key is now an
//// Ed25519 key that the agent's identity record lists with the transaction
//// purpose, so `supplier_pkh` is its key hash.
////
//// A `Case` is a datum, a redeemer and a transaction. Each `*_case` function
//// gives a case that passes; a test changes one part of it.

use aiken/collection/list
use aiken/crypto.{blake2b_224}
use aiken/interval.{Finite, Interval, IntervalBound}
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets.{Value}
use cardano/transaction.{
  Datum, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
  ValidityRange,
}
use identity_marketplace/common.{accept_window_ms}
use identity_marketplace/escrow/rules
use identity_marketplace/types.{
  Accept, Claim, Claimed, EscrowDatum, EscrowRedeemer, Open, PrincipalKey,
  Reclaim, Refund, RefundRevoked, Release, Returned, Submit, Submitted,
}
use vector_identity.{max_time_ms}
use vector_identity/types.{
  Accountable, Active, ControllerSet, Distributor, Ed25519, Guardian, Hold,
  IdentityDatum, Key, KeyHash, P256, Party, PendingRecovery, Provider,
  Responsible, Retired, Revoked, Role, Root, Status, Suspended,
} as identity

// ## Keys, hashes and identifiers

/// The script hash and policy ID of the identity contract (the escrow
/// parameter).
pub const identity_hash: ByteArray =
  #"1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d"

/// The new escrow script (the legacy test value).
pub const escrow_hash: ByteArray =
  #"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab"

/// The script hash of the legacy escrow (§6.5).
pub const legacy_escrow_hash: ByteArray =
  #"810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912"

/// Another script, for example a vault.
pub const other_script_hash: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

pub const buyer_pkh: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

pub const stranger_pkh: ByteArray =
  #"33333333333333333333333333333333333333333333333333333333"

/// The supplier's Ed25519 public key.
pub const supplier_key: ByteArray =
  #"2222222222222222222222222222222222222222222222222222222222222222"

/// `blake2b_224(supplier_key)`: the escrow's `supplier_pkh`.
pub const supplier_pkh: ByteArray = blake2b_224(supplier_key)

/// Another Ed25519 key of the agent.
pub const other_key: ByteArray =
  #"4444444444444444444444444444444444444444444444444444444444444444"

/// The controller key of the agent's record.
pub const controller_key: ByteArray =
  #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

/// The identifier of the agent (the escrow's `agent_id`).
pub const agent_id: ByteArray =
  #"a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9"

/// The identifier of another agent.
pub const other_agent_id: ByteArray =
  #"b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8"

/// The identifier of a parent agent.
pub const parent_id: ByteArray =
  #"9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a"

pub const capability: ByteArray = "llm.text.generate.v1"

pub const advert_tx_hash: ByteArray =
  #"baadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaadbaad"

pub const request_hash: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

pub const prompt_hash: ByteArray =
  #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

pub const receipt_hash_32: ByteArray =
  #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

pub const receipt_hash_short: ByteArray = #"deadbeef"

// ## Times and amounts (legacy values)

pub const deliver_by_ms: Int = 5_000_000_000

pub const posted_at_ms: Int = 4_999_000_000

pub const submitted_at_ms: Int = 4_999_500_000

pub const payment_amt: Int = 5_000_000

pub const buyer_bond_amt: Int = 1_000_000

pub const supplier_bond_amt: Int = 1_000_000

/// The AP3X of the escrow input: payment + buyer bond + supplier bond.
pub const locked_ap3x: Int = 7_000_000

/// `created_at` of the agent's record.
pub const record_created_at: Int = 4_000_000_000

/// `at` of a revocation or retirement in the tests: after `submitted_at_ms`.
pub const ended_at_ms: Int = 4_999_600_000

// ## Addresses, inputs and outputs

/// A closed validity range `[lo, hi]` (legacy `validity_between`).
pub fn validity_between(lo: Int, hi: Int) -> ValidityRange {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lo), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(hi), is_inclusive: True },
  }
}

pub fn placeholder_ref(ix: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: ix,
  }
}

/// The reference of the escrow input that the tests spend.
pub fn own_ref() -> OutputReference {
  placeholder_ref(0)
}

/// The enterprise address of the escrow script.
pub fn escrow_address() -> Address {
  address.from_script(escrow_hash)
}

/// The enterprise address of a key.
pub fn key_address(pkh: ByteArray) -> Address {
  address.from_verification_key(pkh)
}

pub fn locked_value() -> Value {
  assets.from_lovelace(locked_ap3x)
}

pub fn output_at(address: Address, value: Value, datum: Datum) -> Output {
  Output { address, value, datum, reference_script: None }
}

/// The escrow input at `own_ref()`.
pub fn escrow_input(datum: EscrowDatum) -> Input {
  escrow_input_with(locked_value(), datum)
}

/// The escrow input at `own_ref()` with another value.
pub fn escrow_input_with(value: Value, datum: EscrowDatum) -> Input {
  Input {
    output_reference: own_ref(),
    output: output_at(escrow_address(), value, InlineDatum(datum)),
  }
}

/// The continuing escrow output.
pub fn escrow_output(datum: EscrowDatum) -> Output {
  output_at(escrow_address(), locked_value(), InlineDatum(datum))
}

/// An output at the enterprise address of `pkh`, without a datum.
pub fn pkh_output(pkh: ByteArray, lovelace: Int) -> Output {
  output_at(key_address(pkh), assets.from_lovelace(lovelace), NoDatum)
}

/// A wallet input of `pkh` (pays the fee).
pub fn wallet_input(pkh: ByteArray, ix: Int) -> Input {
  Input {
    output_reference: placeholder_ref(ix),
    output: output_at(
      key_address(pkh),
      assets.from_lovelace(5_000_000),
      NoDatum,
    ),
  }
}

/// A second input at `address`, with an escrow datum.
pub fn script_input(address: Address, ix: Int) -> Input {
  Input {
    output_reference: placeholder_ref(ix),
    output: output_at(address, locked_value(), InlineDatum(open_datum())),
  }
}

// ## Identity records

/// The supplier key with the given purposes.
pub fn supplier_key_entry(purposes: Int) -> Key {
  Key { key_type: Ed25519, key: supplier_key, purposes, pop: None }
}

/// An Accountable Party (the controller) from time 0, without an end.
pub fn accountable_party() -> Party {
  Party {
    role: Accountable,
    signer: ControllerSet,
    organisation: None,
    not_before: 0,
    not_after: None,
    rights: 3,
    removal_after: None,
  }
}

/// The agent's record: independent, Active and accountable. It lists the
/// supplier key with the authentication, assertion and transaction purposes,
/// and the escrow's capability.
pub fn supplier_record() -> IdentityDatum {
  IdentityDatum {
    controller: controller_key,
    keys: [
      Key { key_type: Ed25519, key: other_key, purposes: 3, pop: None },
      supplier_key_entry(11),
    ],
    parties: [accountable_party()],
    guardian_threshold: 0,
    pending_recovery: None,
    lineage: Root,
    subagent_epoch: 0,
    name: "supplier-agent",
    description: "Text generation",
    framework: "vector-agent-template",
    endpoint: "https://supplier.example.com/v1",
    capabilities: ["llm.chat.v1", capability],
    created_at: record_created_at,
    status: Active,
  }
}

/// The tombstone of `supplier_record()` with a terminal status (Part 2 §3.7).
pub fn tombstone(status: Status) -> IdentityDatum {
  IdentityDatum {
    ..supplier_record(),
    keys: [],
    parties: [],
    description: "",
    framework: "",
    endpoint: "",
    capabilities: [],
    status,
  }
}

/// A revocation by the controller. Reason 1 (keyCompromise) with
/// `invalid_from`, else reason 5 (cessationOfOperation).
pub fn revoked(invalid_from: Option<Int>) -> Status {
  let reason =
    when invalid_from is {
      Some(_) -> 1
      None -> 5
    }
  Revoked {
    by: ControllerSet,
    reason,
    at: ended_at_ms,
    invalid_from,
    successor: None,
  }
}

/// A retirement without a successor.
pub fn retired() -> Status {
  Retired { at: ended_at_ms, successor: None }
}

/// A hold by `hash` until `until`.
pub fn hold(hash: ByteArray, until: Int) -> Hold {
  Hold { by: KeyHash { hash }, reason: 6, since: until - 86_400_000, until }
}

/// A record output at the exact identity address with the token
/// `(identity_hash, id)`, as a reference input.
pub fn record_input(id: ByteArray, record: IdentityDatum) -> Input {
  record_input_with(
    address.from_script(identity_hash),
    record_value(identity_hash, id),
    record,
  )
}

pub fn record_input_with(
  address: Address,
  value: Value,
  record: IdentityDatum,
) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"7878787878787878787878787878787878787878787878787878787878787878",
      output_index: 0,
    },
    output: output_at(address, value, InlineDatum(record)),
  }
}

/// 10 AP3X and the token `(policy, id)`.
pub fn record_value(policy: ByteArray, id: ByteArray) -> Value {
  assets.from_lovelace(10_000_000) |> assets.add(policy, id, 1)
}

/// The agent's record as a reference input.
pub fn record_ref() -> Input {
  record_input(agent_id, supplier_record())
}

// ## Escrow datums

pub fn advert_ref() -> OutputReference {
  OutputReference { transaction_id: advert_tx_hash, output_index: 0 }
}

/// An Open escrow for the agent `agent_id`, without a refund address.
pub fn open_datum() -> EscrowDatum {
  EscrowDatum {
    buyer_pkh,
    supplier_pkh,
    advert_ref: advert_ref(),
    capability_id: capability,
    request_spec_hash: request_hash,
    prompt_hash,
    payment_lovelace: payment_amt,
    buyer_bond_lovelace: buyer_bond_amt,
    supplier_bond_lovelace: supplier_bond_amt,
    deliver_by: deliver_by_ms,
    posted_at: posted_at_ms,
    submitted_at: None,
    result_receipt_hash: None,
    state: Open,
    agent_id,
    refund: None,
  }
}

pub fn claimed_datum() -> EscrowDatum {
  EscrowDatum { ..open_datum(), state: Claimed }
}

pub fn submitted_datum() -> EscrowDatum {
  EscrowDatum {
    ..open_datum(),
    submitted_at: Some(submitted_at_ms),
    result_receipt_hash: Some(receipt_hash_32),
    state: Submitted,
  }
}

pub fn with_refund(datum: EscrowDatum, refund: Refund) -> EscrowDatum {
  EscrowDatum { ..datum, refund: Some(refund) }
}

/// The buyer's own address without a datum (the refund of the post builders,
/// §6.5).
pub fn buyer_refund() -> Refund {
  Refund { address: key_address(buyer_pkh), datum: None }
}

/// A vault-style refund (§5.3): a script address with an inline datum.
pub fn vault_refund() -> Refund {
  Refund {
    address: address.from_script(other_script_hash),
    datum: Some(vault_returned_datum()),
  }
}

/// The refund datum of a vault (§5.3): `Returned { owner }`, where the owner
/// is the buyer's principal key.
pub fn vault_returned_datum() -> Data {
  let datum: Data =
    Returned { owner: PrincipalKey { hash: buyer_pkh, organisation: None } }
  datum
}

// ## Cases

pub type Case {
  datum: EscrowDatum,
  redeemer: EscrowRedeemer,
  tx: Transaction,
}

/// Runs every rule of §6.1 for the case (the escrow input is `own_ref()`).
pub fn run(case: Case) -> Bool {
  rules.spend(identity_hash, case.datum, case.redeemer, own_ref(), case.tx)
}

/// The legacy Claim range: `[deliver_by - 1,000,000, deliver_by - 500,000]`.
pub fn claim_range() -> ValidityRange {
  validity_between(deliver_by_ms - 1_000_000, deliver_by_ms - 500_000)
}

/// The legacy Submit range, which ends at `submitted_at_ms`.
pub fn submit_range() -> ValidityRange {
  validity_between(deliver_by_ms - 1_000_000, submitted_at_ms)
}

pub fn accept_range() -> ValidityRange {
  validity_between(submitted_at_ms + 1, submitted_at_ms + accept_window_ms)
}

pub fn reclaim_range() -> ValidityRange {
  validity_between(deliver_by_ms, deliver_by_ms + 1_000_000)
}

pub fn release_range() -> ValidityRange {
  validity_between(
    submitted_at_ms + accept_window_ms,
    submitted_at_ms + accept_window_ms + 1_000_000,
  )
}

/// A range before `deliver_by`, for RefundRevoked.
pub fn early_range() -> ValidityRange {
  validity_between(posted_at_ms, posted_at_ms + 600_000)
}

pub fn claim_case() -> Case {
  Case {
    datum: open_datum(),
    redeemer: Claim,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(open_datum()), wallet_input(supplier_pkh, 1)],
      reference_inputs: [record_ref()],
      outputs: [
        escrow_output(claimed_datum()),
        pkh_output(supplier_pkh, 4_000_000),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: claim_range(),
    },
  }
}

pub fn submit_case() -> Case {
  Case {
    datum: claimed_datum(),
    redeemer: Submit { receipt_hash: receipt_hash_32 },
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(claimed_datum()), wallet_input(supplier_pkh, 1)],
      reference_inputs: [record_ref()],
      outputs: [
        escrow_output(submitted_datum()),
        pkh_output(supplier_pkh, 4_000_000),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: submit_range(),
    },
  }
}

pub fn accept_case() -> Case {
  Case {
    datum: submitted_datum(),
    redeemer: Accept,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(submitted_datum()), wallet_input(buyer_pkh, 1)],
      outputs: [
        pkh_output(supplier_pkh, payment_amt + supplier_bond_amt),
        pkh_output(buyer_pkh, buyer_bond_amt),
      ],
      extra_signatories: [buyer_pkh],
      validity_range: accept_range(),
    },
  }
}

/// Reclaim of an Open escrow without a refund address: the buyer signs.
pub fn reclaim_case() -> Case {
  Case {
    datum: open_datum(),
    redeemer: Reclaim,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(open_datum()), wallet_input(buyer_pkh, 1)],
      outputs: [pkh_output(buyer_pkh, locked_ap3x)],
      extra_signatories: [buyer_pkh],
      validity_range: reclaim_range(),
    },
  }
}

/// Reclaim of a Claimed escrow with the vault refund: a stranger submits it.
pub fn reclaim_refund_case() -> Case {
  let datum = with_refund(claimed_datum(), vault_refund())
  Case {
    datum,
    redeemer: Reclaim,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(datum), wallet_input(stranger_pkh, 1)],
      outputs: [
        output_at(
          vault_refund().address,
          locked_value(),
          InlineDatum(vault_returned_datum()),
        ),
      ],
      extra_signatories: [stranger_pkh],
      validity_range: reclaim_range(),
    },
  }
}

pub fn release_case() -> Case {
  Case {
    datum: submitted_datum(),
    redeemer: Release,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(submitted_datum()), wallet_input(supplier_pkh, 1)],
      outputs: [
        pkh_output(
          supplier_pkh,
          payment_amt + supplier_bond_amt + buyer_bond_amt,
        ),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: release_range(),
    },
  }
}

/// RefundRevoked of an Open escrow whose agent is revoked: a stranger submits
/// it before `deliver_by`, and the buyer key gets a full refund.
pub fn refund_revoked_case() -> Case {
  refund_revoked_case_with(open_datum(), tombstone(revoked(None)))
}

/// RefundRevoked of `datum` with the agent's `record`.
pub fn refund_revoked_case_with(
  datum: EscrowDatum,
  record: IdentityDatum,
) -> Case {
  Case {
    datum,
    redeemer: RefundRevoked,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [escrow_input(datum), wallet_input(stranger_pkh, 1)],
      reference_inputs: [record_input(agent_id, record)],
      outputs: [pkh_output(buyer_pkh, locked_ap3x)],
      extra_signatories: [],
      validity_range: early_range(),
    },
  }
}

/// A passing Claim of `datum` (state Open) whose escrow input holds `value`:
/// the continuing output keeps `value`, and `datum.supplier_pkh` signs.
pub fn claim_of(datum: EscrowDatum, value: Value) -> Case {
  let base = claim_case()
  Case {
    datum,
    redeemer: Claim,
    tx: Transaction {
      ..base.tx,
      inputs: [escrow_input_with(value, datum), wallet_input(supplier_pkh, 1)],
      outputs: [
        output_at(
          escrow_address(),
          value,
          InlineDatum(EscrowDatum { ..datum, state: Claimed }),
        ),
        pkh_output(supplier_pkh, 4_000_000),
      ],
      extra_signatories: [datum.supplier_pkh],
    },
  }
}

/// A passing Submit of `datum` (state Claimed) with `receipt_hash_32`.
pub fn submit_of(datum: EscrowDatum) -> Case {
  let base = submit_case()
  Case {
    datum,
    redeemer: Submit { receipt_hash: receipt_hash_32 },
    tx: Transaction {
      ..base.tx,
      inputs: [escrow_input(datum), wallet_input(supplier_pkh, 1)],
      outputs: [
        escrow_output(
          EscrowDatum {
            ..datum,
            submitted_at: Some(submitted_at_ms),
            result_receipt_hash: Some(receipt_hash_32),
            state: Submitted,
          },
        ),
        pkh_output(supplier_pkh, 4_000_000),
      ],
      extra_signatories: [datum.supplier_pkh],
    },
  }
}

/// One passing case for each redeemer, and Reclaim with a refund address.
pub fn every_case() -> List<Case> {
  [
    claim_case(),
    submit_case(),
    accept_case(),
    reclaim_case(),
    reclaim_refund_case(),
    release_case(),
    refund_revoked_case(),
  ]
}

// ## Case changes

pub fn with_tx(case: Case, tx: Transaction) -> Case {
  Case { ..case, tx }
}

/// Adds an input after the inputs of the case.
pub fn add_input(case: Case, input: Input) -> Case {
  with_tx(
    case,
    Transaction { ..case.tx, inputs: list.concat(case.tx.inputs, [input]) },
  )
}

pub fn with_range(case: Case, range: ValidityRange) -> Case {
  with_tx(case, Transaction { ..case.tx, validity_range: range })
}

pub fn with_outputs(case: Case, outputs: List<Output>) -> Case {
  with_tx(case, Transaction { ..case.tx, outputs })
}

pub fn with_refs(case: Case, refs: List<Input>) -> Case {
  with_tx(case, Transaction { ..case.tx, reference_inputs: refs })
}

pub fn with_signers(case: Case, signers: List<ByteArray>) -> Case {
  with_tx(case, Transaction { ..case.tx, extra_signatories: signers })
}

/// The case with another agent record (as the only reference input).
pub fn with_record(case: Case, record: IdentityDatum) -> Case {
  with_refs(case, [record_input(agent_id, record)])
}

/// A range of `width` ms that starts at the lower bound of the case's range.
pub fn widened(case: Case, width: Int) -> Case {
  expect Finite(lo) = case.tx.validity_range.lower_bound.bound_type
  with_range(case, validity_between(lo, lo + width))
}

// ## The largest record (§12.4)

/// The 16th capability of `largest_record()`: 64 bytes.
pub fn largest_capability() -> ByteArray {
  capability_item(16)
}

/// The largest record of §12.4 for Claim and Submit: 8 keys, 8 parties, 10
/// holds, 16 capabilities and the longest profile. The holds have ended, so
/// the effective status is Active. The supplier key, the Accountable Party
/// and the escrow's capability come last, so each search reads the whole list.
pub fn largest_record() -> IdentityDatum {
  IdentityDatum {
    controller: controller_key,
    keys: list.concat(
      list.map(list.range(1, 7), p256_key),
      [supplier_key_entry(27)],
    ),
    parties: [
      party(Responsible, 1, 1),
      party(Provider, 2, 1),
      party(Distributor, 3, 0),
      party(Guardian, 4, 4),
      party(Guardian, 5, 4),
      party(Guardian, 6, 4),
      party(Responsible, 7, 1),
      party(Accountable, 8, 3),
    ],
    guardian_threshold: 3,
    pending_recovery: Some(
      PendingRecovery {
        new_controller: #"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
        effective_after: max_time_ms,
      },
    ),
    lineage: Root,
    subagent_epoch: 9,
    name: filled(#"6e", 64),
    description: filled(#"64", 256),
    framework: filled(#"66", 64),
    endpoint: filled(#"65", 256),
    capabilities: list.map(list.range(1, 16), capability_item),
    created_at: record_created_at,
    status: Suspended {
      holds: list.map(
        list.range(1, 10),
        fn(i) { hold(signer_hash(#"48", i), record_created_at) },
      ),
    },
  }
}

/// Claim with `largest_record()`. The record comes after three other
/// reference inputs, and the transaction has two wallet inputs.
pub fn largest_claim_case() -> Case {
  let datum =
    EscrowDatum { ..open_datum(), capability_id: largest_capability() }
  Case {
    datum,
    redeemer: Claim,
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [
        escrow_input(datum),
        wallet_input(supplier_pkh, 1),
        wallet_input(supplier_pkh, 2),
      ],
      reference_inputs: largest_refs(),
      outputs: [
        escrow_output(EscrowDatum { ..datum, state: Claimed }),
        pkh_output(supplier_pkh, 9_000_000),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: claim_range(),
    },
  }
}

/// Submit with `largest_record()`.
pub fn largest_submit_case() -> Case {
  let datum =
    EscrowDatum {
      ..open_datum(),
      capability_id: largest_capability(),
      state: Claimed,
    }
  Case {
    datum,
    redeemer: Submit { receipt_hash: receipt_hash_32 },
    tx: Transaction {
      ..transaction.placeholder,
      inputs: [
        escrow_input(datum),
        wallet_input(supplier_pkh, 1),
        wallet_input(supplier_pkh, 2),
      ],
      reference_inputs: largest_refs(),
      outputs: [
        escrow_output(
          EscrowDatum {
            ..datum,
            submitted_at: Some(submitted_at_ms),
            result_receipt_hash: Some(receipt_hash_32),
            state: Submitted,
          },
        ),
        pkh_output(supplier_pkh, 9_000_000),
      ],
      extra_signatories: [supplier_pkh],
      validity_range: submit_range(),
    },
  }
}

/// Three other reference inputs (an escrow reference script output, another
/// agent's record and an advert-like output), then the largest record.
fn largest_refs() -> List<Input> {
  [
    Input {
      output_reference: placeholder_ref(7),
      output: Output {
        ..pkh_output(
          #"00000000000000000000000000000000000000000000000000000000",
          20_000_000,
        ),
        reference_script: Some(escrow_hash),
      },
    },
    record_input(other_agent_id, largest_record()),
    Input {
      output_reference: placeholder_ref(8),
      output: output_at(
        address.from_script(other_script_hash),
        assets.from_lovelace(2_000_000),
        InlineDatum(open_datum()),
      ),
    },
    record_input(agent_id, largest_record()),
  ]
}

/// A P-256 key (33 bytes) with the authentication and assertion purposes.
fn p256_key(i: Int) -> Key {
  Key {
    key_type: P256,
    key: bytearray.push(
      bytearray.push(
        #"e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7",
        i,
      ),
      2,
    ),
    purposes: 3,
    pop: Some(filled(#"50", 64)),
  }
}

/// A key-hash party with a 64-byte organisation and both optional times.
fn party(role: Role, i: Int, rights: Int) -> Party {
  Party {
    role,
    signer: KeyHash { hash: signer_hash(#"70", i) },
    organisation: Some(filled(#"6f", 64)),
    not_before: 0,
    not_after: Some(max_time_ms),
    rights,
    removal_after: Some(max_time_ms),
  }
}

/// A 28-byte hash: `byte` 27 times, then `i`.
fn signer_hash(byte: ByteArray, i: Int) -> ByteArray {
  bytearray.concat(filled(byte, 27), bytearray.push(#"", i))
}

/// The `i`-th capability: 63 bytes, then `i`.
fn capability_item(i: Int) -> ByteArray {
  bytearray.concat(filled(#"63", 63), bytearray.push(#"", i))
}

/// `byte` (one byte) `n` times.
fn filled(byte: ByteArray, n: Int) -> ByteArray {
  if n <= 0 {
    #""
  } else {
    bytearray.concat(byte, filled(byte, n - 1))
  }
}
