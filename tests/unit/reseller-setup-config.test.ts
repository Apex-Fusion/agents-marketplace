import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadResellerSetupConfig } from "../../supplier/src/reseller/setupConfig.js";

const tempDirs: string[] = [];

async function configPath(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reseller-config-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({
    networkId: 1,
    ogmiosUrl: "https://ogmios.vector.mainnet.apexfusion.org",
    endpointUrl: "https://mp-suppliers-openrouter-reseller.vector.apexfusion.org",
    marketplaceModel: "vector/resold-model",
    openRouterModel: "provider/model",
    maxInputTokens: 4096,
    maxOutputTokens: 256,
    maxProcessingMs: 600000,
    inferenceTimeoutMs: 180000,
    priceLovelace: "200000",
    supplierBondLovelace: "1000000",
    buyerBondLovelace: "1000000",
    reserveUsd: "1.00",
    composeFile: "deploy/mainnet/docker-compose.supplier-openrouter-reseller.yml",
    ...overrides,
  }));
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("loadResellerSetupConfig", () => {
  it("accepts a bounded mainnet setup", async () => {
    const config = await loadResellerSetupConfig(await configPath());
    expect(config.inferenceTimeoutMs).toBe(180000);
    expect(config.endpointUrl).toBe(
      "https://mp-suppliers-openrouter-reseller.vector.apexfusion.org",
    );
  });

  it("rejects unsupported Ogmios transports", async () => {
    await expect(loadResellerSetupConfig(await configPath({
      ogmiosUrl: "wss://ogmios.example",
    }))).rejects.toThrow(/ogmiosUrl/);
  });

  it("rejects endpoint credentials, query data, and fragments", async () => {
    for (const endpointUrl of [
      "https://user:secret@example.com",
      "https://example.com?token=secret",
      "https://example.com#secret",
    ]) {
      await expect(loadResellerSetupConfig(await configPath({ endpointUrl })))
        .rejects.toThrow(/plain HTTPS origin/);
    }
  });

  it("requires settlement time outside the inference timeout", async () => {
    await expect(loadResellerSetupConfig(await configPath({
      inferenceTimeoutMs: 500000,
    }))).rejects.toThrow(/does not leave time/);
  });
});
