// The attestations that the resolver shows in the DID document metadata (`vectorProvenance`) and
// in the AI Catalog. An attestation is an output at the attestation address that holds exactly one
// token of the attestation policy (Part 2 Section 4.1). The gateway reads all of them in the
// background (attestation-index.ts) and filters them here for one agent at one ledger tip. The
// filter uses the ledger only: the outputs, the height of the tip and the block time of the tip.
// It uses no clock and no fetch, so resolvers that read the same outputs at the same tip show the
// same list.
//
// An attestation counts when all of these are true:
// - its newest output has CONFIRMATION_DEPTH confirmations. A new attestation, a revocation and a
//   contest are each a new output. So a new attestation shows after 30 confirmations, and an
//   attestation that was just revoked or contested does not show for 30 confirmations. A change
//   that reduces what is shown takes effect at once, and a change that adds takes effect after 30
//   confirmations (Part 1 Section 7.2). A withdrawal burns the token, and the output is gone at once;
// - its status is AttActive;
// - the block time of the tip is inside its range. `valid_from` and `valid_until` are inside it.
//
// The list shows the attestations that count, that are solicited (the subject's controller
// co-signed), and that are of the type provenance, software or environment: at most MAX_SHOWN,
// newest first. Any wallet can attest about any agent, so an unsolicited attestation could carry
// the text of a stranger into the metadata of another agent. `othersCount` is the number of the
// attestations that count and that the list does not show.
//
// The resolver does not fetch the document, does not verify the envelope, and does not check the
// standing of the issuer (Part 2 Section 4.3). A verifier does these checks with the token that
// `id` names.

import type { UnspentOutput } from "../chain/types.js";
import { decodeAttestationDatum, type AttestationDatum } from "../codec/attestation-datum.js";
import { multikey } from "../codec/keys.js";
import { hexToBytes } from "../codec/plutus-data.js";
import { recordText } from "../codec/text.js";
import { canonicalDid } from "./did.js";
import { compact, type VectorAttestation, type VectorAttestationType, type VectorProvenance } from "./metadata.js";
import { CONFIRMATION_DEPTH, type Registry } from "./settings.js";
import { formatTime } from "./time.js";

/** The most attestations that the list shows. */
export const MAX_SHOWN = 8;

/** The attestation types that the list shows, by their code in the datum. */
const SHOWN_TYPES: ReadonlyMap<number, VectorAttestationType> = new Map([
  [1, "provenance"],
  [2, "software"],
  [3, "environment"],
]);

/** A ledger tip as the filter needs it: its height, and its block time (POSIX ms). */
export interface ProvenanceTime {
  readonly tipHeight: number;
  readonly timeMs: number;
}

/** What the resolver and the renderings need from the background read of the attestations. */
export interface ProvenanceSource {
  /**
   * The attestations about one agent that count at the tip `at`, from the last read of the ledger.
   * Undefined when there is nothing to show, and when the list is too old for the tip: the member is
   * then left out. It never reads the ledger.
   */
  provenance(vectorId: string, at: ProvenanceTime): VectorProvenance | undefined;
}

/** An authentic attestation with a datum that decodes. */
export interface AttestationRow {
  /** The token name: 64 hex characters. */
  readonly id: string;
  /** The height of the block that holds the newest output of the token. */
  readonly blockHeight: number;
  readonly datum: AttestationDatum;
}

const TOKEN_NAME = /^[0-9a-f]{64}$/;

/**
 * The attestations among the outputs of a read. Each is authentic (Part 2 Section 4.1): exactly at the
 * attestation address, with exactly one token of the policy, in quantity 1, named by 32 bytes; and its
 * inline datum decodes. An output that is not, is left out and counted in `skipped`. A read in pages of
 * a set that changes can list one token twice: the output with the highest block height is the state
 * of the token, so the token counts once, by that output.
 */
export function attestationRows(outputs: readonly UnspentOutput[], registry: Registry): { readonly rows: AttestationRow[]; readonly skipped: number } {
  const byToken = new Map<string, AttestationRow>();
  let skipped = 0;
  for (const output of outputs) {
    const [token, ...others] = output.assets.filter((a) => a.policyId === registry.policyId);
    if (
      output.address !== registry.address ||
      token === undefined ||
      others.length > 0 ||
      token.quantity !== 1n ||
      !TOKEN_NAME.test(token.assetName) ||
      output.inlineDatum === null
    ) {
      skipped++;
      continue;
    }
    try {
      const row = { id: token.assetName, blockHeight: output.blockHeight, datum: decodeAttestationDatum(hexToBytes(output.inlineDatum)) };
      const known = byToken.get(row.id);
      if (known === undefined || row.blockHeight > known.blockHeight) byToken.set(row.id, row);
    } catch {
      skipped++;
    }
  }
  return { rows: [...byToken.values()], skipped };
}

/** Does the attestation count at this tip? (see the head of this file) */
function counts({ blockHeight, datum }: AttestationRow, at: ProvenanceTime): boolean {
  return (
    at.tipHeight - blockHeight >= CONFIRMATION_DEPTH &&
    datum.status.type === "Active" &&
    (datum.validFrom === null || at.timeMs >= datum.validFrom) &&
    (datum.validUntil === null || at.timeMs <= datum.validUntil)
  );
}

/** URL characters (RFC 3986): the text has no space, no control character and no character that a URL must escape. */
const URL_TEXT = /^https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/** The locator as text when it is an https URL without credentials; else undefined. */
function locatorOf(bytes: Uint8Array | null): string | undefined {
  const text = bytes === null ? null : recordText(bytes);
  if (text === null || !URL_TEXT.test(text)) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? text : undefined;
  } catch {
    return undefined;
  }
}

function shown({ id, datum }: AttestationRow, type: VectorAttestationType): VectorAttestation {
  return compact<VectorAttestation>({
    id,
    type,
    issuer: datum.issuerId === null ? `did:key:${multikey("Ed25519", datum.issuer)}` : canonicalDid(datum.issuerId),
    issuedAt: formatTime(datum.issuedAt),
    validUntil: datum.validUntil === null ? undefined : formatTime(datum.validUntil),
    solicited: true,
    contested: datum.contested === null ? undefined : true,
    digest: datum.digest,
    locator: locatorOf(datum.locator),
    envelope: datum.envelopeSig === null ? undefined : true,
  });
}

/**
 * The provenance of one agent at one tip, from the rows whose subject it is. Undefined when there is
 * nothing to show: the member is then left out of the metadata.
 */
export function provenanceOf(rows: readonly AttestationRow[], at: ProvenanceTime): VectorProvenance | undefined {
  const counted = rows.filter((row) => counts(row, at));
  const candidates = counted.flatMap((row) => {
    const type = SHOWN_TYPES.get(row.datum.attType);
    return type !== undefined && row.datum.solicited ? [{ row, type }] : [];
  });
  // Newest first by `issued_at`, then by the token name: the order is the same on every resolver.
  candidates.sort((a, b) => b.row.datum.issuedAt - a.row.datum.issuedAt || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  const attestations = candidates.slice(0, MAX_SHOWN).map(({ row, type }) => shown(row, type));
  const othersCount = counted.length - attestations.length;
  const provenance = compact<VectorProvenance>({ attestations, othersCount: othersCount > 0 ? othersCount : undefined });
  return Object.keys(provenance).length === 0 ? undefined : provenance;
}
