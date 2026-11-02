//// Definitions of the identity contract: Part 2 §3.2, §3.5 and §3.7
//// (`docs/IDENTITY_REGISTRY.md`). The mint and spend handlers share them.

use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Credential}
use cardano/transaction.{InlineDatum, Input, Output}
use identity_marketplace/common.{ap3x_and_token, ap3x_of, key_signed}
use identity_marketplace/identity/datum.{valid_datum}
use vector_identity.{find_record, right_recover}
use vector_identity/types.{
  Accountable, ControllerSet, Guardian, Hold, IdentityDatum, KeyHash, Party,
  Retired, Revoked, Root, Signer, Status,
} as identity

/// The parameters of the `identity` validator, in their order (Part 2 §2).
pub type IdentityParams {
  /// Script hash and policy ID of the legacy registry.
  legacy_hash: ByteArray,
  /// Merkle root of the adoption allowlist (Part 2 §3.4).
  legacy_root: ByteArray,
  /// Policy ID of the configuration token (the `config_seal` hash).
  config_policy: ByteArray,
  /// Script hash of `config_holder`.
  config_holder: ByteArray,
}

/// The least AP3X (base units) of a record output while the status is Active
/// or Suspended: 10 AP3X.
pub const min_live_ap3x: Int = 10_000_000

/// Reason code `keyCompromise` (Appendix A). A revocation with it needs
/// `invalid_from`.
pub const reason_key_compromise: Int = 1

/// Reason code `disputeVerdict` (Appendix A). Only `Script { hash: M1 }` can
/// use it.
pub const reason_dispute_verdict: Int = 64

/// The reason codes of a new hold (Appendix A, "Allowed in" Suspend).
pub const suspend_reasons: List<Int> = [0, 6, 9, 64, 65, 67, 68]

/// The reason codes of a revocation (Appendix A, "Allowed in" Revoke).
pub const revoke_reasons: List<Int> = [0, 1, 3, 4, 5, 9, 64, 65]

/// `ok(s)` of Part 2 §3.2. `controller` is `D.controller` for a spend and
/// `D0.controller` at creation. `m1` is the Module-1 hash from the
/// configuration reference input, when the transaction has it.
///
/// - `KeyHash { hash }`: `hash` is a required signer.
/// - `ControllerSet`: `signed(controller)`.
/// - `Script { hash }`: `hash = M1`, and the transaction has a withdrawal for
///   `Script(M1)`.
pub fn signer_ok(
  signer: Signer,
  signatories: List<VerificationKeyHash>,
  controller: ByteArray,
  m1: Option<ByteArray>,
  withdrawals: Pairs<Credential, Int>,
) -> Bool {
  when signer is {
    KeyHash { hash } -> list.has(signatories, hash)
    identity.Script { hash } -> and {
        m1 == Some(hash),
        pairs.has_key(withdrawals, address.Script(hash)),
      }
    ControllerSet -> key_signed(signatories, controller)
  }
}

/// True when `rights` contains `right` (1 suspend, 2 revoke, 4 recover).
pub fn has_right(rights: Int, right: Int) -> Bool {
  rights / right % 2 == 1
}

/// `covers(p)` of Part 2 §3.2: `not_before <= lo`, and `not_after` is empty
/// or `>= hi`.
pub fn covers(party: Party, lo: Int, hi: Int) -> Bool {
  party.not_before <= lo && not_ended(party, hi)
}

/// An eligible guardian: role Guardian, the recover right, and `covers`.
pub fn eligible_guardian(party: Party, lo: Int, hi: Int) -> Bool {
  and {
    party.role == Guardian,
    has_right(party.rights, right_recover),
    covers(party, lo, hi),
  }
}

/// The guardian bound of Part 2 §3.2: `guardian_threshold` is at most the
/// number of distinct signers of parties with role Guardian and the recover
/// right whose `not_after` is empty or `>= hi`. A valid datum has no two
/// parties with the same role and signer, so each such party has its own
/// signer and the count of parties is the count of signers.
pub fn guardian_bound(record: IdentityDatum, hi: Int) -> Bool {
  record.guardian_threshold <= list.count(
    record.parties,
    fn(party) {
      and {
        party.role == Guardian,
        has_right(party.rights, right_recover),
        not_ended(party, hi),
      }
    },
  )
}

