/**
 * The Module-1 manifest that the module deployment tool writes
 * (vector-agent-modules, Module-1/scripts). The seal and the check read:
 *
 * - `hashes.identity_party`: M1, the hash of Module-1 `identity_party`;
 * - `identity.{identity_hash, identity_ref, config_policy, config_holder}`:
 *   the identity values that Module-1 was built against;
 * - `identity_party_ref`: the reference script of `identity_party`;
 * - `network`, when present.
 */

import { readFileSync } from "node:fs";
import { DeployError } from "./network.js";
import { parseRef, refText, type Deployment } from "./state.js";

export interface Module1Manifest {
  path: string;
  /** M1: 56 lowercase hex characters, not the all-zero placeholder. */
  m1: string;
  identity: { identity_hash?: unknown; identity_ref?: unknown; config_policy?: unknown; config_holder?: unknown };
  /** The reference UTxO of `identity_party`, when the manifest has it. */
  identityPartyRef: string | null;
  network: string | null;
}

export function readModule1Manifest(path: string): Module1Manifest {
  let parsed: { hashes?: { identity_party?: unknown }; identity?: Module1Manifest["identity"]; identity_party_ref?: unknown; network?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch (error) {
    throw new DeployError(`cannot read the Module-1 manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const m1 = parsed.hashes?.identity_party;
  if (typeof m1 !== "string" || !/^[0-9a-f]{56}$/.test(m1)) {
    throw new DeployError(`${path}: hashes.identity_party (M1) must be a 28-byte script hash as 56 lowercase hex characters, not ${JSON.stringify(m1)}`);
  }
  if (/^0+$/.test(m1)) throw new DeployError(`${path}: hashes.identity_party is the all-zero placeholder`);
  if (typeof parsed.identity !== "object" || parsed.identity === null) throw new DeployError(`${path} has no identity object`);
  const ref = parsed.identity_party_ref;
  return {
    path,
    m1,
    identity: parsed.identity,
    identityPartyRef: typeof ref === "string" && ref !== "" ? refText(parseRef(ref, `${path}: identity_party_ref`)) : null,
    network: typeof parsed.network === "string" ? parsed.network : null,
  };
}

/**
 * The identity values in which the manifest and the plan differ. The
 * manifest must name the plan's identity hash, configuration policy and
 * configuration holder; its identity reference, when it has one, must be the
 * published one.
 */
export function manifestDifferences(state: Deployment, manifest: Module1Manifest): string[] {
  const differences: string[] = [];
  const expected = { identity_hash: state.identity_hash, config_policy: state.config_policy, config_holder: state.config_holder };
  for (const [name, value] of Object.entries(expected)) {
    const given = manifest.identity[name as keyof typeof expected];
    if (given !== value) differences.push(`identity.${name} is ${JSON.stringify(given)}, the plan has ${JSON.stringify(value)}`);
  }
  const ref = manifest.identity.identity_ref;
  if (ref !== undefined && ref !== null && ref !== "" && state.refs.identity !== undefined && ref !== state.refs.identity) {
    differences.push(`identity.identity_ref is ${JSON.stringify(ref)}, the published identity reference script is ${state.refs.identity}`);
  }
  if (manifest.network !== null && manifest.network !== state.network) differences.push(`network is ${manifest.network}, the plan is for ${state.network}`);
  return differences;
}
