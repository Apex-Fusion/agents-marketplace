//// Adopt tests (Part 2 §3.4): §12.1 row Adopt, the allowlist tree definition
//// and the Register rules 4–8 that Adopt shares.

use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use cardano/address.{Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, Transaction,
}
use identity_marketplace/identity/allowlist.{member}
use identity_marketplace/identity/kit.{
  accountable, adopt, adopt_id, adopt_proof, adopt_tx, adoption_signers,
  allowlist_ids, allowlist_proof, allowlist_root, bytes, controller,
  creation_signers, hash, hi, legacy_datum, legacy_hash, legacy_input,
  legacy_owner, lo, mint, new_record, outside_id, own, pkh, provider,
  record_input, record_output, staked, with_mint, with_outputs, with_parties,
  within,
}
use vector_identity.{max_range_ms}
use vector_identity/redeemers.{Adopt}
use vector_identity/types.{ControllerSet, IdentityDatum, Subagent}

fn ok_tx() -> Transaction {
  adopt_tx(new_record(), adoption_signers())
}

/// The tx with `inputs` replacing its legacy input (the first input).
fn with_legacy_inputs(tx: Transaction, legacy: List<Input>) -> Transaction {
  expect [_, ..rest] = tx.inputs
  Transaction { ..tx, inputs: list.concat(legacy, rest) }
}

/// An adoption of `id` (in the allowlist) with its own proof.
fn adopt_of(id: ByteArray) -> Bool {
  let tx =
    Transaction {
      ..ok_tx(),
      outputs: [record_output(id, new_record())],
      mint: assets.from_asset(own, id, 1) |> assets.add(legacy_hash, id, -1),
    }
  let tx =
    with_legacy_inputs(
      tx,
      [
        legacy_input(
          id,
          InlineDatum(legacy_datum(VerificationKey(legacy_owner()))),
        ),
      ],
    )
  mint(Adopt { proof: allowlist_proof(allowlist_ids(), id) }, tx)
}

// ## Allowlist tree (Part 2 §3.4)

/// The root of the five test identifiers, computed independently (Python
/// `hashlib.blake2b`, digest size 32) from the §3.4 definition.
const vector_root: ByteArray =
  #"3a6d98e363ec77f4b709815f51169225ba7efac4a707121db816b9d0758a1a90"

test allowlist_root_vector() {
  allowlist_root(allowlist_ids()) == vector_root
}

test allowlist_proof_of_unpaired_last_leaf() {
  // The leaf of 0x03.. is last in byte order; it moves up unchanged twice.
  adopt_proof() == [
    #"5740c1c77507ec1391c5e5d5e448649ffaafb8a51fcefdd49e1d953056f79ece",
  ]
}

test allowlist_proof_of_paired_leaf() {
  allowlist_proof(allowlist_ids(), bytes(32, 5)) == [
    #"f40ceaf86e5776923332b8d8fd3bef849cadb19c6996bc272af1f648d9566a4c",
    #"4f91cc9defb2f09cb437a0b3da827afdd3024e5cc06d71594d7294d0372a25ed",
    #"fc14ac676780c40e5cfeb5b8701b14761a89b5519eaf663b29e7f8abbdc72195",
  ]
}

test allowlist_every_member() {
  let ids = allowlist_ids()
  let root = allowlist_root(ids)
  and {
    member(root, bytes(32, 1), allowlist_proof(ids, bytes(32, 1))),
    member(root, bytes(32, 2), allowlist_proof(ids, bytes(32, 2))),
    member(root, bytes(32, 3), allowlist_proof(ids, bytes(32, 3))),
    member(root, bytes(32, 4), allowlist_proof(ids, bytes(32, 4))),
    member(root, bytes(32, 5), allowlist_proof(ids, bytes(32, 5))),
  }
}

