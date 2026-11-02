/**
 * tx-identity-blueprint.test.ts — the identity-marketplace blueprint loader
 * and the Plutus V3 parameter helper (Part 2 §2, §6.1: the new escrow has the
 * parameter identity_hash).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bech32 } from "bech32";
import { loadBlueprint, loadIdentityBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { applyDataParameter, plutusV3ScriptHash } from "../../packages/shared/src/tx/internal/plutusScript.js";
import { MAX_ESCROW_LOVELACE, MAX_RANGE_MS } from "../../packages/shared/src/identity/constants.js";
import { ESCROW_INPUT_CAP_LOVELACE } from "../../packages/shared/src/tx/index.js";
import { IDENTITY_BLUEPRINT_PATH, REPO_ROOT, TEST_IDENTITY_HASH } from "../fixtures/identity-builders/blueprint.js";

interface BlueprintFile {
  validators: Array<{ title: string; hash: string; compiledCode: string; parameters?: unknown[] }>;
}

const readJson = (path: string): BlueprintFile => JSON.parse(readFileSync(path, "utf8"));

/** Header byte and payload of a bech32 Shelley address. */
function addressBytes(address: string): Uint8Array {
  return Uint8Array.from(bech32.fromWords(bech32.decode(address, 1023).words));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("applyDataParameter / plutusV3ScriptHash", () => {
  // param-demo (tests/legacy-registry/fixtures): `validator gate(expected: Int, tag: ByteArray)`.
  // Expected: `aiken blueprint apply` (v1.1.21) with 182a (Int 42), then 426f6b (ByteArray "ok").
  const demo = readJson(join(REPO_ROOT, "tests/legacy-registry/fixtures/param-demo.plutus.json"))
    .validators.find((v) => v.title === "demo.gate.mint")!;
  const AIKEN_APPLIED =
    "587e010100332229800aba2aba1aab9eaab9dab9a9bad0039bae002488888896600264646644b30013370e900018041baa002" +
    "8992cc004cdc39bad300b004007899b8f006489026f6b008a5040206eb8c028c024dd5001459007180418048009804001180" +
    "400098029baa0088a4d13656400c4c102182a004c0103426f6b0001";

  it("gives the bytes of `aiken blueprint apply`, one parameter at a time", () => {
    const applied = applyDataParameter(
      applyDataParameter(demo.compiledCode, { kind: "int", value: 42n }),
      { kind: "bytes", hex: "6f6b" },
    );
    expect(applied).toBe(AIKEN_APPLIED);
    expect(plutusV3ScriptHash(applied)).toBe("6e1e13ac93e9a14276fc27c9693be687789d6d608921467ba6d2603b");
  });

  it("hashes blueprint code to the blueprint hash (legacy escrow and advert)", () => {
    for (const v of readJson(join(REPO_ROOT, "contracts/marketplace/plutus.json")).validators) {
      expect(plutusV3ScriptHash(v.compiledCode)).toBe(v.hash);
    }
  });

  it("refuses code that is not one CBOR byte string around a flat program", () => {
    expect(() => applyDataParameter("820102", { kind: "int", value: 1n })).toThrow(/CBOR byte string/);
    expect(() => applyDataParameter(`${demo.compiledCode}00`, { kind: "int", value: 1n })).toThrow(/length/);
    expect(() => applyDataParameter("4401010000", { kind: "int", value: 1n })).toThrow(/flat/);
  });
});

describe("loadIdentityBlueprint", () => {
  const path = IDENTITY_BLUEPRINT_PATH;
  const file = readJson(path);
  const escrow = file.validators.find((v) => v.title === "escrow.escrow.spend")!;
  const advert = file.validators.find((v) => v.title === "advert.advert.spend")!;
  const blueprint = loadIdentityBlueprint({ path, identityHash: TEST_IDENTITY_HASH });

  it("applies identity_hash to the new escrow: the address uses the applied hash", () => {
    expect(escrow.parameters).toHaveLength(1);
    expect(blueprint.escrowCompiledCode).toBe(applyDataParameter(escrow.compiledCode, { kind: "bytes", hex: TEST_IDENTITY_HASH }));
    expect(blueprint.escrowScriptHash).toBe(plutusV3ScriptHash(blueprint.escrowCompiledCode));
    expect(blueprint.escrowScriptHash).not.toBe(escrow.hash);
    const bytes = addressBytes(blueprint.escrowScriptAddress(1));
    expect(bytes[0]).toBe(0x71);
    expect(Buffer.from(bytes.subarray(1)).toString("hex")).toBe(blueprint.escrowScriptHash);
    expect(addressBytes(blueprint.escrowScriptAddress(0))[0]).toBe(0x70);
  });

  it("keeps the new advert as compiled (no parameter)", () => {
    expect(advert.parameters ?? []).toHaveLength(0);
    expect(blueprint.advertCompiledCode).toBe(advert.compiledCode);
    expect(blueprint.advertScriptHash).toBe(advert.hash);
    expect(Buffer.from(addressBytes(blueprint.advertScriptAddress(1)).subarray(1)).toString("hex")).toBe(advert.hash);
  });

  it("gives the identity address: Script(identity_hash), no stake credential", () => {
    const bytes = addressBytes(blueprint.identityScriptAddress(1));
    expect(bytes).toHaveLength(29);
    expect(bytes[0]).toBe(0x71);
    expect(Buffer.from(bytes.subarray(1)).toString("hex")).toBe(TEST_IDENTITY_HASH);
  });

  it("keeps the legacy blueprint apart: different hashes, the legacy loader unchanged", () => {
    const legacy = loadBlueprint();
    expect(legacy.escrowScriptHash).toBe("810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912");
    expect(legacy.advertScriptHash).toBe("9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da");
    expect(blueprint.escrowScriptHash).not.toBe(legacy.escrowScriptHash);
    expect(blueprint.advertScriptHash).not.toBe(legacy.advertScriptHash);
  });

  it("reads the identity hash from IDENTITY_POLICY_ID, and another hash gives another escrow", () => {
    const other = "0f".repeat(28);
    vi.stubEnv("IDENTITY_POLICY_ID", other.toUpperCase());
    const fromEnv = loadIdentityBlueprint({ path });
    expect(fromEnv.identityHash).toBe(other);
    expect(fromEnv.escrowScriptHash).not.toBe(blueprint.escrowScriptHash);
    expect(fromEnv.advertScriptHash).toBe(blueprint.advertScriptHash);
    expect(loadIdentityBlueprint({ path, identityHash: TEST_IDENTITY_HASH })).toBe(blueprint);
  });

  it("reads contracts/identity-marketplace/plutus.json by default", () => {
    const byDefault = loadIdentityBlueprint({ identityHash: TEST_IDENTITY_HASH });
    expect(byDefault.escrowScriptHash).toBe(blueprint.escrowScriptHash);
    expect(byDefault.advertScriptHash).toBe(blueprint.advertScriptHash);
  });

  it("refuses a missing or malformed identity hash and a missing file", () => {
    vi.stubEnv("IDENTITY_POLICY_ID", "");
    expect(() => loadIdentityBlueprint({ path })).toThrow(/IDENTITY_POLICY_ID/);
    expect(() => loadIdentityBlueprint({ path, identityHash: "abcd" })).toThrow(/56 hex/);
    expect(() => loadIdentityBlueprint({ path: join(REPO_ROOT, "no-such.json"), identityHash: TEST_IDENTITY_HASH }))
      .toThrow(/failed to read/);
  });
});

describe("escrow constants (Part 2 §6.1, §6.5)", () => {
  it("one hour of validity, 10,000 AP3X value cap, 10,005 AP3X input cap", () => {
    expect(MAX_RANGE_MS).toBe(3_600_000);
    expect(MAX_ESCROW_LOVELACE).toBe(10_000_000_000n);
    expect(ESCROW_INPUT_CAP_LOVELACE).toBe(10_005_000_000n);
  });
});
