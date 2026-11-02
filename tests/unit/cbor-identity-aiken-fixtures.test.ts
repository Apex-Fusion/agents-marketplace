/**
 * Byte parity with the Aiken types (contracts/identity-marketplace).
 *
 * contracts/identity-marketplace/fixtures/cbor-fixtures.json holds
 * cbor.serialise(value) of sample values of each on-chain type. Every fixture
 * must decode with the TypeScript codec of its type and encode back to the
 * same bytes. A fixture of a type without a codec here fails the test.
 *
 * IDENTITY_CBOR_FIXTURES can name another copy of the file.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeAdvertRedeemer, decodeAttestationDatum, decodeAttestationMint, decodeAttestationSpend, decodeDelegationDatum,
  decodeDelegationMint, decodeEscrowRedeemer, decodeIdentityAdvertDatum, decodeIdentityDatum, decodeIdentityEscrowDatum,
  decodeIdentityMint, decodeIdentitySpend, decodeLegacyDatum, decodeVaultDatum, decodeVaultSpend, encodeAdvertRedeemer,
  encodeAttestationDatum, encodeAttestationMint, encodeAttestationSpend, encodeDelegationDatum, encodeDelegationMint,
  encodeEscrowRedeemer, encodeIdentityAdvertDatum, encodeIdentityDatum, encodeIdentityEscrowDatum, encodeIdentityMint,
  encodeIdentitySpend, encodeLegacyDatum, encodeVaultDatum, encodeVaultSpend, vaultDatumFromData,
} from "../../packages/shared/src/cbor/index.js";
import { utf8FromHex } from "../../packages/shared/src/identity/index.js";

interface Fixture { type: string; cbor: string; diagnostic: string }

const FIXTURE_PATH = process.env.IDENTITY_CBOR_FIXTURES
  ?? new URL("../../contracts/identity-marketplace/fixtures/cbor-fixtures.json", import.meta.url).pathname;

/** Round trip: decode with the type's codec, then encode the decoded value. */
const CODECS: Record<string, (hex: string) => string> = {
  "vector_identity/types.IdentityDatum": (hex) => encodeIdentityDatum(decodeIdentityDatum(hex)),
  "vector_identity/types.LegacyDatum": (hex) => encodeLegacyDatum(decodeLegacyDatum(hex)),
  "vector_identity/redeemers.IdentityMint": (hex) => encodeIdentityMint(decodeIdentityMint(hex)),
  "vector_identity/redeemers.IdentitySpend": (hex) => encodeIdentitySpend(decodeIdentitySpend(hex)),
  "identity_marketplace/types.AttestationDatum": (hex) => encodeAttestationDatum(decodeAttestationDatum(hex)),
  "identity_marketplace/types.AttestationMint": (hex) => encodeAttestationMint(decodeAttestationMint(hex)),
  "identity_marketplace/types.AttestationSpend": (hex) => encodeAttestationSpend(decodeAttestationSpend(hex)),
  "identity_marketplace/types.DelegationDatum": (hex) => encodeDelegationDatum(decodeDelegationDatum(hex)),
  "identity_marketplace/types.DelegationMint": (hex) => encodeDelegationMint(decodeDelegationMint(hex)),
  "identity_marketplace/types.VaultDatum": (hex) => encodeVaultDatum(decodeVaultDatum(hex)),
  "identity_marketplace/types.VaultSpend": (hex) => encodeVaultSpend(decodeVaultSpend(hex)),
  "identity_marketplace/types.EscrowDatum": (hex) => encodeIdentityEscrowDatum(decodeIdentityEscrowDatum(hex)),
  "identity_marketplace/types.EscrowRedeemer": (hex) => encodeEscrowRedeemer(decodeEscrowRedeemer(hex)),
  "identity_marketplace/types.AdvertDatum": (hex) => encodeIdentityAdvertDatum(decodeIdentityAdvertDatum(hex)),
  "identity_marketplace/types.AdvertRedeemer": (hex) => encodeAdvertRedeemer(decodeAdvertRedeemer(hex)),
};

const fixtures: Record<string, Fixture> | null = existsSync(FIXTURE_PATH)
  ? (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { fixtures: Record<string, Fixture> }).fixtures
  : null;

function fixture(name: string): Fixture {
  const found = fixtures?.[name];
  if (!found) throw new Error(`fixture ${name} is missing from ${FIXTURE_PATH}`);
  return found;
}

describe("Aiken CBOR fixtures — decode and re-encode byte for byte", () => {
  it("finds the fixture file", () => {
    expect(fixtures, `missing ${FIXTURE_PATH}; set IDENTITY_CBOR_FIXTURES to its path`).not.toBeNull();
    expect(Object.keys(fixtures ?? {}).length).toBeGreaterThanOrEqual(44);
  });

  it.skipIf(fixtures === null)("has a fixture for every codec", () => {
    const types = new Set(Object.values(fixtures ?? {}).map((entry) => entry.type));
    expect(Object.keys(CODECS).filter((type) => !types.has(type))).toEqual([]);
  });

  for (const [name, entry] of Object.entries(fixtures ?? {})) {
    it(`${name} (${entry.type})`, () => {
      const roundTrip = CODECS[entry.type];
      expect(roundTrip, `no TypeScript codec for ${entry.type}`).toBeDefined();
      expect(roundTrip!(entry.cbor)).toBe(entry.cbor);
    });
  }
});

