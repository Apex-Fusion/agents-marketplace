import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_INPUT_BYTES, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_RUNTIME_MS,
  MAX_TOOL_MANIFEST_BYTES, MAX_TOOL_JSON_DEPTH, MAX_TOOL_JSON_NODES,
  PAPER2AGENT_CAPABILITY_ID,
  parsePaper2AgentManifest, paper2AgentManifestHash, paper2AgentModel,
  paper2AgentToolName, validatePaper2AgentInput, validatePaper2AgentOutput,
  paper2AgentRequestHash, paper2AgentResultHash, paper2AgentRequestSpecHash,
  paper2AgentSupplierPkh, parsePaper2AgentRequest, verifyPaper2AgentReceipt,
  type JsonObject, type Paper2AgentManifest,
} from "@marketplace/shared/paper2agent";
import { canonicalize } from "../../packages/shared/src/cbor/canonical.js";
import { buildReceipt } from "../../packages/shared/src/receipt/build.js";
import { receiptResultHash, signReceipt } from "../../packages/shared/src/receipt/sign.js";
import {
  SUPPLIER_PRIVATE_KEY_HEX, SUPPLIER_PUB_KEY_HEX,
} from "../fixtures/supplier-side/wallet-keys.js";

function manifest(): Paper2AgentManifest {
  return {
    schema_version: 1, name: "reviewed.tool", description: "Supplier-configured tool",
    package_sha256: "ab".repeat(32),
    input_schema: {
      type: "object", properties: { text: { type: "string", maxLength: 100 } },
      required: ["text"], additionalProperties: false,
    },
    output_schema: {
      type: "object", properties: { value: { type: "number" } },
      required: ["value"], additionalProperties: false,
    },
    limits: { max_input_bytes: 1024, max_output_bytes: 2048, max_runtime_ms: 5000 },
  };
}

function receiptFixture() {
  const configured = manifest();
  const input = { text: "test" };
  const result = { value: 7 };
  const manifestHash = paper2AgentManifestHash(configured);
  const requestHash = paper2AgentRequestHash(manifestHash, input);
  const supplierPkh = paper2AgentSupplierPkh(SUPPLIER_PUB_KEY_HEX);
  const escrowRef = `${"cd".repeat(32)}#0`;
  const receipt = buildReceipt({
    prompt_hash: requestHash,
    response_hash: paper2AgentResultHash(manifestHash, requestHash, result),
    model: paper2AgentModel(configured), prompt_tokens: 0, completion_tokens: 0,
    wallclock_ms: 21, supplier_pkh: supplierPkh, escrow_ref: escrowRef,
  });
  const signed = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
  return {
    manifest: configured, input, result, receipt,
    signature: signed.signature, publicKeyHex: SUPPLIER_PUB_KEY_HEX, supplierPkh, escrowRef,
  };
}

