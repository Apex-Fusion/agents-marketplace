// GET /agents/{id}/credential (Part 2 Section 8.6): a W3C Verifiable Credential 2.0
// (https://www.w3.org/TR/vc-data-model-2.0/) issued by the gateway's DID, secured with JOSE as
// `application/vc+jwt` (VC-JOSE-COSE Section 3.1.1: ES256, typ vc+jwt, cty vc, kid = the DID URL of
// the issuer key, Section 4.1.1). It has one `credentialStatus` entry for each purpose of the
// gateway's Bitstring Status List (revocation and suspension; Bitstring Status List v1.0 Section 2.1).
// The subject holds only ledger facts, not the self-declared profile: the DID, the time of the first
// mint, the origin and, for a subagent, the parent. The gateway issues it only while the agent's
// effective status is Active (Part 1 Section 7.3, "Relying parties").

import { formatTime } from "../resolve/time.js";
import { gatewayDid, type M4Context } from "./context.js";
import { M4Error, NO_STORE, unavailable, type M4Response } from "./http.js";
import { signJws } from "./jose.js";
import { bitstringIndex, listPosition, type StatusLists } from "./status-lists.js";

/** Validity of an identity credential: it states facts that the controller can change. */
export const CREDENTIAL_VALIDITY_MS = 86_400_000;

export async function identityCredential(ctx: M4Context, statusLists: StatusLists, vectorId: string): Promise<M4Response> {
  const lookup = await ctx.records.currentRecord(vectorId);
  if (!lookup.found) throw new M4Error(404, "not_found", "the DID does not resolve to a registered agent");
  const record = lookup.record;
  if (record.deactivated) throw new M4Error(410, "deactivated", `the DID is deactivated (effective status ${record.effective.status})`);
  if (record.effective.status !== "active") {
    throw new M4Error(409, "agent_not_active", `the agent's effective status is ${record.effective.status}${record.effective.reason ? ` (${record.effective.reason})` : ""}`);
  }
  const index = await statusLists.indexOf(vectorId);
  if (index === null) throw unavailable("the agent has no status-list index yet");
  const { settings, keys } = ctx;
  const { n, p } = listPosition(index);
  const list = `${settings.baseUrl}/status/bsl/${n}`;
  const entry = (purpose: "revocation" | "suspension") => {
    const i = bitstringIndex(purpose, p);
    return { id: `${list}#${i}`, type: "BitstringStatusListEntry", statusPurpose: purpose, statusListIndex: String(i), statusListCredential: list };
  };
  const now = ctx.now();
  const lineage = record.view.kind === "identity" ? record.view.lineage : null;
  const credential = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "VectorAgentIdentityCredential"],
    issuer: gatewayDid(settings),
    validFrom: formatTime(now),
    validUntil: formatTime(now + CREDENTIAL_VALIDITY_MS),
    credentialSubject: {
      id: `did:vector:${vectorId}`,
      created: formatTime(record.created),
      origin: record.origin,
      ...(lineage?.type === "Subagent" ? { parent: `did:vector:${lineage.parent}` } : {}),
    },
    credentialStatus: [entry("revocation"), entry("suspension")],
  };
  const jwt = await signJws({ alg: "ES256", kid: keys.p256.kid, typ: "vc+jwt", cty: "vc" }, credential, keys.p256);
  return { status: 200, headers: { "content-type": "application/vc+jwt", ...NO_STORE }, body: jwt };
}
