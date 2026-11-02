// Values that depend on a fetch (Part 1 Sections 8.1, 8.2 and 9): verified domains, verified
// organisations and the detected protocol. Background jobs fetch them (Part 2 Sections 8.5 and 8.6);
// a resolution only reads what they stored, so the provider is synchronous.

import type { Origin } from "./history.js";
import type { VectorFetched } from "./metadata.js";
import type { RecordView } from "./view.js";

export interface FetchedFacts {
  /** `alsoKnownAs`: https URLs of domains whose link to the DID was verified. */
  readonly alsoKnownAs?: readonly string[];
  /** Party organisation identifiers (the text of the record) whose link to the DID was verified. */
  readonly verifiedOrganisations?: readonly string[];
  /** The protocol detected at the endpoint. */
  readonly protocol?: "a2a" | "mcp" | "web";
  /** The URL, fetch time and SHA-256 of each fetch that these values depend on. */
  readonly fetched?: readonly VectorFetched[];
}

/** The view that stored facts are applied to: a fact counts only while its inputs still apply to it. */
export interface FactsSubject {
  readonly vectorId: string;
  readonly origin: Origin;
  readonly view: RecordView;
  /** Legacy views: the key that the legacy key search found; else null. */
  readonly legacyControllerKey: string | null;
}

/**
 * The stored facts that apply to a view of an identifier, or undefined when none apply.
 * `legacyPolicyId` names the legacy DID form of the identifier.
 */
export type FetchedFactsProvider = (subject: FactsSubject, legacyPolicyId: string) => FetchedFacts | undefined;
