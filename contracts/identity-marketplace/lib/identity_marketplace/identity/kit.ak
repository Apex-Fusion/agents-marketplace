//// Test kit for the identity and configuration validators. Only tests use it.
////
//// It builds records, keys, parties, holds, validity windows, the
//// configuration reference input, legacy inputs, a small allowlist with
//// proofs, and full `Transaction` values for each identity action. All keys
//// and hashes are throwaway test values.

use aiken/cbor
use aiken/collection/list
use aiken/crypto.{blake2b_224, blake2b_256}
use aiken/interval.{Finite, Interval, IntervalBound}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  Datum, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
  ValidityRange,
}
use identity_marketplace/config/record as config
use identity_marketplace/identity/allowlist
use identity_marketplace/identity/mint.{mint_ok}
use identity_marketplace/identity/rules.{IdentityParams}
use identity_marketplace/identity/spend.{spend_ok}
use vector_identity.{day_ms, days_30_ms, days_7_ms, days_90_ms}
use vector_identity/redeemers.{Adopt, IdentityMint, IdentitySpend, Register}
use vector_identity/types.{
  Accountable, Active, ControllerSet, Distributor, Ed25519, Guardian, Hold,
  IdentityDatum, Key, KeyHash, LegacyDatum, P256, Party, Provider, Responsible,
  Retired, Revoked, Role, Root, Signer, Status, Subagent, Suspended,
} as identity

// ## Script hashes and parameters

/// The identity script hash (= its policy ID).
pub const own: ByteArray =
  #"1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d"

/// The legacy registry hash (Part 2 §2).
pub const legacy_hash: ByteArray =
  #"be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01"

/// The configuration token policy (`config_seal` hash).
pub const config_policy: ByteArray =
  #"c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5"

/// The `config_holder` script hash.
pub const config_holder: ByteArray =
  #"cacacacacacacacacacacacacacacacacacacacacacacacacacacaca"

/// The approved Module-1 hash (`M1`) in the configuration datum.
pub const m1: ByteArray =
  #"31313131313131313131313131313131313131313131313131313131"

/// A script hash that is not `M1`.
pub const other_script: ByteArray =
  #"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"

/// 2026-11-02T00:00:00Z.
pub const lo: Int = 1_793_577_600_000

/// `lo` + 10 minutes.
pub const hi: Int = 1_793_578_200_000

pub fn params() -> IdentityParams {
  IdentityParams {
    legacy_hash,
    legacy_root: allowlist_root(allowlist_ids()),
    config_policy,
    config_holder,
  }
}

// ## Keys and signers

/// The controller key of the test record.
pub const controller: ByteArray =
  #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

/// A second controller key.
pub const new_controller: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

/// The controller key of another record (parent or successor).
pub const other_controller: ByteArray =
  #"c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"

/// A 64-byte `pop` value (the contract checks only its length).
pub const pop: ByteArray =
  #"50505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050"

/// `blake2b_224` of a public key: the required-signer hash of that key.
pub fn hash(public_key: ByteArray) -> ByteArray {
  blake2b_224(public_key)
}

/// The n-th Ed25519 test key (32 bytes).
pub fn ed_key(n: Int) -> ByteArray {
  bytearray.push(
    #"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
    n,
  )
}

/// The n-th P-256 test key (33 bytes, compressed form).
pub fn p256_key(n: Int) -> ByteArray {
  bytearray.concat(
    #"02",
    bytearray.push(
      #"a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2",
      n,
    ),
  )
}

pub fn ed(n: Int, purposes: Int) -> Key {
  Key { key_type: Ed25519, key: ed_key(n), purposes, pop: None }
}

pub fn p256(n: Int, purposes: Int) -> Key {
  Key { key_type: P256, key: p256_key(n), purposes, pop: Some(pop) }
}

