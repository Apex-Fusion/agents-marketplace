//// CBOR fixtures for codec parity. Test-only module: validators never import
//// it.
////
//// Each test builds one sample value and traces three strings: the type
//// name, the hex of `cbor.serialise(value)` and `cbor.diagnostic(value)`. It
//// also checks that the CBOR decodes back to the same value. The test name is
//// the fixture name. `fixtures/generate.mjs` runs these tests and writes the
//// traces to `fixtures/cbor-fixtures.json` (see `fixtures/README.md`).

use aiken/cbor
use aiken/primitive/bytearray
use cardano/address.{Address, Inline, VerificationKey}
use cardano/transaction.{OutputReference}
use identity_marketplace/types.{
  Accept, AdvertDatum, Agent, Anchor, AttActive, AttRevoked, Attest,
  AttestationDatum, Burn, Claim, Close, Contest, Delegate, DelegationDatum,
  EscrowDatum, Link, Live, Open, Pay, PostAdvert, PrincipalKey, Refund,
  RefundRevoked, Release, RetireAdvert, Returned, RevokeAtt, Submit, Submitted,
  Undelegate, UpdateAdvert, ValueLimit, Withdraw,
} as market
use vector_identity.{day_ms, days_30_ms, days_366_ms, days_7_ms, days_90_ms}
use vector_identity/redeemers.{
  Adopt, BumpEpoch, ByController, ByParty, ChangeController, RecoverCancel,
  RecoverFinalize, RecoverInit, Register, Retire, Revoke, SetSuccessor, Suspend,
  Unsuspend, Update,
} as redeemers
use vector_identity/types.{
  Accountable, ControllerSet, Ed25519, Hold, IdentityDatum, Key, KeyHash,
  LegacyDatum, P256, Party, PendingRecovery, Responsible, Revoked, Root,
  Subagent, Suspended,
} as identity

// ## Helpers

/// `size` bytes, each equal to `byte`.
fn filled(byte: Int, size: Int) -> ByteArray {
  if size == 0 {
    #""
  } else {
    bytearray.push(filled(byte, size - 1), byte)
  }
}

/// Traces the fixture and checks that its CBOR decodes back to the value.
fn emit(type_name: String, value: Data) -> Bool {
  let bytes = cbor.serialise(value)
  trace type_name
  trace bytearray.to_hex(bytes)
  trace cbor.diagnostic(value)
  cbor.deserialise(bytes) == Some(value)
}

/// 2026-11-02T00:00:00Z.
const t0: Int = 1_793_577_600_000

/// More than 64 bytes, so the CBOR splits it into 64-byte chunks.
const long_description: ByteArray =
  "Fixture agent for codec parity tests. Its description is longer than sixty-four bytes."

/// More than 64 bytes, so the CBOR splits it into 64-byte chunks.
const long_locator: ByteArray =
  "https://attestations.example.org/vector/2026/11/02/fixture-attestation-document.json"

fn seed(byte: Int, index: Int) -> OutputReference {
  OutputReference { transaction_id: filled(byte, 32), output_index: index }
}

fn module_1_hash() -> ByteArray {
  filled(0x66, 28)
}

// ## Identity records (Part 1 §5)

