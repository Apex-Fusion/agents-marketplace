//// Tests of the valid datum (Part 2 §3.3, Part 1 §5): the §12.1 "Record
//// output" limits checked on the datum alone. The transaction-level record
//// output tests are in `tests/register` and `tests/scope`.

use identity_marketplace/identity/datum.{valid_datum}
use identity_marketplace/identity/kit.{
  accountable, bytes, ed, guardian, hi, hold, hold_in_force, largest,
  largest_guarded, lo, long_capabilities, m1, module1, other_script, p256, pop,
  provider, record, responsible, retired_tombstone, revoked_tombstone, signer,
  subagent, suspended,
}
use vector_identity.{days_30_ms, max_time_ms}
use vector_identity/types.{
  ControllerSet, Distributor, IdentityDatum, Key, KeyHash, Party,
  PendingRecovery, Retired, Revoked,
} as identity

fn valid(d: IdentityDatum) -> Bool {
  valid_datum(d, Some(m1))
}

fn with_keys(keys: List<Key>) -> IdentityDatum {
  IdentityDatum { ..record(), keys }
}

fn with_party(party: Party) -> IdentityDatum {
  IdentityDatum { ..record(), parties: [accountable(ControllerSet), party] }
}

const two_63: Int = 9_223_372_036_854_775_808

// ## Valid records

test datum_valid_record() {
  valid(record())
}

test datum_valid_largest() {
  valid(largest()) && valid(largest_guarded())
}

test datum_valid_tombstones() {
  valid(revoked_tombstone()) && valid(retired_tombstone())
}

test datum_valid_subagent() {
  valid(subagent(bytes(32, 7), 0, 4))
}

test datum_valid_without_parties_or_keys() {
  valid(IdentityDatum { ..record(), keys: [], parties: [] })
}

test datum_valid_time_bounds() {
  valid(IdentityDatum { ..record(), created_at: 0 }) && valid(
    IdentityDatum { ..record(), created_at: max_time_ms },
  )
}

// ## Controller and keys

test datum_controller_not_32_bytes() {
  !valid(IdentityDatum { ..record(), controller: bytes(31, 1) }) && !valid(
    IdentityDatum { ..record(), controller: bytes(33, 1) },
  )
}

test datum_nine_keys() {
  !valid(
    with_keys(
      [
        ed(1, 1),
        ed(2, 1),
        ed(3, 1),
        ed(4, 1),
        ed(5, 1),
        ed(6, 1),
        ed(7, 1),
        ed(8, 1),
        ed(9, 1),
      ],
    ),
  )
}

test datum_eight_keys() {
  valid(
    with_keys(
      [
        ed(1, 1),
        ed(2, 2),
        ed(3, 8),
        ed(4, 16),
        ed(5, 27),
        p256(1, 1),
        p256(2, 2),
        p256(3, 3),
      ],
    ),
  )
}

test datum_duplicate_key() {
  !valid(with_keys([ed(1, 1), ed(1, 1)])) && !valid(
    with_keys([ed(1, 1), ed(2, 2), ed(1, 2)]),
  )
}

test datum_key_lengths() {
  and {
    !valid(with_keys([Key { ..ed(1, 1), key: bytes(31, 1) }])),
    !valid(with_keys([Key { ..ed(1, 1), key: bytes(33, 1) }])),
    !valid(with_keys([Key { ..p256(1, 1), key: bytes(32, 2) }])),
    !valid(with_keys([Key { ..p256(1, 1), key: bytes(34, 2) }])),
  }
}

test datum_ed25519_with_pop() {
  !valid(with_keys([Key { ..ed(1, 1), pop: Some(pop) }]))
}

test datum_p256_without_pop() {
  !valid(with_keys([Key { ..p256(1, 1), pop: None }]))
}

test datum_p256_pop_length() {
  !valid(with_keys([Key { ..p256(1, 1), pop: Some(bytes(63, 1)) }])) && !valid(
    with_keys([Key { ..p256(1, 1), pop: Some(bytes(65, 1)) }]),
  )
}

test datum_p256_transaction_purpose() {
  !valid(with_keys([p256(1, 8)])) && !valid(with_keys([p256(1, 9)]))
}

test datum_p256_delegation_purpose() {
  !valid(with_keys([p256(1, 16)])) && !valid(with_keys([p256(1, 19)]))
}

