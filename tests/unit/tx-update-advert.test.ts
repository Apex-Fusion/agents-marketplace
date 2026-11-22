/**
 * Tests buildUpdateAdvertTx() on the mock chain (legacy advert layout).
 * UpdateAdvert spends the advert UTxO and writes a continuing output with the new datum at the same script address.
 * The builder refuses a signer that is not the supplier, a new datum with another supplier_pkh,
 * and an advertised_at that goes back. advert.ak handle_update has the same rules.
 */

import { describe, it, expect } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildUpdateAdvertTx } from "../../packages/shared/src/tx/advert/updateAdvert.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { ADVERT_NOW_MS, ADVERT_SCRIPT_ADDRESS, activeAdvertDatum, seedAdvertUtxo } from "../fixtures/onchain-tx/legacy-advert.js";

const DEPOSIT = 2_000_000n;
const OLD_TIMESTAMP = ADVERT_NOW_MS;
const NEW_TIMESTAMP = ADVERT_NOW_MS + 1_000_000;

const supplier = buildSupplierWalletKey();
const buyer = buildBuyerWalletKey();
const oldDatum = activeAdvertDatum({ advertised_at: OLD_TIMESTAMP });

/** A mock chain that holds the advert with `oldDatum`. */
function seeded(): { chain: MockChainProvider; advert: Utxo } {
  const chain = new MockChainProvider();
  return { chain, advert: seedAdvertUtxo(chain, oldDatum) };
}

describe("buildUpdateAdvertTx()", () => {
  it("spends the advert UTxO", async () => {
    const { chain, advert } = seeded();
    await buildUpdateAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: advert.ref,
      newAdvertDatum: { ...oldDatum, advertised_at: NEW_TIMESTAMP },
      deposit_lovelace: DEPOSIT,
    });
    expect(await chain.queryUtxo(advert.ref)).toBeNull();
  });

  it("writes the continuing output with the new datum at the same script address", async () => {
    const { chain, advert } = seeded();
    const newDatum = { ...oldDatum, advertised_at: NEW_TIMESTAMP };
    const result = await buildUpdateAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: advert.ref,
      newAdvertDatum: newDatum,
      deposit_lovelace: DEPOSIT,
    });
    expect(await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 })).toMatchObject({
      address: ADVERT_SCRIPT_ADDRESS,
      lovelace: DEPOSIT,
      datumHex: encodeAdvertDatum(newDatum),
    });
  });

  it("accepts an advertised_at equal to the old one (non-decreasing)", async () => {
    const { chain, advert } = seeded();
    const sameTimestamp = { ...oldDatum, advertised_at: OLD_TIMESTAMP };
    const result = await buildUpdateAdvertTx({
      chain,
      walletKey: supplier,
      advertRef: advert.ref,
      newAdvertDatum: sameTimestamp,
      deposit_lovelace: DEPOSIT,
    });
    const output = await chain.queryUtxo({ txHash: result.expectedTxHash, index: 0 });
    expect(output?.datumHex).toBe(encodeAdvertDatum(sameTimestamp));
  });

  it.each([
    {
      name: "a wallet key that is not the datum supplier",
      walletKey: buyer,
      newDatum: { ...oldDatum, advertised_at: NEW_TIMESTAMP },
      reason: "supplier signature mismatch",
    },
    {
      name: "a new datum with another supplier_pkh",
      walletKey: supplier,
      newDatum: { ...oldDatum, supplier_pkh: buyer.pubKeyHash, advertised_at: NEW_TIMESTAMP },
      reason: "supplier pkh changed",
    },
    {
      name: "an advertised_at that goes back",
      walletKey: supplier,
      newDatum: { ...oldDatum, advertised_at: OLD_TIMESTAMP - 1 },
      reason: "advertised_at regress",
    },
  ])(
    "refuses $name",
    async ({ walletKey, newDatum, reason }) => {
      const { chain, advert } = seeded();
      await expect(
        buildUpdateAdvertTx({ chain, walletKey, advertRef: advert.ref, newAdvertDatum: newDatum, deposit_lovelace: DEPOSIT }),
      ).rejects.toMatchObject({ name: "TxConstructionError", reason });
    },
  );
});
