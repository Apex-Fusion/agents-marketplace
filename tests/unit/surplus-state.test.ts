import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSurplusStateStore,
  type SurplusControllerState,
} from "../../supplier/src/surplus/state.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "surplus-state-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("FileSurplusStateStore", () => {
  it("writes a private durable completion record and reloads its sale evidence", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    const store = new FileSurplusStateStore(path);
    const state: SurplusControllerState = {
      version: 1,
      phase: "completed",
      offerId: "offer-1",
      model: "alpha-model",
      providerModelId: "vendor/alpha-model",
      tradeObservedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-08-27T10:00:05.000Z",
      settlement: {
        offerId: "offer-1",
        createdAt: "2026-08-27T10:00:03.000Z",
        sellerCostMicroUsd: 100,
        settlementStatus: "confirmed",
      },
    };

    await store.save(state);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(store.load()).resolves.toEqual(state);
  });

  it("rejects a state symlink instead of following it", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.json");
    const path = join(directory, "state.json");
    await writeFile(target, '{"version":1,"phase":"selecting"}\n', { mode: 0o600 });
    await symlink(target, path);

    await expect(new FileSurplusStateStore(path).load()).rejects.toThrow();
  });

  it("rejects an existing state file with broad permissions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    await writeFile(path, '{"version":1,"phase":"selecting"}\n', { mode: 0o600 });
    await chmod(path, 0o644);

    await expect(new FileSurplusStateStore(path).load())
      .rejects.toThrow("must not allow group or other access");
  });
});