describe("Paper2Agent manifest and stable commitments", () => {
  it("exports protocol limits and produces canonical full-version names", () => {
    expect([MAX_TOOL_INPUT_BYTES, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_RUNTIME_MS, MAX_TOOL_MANIFEST_BYTES])
      .toEqual([65536, 262144, 120000, 131072]);
    const configured = parsePaper2AgentManifest(manifest());
    const expected = createHash("sha256").update(canonicalize(configured)).digest("hex");
    expect(paper2AgentManifestHash(configured)).toBe(expected);
    expect(paper2AgentModel(configured)).toBe(`paper2agent:${expected}`);
    expect(paper2AgentToolName(configured)).toBe(`p2a_reviewed.tool_${expected.slice(0, 16)}`);
    expect(paper2AgentRequestSpecHash(configured)).toBe(createHash("sha256").update(canonicalize({
      capability_id: PAPER2AGENT_CAPABILITY_ID, max_output_tokens: 0, model: `paper2agent:${expected}`,
    })).digest("hex"));
  });

  it("uses the exact request/result envelopes and binds every version and value", () => {
    const version = paper2AgentManifestHash(manifest());
    const input = { text: "test" };
    const result = { value: 7 };
    const request = paper2AgentRequestHash(version, input);
    expect(request).toBe(createHash("sha256").update(canonicalize({
      capability_id: PAPER2AGENT_CAPABILITY_ID, manifest_hash: version, input,
    })).digest("hex"));
    const response = paper2AgentResultHash(version, request, result);
    expect(response).toBe(createHash("sha256").update(canonicalize({
      capability_id: PAPER2AGENT_CAPABILITY_ID, manifest_hash: version, request_hash: request, result,
    })).digest("hex"));
    expect(paper2AgentRequestHash("11".repeat(32), input)).not.toBe(request);
    expect(paper2AgentRequestHash(version, { text: "changed" })).not.toBe(request);
    expect(paper2AgentResultHash("11".repeat(32), request, result)).not.toBe(response);
    expect(paper2AgentResultHash(version, "22".repeat(32), result)).not.toBe(response);
    expect(paper2AgentResultHash(version, request, { value: 8 })).not.toBe(response);
    expect(() => paper2AgentRequestHash("AB".repeat(32), input)).toThrow();
  });

  it("normalizes before sorting and returns the same values that are committed", () => {
    const configured = manifest();
    configured.input_schema = { type: "object" };
    const original = { "e\u0301": "e\u0301", z: ["e\u0301"] };
    const normalized = validatePaper2AgentInput(configured, original);
    expect(normalized).toEqual({ "é": "é", z: ["é"] });
    expect(original).toEqual({ "e\u0301": "e\u0301", z: ["e\u0301"] });
    expect(paper2AgentRequestHash("11".repeat(32), original))
      .toBe(paper2AgentRequestHash("11".repeat(32), { z: ["é"], "é": "é" }));
    expect(() => validatePaper2AgentInput(configured, { "é": 1, "e\u0301": 2 })).toThrow(/collision/);
    expect(() => parsePaper2AgentManifest({ ...configured, input_schema: {
      type: "object", properties: { "é": { type: "string" }, "e\u0301": { type: "number" } },
    } })).toThrow(/collision/);
  });

  it.each([
    { extra: true }, { schema_version: 2 }, { name: "not a tool" }, { name: "a".repeat(41) },
    { name: "é" }, { package_sha256: "AB".repeat(32) }, { description: "a".repeat(4097) },
    { input_schema: { type: "array" } },
  ])("rejects invalid or unknown manifest fields %j", (change) => {
    expect(() => parsePaper2AgentManifest({ ...manifest(), ...change })).toThrow();
  });

  it("rejects missing fields and out-of-range limits without changing cached versions", () => {
    const configured = manifest();
    const first = paper2AgentManifestHash(configured);
    const { description: _description, ...missing } = configured;
    expect(() => parsePaper2AgentManifest(missing)).toThrow();
    for (const [key, maximum] of Object.entries({
      max_input_bytes: MAX_TOOL_INPUT_BYTES, max_output_bytes: MAX_TOOL_OUTPUT_BYTES,
      max_runtime_ms: MAX_TOOL_RUNTIME_MS,
    })) {
      for (const value of [0, -1, 0.5, maximum + 1, NaN, Infinity, "1"]) {
        expect(() => parsePaper2AgentManifest({ ...configured, limits: { ...configured.limits, [key]: value } })).toThrow();
      }
    }
    configured.package_sha256 = "cc".repeat(32);
    expect(paper2AgentManifestHash(configured)).not.toBe(first);
    configured.input_schema = { type: "object", required: ["other"] };
    expect(() => validatePaper2AgentInput(configured, { text: "test" })).toThrow();
  });

  it("checks the exact request envelope before execution", () => {
    const configured = manifest();
    const request = { manifest_hash: paper2AgentManifestHash(configured), input: { text: "e\u0301" } };
    expect(parsePaper2AgentRequest(configured, request)).toEqual({ ...request, input: { text: "é" } });
    expect(() => parsePaper2AgentRequest(configured, { ...request, api_key: "private" })).toThrow();
    expect(() => parsePaper2AgentRequest(configured, { ...request, manifest_hash: "00".repeat(32) })).toThrow();
    expect(() => parsePaper2AgentRequest(configured, { input: request.input })).toThrow();
    configured.input_schema = { type: "object" };
    configured.limits.max_input_bytes = 10;
    expect(() => parsePaper2AgentRequest(configured, {
      manifest_hash: paper2AgentManifestHash(configured), input: { x: "e\u0301" },
    })).toThrow(/byte/);
  });
});