/// The n-th party key hash (28 bytes).
pub fn pkh(n: Int) -> ByteArray {
  bytearray.push(#"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a", n)
}

/// `KeyHash { hash: pkh(n) }`.
pub fn signer(n: Int) -> Signer {
  KeyHash { hash: pkh(n) }
}

/// `Script { hash: M1 }`.
pub fn module1() -> Signer {
  identity.Script { hash: m1 }
}

// ## Parties and holds

/// A party that started 30 days before `lo`, without end and removal notice.
pub fn party(role: Role, by: Signer, rights: Int) -> Party {
  Party {
    role,
    signer: by,
    organisation: None,
    not_before: lo - days_30_ms,
    not_after: None,
    rights,
    removal_after: None,
  }
}

pub fn accountable(by: Signer) -> Party {
  party(Accountable, by, 3)
}

pub fn responsible(by: Signer) -> Party {
  party(Responsible, by, 1)
}

pub fn provider(by: Signer) -> Party {
  party(Provider, by, 1)
}

pub fn distributor(by: Signer) -> Party {
  party(Distributor, by, 0)
}

pub fn guardian(by: Signer) -> Party {
  party(Guardian, by, 4)
}

/// A hold that started 7 days before `until`.
pub fn hold(by: Signer, reason: Int, until: Int) -> Hold {
  Hold { by, reason, since: until - days_7_ms, until }
}

/// A hold in force: it ends 5 days after `lo`.
pub fn hold_in_force(by: Signer) -> Hold {
  hold(by, 6, lo + 5 * day_ms)
}

/// A hold that ended at `lo` (not in force).
pub fn hold_lapsed(by: Signer) -> Hold {
  hold(by, 6, lo)
}

// ## Records

/// The identifier of the spent record in spend tests.
pub const record_id: ByteArray =
  #"abababababababababababababababababababababababababababababababab"

/// The identifier of a successor record.
pub const successor_id: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

/// A live root record: Active, one Ed25519 key, the controller as its
/// Accountable Party, created 90 days before `lo`.
pub fn record() -> IdentityDatum {
  IdentityDatum {
    controller,
    keys: [ed(1, 27)],
    parties: [accountable(ControllerSet)],
    guardian_threshold: 0,
    pending_recovery: None,
    lineage: Root,
    subagent_epoch: 0,
    name: "agent",
    description: "test agent",
    framework: "vector-agent",
    endpoint: "https://agent.example",
    capabilities: ["llm.text.generate.v1"],
    created_at: lo - days_90_ms,
    status: Active,
  }
}

/// A record whose parties are `parties`.
pub fn with_parties(d: IdentityDatum, parties: List<Party>) -> IdentityDatum {
  IdentityDatum { ..d, parties }
}

/// A record with `status`.
pub fn with_status(d: IdentityDatum, status: Status) -> IdentityDatum {
  IdentityDatum { ..d, status }
}

/// A record with `holds` (status Suspended).
pub fn suspended(d: IdentityDatum, holds: List<Hold>) -> IdentityDatum {
  IdentityDatum { ..d, status: Suspended { holds } }
}

/// The tombstone of `d` with `status`.
pub fn tombstone(d: IdentityDatum, status: Status) -> IdentityDatum {
  IdentityDatum {
    ..d,
    keys: [],
    parties: [],
    guardian_threshold: 0,
    pending_recovery: None,
    description: "",
    framework: "",
    endpoint: "",
    capabilities: [],
    status,
  }
}

/// A tombstone revoked by the controller at `lo - 1 day`, reason 5, no
/// successor.
pub fn revoked_tombstone() -> IdentityDatum {
  tombstone(
    record(),
    Revoked {
      by: ControllerSet,
      reason: 5,
      at: lo - day_ms,
      invalid_from: None,
      successor: None,
    },
  )
}

/// A tombstone retired at `lo - 1 day`, no successor.
pub fn retired_tombstone() -> IdentityDatum {
  tombstone(record(), Retired { at: lo - day_ms, successor: None })
}

/// A live root record of another agent (successor or parent), controlled by
/// `other_controller`.
pub fn other_record() -> IdentityDatum {
  IdentityDatum {
    ..record(),
    controller: other_controller,
    keys: [],
    name: "other agent",
  }
}

/// A subagent record of `parent` at `depth`.
pub fn subagent(
  parent: ByteArray,
  parent_epoch: Int,
  depth: Int,
) -> IdentityDatum {
  IdentityDatum {
    ..record(),
    endpoint: "",
    lineage: Subagent { parent, parent_epoch, depth },
  }
}

/// The identifier of the record at depth `n` of a test chain (0 = root).
pub fn chain_id(n: Int) -> ByteArray {
  bytearray.push(
    #"c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4",
    n,
  )
}

/// The record at depth `n` of a test chain, controlled by
/// `other_controller`: `other_record()` for 0, else a subagent of record
/// `n - 1` under epoch 0.
pub fn chain_record(n: Int) -> IdentityDatum {
  if n == 0 {
    other_record()
  } else {
    IdentityDatum {
      ..subagent(chain_id(n - 1), 0, n),
      controller: other_controller,
      keys: [],
    }
  }
}

/// The records of depths `0 .. count - 1` of a test chain as reference
/// inputs, deepest first.
pub fn chain_refs(count: Int) -> List<Input> {
  if count <= 0 {
    []
  } else {
    [
      record_input(10 + count - 1, chain_id(count - 1), chain_record(count - 1)),
      ..chain_refs(count - 1)
    ]
  }
}

/// A new subagent at `depth` under the chain record `depth - 1` (epoch 0),
/// with `created_at = hi`.
pub fn new_subagent(depth: Int) -> IdentityDatum {
  IdentityDatum { ..subagent(chain_id(depth - 1), 0, depth), created_at: hi }
}

/// A Register of `new_subagent(depth)` with its `depth` ancestors as
/// reference inputs, signed by the creation signers and the parent's
/// controller.
pub fn subagent_tx(depth: Int) -> Transaction {
  with_refs(
    register_tx(
      new_subagent(depth),
      [hash(other_controller), ..creation_signers()],
    ),
    chain_refs(depth),
  )
}

// ## The largest record (Part 2 §12.4)

/// `n` copies of the byte `byte`.
pub fn bytes(n: Int, byte: Int) -> ByteArray {
  if n <= 0 {
    ""
  } else {
    bytearray.push(bytes(n - 1, byte), byte)
  }
}

/// The n-th 64-byte capability.
pub fn long_capability(n: Int) -> ByteArray {
  bytearray.push(bytes(63, 0x63), n)
}

/// `n` distinct 64-byte capabilities.
pub fn long_capabilities(n: Int) -> List<ByteArray> {
  if n <= 0 {
    []
  } else {
    [long_capability(n), ..long_capabilities(n - 1)]
  }
}

/// 8 keys: five Ed25519 keys with every purpose, three P-256 keys with both
/// of their purposes.
pub fn eight_keys() -> List<Key> {
  [
    ed(1, 27),
    ed(2, 27),
    ed(3, 27),
    ed(4, 27),
    ed(5, 27),
    p256(1, 3),
    p256(2, 3),
    p256(3, 3),
  ]
}

/// A party with a 64-byte organisation, an end 400 days after `lo` and, when
/// `notice` is set, a removal notice for the same time.
pub fn full_party(role: Role, by: Signer, rights: Int, notice: Bool) -> Party {
  Party {
    role,
    signer: by,
    organisation: Some(bytes(64, 0x6f)),
    not_before: lo - days_30_ms,
    not_after: Some(lo + 400 * day_ms),
    rights,
    removal_after: if notice {
      Some(lo + 400 * day_ms)
    } else {
      None
    },
  }
}

/// The Module-1 party as Module-1 consents to it: Accountable, both rights, no
/// end and no removal notice.
pub fn module1_party() -> Party {
  Party {
    role: Accountable,
    signer: module1(),
    organisation: None,
    not_before: lo - days_30_ms,
    not_after: None,
    rights: 3,
    removal_after: None,
  }
}

/// The longest profile of a root record: name 64 bytes, description 256,
/// framework 64, endpoint 256 and 16 capabilities of 64 bytes.
pub fn longest_profile(d: IdentityDatum) -> IdentityDatum {
  IdentityDatum {
    ..d,
    name: bytes(64, 0x6e),
    description: bytes(256, 0x64),
    framework: bytes(64, 0x66),
    endpoint: bytes(256, 0x65),
    capabilities: long_capabilities(16),
  }
}

/// The 8 parties of `largest()`: Module-1 and seven key parties (signers 1–7),
/// each with the suspend right. Party 7 has no removal notice.
pub fn largest_parties() -> List<Party> {
  [
    module1_party(),
    full_party(Accountable, signer(1), 3, True),
    full_party(Accountable, signer(2), 3, True),
    full_party(Responsible, signer(3), 1, True),
    full_party(Responsible, signer(4), 1, True),
    full_party(Provider, signer(5), 1, True),
    full_party(Provider, signer(6), 1, True),
    full_party(Provider, signer(7), 1, False),
  ]
}

/// The 10 holds of `largest()`, all in force: the controller, Module-1, the
/// seven key parties and a removed key party (signer 8).
pub fn largest_holds() -> List<Hold> {
  [
    hold_in_force(ControllerSet),
    hold(module1(), 64, lo + 20 * day_ms),
    hold_in_force(signer(1)),
    hold_in_force(signer(2)),
    hold_in_force(signer(3)),
    hold_in_force(signer(4)),
    hold_in_force(signer(5)),
    hold_in_force(signer(6)),
    hold_in_force(signer(7)),
    hold_in_force(signer(8)),
  ]
}

/// The largest record: 8 keys, 8 parties, 10 holds, 16 capabilities and the
/// longest profile (Part 2 §12.4).
pub fn largest() -> IdentityDatum {
  IdentityDatum {
    ..longest_profile(record()),
    keys: eight_keys(),
    parties: largest_parties(),
    status: Suspended { holds: largest_holds() },
  }
}

/// The largest record with guardians: Module-1, four key parties with the
/// suspend right (signers 1–4) and three guardians (signers 11–13),
/// threshold 3, and 10 holds in force (the controller, Module-1, signers 1–4
/// and four removed key parties, signers 5–8).
pub fn largest_guarded() -> IdentityDatum {
  IdentityDatum {
    ..largest(),
    parties: [
      module1_party(),
      full_party(Accountable, signer(1), 3, True),
      full_party(Responsible, signer(2), 1, True),
      full_party(Provider, signer(3), 1, True),
      full_party(Provider, signer(4), 1, True),
      full_party(Guardian, signer(11), 4, True),
      full_party(Guardian, signer(12), 4, True),
      full_party(Guardian, signer(13), 4, True),
    ],
    guardian_threshold: 3,
  }
}

/// The required-signer hashes of the five Ed25519 keys of `eight_keys()`.
pub fn eight_keys_signers() -> List<ByteArray> {
  list.map([1, 2, 3, 4, 5], fn(n) { hash(ed_key(n)) })
}

// ## Addresses, inputs and outputs

pub fn identity_address() -> Address {
  address.from_script(own)
}

pub fn holder_address() -> Address {
  address.from_script(config_holder)
}

pub fn legacy_address() -> Address {
  address.from_script(legacy_hash)
}

/// `address` with an inline stake key.
pub fn staked(address: Address) -> Address {
  Address {
    ..address,
    stake_credential: Some(address.Inline(VerificationKey(pkh(200)))),
  }
}

/// `amount` AP3X base units and the record token `(own, id)`.
pub fn record_value(id: ByteArray, amount: Int) -> Value {
  assets.from_lovelace(amount) |> assets.add(own, id, 1)
}

/// The AP3X that the test record outputs hold.
pub const deposit: Int = 20_000_000

pub fn output(address: Address, value: Value, datum: Datum) -> Output {
  Output { address, value, datum, reference_script: None }
}

/// A record output for `id` with `deposit` AP3X.
pub fn record_output(id: ByteArray, d: IdentityDatum) -> Output {
  output(identity_address(), record_value(id, deposit), InlineDatum(d))
}

pub fn ref(n: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"7777777777777777777777777777777777777777777777777777777777777777",
    output_index: n,
  }
}

