//// Tests of the configuration record (Part 2 §3.8): the `config_seal` mint
//// rule and the `M1` lookup. The `config_holder` and "other purposes" tests
//// are in `validators/config.ak`.

use cardano/address
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use identity_marketplace/config/record.{module1, seal_ok, token_name}
use identity_marketplace/identity/kit.{
  bytes, config_holder, config_input, config_policy, holder_address, m1, output,
  pkh, ref, staked, wallet_input,
}

/// The seal seed.
fn seed() -> OutputReference {
  OutputReference { transaction_id: bytes(32, 0x5d), output_index: 2 }
}

/// The holder output with the Module-1 hash as inline datum.
fn holder_output(datum: transaction.Datum) -> Output {
  output(
    holder_address(),
    assets.from_lovelace(2_000_000) |> assets.add(config_policy, token_name, 1),
    datum,
  )
}

/// The seal transaction: spends the seed, mints the token and sends it to
/// the holder.
fn seal_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: seed(),
        output: output(
          address.from_verification_key(pkh(99)),
          assets.from_lovelace(20_000_000),
          NoDatum,
        ),
      },
    ],
    outputs: [holder_output(InlineDatum(m1))],
    mint: assets.from_asset(config_policy, token_name, 1),
  }
}

fn seal(tx: Transaction) -> Bool {
  seal_ok(seed(), config_holder, config_policy, tx)
}

fn with_outputs(tx: Transaction, outputs: List<Output>) -> Transaction {
  Transaction { ..tx, outputs }
}

test config_token_name_hex() {
  token_name == #"6964656e746974792d636f6e666967"
}

// ## Seal

test seal_mints_configuration_token() {
  seal(seal_tx())
}

test seal_without_seed() fail {
  seal(Transaction { ..seal_tx(), inputs: [wallet_input()] })
}

test seal_quantity_2() fail {
  let tx =
    Transaction {
      ..seal_tx(),
      outputs: [
        output(
          holder_address(),
          assets.from_lovelace(2_000_000)
            |> assets.add(config_policy, token_name, 2),
          InlineDatum(m1),
        ),
      ],
      mint: assets.from_asset(config_policy, token_name, 2),
    }
  seal(tx)
}

test seal_other_name() fail {
  let tx =
    Transaction {
      ..seal_tx(),
      outputs: [
        output(
          holder_address(),
          assets.from_lovelace(2_000_000)
            |> assets.add(config_policy, "identity-config2", 1),
          InlineDatum(m1),
        ),
      ],
      mint: assets.from_asset(config_policy, "identity-config2", 1),
    }
  seal(tx)
}

test seal_second_token() fail {
  let tx =
    Transaction {
      ..seal_tx(),
      outputs: [
        holder_output(InlineDatum(m1)),
        output(
          address.from_verification_key(pkh(5)),
          assets.from_lovelace(2_000_000) |> assets.add(config_policy, "x", 1),
          NoDatum,
        ),
      ],
      mint: assets.from_asset(config_policy, token_name, 1)
        |> assets.add(config_policy, "x", 1),
    }
  seal(tx)
}

test seal_burn() fail {
  let tx =
    Transaction {
      ..seal_tx(),
      inputs: [
        Input {
          output_reference: seed(),
          output: holder_output(InlineDatum(m1)),
        },
      ],
      outputs: [],
      mint: assets.from_asset(config_policy, token_name, -1),
    }
  seal(tx)
}

test seal_to_staked_holder() fail {
  seal(
    with_outputs(
      seal_tx(),
      [
        Output {
          ..holder_output(InlineDatum(m1)),
          address: staked(holder_address()),
        },
      ],
    ),
  )
}

test seal_to_other_script() fail {
  seal(
    with_outputs(
      seal_tx(),
      [
        Output {
          ..holder_output(InlineDatum(m1)),
          address: address.from_script(kit.other_script),
        },
      ],
    ),
  )
}

test seal_to_key_address() fail {
  seal(
    with_outputs(
      seal_tx(),
      [
        Output {
          ..holder_output(InlineDatum(m1)),
          address: address.from_verification_key(pkh(5)),
        },
      ],
    ),
  )
}

test seal_datum_hash() fail {
  seal(with_outputs(seal_tx(), [holder_output(DatumHash(bytes(32, 1)))]))
}

test seal_no_datum() fail {
  seal(with_outputs(seal_tx(), [holder_output(NoDatum)]))
}

test seal_datum_not_bytes() fail {
  seal(with_outputs(seal_tx(), [holder_output(InlineDatum(28))]))
}

test seal_datum_wrong_length() fail {
  seal(with_outputs(seal_tx(), [holder_output(InlineDatum(bytes(27, 0x31)))]))
}

test seal_datum_too_long() fail {
  seal(with_outputs(seal_tx(), [holder_output(InlineDatum(bytes(32, 0x31)))]))
}

// ## M1 lookup

test module1_found() {
  module1([wallet_input(), config_input()], config_policy, config_holder) == Some(
    m1,
  )
}

test module1_none_without_configuration() {
  module1([wallet_input()], config_policy, config_holder) == None
}

test module1_ignores_staked_holder() {
  let input = config_input()
  let moved =
    Input {
      ..input,
      output: Output { ..input.output, address: staked(holder_address()) },
    }
  module1([moved], config_policy, config_holder) == None
}

test module1_ignores_input_without_token() {
  let input = config_input()
  let empty =
    Input {
      ..input,
      output: Output { ..input.output, value: assets.from_lovelace(2_000_000) },
    }
  module1([empty], config_policy, config_holder) == None
}

test module1_ignores_other_policy() {
  let input = config_input()
  let other =
    Input {
      ..input,
      output: Output {
        ..input.output,
        value: assets.from_lovelace(2_000_000)
          |> assets.add(kit.other_script, token_name, 1),
      },
    }
  module1([other], config_policy, config_holder) == None
}

test module1_datum_not_inline() fail {
  let input = config_input()
  let hashed =
    Input {
      ..input,
      output: Output { ..input.output, datum: DatumHash(bytes(32, 1)) },
    }
  module1([hashed], config_policy, config_holder) == Some(m1)
}

test module1_from_first_holder_input() {
  let second = Input { ..config_input(), output_reference: ref(91) }
  module1([config_input(), second], config_policy, config_holder) == Some(m1)
}
