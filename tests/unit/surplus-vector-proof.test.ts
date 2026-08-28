import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSurplusMerkleBatch,
  canonicalizeSurplusSale,
  canonicalSurplusSaleJson,
  FileSurplusVectorProofLedger,
  hashSurplusSale,
  SURPLUS_SALE_PROOF_PROTOCOL,
  verifySurplusMerkleProof,
  type SurplusMerkleProof,
  type SurplusMerkleBatch,
  type SurplusSaleProofInput,
} from "../../supplier/src/surplus/vectorProof.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "surplus-vector-proof-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function sale(
  id: string,
  overrides: Partial<SurplusSaleProofInput> = {},
): SurplusSaleProofInput {
  return {
    id,
    offerId: "offer-1",
    model: "deepseek-v4-flash",
    createdAt: "2026-08-28T11:00:00.123Z",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    sellerCostMicroUsd: 83,
    effectiveInputUsdPer1m: 0.003972,
    effectiveOutputUsdPer1m: 0.007944,
    ...overrides,
  };
}

function proofFor(
  batch: SurplusMerkleBatch,
  saleId: string,
): SurplusMerkleProof {
  const leaf = batch.leaves.find((candidate) => candidate.sale.saleId === saleId);
  if (leaf === undefined) throw new Error(`Missing test leaf ${saleId}`);
  return {
    saleHash: leaf.saleHash,
    batchRoot: leaf.batchRoot,
    leafIndex: leaf.leafIndex,
    leafCount: leaf.leafCount,
    siblings: [...leaf.siblings],
  };
}

function changedHash(hash: string): string {
  return `${hash[0] === "0" ? "1" : "0"}${hash.slice(1)}`;
}

describe("Surplus Vector sale projection", () => {
  it("encodes the versioned leaf in the required field order and hashes its UTF-8 JSON", () => {
    const input = sale("sale-1");
    const canonical = canonicalizeSurplusSale(input);
    const json = canonicalSurplusSaleJson(canonical);

    expect(canonical).toEqual({
      protocol: SURPLUS_SALE_PROOF_PROTOCOL,
      saleId: "sale-1",
      offerId: "offer-1",
      model: "deepseek-v4-flash",
      createdAtEpochMs: Date.parse("2026-08-28T11:00:00.123Z"),
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      sellerCostMicroUsd: 83,
      effectiveInputUsdPer1m: "0.003972",
      effectiveOutputUsdPer1m: "0.007944",
    });
    expect(json).toBe(
      '{"protocol":"surplus-sale-proof-v1","saleId":"sale-1","offerId":"offer-1","model":"deepseek-v4-flash","createdAtEpochMs":1787914800123,"inputTokens":10,"outputTokens":2,"cacheReadTokens":3,"sellerCostMicroUsd":83,"effectiveInputUsdPer1m":"0.003972","effectiveOutputUsdPer1m":"0.007944"}',
    );
    expect(hashSurplusSale(input)).toBe(
      createHash("sha256").update(json, "utf8").digest("hex"),
    );
  });

  it("rejects sales that cannot produce an immutable canonical leaf", () => {
    expect(() => canonicalizeSurplusSale(sale("sale-1", { offerId: null })))
      .toThrow("offer id");
    expect(() => canonicalizeSurplusSale(sale("sale-1", { createdAt: null })))
      .toThrow("no creation time");
    expect(() => canonicalizeSurplusSale(sale("sale-1", { inputTokens: -1 })))
      .toThrow("non-negative safe integer");
    expect(() => canonicalizeSurplusSale(sale("bad\nid")))
      .toThrow("printable ASCII");
  });
});

