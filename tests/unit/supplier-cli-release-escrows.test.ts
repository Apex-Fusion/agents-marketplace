/**
 * supplier-cli-release-escrows.test.ts — operator release flow behaviour.
 *
 * Discovery scans the escrow script address on chain (the indexer misses
 * Submit transitions and never updates spent rows); explicit --ref values
 * bypass the scan but are still chain-verified.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/index.js";
import {
  runReleaseEscrows,
  type ReleaseEscrowsConfig,
} from "../../supplier/src/cli/release-escrows.js";
import {
  buildOpenEscrowUtxo,
  buildSubmittedEscrowUtxo,
  submittedEscrowDatum,
  SUBMITTED_AT,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const PAST_WINDOW_NOW = SUBMITTED_AT + ACCEPT_WINDOW_MS + 60_000;

function config(overrides: Partial<ReleaseEscrowsConfig> = {}): ReleaseEscrowsConfig {
  return {
    escrowAddress: buildSubmittedEscrowUtxo().address,
    supplierKey: buildSupplierWalletKey(),
    refs: [],
    limit: Number.POSITIVE_INFINITY,
    awaitTimeoutMs: 1_000,
    dryRun: false,
    ...overrides,
  };
}

function chainAt(now: number, ...utxos: Utxo[]): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor(now / 1_000));
  for (const utxo of utxos) chain.seed(utxo);
  return chain;
}

describe("release escrows supplier CLI", () => {
  let output: string;

  beforeEach(() => {
    output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      output += String(line);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("releases a Submitted escrow found by scanning the script address", async () => {
    const escrow = buildSubmittedEscrowUtxo();
    const chain = chainAt(PAST_WINDOW_NOW, escrow);

    const result = await runReleaseEscrows(config(), { chain, now: () => PAST_WINDOW_NOW });

    expect(await chain.queryUtxo(escrow.ref)).toBeNull();
    expect(result).toEqual({ released: 1, skipped: 0, failed: 0, exitCode: 0 });
    expect(output).toContain("released=1 skipped=0 failed=0");
  });

  it("scans past Open escrows and Submitted escrows addressed to other suppliers", async () => {
    const mine = buildSubmittedEscrowUtxo();
    const open = buildOpenEscrowUtxo();
    const foreign: Utxo = {
      ...buildSubmittedEscrowUtxo(),
      ref: { txHash: "a".repeat(64), index: 0 },
      datumHex: encodeEscrowDatum({ ...submittedEscrowDatum(), supplier_pkh: "2".repeat(56) }),
    };
    const chain = chainAt(PAST_WINDOW_NOW, mine, open, foreign);

    const result = await runReleaseEscrows(config(), { chain, now: () => PAST_WINDOW_NOW });

    expect(result).toEqual({ released: 1, skipped: 0, failed: 0, exitCode: 0 });
    expect(await chain.queryUtxo(mine.ref)).toBeNull();
    expect(await chain.queryUtxo(open.ref)).toEqual(open);
    expect(await chain.queryUtxo(foreign.ref)).toEqual(foreign);
  });

  it("skips an explicit --ref whose UTxO is already spent", async () => {
    const escrow = buildSubmittedEscrowUtxo();
    const chain = chainAt(PAST_WINDOW_NOW);
    const supplier = buildSupplierWalletKey();

    const result = await runReleaseEscrows(
      config({ supplierKey: supplier, refs: [escrow.ref] }),
      { chain, now: () => PAST_WINDOW_NOW },
    );

    expect(result).toEqual({ released: 0, skipped: 1, failed: 0, exitCode: 0 });
    expect(await chain.queryUtxosByAddress(supplier.address)).toEqual([]);
    expect(output).toContain(
      `skip ${escrow.ref.txHash}#${escrow.ref.index} already-spent`,
    );
  });

  it("skips a Submitted escrow while the accept window remains open", async () => {
    const escrow = buildSubmittedEscrowUtxo();
    const now = SUBMITTED_AT + ACCEPT_WINDOW_MS - 1;
    const chain = chainAt(now, escrow);

    const result = await runReleaseEscrows(config(), { chain, now: () => now });

    expect(result).toEqual({ released: 0, skipped: 1, failed: 0, exitCode: 0 });
    expect(await chain.queryUtxo(escrow.ref)).toEqual(escrow);
    expect(output).toContain("window-open (releasable at");
  });

  it("does not build or submit transactions in dry-run mode", async () => {
    const escrow = buildSubmittedEscrowUtxo();
    const chain = chainAt(PAST_WINDOW_NOW, escrow);
    const supplier = buildSupplierWalletKey();

    const result = await runReleaseEscrows(
      config({ supplierKey: supplier, dryRun: true }),
      { chain, now: () => PAST_WINDOW_NOW },
    );

    expect(result).toEqual({ released: 0, skipped: 0, failed: 0, exitCode: 0 });
    expect(await chain.queryUtxo(escrow.ref)).toEqual(escrow);
    expect(await chain.queryUtxosByAddress(supplier.address)).toEqual([]);
  });

  it("releases only one of two candidates when limit is one", async () => {
    const first = buildSubmittedEscrowUtxo();
    const second: Utxo = {
      ...buildSubmittedEscrowUtxo(),
      ref: { txHash: "e".repeat(64), index: 3 },
    };
    const chain = chainAt(PAST_WINDOW_NOW, first, second);

    const result = await runReleaseEscrows(config({ limit: 1 }), {
      chain,
      now: () => PAST_WINDOW_NOW,
    });

    expect(result).toEqual({ released: 1, skipped: 0, failed: 0, exitCode: 0 });
    expect([await chain.queryUtxo(first.ref), await chain.queryUtxo(second.ref)].filter((u) => u === null)).toHaveLength(1);
  });
});
