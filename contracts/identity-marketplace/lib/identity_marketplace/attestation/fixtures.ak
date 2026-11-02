//// Test fixtures of the attestation contract. Test-only: no validator uses
//// this module. The tests are in `identity_marketplace/attestation/tests` and
//// in `validators/attestation.ak`.
////
//// Signatures are modelled as key hashes in `extra_signatories`. The keys and
//// hashes are fixed test bytes, not real keys.

use aiken/collection/list
use aiken/crypto.{blake2b_224}
use aiken/interval
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, Mint, NoDatum, Output, OutputReference, Spend, Transaction,
  ValidityRange,
}
use identity_marketplace/attestation/handlers.{attestation_id}
use identity_marketplace/types.{
  Anchor, AttActive, AttRevoked, AttestationDatum, Burn, Link, Withdraw,
}
use vector_identity.{
  day_ms, days_30_ms, days_90_ms, purpose_assertion, purpose_authentication,
  right_revoke, right_suspend,
}
use vector_identity/types.{
  Accountable, Active, ControllerSet, Ed25519, IdentityDatum, Key, KeyHash,
  Lineage, Party, Responsible, Revoked, Root, Status, Subagent,
} as identity

// ## Hashes, keys and identifiers

/// The identity registry: script hash and policy ID.
pub const identity_hash: ByteArray =
  #"1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d"

/// The attestation script: script hash and policy ID.
pub const own_hash: ByteArray =
  #"a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7"

/// A foreign policy.
pub const other_policy: ByteArray =
  #"f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"

/// Another script.
pub const other_script: ByteArray =
  #"0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"

/// The key hash of a wallet that pays fees and receives change.
pub const wallet_pkh: ByteArray =
  #"3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e"

/// A stake key hash.
pub const stake_pkh: ByteArray =
  #"4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b"

/// The issuer's Ed25519 public key.
pub const issuer_key: ByteArray =
  #"1515151515151515151515151515151515151515151515151515151515151515"

/// The controller key of the issuer's record.
pub const issuer_controller: ByteArray =
  #"1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c"

/// The controller key of the subject's record.
pub const subject_controller: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

/// A key that has no role.
pub const stranger_key: ByteArray =
  #"9999999999999999999999999999999999999999999999999999999999999999"

/// The subject's identifier.
pub const subject_id: ByteArray =
  #"5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b"

/// The issuer's identifier.
pub const issuer_id: ByteArray =
  #"1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b"

/// A 32-byte hash (profile, digest, anchor and link values).
pub const hash_32: ByteArray =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"

/// Another 32-byte hash.
pub const other_hash_32: ByteArray =
  #"c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4"

/// A 64-byte envelope signature.
pub const envelope_sig: ByteArray =
  #"e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"

// ## Times

/// 2026-11-02T00:00:00Z: the lower bound of the default validity range.
pub const lo: Int = 1_793_577_600_000

/// `lo` + 10 minutes: the upper bound of the default validity range.
pub const hi: Int = 1_793_578_200_000

/// One hour: the longest validity range.
pub const one_hour: Int = 3_600_000

/// The validity range `[lower, upper]`, both bounds inclusive.
pub fn range(lower: Int, upper: Int) -> ValidityRange {
  interval.between(lower, upper)
}

// ## Helpers

/// The key hash of a public key (`signed(pk)` puts it in `extra_signatories`).
pub fn pkh(key: ByteArray) -> ByteArray {
  blake2b_224(key)
}

/// `n` bytes (0x61, "a").
pub fn bytes(n: Int) -> ByteArray {
  if n <= 0 {
    ""
  } else {
    bytearray.push(bytes(n - 1), 0x61)
  }
}

/// The 32-byte identifier number `n` (0..255).
pub fn test_id(n: Int) -> ByteArray {
  bytearray.push(
    #"00000000000000000000000000000000000000000000000000000000000000",
    n,
  )
}

/// The exact enterprise address of the attestation script (`AA`).
pub fn aa() -> Address {
  address.from_script(own_hash)
}

/// `base` with a stake key.
pub fn staked(base: Address) -> Address {
  address.with_delegation_key(base, stake_pkh)
}

/// The wallet address.
pub fn wallet() -> Address {
  address.from_verification_key(wallet_pkh)
}

// ## Identity records

/// An Accountable Party (the controller) that covers the default range.
pub fn accountable() -> Party {
  Party {
    role: Accountable,
    signer: ControllerSet,
    organisation: None,
    not_before: lo - day_ms,
    not_after: None,
    rights: right_suspend + right_revoke,
    removal_after: None,
  }
}

/// An Ed25519 key with `purposes`.
pub fn listed(key: ByteArray, purposes: Int) -> Key {
  Key { key_type: Ed25519, key, purposes, pop: None }
}

