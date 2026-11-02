//// Datum and redeemer types of the attestation (Part 2 §4), delegation
//// (§5.2), vault (§5.3), escrow (§6.1) and advert (§6.2) contracts
//// (`docs/IDENTITY_REGISTRY.md`).
////
//// The field order and the constructor order are part of the on-chain format.
//// A record type is `Constr 0` with its fields in the order shown. The
//// constructors of a sum type are numbered from 0 in the order shown (Plutus
//// Data tags 121, 122, ...). Do not reorder or insert fields or constructors.
////
//// The identity record types are in `vector_identity/types`, and the identity
//// redeemers are in `vector_identity/redeemers`.

use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/transaction.{OutputReference}

// ## Attestation (§4)

/// An attestation: `Constr 0` with 16 fields.
pub type AttestationDatum {
  /// Identifier of the agent.
  subject: ByteArray,
  /// Ed25519 public key, 32 bytes.
  issuer: ByteArray,
  /// Set when the issuer is a registered agent.
  issuer_id: Option<ByteArray>,
  /// 0 identity, 1 provenance, 2 software, 3 environment, 4 principal
  /// binding, 5 approval, 15 other; others reserved.
  att_type: Int,
  /// CoAP Content-Format of the document; `None` = unspecified.
  format: Option<Int>,
  /// 32 bytes: hash of the profile or type URI.
  profile: Option<ByteArray>,
  /// 32 bytes: SHA-256 of the document.
  digest: ByteArray,
  /// Retrieval hint, up to 256 bytes.
  locator: Option<ByteArray>,
  /// 64 bytes: COSE_Sign1 signature (§4.2).
  envelope_sig: Option<ByteArray>,
  issued_at: Int,
  valid_from: Option<Int>,
  valid_until: Option<Int>,
  /// The subject's controller co-signed.
  solicited: Bool,
  status: AttStatus,
  /// The subject's reply.
  contested: Option<Anchor>,
  /// 0..4 links.
  links: List<Link>,
}

pub type AttStatus {
  AttActive
  AttRevoked { at: Int, reason: Int }
}

/// `uri`: 1..256 bytes. `sha256`: 32 bytes.
pub type Anchor {
  uri: ByteArray,
  sha256: ByteArray,
}

/// `rel`: 0 supersedes, 1 depends_on, 2 corroborates, 3 disputes. `target`:
/// token name of another attestation (32 bytes).
pub type Link {
  rel: Int,
  target: ByteArray,
}

pub type AttestationMint {
  Attest { seed: OutputReference }
  Burn
}

pub type AttestationSpend {
  RevokeAtt { reason: Int }
  Contest
  Withdraw
}

// ## Delegation (§5.2)

pub type Delegator {
  /// `organisation`: DID or domain of an organisation, 1..64 bytes.
  PrincipalKey { hash: ByteArray, organisation: Option<ByteArray> }
  /// A registered agent.
  Agent { id: ByteArray }
}

/// `1 <= period_ms`; `per_tx <= total <= 10,000 AP3X`.
pub type ValueLimit {
  per_tx: Int,
  total: Int,
  period_ms: Int,
}

/// A delegation: `Constr 0` with 12 fields.
pub type DelegationDatum {
  delegator: Delegator,
  /// Token name of the parent delegation (delegation policy).
  parent: Option<ByteArray>,
  /// Identifier of the delegate agent.
  delegate: ByteArray,
  /// Key hash of the delegate's Ed25519 delegation key.
  delegate_key: ByteArray,
  /// 1..16 action patterns.
  actions: List<ByteArray>,
  /// 0..8 resource patterns.
  resources: List<ByteArray>,
  not_before: Int,
  not_after: Int,
  /// 1..4.
  depth: Int,
  /// Further hops allowed below this one; `depth + remaining <= 4`.
  remaining: Int,
  /// 32 bytes: hash of a purpose text or mandate.
  purpose: Option<ByteArray>,
  value: Option<ValueLimit>,
}

pub type DelegationMint {
  Delegate { seed: OutputReference }
  Undelegate
}

// ## Vault (§5.3)

pub type VaultDatum {
  Live {
    owner: Delegator,
    delegation: ByteArray,
    spent: Int,
    period_start: Int,
  }
  /// Escrow refunds; only `Close` spends them.
  Returned { owner: Delegator }
}