test datum_purpose_value_4() {
  and {
    !valid(with_keys([ed(1, 4)])),
    !valid(with_keys([ed(1, 5)])),
    !valid(with_keys([ed(1, 31)])),
    !valid(with_keys([p256(1, 4)])),
    !valid(with_keys([p256(1, 7)])),
  }
}

test datum_purposes_out_of_range() {
  and {
    !valid(with_keys([ed(1, 0)])),
    !valid(with_keys([ed(1, 32)])),
    !valid(with_keys([ed(1, 28)])),
    !valid(with_keys([ed(1, -1)])),
    !valid(with_keys([p256(1, 0)])),
  }
}

test datum_every_ed25519_purpose_sum() {
  and {
    valid(with_keys([ed(1, 1)])),
    valid(with_keys([ed(1, 2)])),
    valid(with_keys([ed(1, 3)])),
    valid(with_keys([ed(1, 8)])),
    valid(with_keys([ed(1, 11)])),
    valid(with_keys([ed(1, 16)])),
    valid(with_keys([ed(1, 24)])),
    valid(with_keys([ed(1, 27)])),
  }
}

// ## Parties

test datum_nine_parties() {
  !valid(
    IdentityDatum {
      ..record(),
      parties: [
        accountable(ControllerSet),
        accountable(signer(1)),
        accountable(signer(2)),
        responsible(signer(3)),
        responsible(signer(4)),
        provider(signer(5)),
        provider(signer(6)),
        provider(signer(7)),
        provider(signer(8)),
      ],
    },
  )
}

test datum_same_role_and_signer() {
  !valid(
    IdentityDatum {
      ..record(),
      parties: [
        accountable(signer(1)),
        provider(signer(2)),
        Party { ..accountable(signer(1)), rights: 1 },
      ],
    },
  )
}

test datum_same_signer_other_roles() {
  valid(
    IdentityDatum {
      ..record(),
      parties: [
        accountable(signer(1)),
        responsible(signer(1)),
        provider(signer(1)),
        guardian(signer(1)),
      ],
    },
  )
}

test datum_rights_above_role() {
  and {
    !valid(with_party(Party { ..accountable(signer(1)), rights: 4 })),
    !valid(with_party(Party { ..accountable(signer(1)), rights: 7 })),
    !valid(with_party(Party { ..responsible(signer(1)), rights: 2 })),
    !valid(with_party(Party { ..responsible(signer(1)), rights: 3 })),
    !valid(with_party(Party { ..provider(signer(1)), rights: 2 })),
    !valid(with_party(Party { ..provider(signer(1)), rights: 4 })),
    !valid(with_party(Party { ..guardian(signer(1)), rights: 1 })),
    !valid(with_party(Party { ..guardian(signer(1)), rights: 5 })),
    !valid(with_party(Party { ..accountable(signer(1)), rights: -1 })),
  }
}

test datum_distributor_or_guardian_suspend_right() {
  !valid(
    with_party(Party { ..provider(signer(1)), role: Distributor, rights: 1 }),
  ) && !valid(with_party(Party { ..guardian(signer(1)), rights: 1 }))
}

test datum_rights_within_role() {
  and {
    valid(with_party(Party { ..accountable(signer(1)), rights: 0 })),
    valid(with_party(Party { ..accountable(signer(1)), rights: 2 })),
    valid(with_party(Party { ..responsible(signer(1)), rights: 0 })),
    valid(
      with_party(Party { ..provider(signer(1)), role: Distributor, rights: 0 }),
    ),
    valid(with_party(Party { ..guardian(signer(1)), rights: 0 })),
  }
}

test datum_signers_by_role() {
  and {
    valid(with_party(responsible(ControllerSet))),
    valid(with_party(responsible(module1()))),
    !valid(with_party(provider(ControllerSet))),
    !valid(with_party(provider(module1()))),
    !valid(
      with_party(
        Party { ..provider(ControllerSet), role: Distributor, rights: 0 },
      ),
    ),
    !valid(
      with_party(Party { ..provider(module1()), role: Distributor, rights: 0 }),
    ),
    !valid(with_party(guardian(ControllerSet))),
    !valid(with_party(guardian(module1()))),
  }
}

test datum_script_party_other_than_module1() {
  !valid(with_party(accountable(identity.Script { hash: other_script })))
}

test datum_script_party_without_configuration() {
  valid(with_party(accountable(module1()))) && !valid_datum(
    with_party(accountable(module1())),
    None,
  )
}

