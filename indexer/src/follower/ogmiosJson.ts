/**
 * indexer/src/follower/ogmiosJson.ts — the text of an Ogmios message → JSON value.
 *
 * JSON.parse turns each number into a double. A metadata integer has up to
 * 64 bits (-2^64 … 2^64 - 1), and Ogmios writes it in full digits in the plain
 * JSON form of `metadata.labels` (Ogmios v6.14.0, `encodeInteger`). Above 2^53
 * the double is not the integer any more, so the digits are lost before
 * follower/metadata.ts sees them.
 *
 * parseOgmiosMessage gives the same value as JSON.parse, with one exception:
 * an integer token outside the safe range (Number.isSafeInteger) inside
 * `metadata.labels` is a bigint with the exact value. Every other number stays
 * a number, because the other readers of the message (ogmiosBlock.ts) read
 * numbers.
 *
 * Nearly every message needs no second pass. The reader below runs only when
 * the text has a `"labels"` key and a number token of 16 digits or more (an
 * integer outside the safe range has at least 16 digits). The text is valid
 * JSON by then, because JSON.parse has read it. When the second pass fails
 * (for example, nesting that is too deep), the value of JSON.parse is the
 * result, as it was before.
 */

const LABELS_KEY = '"labels"';
/** A number token of 16 or more digits: after `:`, `,` or `[`, and white space. */
const LONG_INTEGER = /[:,\[]\s*-?[0-9]{16}/;
const STRING = /"[^"\\]*(?:\\.[^"\\]*)*"/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
/** A nesting limit for the recursive reader. Native JSON.parse has none. */
const MAX_DEPTH = 1_000;

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_QUOTE = 0x22;
const CH_COMMA = 0x2c;
const CH_COLON = 0x3a;
const CH_LBRACKET = 0x5b;
const CH_RBRACKET = 0x5d;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;

/** The reader of valid JSON text. Objects have the same keys and values as JSON.parse gives. */
class ExactReader {
  private pos = 0;

  constructor(private readonly text: string) {}

  read(): unknown {
    const value = this.value(false, null, 0);
    this.skipSpace();
    if (this.pos !== this.text.length) throw new SyntaxError(`unexpected text at ${this.pos}`);
    return value;
  }

  private skipSpace(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c !== CH_SPACE && c !== CH_LF && c !== CH_CR && c !== CH_TAB) return;
      this.pos++;
    }
  }

  /** `exact`: the value is inside `metadata.labels`. `key`: the key of the value in its object. */
  private value(exact: boolean, key: string | null, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new RangeError("the JSON nesting is too deep");
    this.skipSpace();
    switch (this.text.charCodeAt(this.pos)) {
      case CH_LBRACE:
        return this.object(exact, key, depth);
      case CH_LBRACKET:
        return this.array(exact, depth);
      case CH_QUOTE:
        return this.string();
      case 0x74: // t
        return this.word("true", true);
      case 0x66: // f
        return this.word("false", false);
      case 0x6e: // n
        return this.word("null", null);
      default:
        return this.number(exact);
    }
  }

  private word<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) throw new SyntaxError(`unexpected text at ${this.pos}`);
    this.pos += word.length;
    return value;
  }

  private number(exact: boolean): number | bigint {
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (!match) throw new SyntaxError(`unexpected text at ${this.pos}`);
    this.pos = NUMBER.lastIndex;
    const token = match[0];
    const number = Number(token);
    // An integer token (no fraction, no exponent) that is not a safe integer keeps all its digits.
    if (exact && match[1] === undefined && match[2] === undefined && !Number.isSafeInteger(number)) return BigInt(token);
    return number;
  }

  private string(): string {
    STRING.lastIndex = this.pos;
    const match = STRING.exec(this.text);
    if (!match) throw new SyntaxError(`unexpected text at ${this.pos}`);
    this.pos = STRING.lastIndex;
    const token = match[0];
    return token.includes("\\") ? (JSON.parse(token) as string) : token.slice(1, -1);
  }

  private array(exact: boolean, depth: number): unknown[] {
    this.pos++; // [
    const items: unknown[] = [];
    this.skipSpace();
    if (this.text.charCodeAt(this.pos) === CH_RBRACKET) {
      this.pos++;
      return items;
    }
    for (;;) {
      items.push(this.value(exact, null, depth + 1));
      this.skipSpace();
      const c = this.text.charCodeAt(this.pos++);
      if (c === CH_RBRACKET) return items;
      if (c !== CH_COMMA) throw new SyntaxError(`unexpected text at ${this.pos - 1}`);
    }
  }

  private object(exact: boolean, key: string | null, depth: number): Record<string, unknown> {
    this.pos++; // {
    const fields: Record<string, unknown> = {};
    this.skipSpace();
    if (this.text.charCodeAt(this.pos) === CH_RBRACE) {
      this.pos++;
      return fields;
    }
    for (;;) {
      this.skipSpace();
      if (this.text.charCodeAt(this.pos) !== CH_QUOTE) throw new SyntaxError(`unexpected text at ${this.pos}`);
      const name = this.string();
      this.skipSpace();
      if (this.text.charCodeAt(this.pos++) !== CH_COLON) throw new SyntaxError(`unexpected text at ${this.pos - 1}`);
      const value = this.value(exact || (key === "metadata" && name === "labels"), name, depth + 1);
      // JSON.parse makes "__proto__" an own property; an assignment would set the prototype.
      if (name === "__proto__") Object.defineProperty(fields, name, { value, writable: true, enumerable: true, configurable: true });
      else fields[name] = value;
      this.skipSpace();
      const c = this.text.charCodeAt(this.pos++);
      if (c === CH_RBRACE) return fields;
      if (c !== CH_COMMA) throw new SyntaxError(`unexpected text at ${this.pos - 1}`);
    }
  }
}

/** JSON.parse of an Ogmios message; an integer beyond 2^53 inside `metadata.labels` is an exact bigint. Throws as JSON.parse does. */
export function parseOgmiosMessage(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (!text.includes(LABELS_KEY) || !LONG_INTEGER.test(text)) return value;
  try {
    return new ExactReader(text).read();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[ogmiosJson] ${reason}; an integer beyond 2^53 in the transaction metadata is not exact`);
    return value;
  }
}
