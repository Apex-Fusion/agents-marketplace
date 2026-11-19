/**
 * gateway/src/onchain/unreadable.ts — escrows whose datum a chain client withheld.
 *
 * A chain client withholds an inline datum that is nested deeper than 64 levels or is not CBOR that the decoders read (the output
 * stays in the list with no datum). The sweeper and the recovery of one-shot jobs read none of these escrows. Each of them says so
 * one time for each reference, and asks the chain no more about it, so that a timer does not write a line or send a question at each
 * tick. The memory is bounded (oldest out first); after a restart it says each reference once more.
 */

/** The references that the process remembers. */
export const MAX_UNREADABLE_REFS = 5_000;
const refs = new Set<string>();

/** Test only: forgets the references. */
export function resetUnreadableForTests(): void {
  refs.clear();
}

/** True when `ref` (`<txhash>#<index>`) is known as an escrow with a datum that is not read. */
export function isUnreadable(ref: string): boolean {
  return refs.has(ref);
}

/** Remembers `ref`, and writes one line the first time. `who` names the caller in the line. */
export function noteUnreadable(ref: string, who: string): void {
  if (refs.has(ref)) return;
  refs.add(ref);
  if (refs.size > MAX_UNREADABLE_REFS) {
    const oldest = refs.values().next();
    if (!oldest.done) refs.delete(oldest.value);
  }
  // eslint-disable-next-line no-console
  console.log(`[gateway:${who}] skipping escrow ${ref}: its datum is not read (nested too deep, or not CBOR that the decoders read)`);
}
