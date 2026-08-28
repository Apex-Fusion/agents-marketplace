import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHistoricalSalesCsv } from "../../supplier/src/surplus/historyExport.js";

const HEADER =
  "request_id,settled_at,model,input_tokens,output_tokens,seller_earned_usd,settlement_status,settlement_type,tx_hash";

const directories: string[] = [];

async function csvFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "surplus-history-"));
  directories.push(directory);
  const path = join(directory, "sales.csv");
  await writeFile(path, content, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("loadHistoricalSalesCsv", () => {
  it("maps settled export rows onto publisher sales and skips unsettled rows", async () => {
    const baseTx = "0x" + "A".repeat(64);
    const path = await csvFile([
      HEADER,
      `"01SALE1","2026-08-28T07:39:33.869Z","deepseek-v4-flash","151204","805","0.000607","confirmed","onchain","${baseTx}"`,
      `"01SALE2","2026-08-28T07:39:22.308Z","deepseek-v4-flash","10","2","1.5","confirmed","onchain",""`,
      `"01SALE3","2026-08-28T07:39:48.036Z","deepseek-v4-flash","47257","1761","0.000202","accrued","credit",""`,
    ].join("\n"));

    const result = await loadHistoricalSalesCsv(path, "offer-1");

    expect(result.skippedUnsettled).toBe(1);
    expect(result.settledWithoutTx).toBe(1);
    expect(result.sales).toHaveLength(2);
    expect(result.sales[0]).toMatchObject({
      id: "01SALE1",
      offerId: "offer-1",
      model: "deepseek-v4-flash",
      settlementStatus: "confirmed",
      createdAt: "2026-08-28T07:39:33.869Z",
      createdAtMs: Date.parse("2026-08-28T07:39:33.869Z"),
      sellerCostMicroUsd: 607,
      inputTokens: 151_204,
      outputTokens: 805,
      cacheReadTokens: 0,
      effectiveInputUsdPer1m: 0,
      effectiveOutputUsdPer1m: 0,
      transactionHash: baseTx.toLowerCase(),
    });
    expect(result.sales[1]).toMatchObject({
      id: "01SALE2",
      sellerCostMicroUsd: 1_500_000,
      transactionHash: null,
    });
  });

  it("rejects an unexpected header, duplicate ids, and malformed rows", async () => {
    const wrongHeader = await csvFile("request_id,foo\n\"a\",\"b\"");
    await expect(loadHistoricalSalesCsv(wrongHeader, "offer-1")).rejects.toThrow(
      /header must be exactly/,
    );

    const duplicate = await csvFile([
      HEADER,
      `"01SAME","2026-08-28T07:39:33.869Z","m","1","1","0.1","confirmed","onchain",""`,
      `"01SAME","2026-08-28T07:39:33.869Z","m","1","1","0.1","confirmed","onchain",""`,
    ].join("\n"));
    await expect(loadHistoricalSalesCsv(duplicate, "offer-1")).rejects.toThrow(
      /repeats request_id/,
    );

    const badTx = await csvFile([
      HEADER,
      `"01SALE","2026-08-28T07:39:33.869Z","m","1","1","0.1","confirmed","onchain","0x123"`,
    ].join("\n"));
    await expect(loadHistoricalSalesCsv(badTx, "offer-1")).rejects.toThrow(
      /invalid tx_hash/,
    );

    const badTokens = await csvFile([
      HEADER,
      `"01SALE","2026-08-28T07:39:33.869Z","m","-4","1","0.1","confirmed","onchain",""`,
    ].join("\n"));
    await expect(loadHistoricalSalesCsv(badTokens, "offer-1")).rejects.toThrow(
      /input_tokens/,
    );

    await expect(loadHistoricalSalesCsv(badTokens, " ")).rejects.toThrow(
      /non-empty offer id/,
    );
  });
});