test datum_key_hash_length() {
  !valid(with_party(accountable(KeyHash { hash: bytes(27, 1) }))) && !valid(
    with_party(accountable(KeyHash { hash: bytes(29, 1) })),
  )
}

test datum_organisation_length() {
  and {
    valid(with_party(Party { ..provider(signer(1)), organisation: Some("a") })),
    valid(
      with_party(
        Party { ..provider(signer(1)), organisation: Some(bytes(64, 1)) },
      ),
    ),
    !valid(with_party(Party { ..provider(signer(1)), organisation: Some("") })),
    !valid(
      with_party(
        Party { ..provider(signer(1)), organisation: Some(bytes(65, 1)) },
      ),
    ),
  }
}

test datum_party_period() {
  let p = provider(signer(1))
  and {
    valid(with_party(Party { ..p, not_after: Some(p.not_before + 1) })),
    !valid(with_party(Party { ..p, not_after: Some(p.not_before) })),
    !valid(with_party(Party { ..p, not_after: Some(p.not_before - 1) })),
  }
}

test datum_party_times() {
  let p = provider(signer(1))
  and {
    !valid(with_party(Party { ..p, not_before: -1 })),
    !valid(with_party(Party { ..p, not_after: Some(max_time_ms + 1) })),
    !valid(with_party(Party { ..p, removal_after: Some(max_time_ms + 1) })),
    !valid(with_party(Party { ..p, removal_after: Some(-1) })),
    valid(with_party(Party { ..p, removal_after: Some(max_time_ms) })),
  }
}

// ## Threshold, recovery and lineage

test datum_threshold_range() {
  !valid(IdentityDatum { ..record(), guardian_threshold: -1 }) && !valid(
    IdentityDatum { ..record(), guardian_threshold: two_63 },
  )
}

test datum_pending_recovery_with_threshold_0() {
  !valid(
    IdentityDatum {
      ..record(),
      guardian_threshold: 0,
      pending_recovery: Some(
        PendingRecovery { new_controller: bytes(32, 9), effective_after: hi },
      ),
    },
  )
}

test datum_pending_recovery_forms() {
  let guarded =
    IdentityDatum {
      ..record(),
      parties: [accountable(ControllerSet), guardian(signer(1))],
      guardian_threshold: 1,
    }
  and {
    valid(
      IdentityDatum {
        ..guarded,
        pending_recovery: Some(
          PendingRecovery { new_controller: bytes(32, 9), effective_after: hi },
        ),
      },
    ),
    !valid(
      IdentityDatum {
        ..guarded,
        pending_recovery: Some(
          PendingRecovery { new_controller: bytes(31, 9), effective_after: hi },
        ),
      },
    ),
    !valid(
      IdentityDatum {
        ..guarded,
        pending_recovery: Some(
          PendingRecovery {
            new_controller: bytes(32, 9),
            effective_after: max_time_ms + 1,
          },
        ),
      },
    ),
  }
}

test datum_lineage() {
  and {
    !valid(subagent(bytes(31, 7), 0, 1)),
    !valid(subagent(bytes(32, 7), 0, 0)),
    !valid(subagent(bytes(32, 7), 0, 5)),
    !valid(subagent(bytes(32, 7), -1, 1)),
    valid(subagent(bytes(32, 7), 3, 1)),
  }
}

test datum_epoch_range() {
  !valid(IdentityDatum { ..record(), subagent_epoch: -1 }) && !valid(
    IdentityDatum { ..record(), subagent_epoch: two_63 },
  )
}

// ## Profile

test datum_name_length() {
  and {
    !valid(IdentityDatum { ..record(), name: "" }),
    valid(IdentityDatum { ..record(), name: bytes(64, 0x6e) }),
    !valid(IdentityDatum { ..record(), name: bytes(65, 0x6e) }),
  }
}

test datum_description_framework_endpoint_lengths() {
  and {
    valid(IdentityDatum { ..record(), description: bytes(256, 0x64) }),
    !valid(IdentityDatum { ..record(), description: bytes(257, 0x64) }),
    valid(IdentityDatum { ..record(), framework: bytes(64, 0x66) }),
    !valid(IdentityDatum { ..record(), framework: bytes(65, 0x66) }),
    valid(IdentityDatum { ..record(), endpoint: bytes(256, 0x65) }),
    !valid(IdentityDatum { ..record(), endpoint: bytes(257, 0x65) }),
  }
}

