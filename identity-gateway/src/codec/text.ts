// Text from a record (Part 1 Section 8.2): a text field or capability item that is not valid UTF-8,
// or that contains a surrogate code point or a noncharacter (RFC 7493), is left out.
// The decoder is fatal (invalid UTF-8, overlong forms and encoded surrogates throw) and keeps a
// leading U+FEFF, which is ordinary text here.

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** U+FDD0..U+FDEF and the last two code points of every plane. */
const NONCHARACTER = /[\uFDD0-\uFDEF\uFFFE\uFFFF\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/u;

/** The text, or null when the resolver must leave it out. */
export function recordText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return null;
  }
  return NONCHARACTER.test(text) ? null : text;
}
