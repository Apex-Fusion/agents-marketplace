/**
 * entry.test.ts — the entry point of the Paper2Agent process always runs.
 *
 * The image starts it as `tsx paper2agent/src/index.ts <role>` (the ENTRYPOINT of paper2agent/Dockerfile) from the repository root,
 * and the package scripts start it as `tsx src/index.ts <role>` from the package directory. Both forms must start the role, so the
 * entry has no condition. A role that does not exist gives the usage line and exit code 1.
 *
 * The cases run in this process: loading the entry runs `main`, and `main` starts the real role. One child process shows the
 * exit code of the entry at process level.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/run.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const USAGE = "Usage: tsx paper2agent/src/index.ts <control|publisher>";

const argv = process.argv;
beforeEach(() => {
  process.argv = [...argv];
  // A shell with settings of the roles must not change a case.
  for (const name of Object.keys(process.env)) if (name.startsWith("PAPER2AGENT_")) vi.stubEnv(name, undefined);
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
});

describe("the entry point of the Paper2Agent process", () => {
  it("gives the usage line and exit code 1 for a role that does not exist, as the image starts it", () => {
    const result = spawnSync(process.execPath, [TSX, "paper2agent/src/index.ts", "bogus"],
      { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { NODE_ENV: "test" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(USAGE);
  });

  it("runs main when it loads, with no condition: a role that does not exist gives the usage line", async () => {
    process.argv[2] = "bogus";
    await expect(import("../src/index.js")).rejects.toThrow(USAGE);
  });

  it.each([
    ["control", /loadPaperControlConfig: PAPER2AGENT_CONTROL_TOKEN/],
    ["publisher", /loadPaperPublisherConfig: PAPER2AGENT_/],
  ])("starts the role %s: with no configuration it stops with the error of its configuration, not with the usage line", async (role, configError) => {
    const failure: unknown = await main(role).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(configError);
    expect((failure as Error).message).not.toContain(USAGE);
  });
});
