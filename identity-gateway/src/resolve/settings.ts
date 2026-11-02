// Values the resolver depends on (Part 1 Section 4). The identity registry values are published
// at its deployment; until then `identity` is null, no identifier is an identity-registry record,
// and, without a cutoff slot, every legacy record resolves as a legacy record.

import { enterpriseScriptAddress } from "../codec/address.js";

export interface NetworkParameters {
  readonly networkMagic: number;
  /** POSIX seconds. */
  readonly systemStart: number;
  /** Seconds. */
  readonly slotLength: number;
  readonly securityParam: number;
}

export interface Registry {
  /** Policy ID = script hash, 56 lowercase hex characters. */
  readonly policyId: string;
  /** The enterprise address of the script. */
  readonly address: string;
}

export interface RegistrySettings {
  readonly identity: Registry | null;
  readonly legacy: Registry;
  /** Legacy identifiers minted in this slot or later do not resolve. Null: no cutoff is set yet. */
  readonly cutoffSlot: number | null;
}

export interface ResolverSettings {
  readonly network: NetworkParameters;
  readonly registries: RegistrySettings;
}

/** Vector mainnet (Part 1 Section 4): magic 764824073, system start 2025-08-29T16:40:00Z, 1 s slots, k = 2160. */
export const VECTOR_MAINNET: NetworkParameters = {
  networkMagic: 764_824_073,
  systemStart: 1_756_485_600,
  slotLength: 1,
  securityParam: 2160,
};

export const LEGACY_REGISTRY: Registry = {
  policyId: "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01",
  address: "addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42",
};

/** Part 1 Section 2: a transaction with 30 or more confirmations is confirmed. */
export const CONFIRMATION_DEPTH = 30;

/** Part 1 Section 5: subagent depth 1-4, so a record has at most four ancestors. */
export const MAX_ANCESTORS = 4;

const POLICY_ID = /^[0-9a-f]{56}$/;

/** A registry from its policy ID; a given address must be the enterprise address of that script. */
export function registryOf(policyId: string, address?: string): Registry {
  if (!POLICY_ID.test(policyId)) throw new Error(`a policy ID is 56 lowercase hex characters, got "${policyId}"`);
  const derived = enterpriseScriptAddress(policyId);
  if (address !== undefined && address !== derived) {
    throw new Error(`address ${address} is not the enterprise address of script ${policyId} (${derived})`);
  }
  return { policyId, address: derived };
}

export function checkRegistrySettings(settings: RegistrySettings): void {
  registryOf(settings.legacy.policyId, settings.legacy.address);
  if (settings.identity) {
    registryOf(settings.identity.policyId, settings.identity.address);
    if (settings.identity.policyId === settings.legacy.policyId) throw new Error("the identity and legacy registries must differ");
    if (settings.cutoffSlot === null) throw new Error("a deployed identity registry needs its cutoff slot");
  }
  if (settings.cutoffSlot !== null && !(Number.isSafeInteger(settings.cutoffSlot) && settings.cutoffSlot >= 0)) {
    throw new Error("the cutoff slot is a non-negative integer");
  }
}
