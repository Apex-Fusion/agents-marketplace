/**
 * The networks of the deployment tool: default endpoints and the values that
 * identify a network. Flags override environment variables, and environment
 * variables override the defaults.
 *
 * Both Vector networks use the same network magic and the mainnet address
 * tag (addresses start with `addr1`), so the tool identifies a network by its
 * system start (Part 1 §4). It compares the system start that Ogmios and
 * Koios report with the known value and stops on a difference.
 */

export type NetworkName = "mainnet" | "testnet";

/** Policy ID (= script hash) of the legacy registry on mainnet (Part 1 §4). */
export const MAINNET_LEGACY_POLICY = "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01";

/** Vector mainnet system start, 2025-08-29T16:40:00Z, in POSIX seconds (Part 1 §4). */
export const MAINNET_SYSTEM_START = 1_756_485_600;

/** One slot per second on both networks (Part 1 §4). */
export const SLOT_LENGTH_MS = 1000;

/** A refusal with a message for the operator; the CLI prints it without a stack trace. */
export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployError";
  }
}

export interface Network {
  name: NetworkName;
  /** The network ID of addresses and reward accounts: 1 on both Vector networks. */
  networkId: 1;
  ogmiosUrl: string;
  submitUrl: string;
  koiosUrl: string | null;
  koiosToken: string | null;
  /** The legacy registry policy of the allowlist. */
  legacyPolicy: string | null;
  /** System start in POSIX seconds, when the tool knows it. */
  systemStart: number | null;
}

const DEFAULTS: Record<NetworkName, Omit<Network, "koiosToken">> = {
  mainnet: {
    name: "mainnet",
    networkId: 1,
    ogmiosUrl: "https://ogmios.vector.mainnet.apexfusion.org",
    submitUrl: "https://submit.vector.mainnet.apexfusion.org/api/submit/tx",
    koiosUrl: "https://v2.koios.vector.mainnet.apexfusion.org/api/v1",
    legacyPolicy: MAINNET_LEGACY_POLICY,
    systemStart: MAINNET_SYSTEM_START,
  },
  testnet: {
    name: "testnet",
    networkId: 1,
    ogmiosUrl: "https://ogmios.vector.testnet.apexfusion.org",
    submitUrl: "https://submit.vector.testnet.apexfusion.org/api/submit/tx",
    koiosUrl: null,
    legacyPolicy: null,
    systemStart: null,
  },
};

/** The environment variables that override the endpoints (the names of the SDK `.env.example`). */
export const ENDPOINT_ENV = {
  ogmios: "VECTOR_OGMIOS_URL",
  submit: "VECTOR_SUBMIT_URL",
  koios: "VECTOR_KOIOS_URL",
  koiosToken: "VECTOR_KOIOS_TOKEN",
} as const;

export interface NetworkOverrides {
  ogmios?: string;
  submitUrl?: string;
  koios?: string;
  legacyPolicy?: string;
}

const nonEmpty = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());

/** An Ogmios URL for JSON-RPC over HTTP: a `ws://` or `wss://` URL becomes `http://` or `https://`. */
export function ogmiosHttpUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, "http$1://");
}

/** A Koios base URL that ends with `/api/v1`, from either form (with or without the path). */
export function koiosBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

export function resolveNetwork(name: string | undefined, overrides: NetworkOverrides, env: Record<string, string | undefined>): Network {
  if (name !== "mainnet" && name !== "testnet") throw new DeployError("--network must be mainnet or testnet");
  const base = DEFAULTS[name];
  const koios = nonEmpty(overrides.koios) ?? nonEmpty(env[ENDPOINT_ENV.koios]) ?? base.koiosUrl ?? undefined;
  const legacyPolicy = nonEmpty(overrides.legacyPolicy)?.toLowerCase() ?? base.legacyPolicy;
  if (legacyPolicy !== null && !/^[0-9a-f]{56}$/.test(legacyPolicy)) throw new DeployError("--legacy-policy must be 56 hex characters");
  return {
    ...base,
    ogmiosUrl: ogmiosHttpUrl(nonEmpty(overrides.ogmios) ?? nonEmpty(env[ENDPOINT_ENV.ogmios]) ?? base.ogmiosUrl),
    submitUrl: nonEmpty(overrides.submitUrl) ?? nonEmpty(env[ENDPOINT_ENV.submit]) ?? base.submitUrl,
    koiosUrl: koios === undefined ? null : koiosBaseUrl(koios),
    koiosToken: nonEmpty(env[ENDPOINT_ENV.koiosToken]) ?? null,
    legacyPolicy,
  };
}
