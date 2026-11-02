// The facts that background jobs store (Part 2 Sections 8.5 and 8.6) and what they mean for a view
// of the record. A fact counts only while its inputs still apply to that view: a detection only for
// the endpoint that it checked, a domain only while the view still names it (endpoint host or party
// organisation), and a DID configuration check only while the key that signed it is still an
// assertion key of the view. Requests read these facts; they never fetch.

import { keyHash } from "../codec/keys.js";
import { recordText } from "../codec/text.js";
import { canonicalDid, legacyDid } from "../resolve/did.js";
import { PURPOSE } from "../resolve/document.js";
import type { FactsSubject, FetchedFacts, FetchedFactsProvider } from "../resolve/fetched.js";
import type { VectorFetched } from "../resolve/metadata.js";
import type { CurrentRecord } from "../resolve/resolver.js";
import type { Detection } from "./detect.js";
import type { AssertionKey, DomainCheck, LinkageSubject } from "./linkage.js";

/** A party organisation that names a domain. */
export interface OrganisationDomain {
  /** The organisation text of the record. */
  readonly text: string;
  readonly domain: string;
}

/** What the background checks of a record depend on, read from a view: the checks use the current view, and readers apply the facts to the view that they show. */
export interface FactInputs {
  /** The endpoint text, or null when the record has none. */
  readonly endpoint: string | null;
  /** Domains to check: the endpoint host first, then organisation domains in party order, without repeats. */
  readonly domains: readonly string[];
  readonly organisations: readonly OrganisationDomain[];
  readonly subject: LinkageSubject;
}

/** The facts of one record after its last background check. */
export interface RecordFacts {
  readonly vectorId: string;
  /** The record state that the check used (see `changeKey`). */
  readonly changeKey: string;
  /** POSIX milliseconds. */
  readonly checkedAt: number;
  readonly detection: Detection | null;
  readonly domains: readonly DomainCheck[];
}

/** The stored facts that still apply to a view. */
export interface CurrentFacts {
  /** The detection of the view's endpoint, or null. */
  readonly detection: Detection | null;
  /** Verified domains that the view still names, in the order of `FactInputs.domains`. */
  readonly verifiedDomains: readonly DomainCheck[];
  /** Organisation texts whose domain is verified. */
  readonly verifiedOrganisations: readonly string[];
}

export const NO_FACTS: CurrentFacts = { detection: null, verifiedDomains: [], verifiedOrganisations: [] };

/** A domain name: LDH labels, at least two, a top-level label that starts with a letter, at most 253 characters. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The domain that an organisation text or a host names, lowercase; null for a DID, an address or other text. */
export function domainOf(text: string): string | null {
  const lower = text.toLowerCase();
  return DOMAIN.test(lower) ? lower : null;
}

/** A record change restarts the checks: a new base or pending version, or another legacy controller key. */
export function changeKey(record: CurrentRecord): string {
  return [record.versionId, record.pending.join(","), record.legacyControllerKey ?? ""].join("|");
}

/** The endpoint text of a view, or null when it is empty or not readable text. */
export function endpointOf(record: FactsSubject): string | null {
  const { view } = record;
  const bytes = view.kind === "identity" ? view.endpoint : view.profile?.endpoint;
  return (bytes && recordText(bytes)) || null;
}

/** The assertion keys of the DID document of a view (Part 1 Section 8.1). */
export function assertionKeys(record: FactsSubject): Map<string, AssertionKey> {
  const keys = new Map<string, AssertionKey>();
  if (record.view.kind === "identity") {
    for (const k of record.view.keys) if (k.popValid && k.purposes & PURPOSE.assertion) keys.set(k.keyHash, { keyType: k.keyType, key: k.key });
  } else if (record.legacyControllerKey) {
    keys.set(keyHash(record.legacyControllerKey), { keyType: "Ed25519", key: record.legacyControllerKey });
  }
  return keys;
}

export function factInputs(record: FactsSubject, legacyPolicyId: string): FactInputs {
  const endpoint = endpointOf(record);
  let endpointHost: string | null = null;
  try {
    endpointHost = endpoint === null ? null : domainOf(new URL(endpoint).hostname);
  } catch {
    endpointHost = null;
  }
  const organisations: OrganisationDomain[] = [];
  if (record.view.kind === "identity") {
    for (const p of record.view.parties) {
      const text = p.organisation === null ? null : recordText(p.organisation);
      const domain = text === null ? null : domainOf(text);
      if (text !== null && domain !== null) organisations.push({ text, domain });
    }
  }
  const domains = [...new Set([...(endpointHost ? [endpointHost] : []), ...organisations.map((o) => o.domain)])];
  const dids = [canonicalDid(record.vectorId), ...(record.origin === "native" ? [] : [legacyDid(legacyPolicyId, record.vectorId)])];
  return { endpoint, domains, organisations, subject: { dids, assertionKeys: assertionKeys(record) } };
}

/** The stored facts that apply to the inputs. */
export function currentFacts(facts: RecordFacts | undefined, inputs: FactInputs): CurrentFacts {
  if (!facts) return NO_FACTS;
  const detection = facts.detection && facts.detection.endpoint === inputs.endpoint ? facts.detection : null;
  const verifiedDomains = inputs.domains
    .map((domain) => facts.domains.find((d) => d.domain === domain))
    .filter((d): d is DomainCheck => !!d?.verified && (d.method === "dnsTxt" || (d.keyHash !== null && inputs.subject.assertionKeys.has(d.keyHash))));
  const verified = new Set(verifiedDomains.map((d) => d.domain));
  return {
    detection,
    verifiedDomains,
    verifiedOrganisations: [...new Set(inputs.organisations.filter((o) => verified.has(o.domain)).map((o) => o.text))],
  };
}

/** The values for the resolver (Part 1 Section 8.2): verified domains, verified organisations, protocol and their fetch records. */
export function fetchedFacts(current: CurrentFacts): FetchedFacts | undefined {
  const protocol = current.detection?.protocol ?? undefined;
  const fetched: VectorFetched[] = [
    ...(protocol && current.detection?.fetched ? [current.detection.fetched] : []),
    ...current.verifiedDomains.flatMap((d) => (d.fetched ? [d.fetched] : [])),
  ];
  if (!protocol && !current.verifiedDomains.length) return undefined;
  return {
    alsoKnownAs: current.verifiedDomains.map((d) => `https://${d.domain}`),
    verifiedOrganisations: current.verifiedOrganisations,
    protocol,
    fetched,
  };
}

/** Facts in memory, by identifier. Each reader applies them to its own view of the record. */
export class FactsStore {
  private readonly facts = new Map<string, RecordFacts>();

  get(vectorId: string): RecordFacts | undefined {
    return this.facts.get(vectorId);
  }

  set(facts: RecordFacts): void {
    this.facts.set(facts.vectorId, facts);
  }

  /** Forgets an identifier that no longer resolves. */
  delete(vectorId: string): void {
    this.facts.delete(vectorId);
  }

  ids(): string[] {
    return [...this.facts.keys()];
  }

  /** The stored facts that apply to `inputs`, the reader's own view of the record. */
  current(vectorId: string, inputs: FactInputs): CurrentFacts {
    return currentFacts(this.facts.get(vectorId), inputs);
  }

  /** The resolver's FetchedFactsProvider: synchronous, it never fetches; it applies the facts to the view that the result shows. */
  readonly provider: FetchedFactsProvider = (subject, legacyPolicyId) => fetchedFacts(this.current(subject.vectorId, factInputs(subject, legacyPolicyId)));
}
