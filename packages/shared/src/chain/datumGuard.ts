/**
 * chain/datumGuard.ts — the check at the boundary of the Ogmios clients.
 *
 * A client refuses CBOR that is nested deeper than 64 levels before it is decoded (cbor-depth.ts). It checks two things in the answer
 * of Ogmios, and both stay on chain, so the client sees them again at each read:
 *
 * - An inline datum that fails the check is WITHHELD. The output stays in the list with its address, its value and its other
 *   fields, and it has no datum. Its value still counts. A key address needs no datum to be spent. A caller that reads the datum of
 *   an output at a script address finds none, and refuses the output as it refuses an output with no datum.
 * - A native script that fails the check LEAVES THE OUTPUT OUT of the answer (both clients). When such an output is spent, the
 *   ledger asks a fee for its reference script. A transaction that does not count the script gets a fee that is too low, and the
 *   node refuses it. An output with a withheld datum stays in the list, because a datum costs no fee.
 *
 * A Plutus script is opaque bytes and needs no check.
 *
 * The log has one line for each output reference, and never the bytes. The process remembers the last 1,000 references that it
 * reported (all clients share the memory, because a new client is built for each transaction), and says a reference again only
 * after it left that memory. One answer writes at most 20 lines, and one more line for the rest.
 */

import { assertCborHexDepth } from "../cbor-depth.js";

const REMEMBERED_MAX = 1000;
const LINES_PER_ANSWER_MAX = 20;

/** The references that the process reported, oldest first. */
const reported = new Set<string>();

/** True when `ref` was not reported yet. Remembers it, and forgets the oldest reference when the memory is full. */
function remember(ref: string): boolean {
  if (reported.has(ref)) return false;
  reported.add(ref);
  if (reported.size > REMEMBERED_MAX) {
    const oldest = reported.values().next();
    if (!oldest.done) reported.delete(oldest.value);
  }
  return true;
}

function passes(cbor: string, what: string): boolean {
  try {
    assertCborHexDepth(cbor, { what });
    return true;
  } catch {
    return false;
  }
}

/** The outputs of one answer whose datum was withheld or that were left out, in the order in which they were found. */
export class WithheldOutputs {
  private readonly kinds = new Map<string, "datum" | "script">();

  /** The inline datum `datum` of the output `ref`, or null when it fails the check. The empty text is no datum and is kept as it is. */
  datum(datum: string, ref: string): string | null {
    if (datum.length === 0) return datum;
    if (passes(datum, "The datum")) return datum;
    if (!this.kinds.has(ref)) this.kinds.set(ref, "datum");
    return null;
  }

  /** True when the CBOR of the native script of the output `ref` passes the check. False: the output is left out of the answer. */
  nativeScriptReadable(cbor: string, ref: string): boolean {
    if (passes(cbor, "The native script")) return true;
    this.kinds.set(ref, "script");
    return false;
  }

  /** Writes the lines for one answer: one for each reference that was not reported before. `client` names the client. */
  report(client: string): void {
    let extra = 0;
    let lines = 0;
    for (const [ref, kind] of this.kinds) {
      if (!remember(ref)) continue;
      if (lines >= LINES_PER_ANSWER_MAX) {
        extra += 1;
        continue;
      }
      lines += 1;
      // eslint-disable-next-line no-console
      console.warn(
        kind === "script"
          ? `[${client}] output ${ref}: its reference script is not read, so the output is left out of the answer`
          : `[${client}] output ${ref}: its datum is not read, so the output has no datum`,
      );
    }
    // eslint-disable-next-line no-console
    if (extra > 0) console.warn(`[${client}] ${extra} more outputs of the answer carry a datum or a reference script that is not read`);
  }
}
