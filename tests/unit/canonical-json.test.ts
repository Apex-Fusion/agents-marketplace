/**
 * Canonical JSON tests — M0-D coverage audit
 *
 * Covers: canonicalize() in packages/shared/src/cbor/canonical.ts
 * These become load-bearing in M1 for request_spec_hash and prompt_hash.
 *
 * ARCHITECTURE.md §9 #2: RFC-8785 JCS subset — sorted keys, UTF-8 NFC, no whitespace.
 */

import { describe, it, expect } from "vitest";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";

// ─── Output of canonicalize ───────────────────────────────────────────────────

describe("canonicalize — output", () => {
  // [description, input, canonical JSON]
  const rows: Array<[string, unknown, string]> = [
    ["sorts object keys alphabetically", { z: 1, a: 2, m: 3 }, '{"a":2,"m":3,"z":1}'],
    // In JS string comparison, 'A' (0x41) < 'a' (0x61)
    ["sorts keys lexicographically by code-unit (uppercase before lowercase)", { b: 1, A: 2, a: 3 }, '{"A":2,"a":3,"b":1}'],
    ["sorts keys at every nesting level", { z: { y: 1, a: 2 }, a: { z: 3, b: 4 } }, '{"a":{"b":4,"z":3},"z":{"a":2,"y":1}}'],
    ["preserves array element order, also in a nested array (JCS requirement — arrays are ordered)", [3, 1, [2, 0]], "[3,1,[2,0]]"],
    ["array of objects — each object's keys are sorted but array order is preserved", [{ z: 1, a: 2 }, { y: 3, b: 4 }], '[{"a":2,"z":1},{"b":4,"y":3}]'],
    ["drops undefined values from objects", { a: 1, b: undefined, c: 3 }, '{"a":1,"c":3}'],
    ["drops all-undefined object to empty object", { a: undefined, b: undefined }, "{}"],
    ["does NOT drop null (null is a valid JSON value)", { a: null, b: 1 }, '{"a":null,"b":1}'],
    ["writes an empty object and an empty array", [{}, []], "[{},[]]"],
    ["passes booleans and numbers through", { t: true, f: false, i: 42, d: 3.14, z: 0, n: -7 }, '{"d":3.14,"f":false,"i":42,"n":-7,"t":true,"z":0}'],
    // The newline inside the string value is escaped; the JSON structure has no whitespace.
    ["writes no whitespace", { a: "multi\nline", b: [2, 3], c: { d: 4 } }, '{"a":"multi\\nline","b":[2,3],"c":{"d":4}}'],
    [
      "a realistic request envelope",
      {
        supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
        capability_id: "llm.text.generate.v1",
        model: "qwen2.5:0.5b",
        max_output_tokens: 512,
        price_lovelace: 2000000,
      },
      // Keys must be sorted: capability_id < max_output_tokens < model < price_lovelace < supplier_pkh
      '{"capability_id":"llm.text.generate.v1","max_output_tokens":512,"model":"qwen2.5:0.5b","price_lovelace":2000000,"supplier_pkh":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef01"}',
    ],
  ];

  it.each(rows)("%s", (_description, input, expected) => {
    expect(canonicalize(input)).toBe(expected);
  });

  it("binds prototype-named JSON properties instead of dropping them from a commitment", () => {
    const schema = JSON.parse('{"properties":{"__proto__":{"type":"string"}}}');
    expect(canonicalize(schema)).toBe('{"properties":{"__proto__":{"type":"string"}}}');
    expect(canonicalize(schema)).not.toBe(canonicalize({ properties: {} }));
  });
});

// ─── UTF-8 NFC normalization ──────────────────────────────────────────────────

describe("canonicalize — UTF-8 NFC normalization", () => {
  // The escapes keep the two forms apart in the source: U+0065 U+0301 is e + combining acute (NFD), U+00E9 is é (NFC, precomposed).
  // The expected text is the NFC form, so a code that normalizes to NFD fails too.
  const decomposed = "e\u0301";
  const composed = "\u00e9";

  it("NFD-decomposed string value is NFC-normalized", () => {
    expect(canonicalize(decomposed)).toBe(`"${composed}"`);
  });

  it("NFD-decomposed key is NFC-normalized", () => {
    expect(canonicalize({ [decomposed]: 1 })).toBe(`{"${composed}":1}`);
  });
});

// ─── Request spec / prompt hash scenario ─────────────────────────────────────

describe("canonicalize — request_spec_hash / prompt_hash use case", () => {
  it("request specs that differ only in field order give identical canonical JSON; a different value gives different JSON", () => {
    const spec1 = {
      model: "qwen2.5:0.5b",
      capability_id: "llm.text.generate.v1",
      max_output_tokens: 512,
    };
    const spec2 = {
      max_output_tokens: 512,
      capability_id: "llm.text.generate.v1",
      model: "qwen2.5:0.5b",
    };
    expect(canonicalize(spec1)).toBe(canonicalize(spec2));
    expect(canonicalize({ ...spec1, model: "qwen2.5:1.5b" })).not.toBe(canonicalize(spec1));
  });
});
