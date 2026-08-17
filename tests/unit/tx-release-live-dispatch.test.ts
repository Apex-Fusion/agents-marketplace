/**
 * tx-release-live-dispatch.test.ts — buildReleaseTx() must route to the live
 * CBOR builder when the chain is a LiveOgmiosProvider, mirroring reclaim.ts.
 *
 * Parity gap under test: Release is the one escrow spend path still hardwired
 * to the synthetic testTxBody backend, which leaves Submitted-past-accept-window
 * escrows unresolvable on mainnet (sweeper parks them "for supplier Release").
 *
 * The live builder itself needs a real wallet + Ogmios and is exercised by the
 * mainnet fleet scripts like the other six builders; here it is mocked at the
 * module boundary and only the dispatch contract is asserted.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../packages/shared/src/tx/internal/liveCbor.js", () => ({
  buildLiveTxForRelease: vi.fn(async () => ({
    txCborHex: "live-cbor-sentinel",
    expectedTxHash: "live-hash-sentinel",
  })),
}));

import { buildReleaseTx } from "../../packages/shared/src/tx/escrow/release.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/escrow/accept.js";
import * as liveCbor from "../../packages/shared/src/tx/internal/liveCbor.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildSubmittedEscrowUtxo,
  SUBMITTED_AT,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

const RELEASE_THRESHOLD = SUBMITTED_AT + ACCEPT_WINDOW_MS;

/**
 * A stub that passes the `instanceof LiveOgmiosProvider` backend check without
 * opening any connection. Only the methods buildReleaseTx touches pre-dispatch
 * are provided. Tip slot is set past the accept window so that, while the
 * dispatch gap exists, the mock path completes and returns synthetic CBOR
 * (a clean assertion failure) instead of erroring on the window check.
 */
function fakeLiveChain(): LiveOgmiosProvider {
  const utxo = buildSubmittedEscrowUtxo();
  const fake = Object.create(LiveOgmiosProvider.prototype) as LiveOgmiosProvider;
  Object.assign(fake, {
    queryUtxo: async () => utxo,
    tip: async () => Math.floor((RELEASE_THRESHOLD + 60_000) / 1000),
    submitTx: async () => undefined,
  });
  return fake;
}

describe("buildReleaseTx() — live backend dispatch", () => {
  it("routes to buildLiveTxForRelease when chain is a LiveOgmiosProvider", async () => {
    const chain = fakeLiveChain();
    const supplier = buildSupplierWalletKey();
    const utxo = buildSubmittedEscrowUtxo();

    const result = await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref });

    expect(result.txCborHex).toBe("live-cbor-sentinel");
    expect(result.expectedTxHash).toBe("live-hash-sentinel");
    expect(liveCbor.buildLiveTxForRelease).toHaveBeenCalledTimes(1);
  });

  it("passes the escrow UTxO, decoded datum, and a real-clock tipMs to the live builder", async () => {
    const chain = fakeLiveChain();
    const supplier = buildSupplierWalletKey();
    const utxo = buildSubmittedEscrowUtxo();
    const before = Date.now();

    await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: utxo.ref });

    const mockFn = liveCbor.buildLiveTxForRelease as unknown as ReturnType<typeof vi.fn>;
    const args = mockFn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(args.escrowUtxo).toEqual(utxo);
    expect((args.datum as { state: string }).state).toBe("Submitted");
    expect(args.supplierKey).toBe(supplier);
    // Live path derives tipMs from the real clock (reclaim.ts parity), not
    // from the mock slot→ms mapping.
    expect(args.tipMs as number).toBeGreaterThanOrEqual(before);
  });
});
