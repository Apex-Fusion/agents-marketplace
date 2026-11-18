/**
 * chain/datumGuard.ts — the check at the boundary of the Ogmios clients.
 *
 * Any wallet can create an output at any address, with any inline datum and any reference script. These outputs stay on chain, so
 * a client that reads an address reads them again after each restart. The builders hand the datum of an output to the decoder
 * library (Lucid reads it when it spends the output or reads it as a reference), and the library cannot read CBOR that nests very
 * deep. So a client checks each datum, and each native script, before it hands the output on (cbor-depth.ts).
 *
 * An output that fails the check stays in the list. It keeps its address, its value and its other fields, and it has no datum (no
 * reference script). Its value still counts. A key address needs no datum to be spent, so such an output stays a plain input. A
 * caller that reads the datum of an output at a script address finds none, and refuses the output as it refuses an output with no
 * datum.
 *
 * One log line for each answer names the number of such outputs and the reference of the first. It never holds the bytes.
 *
 * A Plutus script is opaque bytes to the library. It needs no check.
 */

import { assertCborHexDepth } from "../cbor-depth.js";

/** The outputs of one answer whose datum or native script was withheld, in the order in which they were found. */
export class WithheldOutputs {
  private readonly refs = new Set<string>();

  /** The inline datum `datum` of the output `ref`, or null when it fails the check. The empty text is no datum and is kept as it is. */
  datum(datum: string, ref: string): string | null {
    if (datum.length === 0) return datum;
    return this.check(datum, ref, "The datum");
  }

  /** The CBOR of the native script of the output `ref`, or null when it fails the check. */
  nativeScript(cbor: string, ref: string): string | null {
    return this.check(cbor, ref, "The native script");
  }

  /** Writes the line for one answer, when an output was withheld. `client` names the client, `answer` the answer. */
  report(client: string, answer: string): void {
    const first = this.refs.values().next();
    if (first.done) return;
    // eslint-disable-next-line no-console
    console.warn(`[${client}] ${this.refs.size} output(s) of ${answer} carry a datum or a reference script that is not read; first: ${first.value}`);
  }

  private check(cbor: string, ref: string, what: string): string | null {
    try {
      assertCborHexDepth(cbor, { what });
      return cbor;
    } catch {
      this.refs.add(ref);
      return null;
    }
  }
}
