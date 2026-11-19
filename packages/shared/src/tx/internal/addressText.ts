/**
 * tx/internal/addressText.ts — the check of an address text before it reaches Lucid.
 *
 * Lucid reads an address text with the decoder library (`pay.ToAddress`, `pay.ToAddressWithData`, `getAddressDetails`). A text can
 * come from outside: a request field, an address in a datum, or a value from the environment or a file with no default.
 *
 * Every such text goes through one of two functions first:
 *
 * - `checkedAddressText` refuses the empty text and a text that is longer than any address text (1,024 characters; a real address has
 *   at most 108). It gives back every other text as it is: a text that is not an address still fails in Lucid, with the error of
 *   Lucid, as before.
 * - `checkedShelleyAddress` does the same, and then reads the text with the codec of this package (CIP-19, bech32, no library). It
 *   refuses a text that is not a Shelley payment address: a wrong checksum, a prefix that does not match the network, a header that
 *   is not an address type, a payload of the wrong size.
 *
 * Both refuse with a TxConstructionError. The message names the address and, for a long text, its length. It never holds the text.
 */

import { plutusAddressFromBech32 } from "../../cbor/address.js";
import { TxConstructionError } from "../types.js";

/** The longest address text that either function gives back. The bech32 codec reads at most 1,023 characters. */
export const MAX_ADDRESS_TEXT_LENGTH = 1024;

/**
 * `address`, or a TxConstructionError when it is the empty text (reason `address_empty`) or longer than MAX_ADDRESS_TEXT_LENGTH
 * (reason `address_too_long`). `what` names the address in the message.
 */
export function checkedAddressText(address: string, what: string): string {
  if (address === "") throw new TxConstructionError("address_empty", `${what} is empty`);
  if (address.length > MAX_ADDRESS_TEXT_LENGTH) {
    throw new TxConstructionError(
      "address_too_long",
      `${what} is ${address.length} characters long; the longest address text is ${MAX_ADDRESS_TEXT_LENGTH} characters`,
    );
  }
  return address;
}

/**
 * `address`, or a TxConstructionError when checkedAddressText refuses it, or when it is not a bech32 Shelley payment address
 * (reason `address_invalid`). The network is not checked: a valid address of another network passes, and Lucid decides about it.
 */
export function checkedShelleyAddress(address: string, what: string): string {
  checkedAddressText(address, what);
  try {
    plutusAddressFromBech32(address);
  } catch {
    throw new TxConstructionError("address_invalid", `${what} is not a Cardano payment address`);
  }
  return address;
}

/**
 * True when `error` is a refusal of an address text by `checkedAddressText` or `checkedShelleyAddress`. The same address gives the
 * same refusal at each try, so a timer that meets one has no reason to try again.
 */
export function isAddressRefusal(error: unknown): error is TxConstructionError {
  return (
    error instanceof TxConstructionError &&
    (error.reason === "address_empty" || error.reason === "address_too_long" || error.reason === "address_invalid")
  );
}