pub type VaultSpend {
  Pay
  Close
}

// ## Escrow (§6.1)

/// Escrow states, in the legacy order: Open=121, Claimed=122, Submitted=123,
/// Accepted=124, Reclaimed=125, Released=126.
pub type EscrowState {
  Open
  Claimed
  Submitted
  Accepted
  Reclaimed
  Released
}

/// The new escrow datum: `Constr 0` with 16 fields. Fields 0..13 are the
/// legacy escrow datum (`contracts/marketplace/lib/marketplace/types.ak`) in
/// the legacy order; fields 14 and 15 are new.
///
///   0  buyer_pkh               ByteArray(28)
///   1  supplier_pkh            ByteArray(28)
///   2  advert_ref              OutputReference
///   3  capability_id           ByteArray (UTF-8)
///   4  request_spec_hash       ByteArray(32)
///   5  prompt_hash             ByteArray(32)
///   6  payment_lovelace        Int
///   7  buyer_bond_lovelace     Int
///   8  supplier_bond_lovelace  Int
///   9  deliver_by              Int (POSIX ms)
///   10 posted_at               Int (POSIX ms)
///   11 submitted_at            Option<Int>
///   12 result_receipt_hash     Option<ByteArray>
///   13 state                   EscrowState
///   14 agent_id                ByteArray(32), from the advert
///   15 refund                  Option<Refund>; None = the buyer key
pub type EscrowDatum {
  buyer_pkh: VerificationKeyHash,
  supplier_pkh: VerificationKeyHash,
  advert_ref: OutputReference,
  capability_id: ByteArray,
  request_spec_hash: ByteArray,
  prompt_hash: ByteArray,
  payment_lovelace: Int,
  buyer_bond_lovelace: Int,
  supplier_bond_lovelace: Int,
  deliver_by: Int,
  posted_at: Int,
  submitted_at: Option<Int>,
  result_receipt_hash: Option<ByteArray>,
  state: EscrowState,
  agent_id: ByteArray,
  refund: Option<Refund>,
}

/// Where buyer payouts go: outputs at exactly `address`, with no datum when
/// `datum` is `None`, or with the inline datum `d` when it is `Some(d)`.
pub type Refund {
  address: Address,
  datum: Option<Data>,
}

/// Escrow redeemers, in the legacy order (Claim=121, Submit=122, Accept=123,
/// Reclaim=124, Release=125), then `RefundRevoked` (126).
pub type EscrowRedeemer {
  Claim
  Submit { receipt_hash: ByteArray }
  Accept
  Reclaim
  Release
  RefundRevoked
}

// ## Advert (§6.2)

/// Advert status, in the legacy order: Active=121, Retired=122.
pub type AdvertStatus {
  Active
  Retired
}

/// The new advert datum: `Constr 0` with 14 fields. Fields 0..12 are the legacy
/// advert datum in the legacy order; field 13 is new.
///
///   0  supplier_pkh            ByteArray(28)
///   1  capability_id           ByteArray (UTF-8)
///   2  model                   ByteArray (UTF-8)
///   3  max_output_tokens       Int
///   4  max_processing_ms       Int
///   5  price_lovelace          Int
///   6  supplier_bond_lovelace  Int
///   7  buyer_bond_lovelace     Int
///   8  endpoint_url            ByteArray (UTF-8)
///   9  detail_uri              ByteArray (UTF-8)
///   10 detail_hash             ByteArray(32)
///   11 advertised_at           Int (POSIX ms)
///   12 status                  AdvertStatus
///   13 agent_id                ByteArray(32)
pub type AdvertDatum {
  supplier_pkh: VerificationKeyHash,
  capability_id: ByteArray,
  model: ByteArray,
  max_output_tokens: Int,
  max_processing_ms: Int,
  price_lovelace: Int,
  supplier_bond_lovelace: Int,
  buyer_bond_lovelace: Int,
  endpoint_url: ByteArray,
  detail_uri: ByteArray,
  detail_hash: ByteArray,
  advertised_at: Int,
  status: AdvertStatus,
  agent_id: ByteArray,
}

/// Advert redeemers, in the legacy order: PostAdvert=121, UpdateAdvert=122,
/// RetireAdvert=123.
pub type AdvertRedeemer {
  PostAdvert
  UpdateAdvert
  RetireAdvert
}
