// JSON Canonicalization Scheme, RFC 8785.
//
// Strings and numbers use the ECMAScript JSON serialisation, which is what RFC 8785 Section 3.2.2
// prescribes; object members are sorted by the UTF-16 code units of their names (Section 3.2.3),
// which is JavaScript's default string order. Strings are NOT Unicode-normalised (Section 3.1).
// Values that I-JSON (RFC 7493) forbids are refused rather than silently changed.

const LONE_SURROGATE = /\p{Cs}/u;

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite numbers are not JSON");
      return JSON.stringify(value);
    case "string":
      if (LONE_SURROGATE.test(value)) throw new TypeError("JCS: strings must not contain lone surrogates");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${canonicalize(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: cannot serialise a value of type ${typeof value}`);
  }
}
