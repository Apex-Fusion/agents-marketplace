// Runtime configuration from the environment. Every value has a public default except the identity
// registry values (published at its deployment) and KOIOS_TOKEN (optional, never logged).

import { LEGACY_REGISTRY, VECTOR_MAINNET, checkRegistrySettings, registryOf, type ResolverSettings } from "./resolve/settings.js";
import { parseVersionTime } from "./resolve/time.js";

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly koiosUrl: string;
  readonly koiosToken: string | undefined;
  readonly ogmiosUrl: string;
  readonly resolver: ResolverSettings;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const text = env[name];
  if (text === undefined || text === "") return fallback;
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative integer, got "${text}"`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be in [${min}, ${max}], got ${text}`);
  return value;
}

/** GENESIS_SYSTEM_START: YYYY-MM-DDThh:mm:ssZ or POSIX seconds. */
function systemStart(env: NodeJS.ProcessEnv): number {
  const text = env.GENESIS_SYSTEM_START;
  if (text === undefined || text === "" || /^\d+$/.test(text)) return integer(env, "GENESIS_SYSTEM_START", VECTOR_MAINNET.systemStart);
  const ms = parseVersionTime(text);
  if (ms === null) throw new Error(`GENESIS_SYSTEM_START must be YYYY-MM-DDThh:mm:ssZ or POSIX seconds, got "${text}"`);
  return ms / 1000;
}

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const identityPolicy = env.IDENTITY_POLICY_ID || undefined;
  if (!identityPolicy && env.IDENTITY_ADDRESS) throw new Error("IDENTITY_ADDRESS needs IDENTITY_POLICY_ID");
  const resolver: ResolverSettings = {
    network: {
      networkMagic: integer(env, "GENESIS_NETWORK_MAGIC", VECTOR_MAINNET.networkMagic),
      systemStart: systemStart(env),
      slotLength: integer(env, "GENESIS_SLOT_LENGTH", VECTOR_MAINNET.slotLength, 1),
      securityParam: integer(env, "GENESIS_SECURITY_PARAM", VECTOR_MAINNET.securityParam, 1),
    },
    registries: {
      identity: identityPolicy ? registryOf(identityPolicy, env.IDENTITY_ADDRESS || undefined) : null,
      legacy: registryOf(env.LEGACY_POLICY_ID || LEGACY_REGISTRY.policyId, env.LEGACY_ADDRESS || undefined),
      cutoffSlot: env.CUTOFF_SLOT ? integer(env, "CUTOFF_SLOT", 0) : null,
    },
  };
  checkRegistrySettings(resolver.registries);
  return {
    host: env.HOST || "127.0.0.1",
    port: integer(env, "PORT", 8080, 0, 65535),
    koiosUrl: env.KOIOS_URL || "https://v2.koios.vector.mainnet.apexfusion.org/api/v1",
    koiosToken: env.KOIOS_TOKEN || undefined,
    ogmiosUrl: env.OGMIOS_URL || "wss://ogmios.vector.mainnet.apexfusion.org",
    resolver,
  };
}
