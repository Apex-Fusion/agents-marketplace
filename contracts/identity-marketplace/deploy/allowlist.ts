/**
 * The adoption allowlist (Part 2 §3.4, §9.1): every identifier that the
 * legacy registry minted in a slot before the cutoff slot, including the
 * identifiers whose token was burned later. The tree and its root come from
 * the shared helper (`buildAllowlistTree`, packages/shared/src/identity/allowlist.ts).
 *
 * Files in the state directory:
 * - `allowlist.json`: `cutoff_slot`, `policy`, `count`, `ids` and `root`. The
 *   `ids` are in leaf order: sorted by blake2b_256(id), the order of the
 *   leaves of the tree.
 * - `allowlist-ids.json`: the same `ids` as a plain JSON list, the file that
 *   VECTOR_IDENTITY_ALLOWLIST_URL of the MCP server serves.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowlistLeaf, buildAllowlistTree } from "@marketplace/shared";
import type { LegacyIndex } from "./chain.js";
import { DeployError } from "./network.js";

export interface AllowlistFile {
  cutoff_slot: number;
  policy: string;
  count: number;
  ids: string[];
  root: string;
}

export const ALLOWLIST_FILE = "allowlist.json";
export const ALLOWLIST_IDS_FILE = "allowlist-ids.json";

export interface LegacyMint {
  id: string;
  /** The slot of the block of the first mint. */
  slot: number;
  /** The supply that the asset cache of the index reports (0: burned), or null when the cache lags behind. */
  supply: bigint | null;
}

/**
 * The legacy mints that the index reports, with the slot of each first mint.
 * The asset table of the index is complete up to its tip; its asset cache
 * can lag, so an asset that the cache lacks gets the time of its first
 * transaction instead. Refuses an index of another chain (system start) or
 * one that has not indexed every block before the cutoff yet.
 */
export async function legacyMints(index: LegacyIndex, policy: string, expectedSystemStart: number | null, cutoffSlot: number | "now"): Promise<{ mints: LegacyMint[]; cutoff: number; tip: number }> {
  const [genesis, tip] = await Promise.all([index.genesis(), index.tipSlot()]);
  if (expectedSystemStart !== null && genesis.systemStart !== expectedSystemStart) {
    throw new DeployError(`${index.label} indexes a chain with system start ${genesis.systemStart}, not ${expectedSystemStart}: wrong network`);
  }
  const cutoff = cutoffSlot === "now" ? tip : cutoffSlot;
  if (cutoff > tip + 1) throw new DeployError(`${index.label} is at slot ${tip}; it must reach slot ${cutoff - 1} before the allowlist for cutoff ${cutoff} is complete`);
  const [names, cached] = await Promise.all([index.policyAssetNames(policy), index.policyAssets(policy)]);
  const known = new Set(names);
  const info = new Map(cached.map((asset) => [asset.name, asset]));
  for (const name of info.keys()) if (!known.has(name)) throw new DeployError(`${index.label}: the asset cache lists ${policy}.${name}, the asset list does not`);
  const mints: LegacyMint[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name)) throw new DeployError(`the legacy policy ${policy} has the asset name ${JSON.stringify(name)}, which is not a 32-byte identifier`);
    const asset = info.get(name);
    const time = asset?.firstMintTime ?? await index.firstMintTime(policy, name);
    const offset = time - genesis.systemStart;
    if (offset < 0 || offset % genesis.slotLength !== 0) throw new DeployError(`asset ${name}: first mint time ${time} is not a slot time`);
    mints.push({ id: name, slot: offset / genesis.slotLength, supply: asset?.supply ?? null });
  }
  return { mints, cutoff, tip };
}

/** The allowlist of the mints in a slot before `cutoffSlot`. */
export function allowlistFromMints(policy: string, cutoffSlot: number, mints: readonly LegacyMint[]): AllowlistFile {
  const ids = mints.filter((m) => m.slot < cutoffSlot).map((m) => m.id);
  if (ids.length === 0) throw new DeployError(`the legacy policy ${policy} minted no identifier before slot ${cutoffSlot}`);
  const tree = buildAllowlistTree(ids);
  const byLeaf = new Map(ids.map((id) => [allowlistLeaf(id), id]));
  return { cutoff_slot: cutoffSlot, policy, count: ids.length, ids: tree.leaves.map((leaf) => byLeaf.get(leaf)!), root: tree.root };
}

/** Reads `allowlist.json` and checks it: the root must be the root of its identifiers. */
export function readAllowlistFile(path: string): AllowlistFile {
  let file: AllowlistFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as AllowlistFile;
  } catch (error) {
    throw new DeployError(`cannot read the allowlist ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isSafeInteger(file.cutoff_slot) || file.cutoff_slot < 0) throw new DeployError(`${path}: cutoff_slot is not a slot`);
  if (typeof file.policy !== "string" || !/^[0-9a-f]{56}$/.test(file.policy)) throw new DeployError(`${path}: policy is not 56 hex characters`);
  if (!Array.isArray(file.ids)) throw new DeployError(`${path}: ids is not a list`);
  const root = buildAllowlistTree(file.ids).root;
  if (root !== file.root) throw new DeployError(`${path}: the identifiers give the root ${root}, not ${file.root}`);
  if (file.count !== file.ids.length) throw new DeployError(`${path}: count ${file.count} differs from the ${file.ids.length} identifiers`);
  return file;
}

/** Writes both allowlist files into `dir`; returns the path and the SHA-256 of `allowlist.json`. */
export function writeAllowlistFiles(dir: string, file: AllowlistFile): { path: string; sha256: string } {
  const body = `${JSON.stringify(file, null, 2)}\n`;
  const path = join(dir, ALLOWLIST_FILE);
  writeFileSync(path, body);
  writeFileSync(join(dir, ALLOWLIST_IDS_FILE), `${JSON.stringify(file.ids, null, 2)}\n`);
  return { path, sha256: createHash("sha256").update(body).digest("hex") };
}