test allowlist_rejects_others() {
  let ids = allowlist_ids()
  let root = allowlist_root(ids)
  and {
    !member(root, outside_id, allowlist_proof(ids, bytes(32, 3))),
    !member(root, outside_id, []),
    !member(root, bytes(32, 3), []),
    !member(root, bytes(32, 5), allowlist_proof(ids, bytes(32, 4))),
    // A node of the tree used as an identifier.
    !member(root, blake2b_256(bytes(32, 3)), allowlist_proof(ids, bytes(32, 3))),
  }
}

test allowlist_single_leaf() {
  let ids = [bytes(32, 9)]
  allowlist_root(ids) == blake2b_256(bytes(32, 9)) && member(
    allowlist_root(ids),
    bytes(32, 9),
    [],
  )
}

// ## Valid adoptions

test adopt_with_inline_datum() {
  adopt(ok_tx())
}

test adopt_with_datum_hash() {
  let datum: Data = legacy_datum(VerificationKey(legacy_owner()))
  let datum_hash = blake2b_256(builtin.serialise_data(datum))
  let tx =
    with_legacy_inputs(ok_tx(), [legacy_input(adopt_id, DatumHash(datum_hash))])
  adopt(
    Transaction { ..tx, datums: dict.from_pairs([Pair(datum_hash, datum)]) },
  )
}

test adopt_identifier_with_long_proof() {
  adopt_of(bytes(32, 5))
}

test adopt_every_allowlisted_identifier() {
  and {
    adopt_of(bytes(32, 1)),
    adopt_of(bytes(32, 2)),
    adopt_of(bytes(32, 4)),
  }
}

test adopt_range_of_one_hour() {
  adopt(within(ok_tx(), hi - max_range_ms, hi))
}

// ## Attacks

test adopt_without_legacy_burn() fail {
  adopt(with_mint(ok_tx(), assets.from_asset(own, adopt_id, 1)))
}

test adopt_burn_of_other_name() fail {
  // Mint X, burn Y: the legacy input holds Y.
  let y = bytes(32, 5)
  let tx =
    with_legacy_inputs(
      with_mint(
        ok_tx(),
        assets.from_asset(own, adopt_id, 1) |> assets.add(legacy_hash, y, -1),
      ),
      [
        legacy_input(
          y,
          InlineDatum(legacy_datum(VerificationKey(legacy_owner()))),
        ),
      ],
    )
  adopt(tx)
}

test adopt_legacy_owner_does_not_sign() fail {
  adopt(adopt_tx(new_record(), creation_signers()))
}

test adopt_name_outside_root() fail {
  let tx =
    Transaction {
      ..ok_tx(),
      outputs: [record_output(outside_id, new_record())],
      mint: assets.from_asset(own, outside_id, 1)
        |> assets.add(legacy_hash, outside_id, -1),
    }
  let tx =
    with_legacy_inputs(
      tx,
      [
        legacy_input(
          outside_id,
          InlineDatum(legacy_datum(VerificationKey(legacy_owner()))),
        ),
      ],
    )
  mint(Adopt { proof: adopt_proof() }, tx)
}

test adopt_wrong_proof() fail {
  mint(Adopt { proof: [] }, ok_tx())
}

test adopt_script_owner() fail {
  let tx =
    with_legacy_inputs(
      ok_tx(),
      [
        legacy_input(
          adopt_id,
          InlineDatum(legacy_datum(Script(legacy_owner()))),
        ),
      ],
    )
  adopt(tx)
}

test adopt_legacy_input_with_stake_credential() fail {
  let input =
    legacy_input(
      adopt_id,
      InlineDatum(legacy_datum(VerificationKey(legacy_owner()))),
    )
  let moved =
    Input {
      ..input,
      output: Output { ..input.output, address: staked(kit.legacy_address()) },
    }
  adopt(with_legacy_inputs(ok_tx(), [moved]))
}