/// The output reference of the spent record.
pub fn record_ref() -> OutputReference {
  ref(0)
}

/// A record at `ref(n)` (a reference input or a spent input).
pub fn record_input(n: Int, id: ByteArray, d: IdentityDatum) -> Input {
  Input { output_reference: ref(n), output: record_output(id, d) }
}

/// The configuration reference input: the token at `CA` with the Module-1
/// hash as inline datum.
pub fn config_input() -> Input {
  Input {
    output_reference: ref(90),
    output: output(
      holder_address(),
      assets.from_lovelace(2_000_000)
        |> assets.add(config_policy, config.token_name, 1),
      InlineDatum(m1),
    ),
  }
}

/// A wallet input that pays the fee.
pub fn wallet_input() -> Input {
  Input {
    output_reference: ref(99),
    output: output(
      address.from_verification_key(pkh(99)),
      assets.from_lovelace(50_000_000),
      NoDatum,
    ),
  }
}

/// The closed validity range `[from, to]`.
pub fn range(from: Int, to: Int) -> ValidityRange {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(from), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(to), is_inclusive: True },
  }
}

/// A withdrawal of 0 for `Script(M1)`.
pub fn module1_withdrawal() -> Pairs<Credential, Int> {
  [Pair(address.Script(m1), 0)]
}