/// The issuer key with the authentication and assertion purposes.
pub fn issuer_listed() -> Key {
  listed(issuer_key, purpose_authentication + purpose_assertion)
}

/// An Active root record with one Accountable Party.
pub fn record(controller: ByteArray, keys: List<Key>) -> IdentityDatum {
  IdentityDatum {
    controller,
    keys,
    parties: [accountable()],
    guardian_threshold: 0,
    pending_recovery: None,
    lineage: Root,
    subagent_epoch: 0,
    name: "test agent",
    description: "",
    framework: "",
    endpoint: "https://agent.example",
    capabilities: ["ocr.extract.v1"],
    created_at: lo - days_30_ms,
    status: Active,
  }
}

/// A revoked tombstone of `base` (Part 2 §3.7).
pub fn tombstone(base: IdentityDatum) -> IdentityDatum {
  IdentityDatum {
    ..base,
    keys: [],
    parties: [],
    endpoint: "",
    capabilities: [],
    status: Revoked {
      by: ControllerSet,
      reason: 5,
      at: lo - day_ms,
      invalid_from: None,
      successor: None,
    },
  }
}

/// `base` with `status`.
pub fn with_status(base: IdentityDatum, status: Status) -> IdentityDatum {
  IdentityDatum { ..base, status }
}

/// The subject's record.
pub fn subject_record() -> IdentityDatum {
  record(subject_controller, [])
}

/// The issuer's record: it lists the issuer key with the assertion purpose.
pub fn issuer_record() -> IdentityDatum {
  record(issuer_controller, [issuer_listed()])
}

/// The issuer's record without the issuer key (the key was removed).
pub fn issuer_record_without_key() -> IdentityDatum {
  record(issuer_controller, [])
}

/// A reference input at the identity address with the token `(identity_hash,
/// id)` and 10 AP3X.
pub fn record_input(id: ByteArray, datum: IdentityDatum) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: id, output_index: 0 },
    output: Output {
      address: address.from_script(identity_hash),
      value: assets.from_lovelace(10_000_000)
        |> assets.add(identity_hash, id, 1),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

/// The subject's and the issuer's records.
pub fn records() -> List<Input> {
  [
    record_input(subject_id, subject_record()),
    record_input(issuer_id, issuer_record()),
  ]
}

/// The subject's record and `issuer` as the issuer's record.
pub fn records_with_issuer(issuer: IdentityDatum) -> List<Input> {
  [record_input(subject_id, subject_record()), record_input(issuer_id, issuer)]
}

/// The subject's record `subject` and the issuer's record.
pub fn records_with_subject(subject: IdentityDatum) -> List<Input> {
  [record_input(subject_id, subject), record_input(issuer_id, issuer_record())]
}

// ## Attestations

/// The seed of the test attestation.
pub fn seed() -> OutputReference {
  OutputReference {
    transaction_id: #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
    output_index: 0,
  }
}

/// The token name of the test attestation.
pub fn att_id() -> ByteArray {
  attestation_id(seed())
}

/// The output reference of the spent test attestation.
pub fn att_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    output_index: 0,
  }
}

/// The output reference of a wallet input.
pub fn fee_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"fefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefe",
    output_index: 0,
  }
}

/// A contest anchor.
pub fn anchor() -> Anchor {
  Anchor { uri: "https://subject.example/replies/1", sha256: other_hash_32 }
}

/// A new attestation by a registered issuer, with every optional field set.
/// Type 2 (software) with `valid_until` 30 days after `issued_at = hi`.
pub fn full_datum() -> AttestationDatum {
  AttestationDatum {
    subject: subject_id,
    issuer: issuer_key,
    issuer_id: Some(issuer_id),
    att_type: 2,
    format: Some(50),
    profile: Some(other_hash_32),
    digest: hash_32,
    locator: Some("https://issuer.example/attestations/1.json"),
    envelope_sig: Some(envelope_sig),
    issued_at: hi,
    valid_from: Some(hi),
    valid_until: Some(hi + days_30_ms),
    solicited: False,
    status: AttActive,
    contested: None,
    links: [Link { rel: 0, target: other_hash_32 }],
  }
}

/// A new attestation by an unregistered issuer, with no optional field set.
pub fn minimal_datum() -> AttestationDatum {
  AttestationDatum {
    subject: subject_id,
    issuer: issuer_key,
    issuer_id: None,
    att_type: 0,
    format: None,
    profile: None,
    digest: hash_32,
    locator: None,
    envelope_sig: None,
    issued_at: hi,
    valid_from: None,
    valid_until: None,
    solicited: False,
    status: AttActive,
    contested: None,
    links: [],
  }
}

