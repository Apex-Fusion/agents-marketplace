/**
 * The identity-marketplace blueprint for the builder tests: the committed
 * contracts/identity-marketplace/plutus.json (all validators, aiken v1.1.21),
 * with a stand-in identity hash applied to the new escrow.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";
import { loadIdentityBlueprint, type IdentityBlueprint } from "../../../packages/shared/src/tx/blueprint.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const IDENTITY_BLUEPRINT_PATH = join(REPO_ROOT, "contracts/identity-marketplace/plutus.json");

/** Stand-in identity hash: blake2b-224("did:vector test identity registry"), as in the identity-gateway vectors. */
export const TEST_IDENTITY_HASH = Buffer.from(
  blake2b(new TextEncoder().encode("did:vector test identity registry"), { dkLen: 28 }),
).toString("hex");

/** The real new escrow and advert, with the stand-in identity hash applied. */
export function testIdentityBlueprint(identityHash = TEST_IDENTITY_HASH): IdentityBlueprint {
  return loadIdentityBlueprint({ path: IDENTITY_BLUEPRINT_PATH, identityHash });
}