// ## Spend transactions

/// A spend of record `record_id` with datum `d` into `d2`: the record input,
/// a wallet input, the configuration reference input, one record output, the
/// window `[lo, hi]` and `signers` as required signers.
pub fn spend_tx(
  d: IdentityDatum,
  d2: IdentityDatum,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [record_input(0, record_id, d), wallet_input()],
    reference_inputs: [config_input()],
    outputs: [record_output(record_id, d2)],
    validity_range: range(lo, hi),
    extra_signatories: signers,
  }
}

/// `spend_tx` signed by the controller.
pub fn controller_tx(d: IdentityDatum, d2: IdentityDatum) -> Transaction {
  spend_tx(d, d2, [hash(controller)])
}

/// The tx with `refs` added after its reference inputs.
pub fn with_refs(tx: Transaction, refs: List<Input>) -> Transaction {
  Transaction { ..tx, reference_inputs: list.concat(tx.reference_inputs, refs) }
}

/// The tx without the configuration reference input.
pub fn without_config(tx: Transaction) -> Transaction {
  Transaction {
    ..tx,
    reference_inputs: list.filter(
      tx.reference_inputs,
      fn(input) { input.output.address != holder_address() },
    ),
  }
}

/// The tx with `signers` added to its required signers.
pub fn signed_also(tx: Transaction, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..tx,
    extra_signatories: list.concat(tx.extra_signatories, signers),
  }
}

