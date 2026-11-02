//// Configuration record of the identity registry: Part 2 §3.8
//// (`docs/IDENTITY_REGISTRY.md`).
////
//// `config_holder` rejects every spend. `config_seal` mints the configuration
//// token once: exactly one token `identity-config`, sent to the exact
//// `config_holder` enterprise address with the 28-byte Module-1 hash as its
//// inline datum. Nobody can change or move the record afterwards, so `M1`
//// never changes.

use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}

/// The asset name of the configuration token: UTF-8 `identity-config`
/// (hex `6964656e746974792d636f6e666967`).
pub const token_name: ByteArray = "identity-config"

/// The length of a script hash in bytes.
pub const script_hash_length: Int = 28

/// `M1` of Part 2 §3.2: the script hash in the inline datum of the first
/// reference input at the exact `config_holder` enterprise address that holds
/// the configuration token `(config_policy, identity-config)`. `None` when no
/// reference input holds the token. Fails when that input's datum is not an
/// inline byte string (the seal makes this impossible).
pub fn module1(
  refs: List<Input>,
  config_policy: ByteArray,
  config_holder: ByteArray,
) -> Option<ByteArray> {
  let holder = address.from_script(config_holder)
  when
    list.find(
      refs,
      fn(input) {
        and {
          input.output.address == holder,
          assets.quantity_of(input.output.value, config_policy, token_name) == 1,
        }
      },
    )
  is {
    Some(input) -> {
      expect InlineDatum(data) = input.output.datum
      expect hash: ByteArray = data
      Some(hash)
    }
    None -> None
  }
}

/// The mint rule of `config_seal` (Part 2 §3.8). The transaction spends
/// `seed`. The mint under `own_policy` is exactly one token `identity-config`.
/// The only output that holds the token is at the exact enterprise address of
/// `config_holder`, holds exactly one such token and has an inline datum that
/// is a 28-byte byte string. Any burn fails, because the mint must be
/// exactly `+1`.
pub fn seal_ok(
  seed: OutputReference,
  config_holder: ByteArray,
  own_policy: PolicyId,
  tx: Transaction,
) -> Bool {
  expect [output] =
    list.filter(
      tx.outputs,
      fn(output) {
        assets.quantity_of(output.value, own_policy, token_name) != 0
      },
    )
  expect InlineDatum(data) = output.datum
  expect hash: ByteArray = data
  and {
    list.any(tx.inputs, fn(input) { input.output_reference == seed })?,
    (dict.to_pairs(assets.tokens(tx.mint, own_policy)) == [Pair(token_name, 1)])?,
    (output.address == address.from_script(config_holder))?,
    (assets.quantity_of(output.value, own_policy, token_name) == 1)?,
    (bytearray.length(hash) == script_hash_length)?,
  }
}