test datum_subagent_endpoint() {
  !valid(
    IdentityDatum { ..subagent(bytes(32, 7), 0, 1), endpoint: "https://x" },
  )
}

test datum_capabilities() {
  and {
    valid(IdentityDatum { ..record(), capabilities: [] }),
    valid(IdentityDatum { ..record(), capabilities: long_capabilities(16) }),
    !valid(IdentityDatum { ..record(), capabilities: long_capabilities(17) }),
    !valid(IdentityDatum { ..record(), capabilities: [""] }),
    !valid(IdentityDatum { ..record(), capabilities: [bytes(65, 0x63)] }),
  }
}

test datum_duplicate_capability() {
  !valid(IdentityDatum { ..record(), capabilities: ["a.v1", "b.v1", "a.v1"] })
}

test datum_created_at_range() {
  !valid(IdentityDatum { ..record(), created_at: -1 }) && !valid(
    IdentityDatum { ..record(), created_at: max_time_ms + 1 },
  )
}

// ## Status

test datum_holds_count() {
  let ten = largest()
  expect identity.Suspended { holds } = ten.status
  and {
    !valid(suspended(record(), [])),
    valid(suspended(record(), [hold_in_force(ControllerSet)])),
    !valid(suspended(ten, [hold_in_force(signer(9)), ..holds])),
  }
}

test datum_two_holds_by_one_author() {
  !valid(
    suspended(
      record(),
      [
        hold_in_force(signer(1)),
        hold_in_force(ControllerSet),
        hold(signer(1), 6, lo + 1),
      ],
    ),
  )
}

test datum_hold_times() {
  let h = hold_in_force(signer(1))
  and {
    !valid(suspended(record(), [identity.Hold { ..h, since: h.until }])),
    !valid(suspended(record(), [identity.Hold { ..h, since: h.until + 1 }])),
    !valid(
      suspended(
        record(),
        [identity.Hold { ..h, since: h.until - days_30_ms - 1 }],
      ),
    ),
    valid(
      suspended(record(), [identity.Hold { ..h, since: h.until - days_30_ms }]),
    ),
    !valid(suspended(record(), [identity.Hold { ..h, since: -1 }])),
    !valid(
      suspended(
        record(),
        [identity.Hold { ..h, since: max_time_ms, until: max_time_ms + 1 }],
      ),
    ),
    !valid(suspended(record(), [identity.Hold { ..h, reason: -1 }])),
    !valid(
      suspended(
        record(),
        [identity.Hold { ..h, by: KeyHash { hash: bytes(27, 1) } }],
      ),
    ),
  }
}

test datum_terminal_is_tombstone() {
  let revoked = revoked_tombstone()
  let retired = retired_tombstone()
  and {
    !valid(IdentityDatum { ..revoked, keys: [ed(1, 1)] }),
    !valid(IdentityDatum { ..revoked, parties: [accountable(ControllerSet)] }),
    !valid(IdentityDatum { ..revoked, description: "x" }),
    !valid(IdentityDatum { ..revoked, framework: "x" }),
    !valid(IdentityDatum { ..revoked, endpoint: "x" }),
    !valid(IdentityDatum { ..revoked, capabilities: ["x"] }),
    !valid(IdentityDatum { ..retired, keys: [ed(1, 1)] }),
    !valid(IdentityDatum { ..retired, capabilities: ["x"] }),
    !valid(
      IdentityDatum {
        ..retired,
        parties: [guardian(signer(1))],
        guardian_threshold: 1,
      },
    ),
  }
}

test datum_tombstone_fields() {
  let base = revoked_tombstone()
  and {
    !valid(
      IdentityDatum {
        ..base,
        status: Revoked {
          by: ControllerSet,
          reason: 1,
          at: lo,
          invalid_from: Some(max_time_ms + 1),
          successor: None,
        },
      },
    ),
    !valid(
      IdentityDatum {
        ..base,
        status: Revoked {
          by: ControllerSet,
          reason: 5,
          at: lo,
          invalid_from: None,
          successor: Some(bytes(31, 5)),
        },
      },
    ),
    !valid(
      IdentityDatum { ..base, status: Retired { at: -1, successor: None } },
    ),
    valid(
      IdentityDatum {
        ..base,
        status: Retired { at: lo, successor: Some(bytes(32, 5)) },
      },
    ),
  }
}
