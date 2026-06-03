/**
 * buyer/src/pdf/tokens.ts — single token-counting helper, shared by the
 * chunker (chunk.ts) and the cost estimator (estimate.ts) so the estimate
 * matches the chunk count exactly.
 *
 * Uses gpt-tokenizer's default cl100k_base encoder — pure JS, no native deps,
 * no network. The exact tokenizer a given supplier model uses may differ, but
 * cl100k is a good universal proxy for chunk sizing and cost bounds.
 */

import { encode } from "gpt-tokenizer";

export function countTokens(s: string): number {
  if (s.length === 0) return 0;
  return encode(s).length;
}
