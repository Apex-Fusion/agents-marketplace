// The adoption allowlist of the deployment tool (Part 2 §3.4, §9.1): every identifier that the
// legacy policy minted before the cutoff slot, burned ones included, in leaf order, with the root
// of the shared tree. The roots equal the published vectors (contracts/identity-marketplace/vectors).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { allowlistLeaf } from "@marketplace/shared";
import { blake2b256, toHex, utf8 } from "../legacy-registry/harness/index.js";
import { allowlistFromMints, legacyMints, readAllowlistFile } from "../../contracts/identity-marketplace/deploy/allowlist.js";
import { main } from "../../contracts/identity-marketplace/deploy/cli.js";
import { MAINNET_LEGACY_POLICY, MAINNET_SYSTEM_START } from "../../contracts/identity-marketplace/deploy/network.js";
import { StateFile } from "../../contracts/identity-marketplace/deploy/state.js";
import { FakeIndex, FakeLedger, testIo } from "./ledger.js";

interface VectorTree {
  name: string;
  ids: string[];
  leaves: string[];
  root: string;
}

const VECTORS = JSON.parse(readFileSync(new URL("../../contracts/identity-marketplace/vectors/allowlist.json", import.meta.url), "utf8")) as { trees: VectorTree[] };
const id = (label: string): string => toHex(blake2b256(utf8(`allowlist test: ${label}`)));

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

describe("allowlist root", () => {
  test.each(VECTORS.trees.map((tree) => [tree.name, tree] as const))("%s: the root equals the published vector", async (_name, tree) => {
    const index = new FakeIndex(10_000, tree.ids.map((name, i) => ({ name, slot: 100 + i })));
    const { mints, cutoff } = await legacyMints(index, MAINNET_LEGACY_POLICY, MAINNET_SYSTEM_START, 5_000);
    const list = allowlistFromMints(MAINNET_LEGACY_POLICY, cutoff, mints);
    expect(list.root).toBe(tree.root);
    expect(list.count).toBe(tree.ids.length);
    expect(list.ids.map(allowlistLeaf)).toEqual(tree.leaves);
    expect([...list.ids].sort()).toEqual([...tree.ids].sort());
  });
});

describe("allowlist mints", () => {
  const before = id("before");
  const burned = id("burned");
  const lagging = id("not in the asset cache yet");
  const atCutoff = id("at the cutoff");
  const after = id("after the cutoff");
  const assets = [
    { name: before, slot: 10 },
    { name: burned, slot: 20, supply: 0n },
    { name: lagging, slot: 999, cached: false },
    { name: atCutoff, slot: 1_000 },
    { name: after, slot: 1_001, cached: false },
  ];

  test("in a slot before the cutoff: in, also when burned or missing from the asset cache; at or after the cutoff: out", async () => {
    const index = new FakeIndex(2_000, assets);
    const { mints, cutoff } = await legacyMints(index, MAINNET_LEGACY_POLICY, MAINNET_SYSTEM_START, 1_000);
    expect(index.lookups.sort()).toEqual([lagging, after].sort());
    const list = allowlistFromMints(MAINNET_LEGACY_POLICY, cutoff, mints);
    expect([...list.ids].sort()).toEqual([before, burned, lagging].sort());
    expect(list.cutoff_slot).toBe(1_000);
  });

  test("refusals: an index behind the cutoff, of another chain, a name that is not an identifier, no identifier", async () => {
    await expect(legacyMints(new FakeIndex(998, assets), MAINNET_LEGACY_POLICY, MAINNET_SYSTEM_START, 1_000)).rejects.toThrow(/must reach slot 999/);
    await expect(legacyMints(new FakeIndex(2_000, assets, MAINNET_SYSTEM_START + 1), MAINNET_LEGACY_POLICY, MAINNET_SYSTEM_START, 1_000)).rejects.toThrow(/wrong network/);
    await expect(legacyMints(new FakeIndex(2_000, [{ name: "abcd", slot: 1 }]), MAINNET_LEGACY_POLICY, MAINNET_SYSTEM_START, 1_000)).rejects.toThrow(/not a 32-byte identifier/);
    expect(() => allowlistFromMints(MAINNET_LEGACY_POLICY, 5, [{ id: before, slot: 10, supply: 1n }])).toThrow(/minted no identifier/);
  });

  test("allowlist --cutoff now: the tip of the index is the cutoff; the files and the state agree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-deploy-allowlist-"));
    directories.push(dir);
    const index = new FakeIndex(1_000, assets);
    const io = testIo(new FakeLedger(), index);
    expect(await main(["allowlist", "--network", "mainnet", "--dir", dir, "--cutoff", "now"], io, {})).toBe(0);
    const list = readAllowlistFile(join(dir, "allowlist.json"));
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "allowlist.json"), "utf8")))).toEqual(["cutoff_slot", "policy", "count", "ids", "root"]);
    expect(list).toMatchObject({ cutoff_slot: 1_000, policy: MAINNET_LEGACY_POLICY, count: 3 });
    expect(JSON.parse(readFileSync(join(dir, "allowlist-ids.json"), "utf8"))).toEqual(list.ids);
    expect(new StateFile(dir).load()).toMatchObject({ cutoff_slot: 1_000, legacy_hash: MAINNET_LEGACY_POLICY, legacy_root: list.root, allowlist: { count: 3 } });
    expect(io.lines.join("\n")).toMatch(/identifiers: 3 minted before the cutoff \(1 of them burned since\); 2 minted at or after the cutoff/);
    await expect(main(["allowlist", "--network", "mainnet", "--dir", dir, "--cutoff-slot", "1"], io, {})).rejects.toThrow(/minted no identifier/);
    await expect(main(["allowlist", "--network", "mainnet", "--dir", dir], io, {})).rejects.toThrow(/--cutoff-slot <slot> or --cutoff now/);
  });
});
