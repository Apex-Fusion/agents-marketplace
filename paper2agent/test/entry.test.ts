/**
 * entry.test.ts — the entry point of the Paper2Agent process always runs.
 *
 * The image starts it as `tsx paper2agent/src/index.ts <role>` (the ENTRYPOINT of paper2agent/Dockerfile) from the repository root,
 * and the package scripts start it as `tsx src/index.ts <role>` from the package directory. Both forms must start the role, so the
 * entry has no condition. A role that does not exist gives the usage line and exit code 1.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");

function start(cwd: string, entry: string, ...args: string[]) {
  return spawnSync(process.execPath, [TSX, entry, ...args], { cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "test" } });
}

describe("the entry point of the Paper2Agent process", () => {
  it.each([
    ["from the repository root, as the image starts it", ROOT, "paper2agent/src/index.ts"],
    ["from the package directory, as the package scripts start it", resolve(ROOT, "paper2agent"), "src/index.ts"],
  ])("gives the usage line and exit code 1 for a role that does not exist, %s", (_name, cwd, entry) => {
    const result = start(cwd, entry, "bogus");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: tsx paper2agent/src/index.ts <control|publisher>");
  });

  it("gives the usage line and exit code 1 when no role is given", () => {
    const result = start(ROOT, "paper2agent/src/index.ts");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: tsx paper2agent/src/index.ts <control|publisher>");
  });

  it("starts the role: a role with no configuration stops with the error of its configuration, not with the usage line", () => {
    for (const role of ["control", "publisher"]) {
      const result = start(ROOT, "paper2agent/src/index.ts", role);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("Usage: tsx paper2agent/src/index.ts");
      expect(result.stderr).toMatch(/PAPER2AGENT_/);
    }
  });
});