test adopt_two_legacy_inputs() fail {
  let first =
    legacy_input(
      adopt_id,
      InlineDatum(legacy_datum(VerificationKey(legacy_owner()))),
    )
  let second =
    Input {
      ..legacy_input(
        bytes(32, 5),
        InlineDatum(legacy_datum(VerificationKey(legacy_owner()))),
      ),
      output_reference: kit.ref(41),
    }
  adopt(with_legacy_inputs(ok_tx(), [first, second]))
}

test adopt_legacy_input_with_two_tokens() fail {
  let input =
    legacy_input(
      adopt_id,
      InlineDatum(legacy_datum(VerificationKey(legacy_owner()))),
    )
  let doubled =
    Input {
      ..input,
      output: Output {
        ..input.output,
        value: input.output.value |> assets.add(legacy_hash, bytes(32, 5), 1),
      },
    }
  adopt(with_legacy_inputs(ok_tx(), [doubled]))
}

test adopt_legacy_input_without_datum() fail {
  adopt(with_legacy_inputs(ok_tx(), [legacy_input(adopt_id, NoDatum)]))
}

test adopt_datum_hash_not_in_transaction() fail {
  adopt(
    with_legacy_inputs(
      ok_tx(),
      [legacy_input(adopt_id, DatumHash(bytes(32, 1)))],
    ),
  )
}

test adopt_legacy_datum_not_decoded() fail {
  adopt(with_legacy_inputs(ok_tx(), [legacy_input(adopt_id, InlineDatum(42))]))
}

test adopt_identity_quantity_2() fail {
  let tx =
    with_mint(
      ok_tx(),
      assets.from_asset(own, adopt_id, 2)
        |> assets.add(legacy_hash, adopt_id, -1),
    )
  adopt(tx)
}

test adopt_with_second_identity_name() fail {
  let tx =
    with_mint(
      ok_tx(),
      assets.from_asset(own, adopt_id, 1)
        |> assets.add(own, bytes(32, 5), 1)
        |> assets.add(legacy_hash, adopt_id, -1),
    )
  adopt(tx)
}

test adopt_as_subagent() fail {
  let d0 =
    IdentityDatum {
      ..new_record(),
      endpoint: "",
      lineage: Subagent { parent: bytes(32, 7), parent_epoch: 0, depth: 1 },
    }
  adopt(adopt_tx(d0, adoption_signers()))
}

test adopt_created_at_not_hi() fail {
  adopt(
    adopt_tx(
      IdentityDatum { ..new_record(), created_at: lo },
      adoption_signers(),
    ),
  )
}

test adopt_controller_does_not_sign() fail {
  adopt(adopt_tx(new_record(), [legacy_owner(), hash(kit.ed_key(1))]))
}

test adopt_ed25519_key_does_not_sign() fail {
  adopt(adopt_tx(new_record(), [legacy_owner(), hash(controller)]))
}

test adopt_party_does_not_sign() fail {
  adopt(
    adopt_tx(
      with_parties(
        new_record(),
        [accountable(ControllerSet), provider(kit.signer(2))],
      ),
      adoption_signers(),
    ),
  )
}

test adopt_party_signs() {
  adopt(
    adopt_tx(
      with_parties(
        new_record(),
        [accountable(ControllerSet), provider(kit.signer(2))],
      ),
      [pkh(2), ..adoption_signers()],
    ),
  )
}

test adopt_without_accountable_party() fail {
  adopt(adopt_tx(with_parties(new_record(), []), adoption_signers()))
}

test adopt_with_identity_input() fail {
  let tx = ok_tx()
  adopt(
    Transaction {
      ..tx,
      inputs: [record_input(0, kit.record_id, kit.record()), ..tx.inputs],
    },
  )
}

test adopt_two_outputs_at_identity_address() fail {
  adopt(
    with_outputs(
      ok_tx(),
      [
        record_output(adopt_id, new_record()),
        record_output(adopt_id, new_record()),
      ],
    ),
  )
}

test adopt_range_over_one_hour() fail {
  adopt(within(ok_tx(), hi - max_range_ms - 1, hi))
}
