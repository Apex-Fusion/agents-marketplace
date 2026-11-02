//// Test fixtures for the delegation and vault tests
//// (`identity_marketplace/delegation/tests`, `identity_marketplace/vault/tests`).
//// Validators do not use this module.
////
//// Agent `n` has the identifier `agent_id(n)`, the controller
//// `controller_key(n)`, a delegation key (`delegation_key(n)`, purposes
//// authentication and delegation) and a transaction key (`transaction_key(n)`,
//// purposes authentication and transaction). Its record is a root record with
//// an Accountable Party (the controller) that covers the test window.
////
//// Delegation chains: link `n` (1..4) has the identifier `delegation_id(n)`,
//// the delegate agent `n` and the delegate key `delegation_key(n)`. Link 1 has
//// the root delegator and no parent; link `n > 1` has the delegator
//// `Agent(agent_id(n - 1))` and the parent `delegation_id(n - 1)`. Each link
//// is narrower than its parent.

use aiken/cbor
use aiken/collection/list
use aiken/crypto.{blake2b_224, blake2b_256}
use aiken/interval.{Finite, Interval, IntervalBound}
use aiken/primitive/bytearray
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ValidityRange,
}
use identity_marketplace/types.{
  Agent, DelegationDatum, Delegator, PrincipalKey, ValueLimit,
}
use vector_identity.{
  day_ms, days_30_ms, days_7_ms, max_depth, purpose_authentication,
  purpose_delegation, purpose_transaction, right_revoke, right_suspend,
}
use vector_identity/types.{
  Accountable, Active, ControllerSet, Ed25519, Hold, IdentityDatum, Key, KeyHash,
  Party, Revoked, Root, Suspended,
} as identity

// ## Hashes and keys

/// The identity script hash (policy ID).
pub const identity_hash: ByteArray =
  #"1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d"

/// The delegation script hash (policy ID).
pub const delegation_hash: ByteArray =
  #"dededededededededededededededededededededededededededede"

/// The vault script hash.
pub const vault_hash: ByteArray =
  #"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"

/// The escrow script hash.
pub const escrow_hash: ByteArray =
  #"e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"

/// Another script hash and policy ID.
pub const other_hash: ByteArray =
  #"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"

/// The key hash of a person who delegates with a `PrincipalKey`.
pub const principal: ByteArray =
  #"b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"

/// The key hash of a stranger.
pub const stranger: ByteArray =
  #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e"

/// The resource `script:<escrow_hash>`.
pub const escrow_pattern: ByteArray =
  "script:e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"

/// One AP3X in base units.
pub const ap3x: Int = 1_000_000

// ## Time

/// 2026-11-02T00:00:00Z.
pub const lo: Int = 1_793_577_600_000

/// `lo` + 10 minutes.
pub const hi: Int = 1_793_578_200_000

/// The validity range `[lower, upper]` with inclusive finite bounds.
pub fn range(lower: Int, upper: Int) -> ValidityRange {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lower), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(upper), is_inclusive: True },
  }
}

/// The test window `[lo, hi]`.
pub fn now() -> ValidityRange {
  range(lo, hi)
}

// ## Agents

/// The identifier of agent `n` (32 bytes).
pub fn agent_id(n: Int) -> ByteArray {
  bytearray.push(
    #"00000000000000000000000000000000000000000000000000000000000000",
    n,
  )
}

/// The controller key of agent `n` (32 bytes).
pub fn controller_key(n: Int) -> ByteArray {
  bytearray.push(
    #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    n,
  )
}

/// The delegation key of agent `n` (32 bytes).
pub fn delegation_key(n: Int) -> ByteArray {
  bytearray.push(
    #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
    n,
  )
}

/// The transaction key of agent `n` (32 bytes): no delegation purpose.
pub fn transaction_key(n: Int) -> ByteArray {
  bytearray.push(
    #"a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8",
    n,
  )
}

/// The key hash of a public key.
pub fn hash(key: ByteArray) -> ByteArray {
  blake2b_224(key)
}

