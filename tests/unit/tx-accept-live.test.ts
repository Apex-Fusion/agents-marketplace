/**
 * tx-accept-live.test.ts: buildAcceptTx() on a LiveOgmiosProvider, legacy layout. The transaction is real Cardano CBOR from lucid.
 * The fake Ogmios and the pinned clock are in tests/fixtures/onchain-tx/legacy-live.ts. The mock-chain twin is tx-accept.test.ts.
 * The live path reads the accept window from the clock, not from the tip slot.
 */

import { describe, expect, it } from "vitest";
import { buildAcceptTx } from "../../packages/shared/src/tx/escrow/accept.js";
import { TxConstructionError, type WalletKey } from "../../packages/shared/src/tx/types.js";
import { ACCEPT_WINDOW_MS, MIN_UTXO_LOVELACE } from "../../packages/shared/src/tx/internal/constants.js";
import { pkhToEnterpriseAddress } from "../../packages/shared/src/tx/internal/pkhAddress.js";
import { inspectSignedTransaction, inspectSignedTransactionFinancials } from "../../packages/shared/src/tx/internal/signedTransaction.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildBuyerWalletKey, BUYER_PKH } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildSubmittedEscrowUtxo,
  ESCROW_SUPPLIER_PKH,
  PAYMENT_LOVELACE,
  SUBMITTED_AT,
  SUPPLIER_BOND,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";
import { AP3X, VECTOR_MAINNET_ZERO_TIME_MS } from "../fixtures/identity-builders/world.js";
import { legacyLive, lucidWallet } from "../fixtures/onchain-tx/legacy-live.js";

const ESCROW_REF = buildSubmittedEscrowUtxo().ref;
const buyer = buildBuyerWalletKey();
const live = legacyLive(SUBMITTED_AT + 60_000);

/** The Submitted escrow of the fixtures with `changes` in its datum, and a buyer wallet with `funds`. Returns the funds. */
function seedEscrow(changes: Partial<EscrowDatum> = {}, funds: bigint[] = [100n * AP3X]): Utxo[] {
  const submitted = buildSubmittedEscrowUtxo();
  live.ogmios.add({ ...submitted, datumHex: encodeEscrowDatum({ ...decodeEscrowDatum(submitted.datumHex!), ...changes }) });
  return live.ogmios.fund(lucidWallet(buyer), ...funds);
}

const accept = (buyerKey: WalletKey = buyer, excludeInputs?: Utxo["ref"][]) =>
  buildAcceptTx({ chain: live.ogmios.chain(), buyerKey, escrowRef: ESCROW_REF, excludeInputs });

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(TxConstructionError);
  return (error as TxConstructionError).reason;
}

describe("buildAcceptTx() [live]", () => {
  it("spends the escrow, pays the supplier the payment and its bond, and pays the buyer its bond", async () => {
    seedEscrow();

    const { txCborHex } = await accept();

    const { inputs, outputs } = inspectSignedTransactionFinancials(txCborHex);
    expect(inputs).toContainEqual(ESCROW_REF);
    expect(outputs).toContainEqual({ address: pkhToEnterpriseAddress(ESCROW_SUPPLIER_PKH, 1), lovelace: PAYMENT_LOVELACE + SUPPLIER_BOND });
    // The buyer bond (1 AP3X) is below the output floor, so the builder pays the floor.
    expect(outputs).toContainEqual({ address: pkhToEnterpriseAddress(BUYER_PKH, 1), lovelace: MIN_UTXO_LOVELACE });
    expect(outputs.filter((output) => output.datumHex !== undefined)).toEqual([]);
    // The validity range ends with the accept window: submitted_at + ACCEPT_WINDOW_MS, on the slot clock.
    expect(inspectSignedTransaction(txCborHex).validUntilSlot).toBe((SUBMITTED_AT + ACCEPT_WINDOW_MS - VECTOR_MAINNET_ZERO_TIME_MS) / 1000);
  });

  it("never spends a wallet output that a pending transaction spends", async () => {
    // Coin selection would fund from the larger output.
    const [kept, pending] = seedEscrow({}, [100n * AP3X, 200n * AP3X]);

    const { txCborHex } = await accept(buyer, [pending!.ref]);

    const { inputs } = inspectSignedTransactionFinancials(txCborHex);
    expect(inputs).not.toContainEqual(pending!.ref);
    expect(inputs).toContainEqual(kept!.ref);
  });

  it("refuses a key that is not the buyer", async () => {
    seedEscrow();
    expect(await reasonOf(accept(buildSupplierWalletKey()))).toBe("buyer signature mismatch");
  });

  it("refuses an escrow that is not Submitted", async () => {
    seedEscrow({ state: "Open", submitted_at: null, result_receipt_hash: null });
    expect(await reasonOf(accept())).toBe("wrong state");
  });

  it("refuses after the accept window on the clock", async () => {
    seedEscrow({ submitted_at: Date.now() - ACCEPT_WINDOW_MS - 1 });
    expect(await reasonOf(accept())).toBe("accept window expired");
  });

  it("refuses an escrow that is not on chain", async () => {
    live.ogmios.fund(lucidWallet(buyer), 100n * AP3X);
    expect(await reasonOf(accept())).toBe("escrow ref not on chain");
  });

  it("refuses a wallet without a UTxO for the collateral", async () => {
    seedEscrow({}, []);
    expect(await reasonOf(accept())).toContain("collateral");
  });
});