/// `accountable(D)` of Part 2 §3.2: some party with role Accountable covers.
pub fn accountable(record: IdentityDatum, lo: Int, hi: Int) -> Bool {
  list.any(
    record.parties,
    fn(party) { party.role == Accountable && covers(party, lo, hi) },
  )
}

/// A current author (Part 2 §3.2): `ControllerSet`, the signer of a party in
/// `parties`, or any `Script` signer. Only Module-1 can set a `Script` hold,
/// so a Module-1 hold stays after Module-1's removal without a lookup of `M1`.
pub fn current_author(signer: Signer, parties: List<Party>) -> Bool {
  when signer is {
    KeyHash { .. } -> list.any(parties, fn(party) { party.signer == signer })
    identity.Script { .. } -> True
    ControllerSet -> True
  }
}

/// The holds that a `Suspend` or an `Unsuspend` by `author` keeps (Part 2
/// §3.5): the holds in force (`until > lo`) whose author is a current author
/// other than `author`, in their order.
pub fn kept_holds(
  holds: List<Hold>,
  parties: List<Party>,
  lo: Int,
  author: Signer,
) -> List<Hold> {
  list.filter(
    holds,
    fn(hold) {
      and {
        hold.until > lo,
        hold.by != author,
        current_author(hold.by, parties),
      }
    },
  )
}

/// True when `reason` is one of `allowed`, and reason 64 comes only from
/// `Script { hash: M1 }` (Part 2 §3.7).
pub fn reason_ok(
  reason: Int,
  allowed: List<Int>,
  author: Signer,
  m1: Option<ByteArray>,
) -> Bool {
  and {
    list.has(allowed, reason),
    if reason == reason_dispute_verdict {
      when author is {
        identity.Script { hash } -> m1 == Some(hash)
        _ -> False
      }
    } else {
      True
    },
  }
}

/// `invalid_from` of a revocation (Part 2 §3.7): empty or in
/// `[created_at, lo]`; reason 1 (`keyCompromise`) requires it.
pub fn invalid_from_ok(
  invalid_from: Option<Int>,
  reason: Int,
  created_at: Int,
  lo: Int,
) -> Bool {
  when invalid_from is {
    None -> reason != reason_key_compromise
    Some(t) -> created_at <= t && t <= lo
  }
}

/// Terminal (Part 2 §3.2): status Revoked or Retired.
pub fn terminal(status: Status) -> Bool {
  when status is {
    Revoked { .. } -> True
    Retired { .. } -> True
    _ -> False
  }
}

/// The successor rules of Part 2 §3.7 for `successor = Some(s)` of the record
/// `id`: `s ≠ id`; a reference input holds the live record of `s`
/// (`find_record`) with lineage `Root`; its controller signs.
pub fn successor_ok(
  s: ByteArray,
  id: ByteArray,
  own: ByteArray,
  refs: List<Input>,
  signatories: List<VerificationKeyHash>,
) -> Bool {
  and {
    s != id,
    when find_record(refs, own, s) is {
      Some(record) -> and {
          record.lineage == Root,
          !terminal(record.status),
          key_signed(signatories, record.controller),
        }
      None -> False
    },
  }
}

/// The tombstone of `record` with `status` (Part 2 §3.7): no keys and no
/// parties, a threshold of 0, no pending recovery, and an empty description,
/// framework, endpoint and capability list. The controller, name, lineage,
/// epoch and `created_at` stay. Holds end with the new status.
pub fn tombstone(record: IdentityDatum, status: Status) -> IdentityDatum {
  IdentityDatum {
    ..record,
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

/// The datum of a record output for `id` (Part 2 §3.2). The caller selects
/// `output` as the only output at the identity address. The output has no
/// reference script, an inline datum that is a valid datum (§3.3), exactly
/// one token `(own, id)` and no other non-AP3X asset, and at least 10 AP3X
/// while the status is Active or Suspended. Fails otherwise.
pub fn record_output(
  output: Output,
  own: ByteArray,
  id: ByteArray,
  m1: Option<ByteArray>,
) -> IdentityDatum {
  expect InlineDatum(data) = output.datum
  expect record: IdentityDatum = data
  expect and {
      (output.reference_script == None)?,
      ap3x_and_token(output.value, own, id)?,
      valid_datum(record, m1)?,
      (terminal(record.status) || ap3x_of(output.value) >= min_live_ap3x)?,
    }
  record
}

fn not_ended(party: Party, hi: Int) -> Bool {
  when party.not_after is {
    None -> True
    Some(not_after) -> not_after >= hi
  }
}
