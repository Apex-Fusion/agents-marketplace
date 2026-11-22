/**
 * Tests buildRetireAdvertTx() on the mock chain (legacy advert layout).
 * RetireAdvert spends the advert UTxO and pays its value to the supplier wallet. The supplier signs.
 * advert.ak handle_retire checks the supplier signature and an output to the supplier. The builder checks the signer first.
 */

import { describe, it, expect } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildRetireAdvertTx } from "../../packages/shared/src/tx/advert/retireAdvert.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { activeAdvertDatum, seedAdvertUtxo } from "../fixtures/onchain-tx/legacy-advert.js";

const supplier = buildSupplierWalletKey();
const buyer = buildBuyerWalletKey();

describe("buildRetireAdvertTx()", () => {
  it("spends the advert UTxO", async () => {
    const chain = new MockChainProvider();
    const advert = seedAdvertUtxo(chain, activeAdvertDatum());
    await buildRetireAdvertTx({ chain, walletKey: supplier, advertRef: advert.ref });
    expect(await chain.queryUtxo(advert.ref)).toBeNull();
  });

  it("pays the advert value to the supplier wallet address", async () => {
    const chain = new MockChainProvider();
    const advert = seedAdvertUtxo(chain, activeAdvertDatum());
    await buildRetireAdvertTx({ chain, walletKey: supplier, advertRef: advert.ref });
    const supplierUtxos = await chain.queryUtxosByAddress(supplier.address);
    const total = supplierUtxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    expect(total).toBeGreaterThanOrEqual(advert.lovelace);
  });

  it("lists the supplier key hash as a required signer", async () => {
    const chain = new MockChainProvider();
    const advert = seedAdvertUtxo(chain, activeAdvertDatum());
    const result = await buildRetireAdvertTx({ chain, walletKey: supplier, advertRef: advert.ref });
    expect(result.txCborHex).toContain(supplier.pubKeyHash);
  });

  it.each([
    { name: "a wallet key that is not the datum supplier", walletKey: buyer, datumSupplier: supplier.pubKeyHash },
    { name: "a datum that names another supplier than the wallet key", walletKey: supplier, datumSupplier: buyer.pubKeyHash },
  ])("refuses $name", async ({ walletKey, datumSupplier }) => {
    const chain = new MockChainProvider();
    const advert = seedAdvertUtxo(chain, activeAdvertDatum({ supplier_pkh: datumSupplier }));
    await expect(
      buildRetireAdvertTx({ chain, walletKey, advertRef: advert.ref }),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "supplier signature mismatch" });
  });
});
