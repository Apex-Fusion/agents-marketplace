/**
 * The tests run the deployed bytes: this file proves that the vendored
 * blueprint is the deployed script and that the evaluator is the compiler
 * version that built it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aikenVersion,
  bech32Address,
  fromHex,
  identifierOf,
  LEGACY_ADDRESS,
  LEGACY_BLUEPRINT,
  LEGACY_BLUEPRINT_PATH,
  LEGACY_HASH,
  LEGACY_SCRIPT,
  scriptHash,
  toHex,
} from "./harness/index.js";

describe("deployed legacy blueprint", () => {
  it("is a byte copy of vector-ai-agents@f6ae4bb agent-registry/deploy/agent-registry/plutus.json", () => {
    const content = readFileSync(LEGACY_BLUEPRINT_PATH);
    const blob = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    expect(blob).toBe("4c79883eaef7b448d7c195bc68bfda9ed8ac9854");
  });

  it("has one code for mint, spend and else, compiled by Aiken v1.1.21 for Plutus V3", () => {
    expect(LEGACY_BLUEPRINT.preamble.plutusVersion).toBe("v3");
    expect(LEGACY_BLUEPRINT.preamble.compiler.version).toBe("v1.1.21+42babe5");
    expect(LEGACY_BLUEPRINT.validators.map((v) => v.title)).toEqual([
      "registry.registry.mint",
      "registry.registry.spend",
      "registry.registry.else",
    ]);
    for (const v of LEGACY_BLUEPRINT.validators) {
      expect(v.compiledCode).toBe(toHex(LEGACY_SCRIPT.compiledCode));
      expect(v.hash).toBe(toHex(LEGACY_HASH));
    }
  });

  it("hashes to legacy_hash: blake2b_224(0x03 || compiledCode)", () => {
    expect(toHex(LEGACY_HASH)).toBe("be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01");
    // compiledCode is one CBOR byte string (0x59, 2-byte length 0x09d1) around the flat program.
    const code = LEGACY_SCRIPT.compiledCode;
    expect(toHex(code.subarray(0, 3))).toBe("5909d1");
    expect(code.length).toBe(3 + 0x09d1);
    // The CBOR header is part of the hashed bytes: the flat program alone gives another hash.
    expect(toHex(scriptHash({ compiledCode: code.subarray(3) }))).toBe("4646671a3b80600697b0f5536c3958a60b4cf6b5bd7166b824f30f1b");
  });

  it("has the legacy address of Part 1 §4", () => {
    expect(bech32Address(LEGACY_ADDRESS)).toBe("addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42");
  });

  it("names tokens as the Part 1 §3.1 test vectors", () => {
    expect(toHex(identifierOf({ txId: new Uint8Array(32), index: 0 }))).toBe(
      "a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9",
    );
    expect(toHex(identifierOf({ txId: fromHex("ab".repeat(32)), index: 24 }))).toBe(
      "3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b",
    );
  });

  it("runs on the evaluator of the compiler that built it", () => {
    expect(aikenVersion()).toBe("aiken v1.1.21+42babe5");
  });
});