describe("Surplus sale Merkle batches", () => {
  it("sorts by sale id and duplicates the final node at odd tree levels", () => {
    const batch = buildSurplusMerkleBatch([
      canonicalizeSurplusSale(sale("sale-c")),
      canonicalizeSurplusSale(sale("sale-a")),
      canonicalizeSurplusSale(sale("sale-b")),
    ]);

    expect(batch.count).toBe(3);
    expect(batch.firstSaleId).toBe("sale-a");
    expect(batch.lastSaleId).toBe("sale-c");
    expect(batch.leaves.map((leaf) => leaf.sale.saleId)).toEqual([
      "sale-a",
      "sale-b",
      "sale-c",
    ]);
    const last = batch.leaves[2];
    expect(last.siblings[0]).toBe(last.saleHash);
    for (const leaf of batch.leaves) {
      expect(verifySurplusMerkleProof(leaf.sale, leaf)).toBe(true);
    }

    const reordered = buildSurplusMerkleBatch([
      canonicalizeSurplusSale(sale("sale-b")),
      canonicalizeSurplusSale(sale("sale-c")),
      canonicalizeSurplusSale(sale("sale-a")),
    ]);
    expect(reordered.root).toBe(batch.root);
    expect(reordered.leaves).toEqual(batch.leaves);
  });

  it("rejects every material proof mutation", () => {
    const originalSale = sale("sale-a");
    const batch = buildSurplusMerkleBatch([
      canonicalizeSurplusSale(originalSale),
      canonicalizeSurplusSale(sale("sale-b")),
      canonicalizeSurplusSale(sale("sale-c")),
    ]);
    const proof = proofFor(batch, "sale-a");
    expect(verifySurplusMerkleProof(originalSale, proof)).toBe(true);

    const changedFields: SurplusSaleProofInput[] = [
      sale("sale-x"),
      sale("sale-a", { offerId: "offer-2" }),
      sale("sale-a", { model: "another-model" }),
      sale("sale-a", { createdAt: "2026-08-28T11:00:00.124Z" }),
      sale("sale-a", { inputTokens: 11 }),
      sale("sale-a", { outputTokens: 3 }),
      sale("sale-a", { cacheReadTokens: 4 }),
      sale("sale-a", { sellerCostMicroUsd: 84 }),
      sale("sale-a", { effectiveInputUsdPer1m: 0.003973 }),
      sale("sale-a", { effectiveOutputUsdPer1m: 0.007945 }),
    ];
    for (const changed of changedFields) {
      expect(verifySurplusMerkleProof(changed, proof)).toBe(false);
    }

    expect(verifySurplusMerkleProof(originalSale, {
      ...proof,
      siblings: [changedHash(proof.siblings[0]), ...proof.siblings.slice(1)],
    })).toBe(false);
    expect(verifySurplusMerkleProof(originalSale, {
      ...proof,
      leafIndex: 1,
    })).toBe(false);
    expect(verifySurplusMerkleProof(originalSale, {
      ...proof,
      batchRoot: changedHash(proof.batchRoot),
    })).toBe(false);
    expect(verifySurplusMerkleProof(originalSale, {
      ...proof,
      saleHash: changedHash(proof.saleHash),
    })).toBe(false);
  });
});