describe("Aiken CBOR fixtures — decoded values", () => {
  it.skipIf(fixtures === null)("reads the full identity record", () => {
    const datum = decodeIdentityDatum(fixture("identity_datum_full").cbor);
    expect(datum.keys.map((key) => [key.keyType, key.purposes, key.pop === null])).toEqual([["Ed25519", 9, true], ["P256", 2, false]]);
    expect(datum.parties.map((party) => [party.role, party.signer.type, party.rights])).toEqual([
      ["Accountable", "KeyHash", 3], ["Responsible", "ControllerSet", 1], ["Accountable", "Script", 3],
    ]);
    expect(utf8FromHex(datum.parties[0]!.organisation!)).toBe("did:web:example.org");
    expect(datum.lineage).toEqual({ type: "Subagent", parent: "88".repeat(32), parentEpoch: 2, depth: 1 });
    expect(utf8FromHex(datum.name)).toBe("fixture-agent");
    expect(datum.capabilities.map(utf8FromHex)).toEqual(["ocr.extract.v1", "llm.text.generate.v1"]);
    expect(datum.status.type).toBe("Suspended");
    expect(datum.status.type === "Suspended" && datum.status.holds.map((hold) => [hold.by.type, hold.reason])).toEqual([
      ["ControllerSet", 6], ["Script", 64],
    ]);
  });

  it.skipIf(fixtures === null)("reads the tombstones", () => {
    expect(decodeIdentityDatum(fixture("identity_datum_revoked_tombstone").cbor).status).toEqual({
      type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: 1794441600000, invalidFrom: 1794355200000, successor: "99".repeat(32),
    });
    expect(decodeIdentityDatum(fixture("identity_datum_retired_tombstone").cbor).status).toEqual({ type: "Retired", at: 1795305600000, successor: null });
  });

  it.skipIf(fixtures === null)("reads the escrow refund to a vault and the agent identifier", () => {
    const datum = decodeIdentityEscrowDatum(fixture("escrow_datum_with_refund").cbor);
    expect(datum.state).toBe("Submitted");
    expect(datum.capability_id).toBe("ocr.extract.v1");
    expect(datum.agent_id).toBe("d7".repeat(32));
    expect(datum.refund?.address).toEqual({
      paymentCredential: { type: "Script", hash: "d8".repeat(28) },
      stakeCredential: { type: "Inline", credential: { type: "VerificationKey", hash: "d9".repeat(28) } },
    });
    expect(vaultDatumFromData(datum.refund!.datum!)).toEqual({ type: "Returned", owner: { type: "PrincipalKey", hash: "c1".repeat(28), organisation: null } });
    expect(decodeIdentityEscrowDatum(fixture("escrow_datum_without_refund").cbor).refund).toBeNull();
    expect(decodeEscrowRedeemer(fixture("escrow_redeemer_refund_revoked").cbor)).toEqual({ type: "RefundRevoked" });
  });

  it.skipIf(fixtures === null)("reads the advert, delegation, vault, attestation and redeemer values", () => {
    expect(decodeIdentityAdvertDatum(fixture("advert_datum").cbor).agent_id).toBe("e3".repeat(32));
    const delegation = decodeDelegationDatum(fixture("delegation_datum").cbor);
    expect(delegation.delegator).toEqual({ type: "Agent", id: "b1".repeat(32) });
    expect(delegation.actions.map(utf8FromHex)).toEqual(["marketplace.hire.v1", "ocr.*"]);
    expect(delegation.value).toEqual({ perTx: 10000000n, total: 100000000n, periodMs: 86400000 });
    expect(decodeVaultDatum(fixture("vault_datum_live").cbor)).toMatchObject({ type: "Live", spent: 25000000n, periodStart: 1793577600000 });
    const attestation = decodeAttestationDatum(fixture("attestation_datum_full").cbor);
    expect([attestation.solicited, attestation.status, attestation.links.map((link) => link.rel)]).toEqual([true, { type: "AttRevoked", at: 1796169600000, reason: 5 }, [0, 3]]);
    expect(decodeAttestationDatum(fixture("attestation_datum_minimal").cbor)).toMatchObject({ solicited: false, status: { type: "AttActive" }, links: [] });
    expect(decodeIdentitySpend(fixture("identity_spend_set_successor").cbor)).toEqual({ type: "SetSuccessor" });
    expect(decodeIdentitySpend(fixture("identity_spend_recover_init").cbor)).toEqual({ type: "RecoverInit", guardians: [0, 3] });
    expect(decodeIdentityMint(fixture("identity_mint_register").cbor)).toEqual({ type: "Register", seed: { txHash: "f1".repeat(32), index: 24 } });
  });
});
