/**
 * tx-claim-live.test.ts: buildClaimTx() on a LiveOgmiosProvider, legacy layout. The transaction is real Cardano CBOR from lucid.
 * The fake Ogmios and the pinned clock are in tests/fixtures/onchain-tx/legacy-live.ts. The mock-chain twin is tx-claim.test.ts.
 * The live path reads the deadline from the clock, not from the tip slot. The fake tip slot, read as slot x 1000, is far from the
 * clock, so the deadline case below fails when the builder reads the tip.
 */

import { describe, expect, it } from "vitest";
import { buildClaimTx } from "../../packages/shared/src/tx/escrow/claim.js";
import { TxConstructionError, type WalletKey } from "../../packages/shared/src/tx/types.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildOpenEscrowUtxo, DELIVER_BY } from "../fixtures/buyer-side/sample-escrow-utxos.js";
import { AP3X } from "../fixtures/identity-builders/world.js";
import { legacyLive, lucidWallet } from "../fixtures/onchain-tx/legacy-live.js";

const ESCROW_REF = buildOpenEscrowUtxo().ref;
const supplier = buildSupplierWalletKey();
const live = legacyLive(DELIVER_BY - 30_000);

/** The Open escrow of the fixtures with `changes` in its datum, and a supplier wallet with `funds`. */
function seedEscrow(changes: Partial<EscrowDatum> = {}, funds: bigint[] = [100n * AP3X]): void {
  const open = buildOpenEscrowUtxo();
  live.ogmios.add({ ...open, datumHex: encodeEscrowDatum({ ...decodeEscrowDatum(open.datumHex!), ...changes }) });
  live.ogmios.fund(lucidWallet(supplier), ...funds);
}

const claim = (supplierKey: WalletKey = supplier) =>
  buildClaimTx({ chain: live.ogmios.chain(), supplierKey, escrowRef: ESCROW_REF });

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(TxConstructionError);
  return (error as TxConstructionError).reason;
}

describe("buildClaimTx() [live]", () => {
  it("writes the Claimed datum into the continuing output", async () => {
    seedEscrow();

    const result = await claim();

    const claimed = encodeEscrowDatum({ ...decodeEscrowDatum(buildOpenEscrowUtxo().datumHex!), state: "Claimed" });
    expect(result.txCborHex).toContain(claimed);
  });

  it("refuses a key that is not the supplier", async () => {
    seedEscrow();
    expect(await reasonOf(claim(buildBuyerWalletKey()))).toBe("supplier signature mismatch");
  });

  it("refuses an escrow that is not Open", async () => {
    seedEscrow({ state: "Claimed" });
    expect(await reasonOf(claim())).toBe("wrong state");
  });

  it("refuses after deliver_by on the clock", async () => {
    seedEscrow({ deliver_by: Date.now() - 1 });
    expect(await reasonOf(claim())).toBe("claim after deliver_by");
  });

  it("refuses an escrow that is not on chain", async () => {
    live.ogmios.fund(lucidWallet(supplier), 100n * AP3X);
    expect(await reasonOf(claim())).toBe("escrow ref not on chain");
  });

  it("refuses a wallet without a UTxO for the collateral", async () => {
    seedEscrow({}, [1n * AP3X]);
    expect(await reasonOf(claim())).toContain("collateral");
  });
});
