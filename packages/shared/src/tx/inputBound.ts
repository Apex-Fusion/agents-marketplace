import type { ChatMessage } from "./types.js";
import { canonicalize } from "../cbor/canonical.js";

/** Advert detail-URI marker for suppliers that require live input-cap preflight. */
export const BOUNDED_INPUT_DETAIL_MARKER = "#vector-bounded-input-v1";

const CHAT_MESSAGE_OVERHEAD = 8;
const CHAT_REPLY_PRIMER = 3;
const encoder = new TextEncoder();

/**
 * Conservative, tokenizer-independent upper bound for text chat input.
 *
 * Every UTF-8 byte counts as one token unit. The fixed per-message and reply
 * overhead covers role separators and the provider chat template. Major
 * byte-fallback tokenizers cannot emit more content tokens than input bytes.
 */
export function chatInputTokenUpperBound(
  messages: readonly ChatMessage[],
): number {
  return (
    CHAT_REPLY_PRIMER +
    CHAT_MESSAGE_OVERHEAD * messages.length +
    encoder.encode(canonicalize(messages)).byteLength
  );
}