/// The tx with the Module-1 withdrawal.
pub fn with_module1(tx: Transaction) -> Transaction {
  Transaction { ..tx, withdrawals: module1_withdrawal() }
}

/// The tx with the validity range `[from, to]`.
pub fn within(tx: Transaction, from: Int, to: Int) -> Transaction {
  Transaction { ..tx, validity_range: range(from, to) }
}

/// The tx whose record output holds `amount` AP3X instead of `deposit`.
pub fn output_ap3x(tx: Transaction, amount: Int) -> Transaction {
  expect [first, ..rest] = tx.outputs
  Transaction {
    ..tx,
    outputs: [
      Output {
        ..first,
        value: assets.merge(
          assets.without_lovelace(first.value),
          assets.from_lovelace(amount),
        ),
      },
      ..rest
    ],
  }
}

/// The tx with `outputs` as its outputs.
pub fn with_outputs(tx: Transaction, outputs: List<Output>) -> Transaction {
  Transaction { ..tx, outputs }
}

/// Runs the spend handler on the record input.
pub fn spend(redeemer: IdentitySpend, tx: Transaction) -> Bool {
  spend_ok(params(), redeemer, record_ref(), tx)
}

// ## Register

/// The seed of the test registration.
pub fn seed() -> OutputReference {
  OutputReference {
    transaction_id: #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
    output_index: 1,
  }
}

/// `blake2b_256(serialise(seed))`.
pub fn id_of(seed: OutputReference) -> ByteArray {
  blake2b_256(cbor.serialise(seed))
}

/// The record of a registration: `record()` with `created_at = hi`.
pub fn new_record() -> IdentityDatum {
  IdentityDatum { ..record(), created_at: hi }
}

/// A Register of `d0` with the seed `seed()`: the seed input, the
/// configuration reference input, one record output, the mint
/// `{ id: +1 }`, the window `[lo, hi]` and `signers`.
pub fn register_tx(d0: IdentityDatum, signers: List<ByteArray>) -> Transaction {
  let id = id_of(seed())
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: seed(),
        output: output(
          address.from_verification_key(pkh(99)),
          assets.from_lovelace(50_000_000),
          NoDatum,
        ),
      },
    ],
    reference_inputs: [config_input()],
    outputs: [record_output(id, d0)],
    mint: assets.from_asset(own, id, 1),
    validity_range: range(lo, hi),
    extra_signatories: signers,
  }
}

/// The signers of `record()` at creation: the controller and its Ed25519 key.
pub fn creation_signers() -> List<ByteArray> {
  [hash(controller), hash(ed_key(1))]
}

/// Runs the mint handler of the identity policy.
pub fn mint(redeemer: IdentityMint, tx: Transaction) -> Bool {
  mint_ok(params(), redeemer, own, tx)
}

/// Runs the mint handler with `Register { seed: seed() }`.
pub fn register(tx: Transaction) -> Bool {
  mint(Register { seed: seed() }, tx)
}

/// The tx with `value` as its mint.
pub fn with_mint(tx: Transaction, value: Value) -> Transaction {
  Transaction { ..tx, mint: value }
}

// ## Adopt and the allowlist

