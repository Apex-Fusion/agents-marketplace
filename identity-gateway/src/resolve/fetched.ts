// Values that depend on a fetch (Part 1 Sections 8.1, 8.2 and 9): verified domains, verified
// organisations and the detected protocol. Background jobs fetch them (Part 2 Sections 8.5 and 8.6);
// a resolution only reads what they stored, so the provider is synchronous.

import type { VectorFetched } from "./metadata.js";

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

/** The stored facts for an identifier, or undefined when no job has verified anything for it. */
export type FetchedFactsProvider = (vectorId: string) => FetchedFacts | undefined;