describe("Paper2Agent bounded JSON and maintained schema validation", () => {
  it.each([undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol("x"), new Date(), /x/, "\ud800"])(
    "rejects non-JSON values, including malformed strings: %s", (value) => {
      const configured = manifest();
      configured.input_schema = { type: "object" };
      expect(() => validatePaper2AgentInput(configured, { value })).toThrow();
    },
  );

  it("rejects cycles, sparse arrays, hidden fields and accessors without calling them", () => {
    const configured = manifest();
    configured.input_schema = { type: "object" };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let called = false;
    const accessor = Object.defineProperty({}, "text", { enumerable: true, get() { called = true; return "test"; } });
    for (const value of [cyclic, { values: new Array(3) }, accessor,
      Object.defineProperty({}, "hidden", { value: 1 }), { [Symbol("key")]: 1 },
      { text: "test", toJSON() { called = true; return {}; } },
    ]) expect(() => validatePaper2AgentInput(configured, value)).toThrow();
    expect(called).toBe(false);
  });

  it("enforces UTF-8 byte limits, depth and node bounds", () => {
    const configured = manifest();
    configured.input_schema = { type: "object" };
    configured.output_schema = { type: "object" };
    configured.limits.max_input_bytes = 10;
    expect(validatePaper2AgentInput(configured, { x: "é" })).toEqual({ x: "é" });
    expect(() => validatePaper2AgentInput(configured, { x: "éé" })).toThrow(/byte limit/);
    configured.limits.max_output_bytes = 10;
    expect(() => validatePaper2AgentOutput(configured, { x: "éé" })).toThrow(/byte limit/);
    configured.limits.max_input_bytes = MAX_TOOL_INPUT_BYTES;
    let deep: JsonObject = {};
    for (let i = 0; i <= MAX_TOOL_JSON_DEPTH; i++) deep = { child: deep };
    expect(() => validatePaper2AgentInput(configured, deep)).toThrow(/depth/);
    expect(() => validatePaper2AgentInput(configured, { values: Array(MAX_TOOL_JSON_NODES).fill(0) })).toThrow(/node/);
    expect(() => paper2AgentResultHash("11".repeat(32), "22".repeat(32), { x: "a".repeat(MAX_TOOL_OUTPUT_BYTES) })).toThrow(/byte/);
    expect(() => parsePaper2AgentManifest({ ...configured, input_schema: {
      type: "object", description: "a".repeat(MAX_TOOL_MANIFEST_BYTES),
    } })).toThrow(/byte/);
  });

  it("uses AJV for required, numeric, combinator and local-reference semantics without coercion", () => {
    const configured = manifest();
    configured.input_schema = {
      type: "object", definitions: { value: { type: "integer", minimum: 2, maximum: 9 } },
      properties: { number: { $ref: "#/definitions/value" }, mode: { enum: ["a", "b"], default: "a" } },
      required: ["number", "mode"], additionalProperties: false,
      oneOf: [{ properties: { mode: { const: "a" } } }, { properties: { mode: { const: "b" } } }],
    };
    const good = { number: 3, mode: "a" };
    expect(validatePaper2AgentInput(configured, good)).toEqual(good);
    for (const bad of [{ number: "3", mode: "a" }, { number: 1, mode: "a" }, { number: 3 },
      { number: 3, mode: "c" }, { ...good, extra: true }]) {
      expect(() => validatePaper2AgentInput(configured, bad)).toThrow(/schema/);
    }
    expect(() => validatePaper2AgentOutput(manifest(), { value: "7" })).toThrow(/schema/);
    expect(() => validatePaper2AgentOutput(manifest(), { value: 7, extra: true })).toThrow(/schema/);
  });

  it.each([
    { type: "object", $ref: "https://example.com/schema" },
    { type: "object", $ref: "file:///tmp/schema" },
    { type: "object", properties: { next: { $ref: "#" } } },
    { type: "object", definitions: { a: { $ref: "#/definitions/b" }, b: { $ref: "#/definitions/a" } } },
    { type: "object", properties: { value: { type: "string", pattern: "^(a+)+$" } } },
    { type: "object", patternProperties: { ".*": {} } },
    { type: "object", properties: { value: { type: "string", format: "email" } } },
    { type: "object", $async: true },
    { type: "object", $id: "https://example.com/" },
    { type: "object", misspelledKeyword: true },
  ])("rejects unsafe or invalid schemas before compilation: %j", (schema) => {
    expect(() => parsePaper2AgentManifest({ ...manifest(), input_schema: schema })).toThrow();
  });

  it("rejects acyclic reference expansion bombs", () => {
    const definitions: JsonObject = { end: { type: "number" } };
    let previous = "end";
    for (let i = 0; i < 16; i++) {
      const name = `node${i}`;
      definitions[name] = { allOf: [{ $ref: `#/definitions/${previous}` }, { $ref: `#/definitions/${previous}` }] };
      previous = name;
    }
    expect(() => parsePaper2AgentManifest({ ...manifest(), input_schema: {
      type: "object", definitions, properties: { value: { $ref: `#/definitions/${previous}` } },
    } })).toThrow(/expansion/);
  });

  it("bounds reference depth even when definitions have cached traversal costs", () => {
    const definitions: JsonObject = { end: { type: "number" } };
    let previous = "end";
    for (let i = 0; i <= MAX_TOOL_JSON_DEPTH; i++) {
      const name = `node${i}`;
      definitions[name] = { $ref: `#/definitions/${previous}` };
      previous = name;
    }
    expect(() => parsePaper2AgentManifest({ ...manifest(), input_schema: {
      type: "object", definitions, properties: { value: { $ref: `#/definitions/${previous}` } },
    } })).toThrow(/depth/);
  });
});

