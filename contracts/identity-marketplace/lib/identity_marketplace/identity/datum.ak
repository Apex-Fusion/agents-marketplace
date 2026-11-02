//// Valid datum of an identity record: Part 2 §3.3 (`docs/IDENTITY_REGISTRY.md`)
//// with the limits of Part 1 §5 (`docs/did-vector-method.md`).
////
//// The contract checks lengths, purposes, duplicates and the `pop` length. It
//// does not check `pop` signatures. The guardian bound is not part of the
//// valid datum: the mint and `Update` rules check it where parties or the
//// threshold change.

use aiken/collection/list
use aiken/primitive/bytearray
use identity_marketplace/common.{valid_time, valid_uint}
use vector_identity.{days_30_ms, max_depth}
use vector_identity/types.{
  Accountable, Active, ControllerSet, Distributor, Ed25519, Guardian, Hold,
  IdentityDatum, Key, KeyHash, Lineage, P256, Party, PendingRecovery, Provider,
  Responsible, Retired, Revoked, Role, Root, Signer, Subagent, Suspended,
} as identity

/// The most listed keys of a record.
pub const max_keys: Int = 8

/// The most parties of a record.
pub const max_parties: Int = 8

/// The most holds of a suspended record.
pub const max_holds: Int = 10

/// The most capabilities of a record.
pub const max_capabilities: Int = 16

/// True when `record` is a valid datum (Part 2 §3.3). `m1` is the Module-1
/// hash of the configuration record when the transaction reads it: a `Script`
/// party is valid only with `hash = M1`, so a record output with a `Script`
/// party needs the configuration reference input.
pub fn valid_datum(record: IdentityDatum, m1: Option<ByteArray>) -> Bool {
  let IdentityDatum {
    controller,
    keys,
    parties,
    guardian_threshold,
    pending_recovery,
    lineage,
    subagent_epoch,
    name,
    description,
    framework,
    endpoint,
    capabilities,
    created_at,
    status,
  } = record
  let name_length = bytearray.length(name)
  and {
    (bytearray.length(controller) == 32)?,
    valid_keys(keys, max_keys)?,
    valid_parties(parties, m1, max_parties)?,
    valid_uint(guardian_threshold)?,
    valid_pending(pending_recovery, guardian_threshold)?,
    valid_lineage(lineage)?,
    valid_uint(subagent_epoch)?,
    (name_length >= 1 && name_length <= 64)?,
    (bytearray.length(description) <= 256)?,
    (bytearray.length(framework) <= 64)?,
    valid_endpoint(endpoint, lineage)?,
    valid_capabilities(capabilities, max_capabilities)?,
    valid_time(created_at)?,
    when status is {
      Active -> True
      Suspended { holds } -> and {
          holds != [],
          valid_holds(holds, max_holds)?,
        }
      Revoked { by, reason, at, invalid_from, successor } -> and {
          tombstone_fields(record)?,
          valid_signer(by),
          valid_uint(reason),
          valid_time(at),
          valid_optional_time(invalid_from),
          valid_successor(successor),
        }
      Retired { at, successor } -> and {
          tombstone_fields(record)?,
          valid_time(at),
          valid_successor(successor),
        }
    },
  }
}

/// The fields that a tombstone clears (Part 2 §3.7): no keys, no parties, a
/// threshold of 0, no pending recovery, and an empty description, framework,
/// endpoint and capability list.
pub fn tombstone_fields(record: IdentityDatum) -> Bool {
  and {
    record.keys == [],
    record.parties == [],
    record.guardian_threshold == 0,
    record.pending_recovery == None,
    record.description == "",
    record.framework == "",
    record.endpoint == "",
    record.capabilities == [],
  }
}

/// The highest rights of a role (Part 1 §5), as a test on `rights`: Accountable
/// suspend and revoke (3), Responsible and Provider suspend (1), Distributor
/// none, Guardian recover (4).
pub fn rights_within_role(role: Role, rights: Int) -> Bool {
  when role is {
    Accountable -> rights >= 0 && rights <= 3
    Responsible -> rights == 0 || rights == 1
    Provider -> rights == 0 || rights == 1
    Distributor -> rights == 0
    Guardian -> rights == 0 || rights == 4
  }
}

/// The allowed signers of a role (Part 1 §5): a key hash for every role;
/// Module-1 (`Script` with `hash = M1`) and the controller only for
/// Accountable and Responsible.
pub fn signer_allowed(role: Role, signer: Signer, m1: Option<ByteArray>) -> Bool {
  when signer is {
    KeyHash { hash } -> bytearray.length(hash) == 28
    identity.Script { hash } -> and {
        role == Accountable || role == Responsible,
        m1 == Some(hash),
      }
    ControllerSet -> role == Accountable || role == Responsible
  }
}

// ## Internal checks