test identity_datum_full() {
  let record =
    IdentityDatum {
      controller: filled(0x11, 32),
      keys: [
        Key {
          key_type: Ed25519,
          key: filled(0x22, 32),
          purposes: 1 + 8,
          pop: None,
        },
        Key {
          key_type: P256,
          key: bytearray.concat(#"02", filled(0x33, 32)),
          purposes: 2,
          pop: Some(filled(0x44, 64)),
        },
      ],
      parties: [
        Party {
          role: Accountable,
          signer: KeyHash { hash: filled(0x55, 28) },
          organisation: Some("did:web:example.org"),
          not_before: t0,
          not_after: Some(t0 + days_366_ms),
          rights: 3,
          removal_after: Some(t0 + days_30_ms),
        },
        Party {
          role: Responsible,
          signer: ControllerSet,
          organisation: None,
          not_before: t0,
          not_after: None,
          rights: 1,
          removal_after: None,
        },
        Party {
          role: Accountable,
          signer: identity.Script { hash: module_1_hash() },
          organisation: None,
          not_before: t0,
          not_after: None,
          rights: 3,
          removal_after: None,
        },
      ],
      guardian_threshold: 1,
      pending_recovery: Some(
        PendingRecovery {
          new_controller: filled(0x77, 32),
          effective_after: t0 + day_ms + days_7_ms,
        },
      ),
      lineage: Subagent { parent: filled(0x88, 32), parent_epoch: 2, depth: 1 },
      subagent_epoch: 0,
      name: "fixture-agent",
      description: long_description,
      framework: "vector-agent-template",
      endpoint: "",
      capabilities: ["ocr.extract.v1", "llm.text.generate.v1"],
      created_at: t0,
      status: Suspended {
        holds: [
          Hold {
            by: ControllerSet,
            reason: 6,
            since: t0 + day_ms,
            until: t0 + day_ms + days_7_ms,
          },
          Hold {
            by: identity.Script { hash: module_1_hash() },
            reason: 64,
            since: t0 + 2 * day_ms,
            until: t0 + 2 * day_ms + days_30_ms,
          },
        ],
      },
    }
  emit(@"vector_identity/types.IdentityDatum", record)
}

test identity_datum_revoked_tombstone() {
  let record =
    IdentityDatum {
      controller: filled(0x11, 32),
      keys: [],
      parties: [],
      guardian_threshold: 0,
      pending_recovery: None,
      lineage: Root,
      subagent_epoch: 3,
      name: "revoked-agent",
      description: "",
      framework: "",
      endpoint: "",
      capabilities: [],
      created_at: t0,
      status: Revoked {
        by: ControllerSet,
        reason: 1,
        at: t0 + 10 * day_ms,
        invalid_from: Some(t0 + 9 * day_ms),
        successor: Some(filled(0x99, 32)),
      },
    }
  emit(@"vector_identity/types.IdentityDatum", record)
}

test identity_datum_retired_tombstone() {
  let record =
    IdentityDatum {
      controller: filled(0x12, 32),
      keys: [],
      parties: [],
      guardian_threshold: 0,
      pending_recovery: None,
      lineage: Root,
      subagent_epoch: 0,
      name: "retired-agent",
      description: "",
      framework: "",
      endpoint: "",
      capabilities: [],
      created_at: t0,
      status: identity.Retired { at: t0 + 20 * day_ms, successor: None },
    }
  emit(@"vector_identity/types.IdentityDatum", record)
}

test legacy_datum() {
  let record =
    LegacyDatum {
      owner: VerificationKey(filled(0xaa, 28)),
      name: "Legacy Agent",
      description: "A record of the legacy registry.",
      capabilities: ["document-extraction"],
      framework: "custom",
      endpoint: "https://legacy.example.org/agent",
      registered_at: 1_756_000_000_000,
    }
  emit(@"vector_identity/types.LegacyDatum", record)
}

// ## Attestations (Part 2 §4)

test attestation_datum_full() {
  let attestation =
    AttestationDatum {
      subject: filled(0xa1, 32),
      issuer: filled(0xa2, 32),
      issuer_id: Some(filled(0xa3, 32)),
      att_type: 2,
      format: Some(50),
      profile: Some(filled(0xa4, 32)),
      digest: filled(0xa5, 32),
      locator: Some(long_locator),
      envelope_sig: Some(filled(0xa6, 64)),
      issued_at: t0,
      valid_from: Some(t0),
      valid_until: Some(t0 + days_366_ms),
      solicited: True,
      status: AttRevoked { at: t0 + days_30_ms, reason: 5 },
      contested: Some(
        Anchor {
          uri: "https://subject.example.org/reply.json",
          sha256: filled(0xa7, 32),
        },
      ),
      links: [
        Link { rel: 0, target: filled(0xa8, 32) },
        Link { rel: 3, target: filled(0xa9, 32) },
      ],
    }
  emit(@"identity_marketplace/types.AttestationDatum", attestation)
}

test attestation_datum_minimal() {
  let attestation =
    AttestationDatum {
      subject: filled(0xa1, 32),
      issuer: filled(0xa2, 32),
      issuer_id: None,
      att_type: 0,
      format: None,
      profile: None,
      digest: filled(0xa5, 32),
      locator: None,
      envelope_sig: None,
      issued_at: t0,
      valid_from: None,
      valid_until: None,
      solicited: False,
      status: AttActive,
      contested: None,
      links: [],
    }
  emit(@"identity_marketplace/types.AttestationDatum", attestation)
}

// ## Delegations and vaults (Part 2 §5)

test delegation_datum() {
  let delegation =
    DelegationDatum {
      delegator: Agent { id: filled(0xb1, 32) },
      parent: Some(filled(0xb2, 32)),
      delegate: filled(0xb3, 32),
      delegate_key: filled(0xb4, 28),
      actions: ["marketplace.hire.v1", "ocr.*"],
      resources: [
        "script:0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      ],
      not_before: t0,
      not_after: t0 + days_90_ms,
      depth: 2,
      remaining: 1,
      purpose: Some(filled(0xb5, 32)),
      value: Some(
        ValueLimit { per_tx: 10_000_000, total: 100_000_000, period_ms: day_ms },
      ),
    }
  emit(@"identity_marketplace/types.DelegationDatum", delegation)
}

test vault_datum_live() {
  let vault =
    Live {
      owner: PrincipalKey {
        hash: filled(0xc1, 28),
        organisation: Some("example.org"),
      },
      delegation: filled(0xc2, 32),
      spent: 25_000_000,
      period_start: t0,
    }
  emit(@"identity_marketplace/types.VaultDatum", vault)
}

test vault_datum_returned() {
  emit(
    @"identity_marketplace/types.VaultDatum",
    Returned { owner: Agent { id: filled(0xc3, 32) } },
  )
}

// ## Escrow and advert (Part 2 §6)

test escrow_datum_with_refund() {
  let refund_datum: Data =
    Returned {
      owner: PrincipalKey { hash: filled(0xc1, 28), organisation: None },
    }
  let escrow =
    EscrowDatum {
      buyer_pkh: filled(0xd1, 28),
      supplier_pkh: filled(0xd2, 28),
      advert_ref: seed(0xd3, 1),
      capability_id: "ocr.extract.v1",
      request_spec_hash: filled(0xd4, 32),
      prompt_hash: filled(0xd5, 32),
      payment_lovelace: 5_000_000,
      buyer_bond_lovelace: 1_000_000,
      supplier_bond_lovelace: 1_000_000,
      deliver_by: t0 + 3_600_000,
      posted_at: t0,
      submitted_at: Some(t0 + 1_800_000),
      result_receipt_hash: Some(filled(0xd6, 32)),
      state: Submitted,
      agent_id: filled(0xd7, 32),
      refund: Some(
        Refund {
          address: Address {
            payment_credential: address.Script(filled(0xd8, 28)),
            stake_credential: Some(Inline(VerificationKey(filled(0xd9, 28)))),
          },
          datum: Some(refund_datum),
        },
      ),
    }
  emit(@"identity_marketplace/types.EscrowDatum", escrow)
}

test escrow_datum_without_refund() {
  let escrow =
    EscrowDatum {
      buyer_pkh: filled(0xd1, 28),
      supplier_pkh: filled(0xd2, 28),
      advert_ref: seed(0xd3, 0),
      capability_id: "llm.text.generate.v1",
      request_spec_hash: filled(0xd4, 32),
      prompt_hash: filled(0xd5, 32),
      payment_lovelace: 2_000_000,
      buyer_bond_lovelace: 500_000,
      supplier_bond_lovelace: 500_000,
      deliver_by: t0 + 3_600_000,
      posted_at: t0,
      submitted_at: None,
      result_receipt_hash: None,
      state: Open,
      agent_id: filled(0xd7, 32),
      refund: None,
    }
  emit(@"identity_marketplace/types.EscrowDatum", escrow)
}

test advert_datum() {
  let advert =
    AdvertDatum {
      supplier_pkh: filled(0xe1, 28),
      capability_id: "llm.text.generate.v1",
      model: "qwen2.5:0.5b",
      max_output_tokens: 4096,
      max_processing_ms: 60_000,
      price_lovelace: 1_500_000,
      supplier_bond_lovelace: 1_000_000,
      buyer_bond_lovelace: 1_000_000,
      endpoint_url: "https://supplier.example.org/v1",
      detail_uri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      detail_hash: filled(0xe2, 32),
      advertised_at: t0,
      status: market.Active,
      agent_id: filled(0xe3, 32),
    }
  emit(@"identity_marketplace/types.AdvertDatum", advert)
}

// ## Identity redeemers (Part 2 §3.1)

test identity_mint_register() {
  emit(
    @"vector_identity/redeemers.IdentityMint",
    Register { seed: seed(0xf1, 24) },
  )
}

test identity_mint_adopt() {
  emit(
    @"vector_identity/redeemers.IdentityMint",
    Adopt { proof: [filled(0xf2, 32), filled(0xf3, 32)] },
  )
}

test identity_spend_update() {
  emit(@"vector_identity/redeemers.IdentitySpend", Update)
}

test identity_spend_change_controller() {
  emit(@"vector_identity/redeemers.IdentitySpend", ChangeController)
}

test identity_spend_suspend() {
  emit(
    @"vector_identity/redeemers.IdentitySpend",
    Suspend { actor: ByController },
  )
}

test identity_spend_unsuspend() {
  emit(
    @"vector_identity/redeemers.IdentitySpend",
    Unsuspend { author: identity.Script { hash: module_1_hash() } },
  )
}

test identity_spend_revoke() {
  emit(
    @"vector_identity/redeemers.IdentitySpend",
    Revoke { actor: ByParty { index: 2 } },
  )
}

test identity_spend_retire() {
  emit(@"vector_identity/redeemers.IdentitySpend", Retire)
}

test identity_spend_reclaim() {
  emit(@"vector_identity/redeemers.IdentitySpend", redeemers.Reclaim)
}

test identity_spend_set_successor() {
  emit(@"vector_identity/redeemers.IdentitySpend", SetSuccessor)
}

test identity_spend_bump_epoch() {
  emit(@"vector_identity/redeemers.IdentitySpend", BumpEpoch)
}

test identity_spend_recover_init() {
  emit(
    @"vector_identity/redeemers.IdentitySpend",
    RecoverInit { guardians: [0, 3] },
  )
}

test identity_spend_recover_cancel() {
  emit(
    @"vector_identity/redeemers.IdentitySpend",
    RecoverCancel { guardians: [1] },
  )
}

test identity_spend_recover_finalize() {
  emit(@"vector_identity/redeemers.IdentitySpend", RecoverFinalize)
}

// ## Other redeemers (Part 2 §4–§6)

test attestation_mint_attest() {
  emit(
    @"identity_marketplace/types.AttestationMint",
    Attest { seed: seed(0xf4, 0) },
  )
}

test attestation_mint_burn() {
  emit(@"identity_marketplace/types.AttestationMint", Burn)
}

test attestation_spend_revoke_att() {
  emit(@"identity_marketplace/types.AttestationSpend", RevokeAtt { reason: 5 })
}

test attestation_spend_contest() {
  emit(@"identity_marketplace/types.AttestationSpend", Contest)
}

test attestation_spend_withdraw() {
  emit(@"identity_marketplace/types.AttestationSpend", Withdraw)
}

test delegation_mint_delegate() {
  emit(
    @"identity_marketplace/types.DelegationMint",
    Delegate { seed: seed(0xf5, 300) },
  )
}

test delegation_mint_undelegate() {
  emit(@"identity_marketplace/types.DelegationMint", Undelegate)
}

test vault_spend_pay() {
  emit(@"identity_marketplace/types.VaultSpend", Pay)
}

test vault_spend_close() {
  emit(@"identity_marketplace/types.VaultSpend", Close)
}

test escrow_redeemer_claim() {
  emit(@"identity_marketplace/types.EscrowRedeemer", Claim)
}

test escrow_redeemer_submit() {
  emit(
    @"identity_marketplace/types.EscrowRedeemer",
    Submit { receipt_hash: filled(0xd6, 32) },
  )
}

test escrow_redeemer_accept() {
  emit(@"identity_marketplace/types.EscrowRedeemer", Accept)
}

test escrow_redeemer_reclaim() {
  emit(@"identity_marketplace/types.EscrowRedeemer", market.Reclaim)
}

test escrow_redeemer_release() {
  emit(@"identity_marketplace/types.EscrowRedeemer", Release)
}

test escrow_redeemer_refund_revoked() {
  emit(@"identity_marketplace/types.EscrowRedeemer", RefundRevoked)
}

test advert_redeemer_post() {
  emit(@"identity_marketplace/types.AdvertRedeemer", PostAdvert)
}

test advert_redeemer_update() {
  emit(@"identity_marketplace/types.AdvertRedeemer", UpdateAdvert)
}

test advert_redeemer_retire() {
  emit(@"identity_marketplace/types.AdvertRedeemer", RetireAdvert)
}