describe("Paper2Agent genuine receipt and supplier-key binding", () => {
  it("accepts deterministic signed receipts and reuses the existing on-chain receipt commitment", () => {
    const args = receiptFixture();
    expect(() => verifyPaper2AgentReceipt(args)).not.toThrow();
    expect(signReceipt(args.receipt, SUPPLIER_PRIVATE_KEY_HEX).signature).toBe(args.signature);
    expect(receiptResultHash({ receipt: args.receipt, signature: args.signature })).toBe(
      createHash("sha256").update(canonicalize({ receipt: args.receipt, signature: args.signature })).digest("hex"),
    );
    // Cardano hashes the key with BLAKE2b's digest-length parameter, not a
    // truncated BLAKE2b-512 digest. Binding must not accept that common mistake.
    const truncated = createHash("blake2b512").update(Buffer.from(args.publicKeyHex, "hex")).digest("hex").slice(0, 56);
    expect(args.supplierPkh).not.toBe(truncated);
    expect(() => verifyPaper2AgentReceipt({ ...args, supplierPkh: truncated })).toThrow(/PKH/);
  });

  it("rejects wrong supplier keys and zero or forged nonzero signatures", () => {
    const args = receiptFixture();
    expect(() => verifyPaper2AgentReceipt({ ...args, publicKeyHex: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" })).toThrow(/PKH/);
    for (const signature of ["00".repeat(64), "11".repeat(64), args.signature.slice(0, 126), "not-hex"]) {
      expect(() => verifyPaper2AgentReceipt({ ...args, signature })).toThrow(/signature/);
    }
    expect(() => paper2AgentSupplierPkh(`01${"00".repeat(31)}`)).toThrow(/signing key/);
    expect(() => paper2AgentSupplierPkh("not a key")).toThrow();
  });

  it("rejects changed input, result, tool version and original escrow", () => {
    const args = receiptFixture();
    expect(() => verifyPaper2AgentReceipt({ ...args, input: { text: "changed" } })).toThrow(/commitment/);
    expect(() => verifyPaper2AgentReceipt({ ...args, result: { value: 8 } })).toThrow(/commitment/);
    expect(() => verifyPaper2AgentReceipt({ ...args, manifest: { ...args.manifest, package_sha256: "dd".repeat(32) } })).toThrow(/commitment/);
    expect(() => verifyPaper2AgentReceipt({ ...args, escrowRef: `${"cd".repeat(32)}#1` })).toThrow(/commitment/);
  });

  it("rejects correctly signed but invalid receipt fields", () => {
    const args = receiptFixture();
    for (const change of [
      { model: "unversioned" }, { prompt_hash: "11".repeat(32) }, { response_hash: "22".repeat(32) },
      { supplier_pkh: "33".repeat(28) }, { escrow_ref: `${"44".repeat(32)}#0` },
      { prompt_tokens: 1 }, { completion_tokens: 1 }, { wallclock_ms: 5001 }, { wallclock_ms: 0.5 },
    ]) {
      const receipt = { ...args.receipt, ...change };
      const { signature } = signReceipt(receipt, SUPPLIER_PRIVATE_KEY_HEX);
      expect(() => verifyPaper2AgentReceipt({ ...args, receipt, signature })).toThrow();
    }
    expect(() => verifyPaper2AgentReceipt({ ...args, receipt: { ...args.receipt, extra: true } as typeof args.receipt })).toThrow(/fields/);
    expect(() => verifyPaper2AgentReceipt({ ...args, receipt: { ...args.receipt, wallclock_ms: NaN } })).toThrow(/finite/);
  });
});