/// Five allowlisted identifiers (an odd number of leaves).
pub fn allowlist_ids() -> List<ByteArray> {
  [
    #"0101010101010101010101010101010101010101010101010101010101010101",
    #"0202020202020202020202020202020202020202020202020202020202020202",
    adopt_id,
    #"0404040404040404040404040404040404040404040404040404040404040404",
    #"0505050505050505050505050505050505050505050505050505050505050505",
  ]
}

/// The allowlisted identifier that the adoption tests adopt.
pub const adopt_id: ByteArray =
  #"0303030303030303030303030303030303030303030303030303030303030303"

/// An identifier that is not on the allowlist.
pub const outside_id: ByteArray =
  #"0606060606060606060606060606060606060606060606060606060606060606"

/// The root of the allowlist tree of `ids` (Part 2 §3.4).
pub fn allowlist_root(ids: List<ByteArray>) -> ByteArray {
  root_of(leaves(ids))
}

/// The proof of `id` in the allowlist tree of `ids`: the paired nodes from the
/// leaf upward.
pub fn allowlist_proof(ids: List<ByteArray>, id: ByteArray) -> List<ByteArray> {
  let level = leaves(ids)
  expect Some(position) = list.index_of(level, blake2b_256(id))
  proof_of(level, position)
}

fn leaves(ids: List<ByteArray>) -> List<ByteArray> {
  list.sort(list.map(ids, blake2b_256), bytearray.compare)
}

fn pair_up(level: List<ByteArray>) -> List<ByteArray> {
  when level is {
    [left, right, ..rest] -> [allowlist.node(left, right), ..pair_up(rest)]
    _ -> level
  }
}

fn root_of(level: List<ByteArray>) -> ByteArray {
  when level is {
    [root] -> root
    _ -> root_of(pair_up(level))
  }
}

fn proof_of(level: List<ByteArray>, position: Int) -> List<ByteArray> {
  when level is {
    [_] -> []
    _ -> {
      let sibling =
        if position % 2 == 0 {
          position + 1
        } else {
          position - 1
        }
      let rest = proof_of(pair_up(level), position / 2)
      when list.at(level, sibling) is {
        Some(node) -> [node, ..rest]
        None -> rest
      }
    }
  }
}

/// The legacy owner key hash of the adopted record.
pub fn legacy_owner() -> ByteArray {
  pkh(50)
}

/// A legacy datum with `owner`.
pub fn legacy_datum(owner: Credential) -> LegacyDatum {
  LegacyDatum {
    owner,
    name: "legacy agent",
    description: "",
    capabilities: ["llm.chat.v1"],
    framework: "",
    endpoint: "https://legacy.example",
    registered_at: 1_760_000_000_000,
  }
}

/// A legacy record input for `id` at `LA` with `datum`.
pub fn legacy_input(id: ByteArray, datum: Datum) -> Input {
  Input {
    output_reference: ref(40),
    output: output(
      legacy_address(),
      assets.from_lovelace(5_000_000) |> assets.add(legacy_hash, id, 1),
      datum,
    ),
  }
}

/// An Adopt of `adopt_id` into `d0`: the legacy input with an inline datum
/// owned by `legacy_owner()`, a wallet input, the configuration reference
/// input, one record output, the mint `{ id: +1 }` and the legacy burn
/// `{ id: -1 }`, signed by `signers`.
pub fn adopt_tx(d0: IdentityDatum, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      legacy_input(
        adopt_id,
        InlineDatum(legacy_datum(VerificationKey(legacy_owner()))),
      ),
      wallet_input(),
    ],
    reference_inputs: [config_input()],
    outputs: [record_output(adopt_id, d0)],
    mint: assets.from_asset(own, adopt_id, 1)
      |> assets.add(legacy_hash, adopt_id, -1),
    validity_range: range(lo, hi),
    extra_signatories: signers,
  }
}

/// The signers of an adoption of `record()`: the creation signers and the
/// legacy owner.
pub fn adoption_signers() -> List<ByteArray> {
  [legacy_owner(), ..creation_signers()]
}

/// The proof of `adopt_id`.
pub fn adopt_proof() -> List<ByteArray> {
  allowlist_proof(allowlist_ids(), adopt_id)
}

/// Runs the mint handler with `Adopt { proof: adopt_proof() }`.
pub fn adopt(tx: Transaction) -> Bool {
  mint(Adopt { proof: adopt_proof() }, tx)
}