describe("FileSurplusVectorProofLedger", () => {
  it("persists intent before confirmation and never selects confirmed sales again", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "proofs", "ledger.json");
    let now = Date.parse("2026-08-28T12:00:00.000Z");
    const ledger = await FileSurplusVectorProofLedger.open(path, { now: () => now });

    expect(await ledger.ingestSales([
      sale("sale-c"),
      sale("sale-a"),
      sale("sale-b"),
      sale("sale-a"),
    ])).toEqual({ inserted: 3, duplicates: 1 });
    expect(ledger.selectUnprovedSales(2).map((item) => item.saleId)).toEqual([
      "sale-a",
      "sale-b",
    ]);

    const intent = await ledger.persistPendingBatch(["sale-b", "sale-a"]);
    expect(intent.leaves.map((leaf) => leaf.saleId)).toEqual(["sale-a", "sale-b"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const restarted = await FileSurplusVectorProofLedger.open(path, { now: () => now });
    expect(restarted.pendingBatchIntent()).toEqual(intent);
    expect(() => restarted.selectUnprovedSales()).toThrow(
      "pending Surplus proof batch must be resolved first",
    );
    await expect(restarted.createPendingBatch()).rejects.toThrow(
      "pending Surplus proof batch must be resolved first",
    );

    now += 1_000;
    const txHash = "AB".repeat(32);
    const confirmed = await restarted.confirmPendingBatch(intent.batchRoot, txHash);
    expect(confirmed.txHash).toBe(txHash.toLowerCase());
    for (const id of ["sale-a", "sale-b"]) {
      const proof = restarted.dashboardProof(id);
      expect(proof).toMatchObject({
        status: "confirmed",
        batchRoot: intent.batchRoot,
        txHash: txHash.toLowerCase(),
      });
      expect(verifySurplusMerkleProof(sale(id), {
        saleHash: proof!.saleHash,
        batchRoot: proof!.batchRoot!,
        leafIndex: proof!.leafIndex!,
        leafCount: intent.count,
        siblings: proof!.siblings,
      })).toBe(true);
    }

    const confirmedRestart = await FileSurplusVectorProofLedger.open(path);
    expect(confirmedRestart.selectUnprovedSales().map((item) => item.saleId))
      .toEqual(["sale-c"]);
    expect(confirmedRestart.confirmedBatchHistory()).toEqual([confirmed]);
  });

  it("deduplicates exact sales and rejects an immutable id conflict", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "ledger.json");
    const ledger = await FileSurplusVectorProofLedger.open(path);

    expect(await ledger.ingestSales([sale("sale-a")]))
      .toEqual({ inserted: 1, duplicates: 0 });
    expect(await ledger.ingestSales([sale("sale-a")]))
      .toEqual({ inserted: 0, duplicates: 1 });
    await expect(ledger.ingestSales([
      sale("sale-a", { sellerCostMicroUsd: 84 }),
    ])).rejects.toThrow("Conflicting Surplus sale id");
    expect(ledger.selectUnprovedSales()).toHaveLength(1);
  });

  it("records a safe failed attempt and makes its sales eligible for a later batch", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "ledger.json");
    let now = Date.parse("2026-08-28T12:00:00.000Z");
    const ledger = await FileSurplusVectorProofLedger.open(path, { now: () => now });
    await ledger.ingestSales([sale("sale-a"), sale("sale-b")]);
    const intent = await ledger.createPendingBatch();
    if (intent === null) throw new Error("Expected a pending test batch");

    now += 1_000;
    const failure = await ledger.failPendingBatch(intent.batchRoot, "submit");
    expect(failure).toEqual({
      batchRoot: intent.batchRoot,
      count: 2,
      firstSaleId: "sale-a",
      lastSaleId: "sale-b",
      stage: "submit",
      failedAt: "2026-08-28T12:00:01.000Z",
    });
    expect(ledger.dashboardProof("sale-a")).toMatchObject({
      status: "failed",
      batchRoot: intent.batchRoot,
      txHash: null,
      leafIndex: 0,
    });

    const restarted = await FileSurplusVectorProofLedger.open(path);
    expect(restarted.failedAttemptHistory()).toEqual([failure]);
    expect(restarted.selectUnprovedSales().map((item) => item.saleId)).toEqual([
      "sale-a",
      "sale-b",
    ]);
    const retry = await restarted.createPendingBatch();
    expect(retry?.batchRoot).toBe(intent.batchRoot);
    expect(restarted.dashboardProof("sale-a")?.status).toBe("pending");
  });

  it("stores only canonical sale fields and proof data", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "ledger.json");
    const ledger = await FileSurplusVectorProofLedger.open(path);
    const input = {
      ...sale("sale-a"),
      apiKey: "must-not-be-written",
      buyerAddress: "must-not-be-written",
    };

    await ledger.ingestSales([input]);

    const text = await readFile(path, "utf8");
    expect(text).not.toContain("must-not-be-written");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("buyerAddress");
  });

  it("rejects ledger symlinks on load and before an atomic write", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.json");
    const loadPath = join(directory, "load-ledger.json");
    await writeFile(
      target,
      '{"version":1,"sales":[],"pendingBatch":null,"confirmedBatches":[],"failedAttempts":[]}\n',
      { mode: 0o600 },
    );
    await symlink(target, loadPath);
    await expect(FileSurplusVectorProofLedger.open(loadPath)).rejects.toThrow();

    const writePath = join(directory, "write-ledger.json");
    const ledger = await FileSurplusVectorProofLedger.open(writePath);
    await symlink(target, writePath);
    await expect(ledger.ingestSales([sale("sale-a")])).rejects.toThrow(
      "wrong file type",
    );
    expect(await readFile(target, "utf8")).not.toContain("sale-a");
  });
});
