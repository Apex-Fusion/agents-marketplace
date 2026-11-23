// Attestations for the provenance tests: the deployed attestation contract, a datum that the filter
// shows, and the unspent output that holds a datum.

import type { UnspentOutput } from "../../src/chain/types.js";
import { encodeAttestationDatum, type AttestationDatum } from "../../src/codec/attestation-datum.js";
import { registryOf } from "../../src/resolve/settings.js";
import { ed25519Key } from "./keys.js";
import { idOf, utf8 } from "./ledger.js";

/** The attestation contract on Vector mainnet (contracts/identity-marketplace/deploy/mainnet/deployment.json). */
export const ATTESTATION = registryOf("f07c644e042ead094cc501f443e03a8955dc1f4d0dcd5b387863e042", "addr1w8c8cezwqsh26z2vc5qlgslq82y4thqlf5xu6kec0p37qssut0y3q");

export const SUBJECT = idOf("attested agent");
export const ISSUER_ID = idOf("issuer agent");
export const DOCUMENT_DIGEST = idOf("attested document");
export const LOCATOR = "https://attestations.example.org/build/1.json";
/** The time of the tests, POSIX ms. */
export const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

/** The token name of the nth attestation: 64 hex characters. */
export const tokenName = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);

/** A solicited software attestation of a registered issuer, valid for a day after `NOW`, that an agent shows. */
export function attestationDatum(overrides: Partial<AttestationDatum> = {}): AttestationDatum {
  return {
    subject: SUBJECT,
    issuer: ed25519Key(11),
    issuerId: ISSUER_ID,
    attType: 2,
    format: 50,
    profile: null,
    digest: DOCUMENT_DIGEST,
    locator: utf8(LOCATOR),
    envelopeSig: "ab".repeat(64),
    issuedAt: NOW - 3_600_000,
    validFrom: null,
    validUntil: NOW + 86_400_000,
    solicited: true,
    status: { type: "Active" },
    contested: null,
    links: [],
    ...overrides,
  };
}

/** The output that holds the token `token` with this datum (typed, or raw CBOR hex), in the block `height`. */
export function attestationOutput(datum: AttestationDatum | string, height: number, token: string, overrides: Partial<UnspentOutput> = {}): UnspentOutput {
  return {
    txHash: `${token.slice(0, 62)}00`,
    outputIndex: 0,
    blockHeight: height,
    address: ATTESTATION.address,
    assets: [{ policyId: ATTESTATION.policyId, assetName: token, quantity: 1n }],
    inlineDatum: typeof datum === "string" ? datum : Buffer.from(encodeAttestationDatum(datum)).toString("hex"),
    ...overrides,
  };
}