/// An attestation that a registered issuer made 30 days before `lo`; it
/// expires 30 days after `lo`.
pub fn existing() -> AttestationDatum {
  AttestationDatum {
    ..full_datum(),
    issued_at: lo - days_30_ms,
    valid_from: Some(lo - days_30_ms),
    valid_until: Some(lo + days_30_ms),
  }
}

/// `existing()` without `issuer_id` (an unregistered issuer).
pub fn existing_unregistered() -> AttestationDatum {
  AttestationDatum { ..existing(), issuer_id: None }
}

/// `base` revoked at `at` with `reason`.
pub fn revoked(base: AttestationDatum, at: Int, reason: Int) -> AttestationDatum {
  AttestationDatum { ..base, status: AttRevoked { at, reason } }
}

/// `base` with the contest anchor `reply`.
pub fn contested(base: AttestationDatum, reply: Anchor) -> AttestationDatum {
  AttestationDatum { ..base, contested: Some(reply) }
}

/// `ap3x` base units of AP3X and the test attestation token.
pub fn att_value(ap3x: Int) -> Value {
  assets.from_lovelace(ap3x) |> assets.add(own_hash, att_id(), 1)
}

/// An output at `AA` with 5 AP3X, the test token and the inline datum.
pub fn att_output(datum: AttestationDatum) -> Output {
  Output {
    address: aa(),
    value: att_value(5_000_000),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

/// The spent test attestation.
pub fn att_input(datum: AttestationDatum) -> Input {
  Input { output_reference: att_ref(), output: att_output(datum) }
}

/// A wallet input with 20 AP3X.
pub fn wallet_input(ref: OutputReference) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: wallet(),
      value: assets.from_lovelace(20_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

/// A wallet output with `ap3x` base units.
pub fn wallet_output(ap3x: Int) -> Output {
  Output {
    address: wallet(),
    value: assets.from_lovelace(ap3x),
    datum: NoDatum,
    reference_script: None,
  }
}

// ## Transactions

/// `Attest { seed() }` for `datum`, signed by `signers`: spends the seed, mints
/// the token, references the subject's and the issuer's records, and has the
/// attestation output and a change output. Validity range `[lo, hi]`.
pub fn attest_tx(
  datum: AttestationDatum,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [wallet_input(seed())],
    reference_inputs: records(),
    outputs: [att_output(datum), wallet_output(14_000_000)],
    mint: assets.from_asset(own_hash, att_id(), 1),
    extra_signatories: signers,
    validity_range: range(lo, hi),
  }
}

/// A transaction that spends the test attestation with datum `old` and writes
/// `new` to the continuing output, signed by `signers`. It references the
/// subject's and the issuer's records. Validity range `[lo, hi]`.
pub fn spend_tx(
  old: AttestationDatum,
  new: AttestationDatum,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [att_input(old), wallet_input(fee_ref())],
    reference_inputs: records(),
    outputs: [att_output(new), wallet_output(19_000_000)],
    extra_signatories: signers,
    validity_range: range(lo, hi),
  }
}

/// The redeemer `Withdraw` as Data.
pub fn withdraw_redeemer() -> Data {
  let redeemer: Data = Withdraw
  redeemer
}

/// The redeemer `Burn` as Data.
pub fn burn_redeemer() -> Data {
  let redeemer: Data = Burn
  redeemer
}

/// `Withdraw` with `Burn` of the test attestation with datum `old`, signed by
/// `signers`, with the validity range `[lower, lower + 10 minutes]`. The
/// deposit goes to the wallet.
pub fn withdraw_tx(
  old: AttestationDatum,
  lower: Int,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [att_input(old), wallet_input(fee_ref())],
    reference_inputs: records(),
    outputs: [wallet_output(24_000_000)],
    mint: assets.from_asset(own_hash, att_id(), -1),
    extra_signatories: signers,
    validity_range: range(lower, lower + 600_000),
    redeemers: [
      Pair(Mint(own_hash), burn_redeemer()),
      Pair(Spend(att_ref()), withdraw_redeemer()),
    ],
  }
}

// ## Largest case

/// 8 keys: 7 filler keys, then `last`.
pub fn eight_keys(last: Key) -> List<Key> {
  list.concat(
    list.map(
      [1, 2, 3, 4, 5, 6, 7],
      fn(n) {
        listed(
          bytearray.push(
            #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            n,
          ),
          purpose_authentication,
        )
      },
    ),
    [last],
  )
}

/// 8 parties: 7 Responsible parties with key signers, then the Accountable
/// Party.
pub fn eight_parties() -> List<Party> {
  list.concat(
    list.map(
      [1, 2, 3, 4, 5, 6, 7],
      fn(n) {
        Party {
          role: Responsible,
          signer: KeyHash {
            hash: bytearray.push(
              #"dddddddddddddddddddddddddddddddddddddddddddddddddddddd",
              n,
            ),
          },
          organisation: Some("https://organisation.example"),
          not_before: lo - day_ms,
          not_after: Some(lo + days_30_ms),
          rights: right_suspend,
          removal_after: None,
        }
      },
    ),
    [accountable()],
  )
}

