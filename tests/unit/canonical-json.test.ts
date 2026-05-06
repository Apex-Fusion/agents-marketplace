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

// ─── Key sorting ─────────────────────────────────────────────────────────────

describe("canonicalize — key sorting", () => {
  it("sorts object keys alphabetically", () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("sorts keys lexicographically by code-unit (uppercase before lowercase)", () => {
    // In JS string comparison, 'A' (0x41) < 'a' (0x61)
    const result = canonicalize({ b: 1, A: 2, a: 3 });
    expect(result).toBe('{"A":2,"a":3,"b":1}');
  });

  it("already-sorted keys produce the same output", () => {
    const result = canonicalize({ a: 1, b: 2, c: 3 });
    expect(result).toBe('{"a":1,"b":2,"c":3}');
  });

  it("single-key object is unaffected by sorting", () => {
    const result = canonicalize({ only: "one" });
    expect(result).toBe('{"only":"one"}');
  });

  it("empty object produces empty braces", () => {
    expect(canonicalize({})).toBe("{}");
  });
});

// ─── Nested object key sorting ────────────────────────────────────────────────

describe("canonicalize — nested object key sorting", () => {
  it("sorts keys at every nesting level", () => {
    const result = canonicalize({ z: { y: 1, a: 2 }, a: { z: 3, b: 4 } });
    expect(result).toBe('{"a":{"b":4,"z":3},"z":{"a":2,"y":1}}');
  });

  it("deeply nested objects are all sorted", () => {
    const input = { c: { b: { a: "deep" } } };
    expect(canonicalize(input)).toBe('{"c":{"b":{"a":"deep"}}}');
  });
});

// ─── Array order preservation ─────────────────────────────────────────────────

describe("canonicalize — array order preservation", () => {
  it("preserves array element order (JCS requirement — arrays are ordered)", () => {
    const result = canonicalize([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("empty array serializes as []", () => {
    expect(canonicalize([])).toBe("[]");
  });

  it("array of strings preserves order", () => {
    const result = canonicalize(["z", "a", "m"]);
    expect(result).toBe('["z","a","m"]');
  });

  it("array of objects — each object's keys are sorted but array order is preserved", () => {
    const result = canonicalize([{ z: 1, a: 2 }, { y: 3, b: 4 }]);
    expect(result).toBe('[{"a":2,"z":1},{"b":4,"y":3}]');
  });

  it("nested array order is preserved", () => {
    const result = canonicalize([[3, 1], [2, 0]]);
    expect(result).toBe("[[3,1],[2,0]]");
  });
});

// ─── Undefined-drop ───────────────────────────────────────────────────────────

describe("canonicalize — undefined value dropping", () => {
  it("drops undefined values from objects", () => {
    const result = canonicalize({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it("drops all-undefined object to empty object", () => {
    const result = canonicalize({ a: undefined, b: undefined });
    expect(result).toBe("{}");
  });

  it("does NOT drop null (null is a valid JSON value)", () => {
    const result = canonicalize({ a: null, b: 1 });
    expect(result).toBe('{"a":null,"b":1}');
  });
});

// ─── Scalar value handling ────────────────────────────────────────────────────

describe("canonicalize — null, boolean, number", () => {
  it("null top-level value serializes as 'null'", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("boolean true serializes as 'true'", () => {
    expect(canonicalize(true)).toBe("true");
  });

  it("boolean false serializes as 'false'", () => {
    expect(canonicalize(false)).toBe("false");
  });

  it("integer number serializes without decimal", () => {
    expect(canonicalize(42)).toBe("42");
  });

  it("float number serializes with decimal", () => {
    expect(canonicalize(3.14)).toBe("3.14");
  });

  it("zero serializes as 0", () => {
    expect(canonicalize(0)).toBe("0");
  });

  it("negative integer serializes correctly", () => {
    expect(canonicalize(-7)).toBe("-7");
  });
});

// ─── UTF-8 NFC normalization ──────────────────────────────────────────────────

describe("canonicalize — UTF-8 NFC normalization", () => {
  it("NFC-composed string stays the same", () => {
    // U+00E9 = é (precomposed)
    const composed = "é";
    const result = canonicalize({ key: composed });
    const expected = JSON.stringify({ key: "é" });
    expect(result).toBe(expected);
  });

  it("NFD-decomposed string is NFC-normalized (key value)", () => {
    // U+0065 + U+0301 = e + combining acute = é (decomposed)
    const decomposed = "é";
    const composed = "é";
    const resultKey = canonicalize({ [decomposed]: 1 });
    const resultComposed = canonicalize({ [composed]: 1 });
    // Both should produce identical output after NFC normalization
    expect(resultKey).toBe(resultComposed);
  });

  it("NFD-decomposed string value is NFC-normalized", () => {
    const decomposed = "é"; // NFD é
    const composed = "é"; // NFC é
    const r1 = canonicalize(decomposed);
    const r2 = canonicalize(composed);
    expect(r1).toBe(r2);
  });

  it("ASCII string (no normalization needed) is unchanged", () => {
    expect(canonicalize("hello world")).toBe('"hello world"');
  });
});

// ─── Determinism ──────────────────────────────────────────────────────────────

describe("canonicalize — determinism (same input → same output)", () => {
  it("calling twice with the same object returns identical strings", () => {
    const obj = { z: [1, 2], a: { y: true, b: null } };
    expect(canonicalize(obj)).toBe(canonicalize(obj));
  });

  it("structurally equal objects with same keys produce identical output", () => {
    const o1 = { b: 2, a: 1 };
    const o2 = { a: 1, b: 2 };
    expect(canonicalize(o1)).toBe(canonicalize(o2));
  });
});

// ─── No whitespace ────────────────────────────────────────────────────────────

describe("canonicalize — no whitespace in output", () => {
  it("output contains no spaces", () => {
    const result = canonicalize({ a: 1, b: [2, 3], c: { d: 4 } });
    expect(result).not.toMatch(/\s/);
  });

  it("output contains no newlines", () => {
    const result = canonicalize({ a: "multi\nline", b: 1 });
    // The newline inside the string value is allowed (escaped), but the JSON structure has none
    expect(result.replace(/"[^"]*"/g, '""')).not.toMatch(/\n/);
  });
});

// ─── Request spec / prompt hash scenario ─────────────────────────────────────

describe("canonicalize — request_spec_hash / prompt_hash use case", () => {
  it("two request specs differing only in field order produce identical canonical JSON", () => {
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
  });

  it("two request specs with different values produce different canonical JSON", () => {
    const spec1 = { model: "qwen2.5:0.5b", max_output_tokens: 512 };
    const spec2 = { model: "qwen2.5:1.5b", max_output_tokens: 512 };
    expect(canonicalize(spec1)).not.toBe(canonicalize(spec2));
  });

  it("canonical form of a realistic request envelope is stable", () => {
    const envelope = {
      supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
      capability_id: "llm.text.generate.v1",
      model: "qwen2.5:0.5b",
      max_output_tokens: 512,
      price_lovelace: 2000000,
    };
    // Must be deterministic and no whitespace
    const result = canonicalize(envelope);
    expect(result).toBe(canonicalize(envelope));
    expect(result).not.toMatch(/\s/);
    // Keys must be sorted: capability_id < max_output_tokens < model < price_lovelace < supplier_pkh
    expect(result).toBe(
      '{"capability_id":"llm.text.generate.v1","max_output_tokens":512,"model":"qwen2.5:0.5b","price_lovelace":2000000,"supplier_pkh":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef01"}'
    );
  });
});
