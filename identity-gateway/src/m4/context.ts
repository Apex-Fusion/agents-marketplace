// What the M4 services (Part 2 Section 8.6) share: settings, the gateway keys, the resolver core
// (everything that the gateway issues uses the view without options, Part 2 Section 8.4), the chain
// source (delegation records) and a clock.

import type { ChainSource } from "../chain/types.js";
import type { GatewayKeys } from "../keys/gateway-keys.js";
import type { RecordList } from "../resolve/records.js";
import type { CurrentLookup, StatusLookup } from "../resolve/resolver.js";
import type { Registry } from "../resolve/settings.js";

export interface M4Settings {
  /** Public origin of the gateway, for example `https://id.vector.apexfusion.org`. It is the RFC 8414 issuer. */
  readonly baseUrl: string;
  /** The gateway's own identifier (64 hex): its DID issues credentials and names its keys. */
  readonly gatewayId: string;
  /** SPIFFE trust domain: the host of `baseUrl` (Part 2 Section 8.1). */
  readonly trustDomain: string;
  /** The delegation contract (policy ID = script hash, and the delegation address); null when not deployed. */
  readonly delegation: Registry | null;
  /** How long a built status list (and the status-list index) is used before it is built again. */
  readonly statusListRefreshMs: number;
}

/** The resolver core functions that the M4 services use. `VectorResolver` implements them. */
export interface RecordSource {
  currentRecord(vectorId: string): Promise<CurrentLookup>;
  /** The effective status alone, without the legacy key search (status lists, token checks). */
  currentStatus(vectorId: string): Promise<StatusLookup>;
  listRecords(): Promise<RecordList>;
}

export interface M4Context {
  readonly settings: M4Settings;
  readonly keys: GatewayKeys;
  readonly records: RecordSource;
  readonly chain: ChainSource;
  /** POSIX milliseconds. */
  readonly now: () => number;
  /** Error log. Messages never contain tokens or key material. */
  readonly log: (message: string) => void;
}

export const tokenEndpoint = (settings: M4Settings): string => `${settings.baseUrl}/token`;
export const gatewayDid = (settings: M4Settings): string => `did:vector:${settings.gatewayId}`;
export const spiffeIdOf = (settings: M4Settings, vectorId: string): string => `spiffe://${settings.trustDomain}/agent/${vectorId}`;
/** Part 2 Section 5.4: the `sub` of a delegation token whose root delegator is a PrincipalKey. */
export const principalKeyIdOf = (settings: M4Settings, keyHash: string): string => `${settings.baseUrl}/principals/key/${keyHash}`;

/** Lifetime limit of subject tokens, client assertions, issued tokens and JWT-SVIDs (Part 2 Section 8.6). */
export const MAX_TOKEN_LIFETIME_S = 300;
/** Allowed clock difference when the gateway checks `iat`, `nbf` and `exp`. */
export const CLOCK_LEEWAY_S = 30;