/// At most `left` keys, each valid, no key bytes twice (also not with other
/// purposes).
fn valid_keys(keys: List<Key>, left: Int) -> Bool {
  when keys is {
    [] -> True
    [key, ..rest] -> and {
        left > 0,
        valid_key(key),
        !list.any(rest, fn(other) { other.key == key.key }),
        valid_keys(rest, left - 1),
      }
  }
}

/// Ed25519: 32 bytes, no `pop`, purposes a non-empty sum of 1, 2, 8 and 16.
/// P256: 33 bytes, a 64-byte `pop`, purposes a non-empty sum of 1 and 2. The
/// value 4 is never a purpose.
fn valid_key(key: Key) -> Bool {
  let purposes = key.purposes
  when key.key_type is {
    Ed25519 -> and {
        bytearray.length(key.key) == 32,
        key.pop == None,
        purposes >= 1,
        purposes <= 27,
        purposes / 4 % 2 == 0,
      }
    P256 -> and {
        bytearray.length(key.key) == 33,
        when key.pop is {
          Some(pop) -> bytearray.length(pop) == 64
          None -> False
        },
        purposes >= 1,
        purposes <= 3,
      }
  }
}

/// At most `left` parties, each valid, no two with the same role and signer.
fn valid_parties(parties: List<Party>, m1: Option<ByteArray>, left: Int) -> Bool {
  when parties is {
    [] -> True
    [party, ..rest] -> and {
        left > 0,
        valid_party(party, m1),
        !list.any(
          rest,
          fn(other) { other.role == party.role && other.signer == party.signer },
        ),
        valid_parties(rest, m1, left - 1),
      }
  }
}

fn valid_party(party: Party, m1: Option<ByteArray>) -> Bool {
  and {
    rights_within_role(party.role, party.rights),
    signer_allowed(party.role, party.signer, m1),
    when party.organisation is {
      None -> True
      Some(organisation) -> {
        let length = bytearray.length(organisation)
        length >= 1 && length <= 64
      }
    },
    valid_time(party.not_before),
    when party.not_after is {
      None -> True
      Some(not_after) -> valid_time(not_after) && not_after > party.not_before
    },
    valid_optional_time(party.removal_after),
  }
}

/// A pending recovery needs a threshold of at least 1 and a 32-byte new
/// controller key.
fn valid_pending(pending: Option<PendingRecovery>, threshold: Int) -> Bool {
  when pending is {
    None -> True
    Some(PendingRecovery { new_controller, effective_after }) -> and {
        threshold >= 1,
        bytearray.length(new_controller) == 32,
        valid_time(effective_after),
      }
  }
}

fn valid_lineage(lineage: Lineage) -> Bool {
  when lineage is {
    Root -> True
    Subagent { parent, parent_epoch, depth } -> and {
        bytearray.length(parent) == 32,
        valid_uint(parent_epoch),
        depth >= 1,
        depth <= max_depth,
      }
  }
}

/// Up to 256 bytes; a subagent has an empty endpoint.
fn valid_endpoint(endpoint: ByteArray, lineage: Lineage) -> Bool {
  when lineage is {
    Root -> bytearray.length(endpoint) <= 256
    Subagent { .. } -> endpoint == ""
  }
}

/// At most `left` capabilities of 1–64 bytes each, without duplicates.
fn valid_capabilities(capabilities: List<ByteArray>, left: Int) -> Bool {
  when capabilities is {
    [] -> True
    [capability, ..rest] -> {
      let length = bytearray.length(capability)
      and {
        left > 0,
        length >= 1,
        length <= 64,
        !list.has(rest, capability),
        valid_capabilities(rest, left - 1),
      }
    }
  }
}

/// At most `left` holds with distinct authors. Each hold has valid times,
/// `since < until` and lasts at most 30 days.
fn valid_holds(holds: List<Hold>, left: Int) -> Bool {
  when holds is {
    [] -> True
    [hold, ..rest] -> and {
        left > 0,
        valid_signer(hold.by),
        valid_uint(hold.reason),
        valid_time(hold.since),
        valid_time(hold.until),
        hold.since < hold.until,
        hold.until - hold.since <= days_30_ms,
        !list.any(rest, fn(other) { other.by == hold.by }),
        valid_holds(rest, left - 1),
      }
  }
}

/// The form of a signer: a 28-byte key hash or script hash, or `ControllerSet`.
fn valid_signer(signer: Signer) -> Bool {
  when signer is {
    KeyHash { hash } -> bytearray.length(hash) == 28
    identity.Script { hash } -> bytearray.length(hash) == 28
    ControllerSet -> True
  }
}

fn valid_optional_time(time: Option<Int>) -> Bool {
  when time is {
    None -> True
    Some(t) -> valid_time(t)
  }
}

fn valid_successor(successor: Option<ByteArray>) -> Bool {
  when successor is {
    None -> True
    Some(id) -> bytearray.length(id) == 32
  }
}
