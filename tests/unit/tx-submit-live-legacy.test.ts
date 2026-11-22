/**
 * tx-submit-live-legacy.test.ts — buildSubmitTx() with LiveOgmiosProvider, legacy escrow layout.
 *
 * The live Submit builder (buildLiveTxForSubmit) spends the Claimed escrow output with the Submit redeemer. A failure of the build
 * (here: a failed evaluation by Ogmios) is a TxConstructionError that names the step (liveCbor.ts, rethrowAsTxError). The success case
 * (the Submitted datum, the receipt hash, the stamp) is the Submit step of the lifecycle case of tx-post-escrow-live.test.ts.
 *
 * The mock of Ogmios answers evaluateTransaction with the true index of the spend redeemer. The escrow input ("ff…") sorts
 * after the wallet input ("cc…"), so its index is 1. A mock that answers index 0 makes the set_exunits call of CML panic
 * with "unreachable" (the same note is in tx-claim-live.test.ts).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { buildSubmitTx } from "../../packages/shared/src/tx/escrow/submit.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildClaimedEscrowUtxo, DELIVER_BY } from "../fixtures/buyer-side/sample-escrow-utxos.js";
import { makeOgmiosProtocolParams } from "../fixtures/chain-codec/ogmios-protocol-parameters.js";

const ESCROW_TX_HASH = "f".repeat(64);
const ESCROW_INDEX = 1;
const RECEIPT_HASH = "a".repeat(64);
// 30 s before deliver_by: the live path reads the wall clock, and the fixture deadline is a fixed POSIX time.
const FAKE_NOW_MS = DELIVER_BY - 30_000;

afterEach(() => {
  vi.useRealTimers();
});

function rpcOk<T>(result: T) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) };
}

function ogmiosUtxo(txId: string, index: number, address: string, lovelace: number, datumHex?: string) {
  return { transaction: { id: txId }, index, address, value: { ada: { lovelace } }, datum: datumHex ?? null, datumHash: null, script: null };
}

const EVALUATION = rpcOk([{ validator: { purpose: "spend", index: 1 }, budget: { memory: 1_000_000, cpu: 500_000_000 } }]);
const EVALUATION_FAILS = { ok: true, json: async () => ({ jsonrpc: "2.0", error: { code: 3010, message: "Script execution failure" } }) };

/** buildSubmitTx for the Claimed escrow, on a fake Ogmios that answers evaluateTransaction with `evaluation`. */
async function submitOnFakeOgmios(evaluation: unknown) {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW_MS);

  const supplier = buildSupplierWalletKey();
  const claimed = buildClaimedEscrowUtxo();
  const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    switch (body.method) {
      case "queryLedgerState/protocolParameters":
        return rpcOk(makeOgmiosProtocolParams());
      case "queryLedgerState/utxo":
        return (body.params ?? {}).outputReferences
          ? rpcOk([ogmiosUtxo(ESCROW_TX_HASH, ESCROW_INDEX, claimed.address, 4_000_000, claimed.datumHex!)])
          : rpcOk([ogmiosUtxo("c".repeat(64), 0, supplier.address, 100_000_000)]); // wallet: fee, collateral and change
      case "queryNetwork/tip":
        return rpcOk({ slot: Math.floor((DELIVER_BY - 60_000) / 1000), id: "a".repeat(64) });
      case "evaluateTransaction":
        return evaluation;
      case "submitTransaction":
        return rpcOk({ transaction: { id: "d".repeat(64) } });
      default:
        return rpcOk({});
    }
  });
  const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: mockFetch as unknown as typeof globalThis.fetch });

  return {
    claimed,
    result: buildSubmitTx({
      chain,
      supplierKey: supplier,
      escrowRef: { txHash: ESCROW_TX_HASH, index: ESCROW_INDEX },
      receiptHash: RECEIPT_HASH,
    }),
  };
}

describe("buildSubmitTx() [live] — legacy layout", () => {
  it("refuses with a TxConstructionError that names the step when Ogmios fails the evaluation", async () => {
    const { result } = await submitOnFakeOgmios(EVALUATION_FAILS);

    await expect(result).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "spend-tx build failed",
      message: expect.stringContaining("Script execution failure"),
    });
  });
});
