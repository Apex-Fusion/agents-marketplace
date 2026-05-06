/**
 * blueprint.test.ts — RED phase tests for packages/shared/src/tx/blueprint.ts
 *
 * loadBlueprint() reads contracts/marketplace/plutus.json and exposes:
 *   - advertScriptHash: 28-byte (56 hex char) hash
 *   - escrowScriptHash: 28-byte (56 hex char) hash
 *   - advertScriptAddress(networkId): bech32 address
 *   - escrowScriptAddress(networkId): bech32 address
 *
 * Known hashes from plutus.json:
 *   advert: "9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da"
 *   escrow: "810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912"
 *
 * These are 28-byte (56 hex char) strings — confirmed from plutus.json "hash" fields.
 */

import { describe, it, expect } from "vitest";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";

const ADVERT_SCRIPT_HASH = "9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da";
const ESCROW_SCRIPT_HASH = "810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912";

describe("loadBlueprint()", () => {
  it("returns without throwing", () => {
    expect(() => loadBlueprint()).not.toThrow();
  });

  describe("advertScriptHash", () => {
    it("returns the advert script hash from plutus.json", () => {
      const bp = loadBlueprint();
      expect(bp.advertScriptHash).toBe(ADVERT_SCRIPT_HASH);
    });

    it("is a 56-character lowercase hex string (28 bytes)", () => {
      const bp = loadBlueprint();
      expect(bp.advertScriptHash).toHaveLength(56);
      expect(bp.advertScriptHash).toMatch(/^[0-9a-f]{56}$/);
    });
  });

  describe("escrowScriptHash", () => {
    it("returns the escrow script hash from plutus.json", () => {
      const bp = loadBlueprint();
      expect(bp.escrowScriptHash).toBe(ESCROW_SCRIPT_HASH);
    });

    it("is a 56-character lowercase hex string (28 bytes)", () => {
      const bp = loadBlueprint();
      expect(bp.escrowScriptHash).toHaveLength(56);
      expect(bp.escrowScriptHash).toMatch(/^[0-9a-f]{56}$/);
    });
  });

  describe("advertScriptAddress(networkId)", () => {
    it("testnet (networkId=0) produces addr_test1... prefix", () => {
      const bp = loadBlueprint();
      const addr = bp.advertScriptAddress(0);
      expect(addr).toMatch(/^addr_test1/);
    });

    it("mainnet (networkId=1) produces addr1... prefix (no _test)", () => {
      const bp = loadBlueprint();
      const addr = bp.advertScriptAddress(1);
      expect(addr).toMatch(/^addr1/);
      expect(addr).not.toMatch(/^addr_test1/);
    });

    it("testnet and mainnet addresses are different", () => {
      const bp = loadBlueprint();
      expect(bp.advertScriptAddress(0)).not.toBe(bp.advertScriptAddress(1));
    });

    it("testnet address is a non-empty string", () => {
      const bp = loadBlueprint();
      const addr = bp.advertScriptAddress(0);
      expect(typeof addr).toBe("string");
      expect(addr.length).toBeGreaterThan(0);
    });
  });

  describe("escrowScriptAddress(networkId)", () => {
    it("testnet (networkId=0) produces addr_test1... prefix", () => {
      const bp = loadBlueprint();
      const addr = bp.escrowScriptAddress(0);
      expect(addr).toMatch(/^addr_test1/);
    });

    it("mainnet (networkId=1) produces addr1... prefix (no _test)", () => {
      const bp = loadBlueprint();
      const addr = bp.escrowScriptAddress(1);
      expect(addr).toMatch(/^addr1/);
      expect(addr).not.toMatch(/^addr_test1/);
    });

    it("testnet and mainnet addresses are different", () => {
      const bp = loadBlueprint();
      expect(bp.escrowScriptAddress(0)).not.toBe(bp.escrowScriptAddress(1));
    });

    it("advert and escrow addresses are different (distinct script hashes)", () => {
      const bp = loadBlueprint();
      expect(bp.advertScriptAddress(0)).not.toBe(bp.escrowScriptAddress(0));
      expect(bp.advertScriptAddress(1)).not.toBe(bp.escrowScriptAddress(1));
    });
  });
});