/// A large record: 8 keys (`last` is the last one), 8 parties, 16
/// capabilities and a long profile.
pub fn big_record(
  controller: ByteArray,
  last: Key,
  lineage: Lineage,
) -> IdentityDatum {
  IdentityDatum {
    ..record(controller, eight_keys(last)),
    parties: eight_parties(),
    lineage,
    name: bytes(64),
    description: bytes(256),
    framework: bytes(64),
    endpoint: when lineage is {
      Root -> bytes(256)
      _ -> ""
    },
    capabilities: list.map(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      fn(n) { bytearray.push(bytes(63), n) },
    ),
  }
}

/// The reference inputs of the largest case: the issuer is a depth-4
/// subagent. Its ancestors (identifiers 1..4), then the issuer's record, then
/// the subject's record, all large.
pub fn largest_records() -> List<Input> {
  let ancestor =
    fn(n: Int) {
      let lineage =
        if n == 1 {
          Root
        } else {
          Subagent { parent: test_id(n - 1), parent_epoch: 0, depth: n - 1 }
        }
      record_input(
        test_id(n),
        big_record(issuer_controller, issuer_listed(), lineage),
      )
    }
  [
    ancestor(1),
    ancestor(2),
    ancestor(3),
    ancestor(4),
    record_input(
      issuer_id,
      big_record(
        issuer_controller,
        issuer_listed(),
        Subagent { parent: test_id(4), parent_epoch: 0, depth: 4 },
      ),
    ),
    record_input(
      subject_id,
      big_record(subject_controller, issuer_listed(), Root),
    ),
  ]
}

/// The largest new attestation: every optional field set, a 256-byte locator
/// and 4 links.
pub fn largest_datum() -> AttestationDatum {
  AttestationDatum {
    ..full_datum(),
    locator: Some(bytes(256)),
    solicited: True,
    links: [
      Link { rel: 0, target: hash_32 },
      Link { rel: 1, target: other_hash_32 },
      Link { rel: 2, target: hash_32 },
      Link { rel: 3, target: other_hash_32 },
    ],
  }
}

/// Six other signers, then the given signers.
pub fn many_signers(signers: List<ByteArray>) -> List<ByteArray> {
  list.concat(
    list.map([1, 2, 3, 4, 5, 6], fn(n) { pkh(bytearray.push(bytes(31), n)) }),
    signers,
  )
}

/// An attestation like `largest_datum()`, made 30 days before `lo`, with a
/// 256-byte contest anchor.
pub fn largest_existing() -> AttestationDatum {
  AttestationDatum {
    ..largest_datum(),
    issued_at: lo - days_30_ms,
    valid_from: Some(lo - days_30_ms),
    valid_until: Some(lo + days_30_ms),
    contested: Some(Anchor { uri: bytes(256), sha256: hash_32 }),
  }
}

/// The largest `Attest`: `largest_datum()`, solicited, 8 signers, and the
/// reference inputs of `largest_records()`. A constant, so that the compiler
/// builds it and test budgets show the cost of the rules only.
pub const largest_attest_tx: Transaction =
  Transaction {
    ..attest_tx(
      largest_datum(),
      many_signers([pkh(issuer_key), pkh(subject_controller)]),
    ),
    reference_inputs: largest_records(),
  }

/// The largest `RevokeAtt { reason: 5 }` of `largest_existing()` by the issuer
/// key (the last of 8 listed keys of a depth-4 subagent issuer).
pub const largest_revoke_tx: Transaction =
  Transaction {
    ..spend_tx(
      largest_existing(),
      revoked(largest_existing(), lo, 5),
      many_signers([pkh(issuer_key)]),
    ),
    reference_inputs: largest_records(),
  }

/// The largest `Contest` of `largest_existing()`: a new 256-byte anchor.
pub const largest_contest_tx: Transaction =
  Transaction {
    ..spend_tx(
      largest_existing(),
      contested(
        largest_existing(),
        Anchor { uri: bytes(256), sha256: other_hash_32 },
      ),
      many_signers([pkh(subject_controller)]),
    ),
    reference_inputs: largest_records(),
  }

/// The largest `Withdraw` with `Burn` of `largest_existing()`, revoked at `lo`,
/// at `lo + 90 days` by the issuer key.
pub const largest_withdraw_tx: Transaction =
  Transaction {
    ..withdraw_tx(
      revoked(largest_existing(), lo, 5),
      lo + days_90_ms,
      many_signers([pkh(issuer_key)]),
    ),
    reference_inputs: largest_records(),
  }