/// The root record of agent `n`, Active.
pub fn agent(n: Int) -> IdentityDatum {
  IdentityDatum {
    controller: controller_key(n),
    keys: [
      Key {
        key_type: Ed25519,
        key: delegation_key(n),
        purposes: purpose_authentication + purpose_delegation,
        pop: None,
      },
      Key {
        key_type: Ed25519,
        key: transaction_key(n),
        purposes: purpose_authentication + purpose_transaction,
        pop: None,
      },
    ],
    parties: [
      Party {
        role: Accountable,
        signer: ControllerSet,
        organisation: None,
        not_before: lo - days_30_ms,
        not_after: None,
        rights: right_suspend + right_revoke,
        removal_after: None,
      },
    ],
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

/// The record with a hold in force (effective status Suspended).
pub fn suspended(record: IdentityDatum) -> IdentityDatum {
  IdentityDatum {
    ..record,
    status: Suspended {
      holds: [
        Hold {
          by: KeyHash { hash: stranger },
          reason: 6,
          since: lo - day_ms,
          until: hi + day_ms,
        },
      ],
    },
  }
}

/// The record as a revocation tombstone (effective status Revoked).
pub fn revoked(record: IdentityDatum) -> IdentityDatum {
  IdentityDatum {
    ..record,
    keys: [],
    parties: [],
    description: "",
    framework: "",
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

/// The record without its delegation key (the controller removed it).
pub fn without_delegation_key(record: IdentityDatum) -> IdentityDatum {
  IdentityDatum {
    ..record,
    keys: list.filter(
      record.keys,
      fn(key) { key.purposes != purpose_authentication + purpose_delegation },
    ),
  }
}

/// A reference input of an output at `address` with `value` and the inline
/// datum `datum`.
pub fn input_at(
  n: Int,
  address: Address,
  value: assets.Value,
  datum: Data,
) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"4242424242424242424242424242424242424242424242424242424242424242",
      output_index: n,
    },
    output: Output {
      address,
      value,
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

/// The record of agent `n` as an authentic reference input.
pub fn record_input(n: Int, record: IdentityDatum) -> Input {
  input_at(
    100 + n,
    address.from_script(identity_hash),
    assets.from_lovelace(10 * ap3x)
      |> assets.add(identity_hash, agent_id(n), 1),
    record,
  )
}

/// The Active records of agents `first` to `last`.
pub fn records(first: Int, last: Int) -> List<Input> {
  if first > last {
    []
  } else {
    [record_input(first, agent(first)), ..records(first + 1, last)]
  }
}

// ## Delegations

/// The identifier of chain link `n` (32 bytes).
pub fn delegation_id(n: Int) -> ByteArray {
  bytearray.push(
    #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    n,
  )
}

/// A `PrincipalKey` delegator with an organisation.
pub fn principal_delegator() -> Delegator {
  PrincipalKey { hash: principal, organisation: Some("example.org") }
}

/// The delegator agent `n`.
pub fn agent_delegator(n: Int) -> Delegator {
  Agent { id: agent_id(n) }
}

/// The value limit of the chain links: 100 AP3X per transaction, 500 AP3X per
/// day.
pub fn limit() -> ValueLimit {
  ValueLimit { per_tx: 100 * ap3x, total: 500 * ap3x, period_ms: day_ms }
}

/// Chain link `n` with `delegator` and `parent`.
pub fn link(
  n: Int,
  delegator: Delegator,
  parent: Option<ByteArray>,
) -> DelegationDatum {
  DelegationDatum {
    delegator,
    parent,
    delegate: agent_id(n),
    delegate_key: hash(delegation_key(n)),
    actions: ["marketplace.*", "ocr.*"],
    resources: [escrow_pattern],
    not_before: lo - days_7_ms + n,
    not_after: lo + days_30_ms - n,
    depth: n,
    remaining: max_depth - n,
    purpose: Some(blake2b_256("purpose text")),
    value: Some(limit()),
  }
}

/// Link `n` of the chain whose link 1 has the delegator `root`.
pub fn chain_link(n: Int, root: Delegator) -> DelegationDatum {
  if n == 1 {
    link(1, root, None)
  } else {
    link(n, agent_delegator(n - 1), Some(delegation_id(n - 1)))
  }
}

/// The delegation `id` with `datum` as an authentic reference input.
pub fn delegation_input(id: ByteArray, datum: DelegationDatum) -> Input {
  input_at(
    200 + bytearray.at(id, 0),
    address.from_script(delegation_hash),
    delegation_value(id),
    datum,
  )
}

/// The value of a delegation output: 2 AP3X and the token.
pub fn delegation_value(id: ByteArray) -> assets.Value {
  assets.from_lovelace(2 * ap3x) |> assets.add(delegation_hash, id, 1)
}

/// The delegation output of `id` with `datum`.
pub fn delegation_output(id: ByteArray, datum: DelegationDatum) -> Output {
  Output {
    address: address.from_script(delegation_hash),
    value: delegation_value(id),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

/// Links 1 to `depth` of the chain with the root delegator `root`, as
/// reference inputs.
pub fn chain_inputs(depth: Int, root: Delegator) -> List<Input> {
  if depth == 0 {
    []
  } else {
    [
      delegation_input(delegation_id(depth), chain_link(depth, root)),
      ..chain_inputs(depth - 1, root)
    ]
  }
}

/// Every reference input that the use of link `depth` reads: the links, the
/// records of their delegates (agents 1..`depth`), and the record of agent 0
/// when the root delegator is that agent.
pub fn chain_refs(depth: Int, root: Delegator) -> List<Input> {
  let root_records =
    when root is {
      Agent { .. } -> [record_input(0, agent(0))]
      PrincipalKey { .. } -> []
    }
  list.concat(
    chain_inputs(depth, root),
    list.concat(records(1, depth), root_records),
  )
}

// ## Other inputs

/// A seed for `Delegate`.
pub fn seed() -> OutputReference {
  OutputReference {
    transaction_id: #"9999999999999999999999999999999999999999999999999999999999999999",
    output_index: 1,
  }
}

/// The identifier that `Delegate { seed: seed() }` mints.
pub fn new_id() -> ByteArray {
  blake2b_256(cbor.serialise(seed()))
}

/// A wallet input at the key address of `principal`.
pub fn wallet_input(reference: OutputReference) -> Input {
  Input {
    output_reference: reference,
    output: Output {
      address: address.from_verification_key(principal),
      value: assets.from_lovelace(50 * ap3x),
      datum: transaction.NoDatum,
      reference_script: None,
    },
  }
}

/// The address with the payment credential `Script(hash)` and a stake key.
pub fn staked_script_address(hash: ByteArray) -> Address {
  Address {
    payment_credential: Script(hash),
    stake_credential: Some(address.Inline(VerificationKey(stranger))),
  }
}
