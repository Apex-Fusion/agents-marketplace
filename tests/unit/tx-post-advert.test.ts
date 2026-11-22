/**
 * Tests buildPostAdvertTx() on the mock chain (legacy advert layout).
 * The validator cannot check a new advert (advert.ak: PostAdvert is enforced off-chain, ARCHITECTURE.md §4.1).
 * So the builder refuses a wallet key that is not the supplier, a status that is not Active,
 * and an advertised_at more than five minutes from the tip.
 */

import { describe, it, expect } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildPostAdvertTx } from "../../packages/shared/src/tx/advert/postAdvert.js";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { ADVERT_NOW_MS, activeAdvertDatum } from "../fixtures/onchain-tx/legacy-advert.js";

const DEPOSIT = 2_000_000n;
const FIVE_MIN_MS = 5 * 60 * 1000;

const supplier = buildSupplierWalletKey();

/** A mock chain with the tip at ADVERT_NOW_MS (the mock chain reads slot x 1000 as the time). */
function chainAtNow(): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor(ADVERT_NOW_MS / 1000));
  return chain;
}

function post(chain: MockChainProvider, advertDatum: AdvertDatum, walletKey = supplier) {
  return buildPostAdvertTx({ chain, walletKey, advertDatum, deposit_lovelace: DEPOSIT });
}

describe("buildPostAdvertTx()", () => {
  it("writes the encoded advert datum at the advert script address", async () => {
    const chain = chainAtNow();
    const advert = activeAdvertDatum();
    const result = await post(chain, advert);
    expect(await chain.queryUtxo(result.advertOutputRef)).toMatchObject({
      address: loadBlueprint().advertScriptAddress(0),
      datumHex: encodeAdvertDatum(advert),
    });
  });

  it("locks at least the deposit", async () => {
    const chain = chainAtNow();
    const result = await post(chain, activeAdvertDatum());
    const output = await chain.queryUtxo(result.advertOutputRef);
    expect(output!.lovelace).toBeGreaterThanOrEqual(DEPOSIT);
  });

  it("lists the supplier key hash as a required signer", async () => {
    const result = await post(chainAtNow(), activeAdvertDatum());
    expect(result.txCborHex).toContain(supplier.pubKeyHash);
  });

  it("returns the transaction hash and the reference of output 0", async () => {
    const result = await post(chainAtNow(), activeAdvertDatum());
    expect(result.expectedTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.advertOutputRef).toEqual({ txHash: result.expectedTxHash, index: 0 });
  });

  it("refuses a wallet key that is not the datum supplier", async () => {
    await expect(
      post(chainAtNow(), activeAdvertDatum(), buildBuyerWalletKey()),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "supplier signature mismatch" });
  });

  it("refuses a datum whose status is not Active", async () => {
    await expect(
      post(chainAtNow(), activeAdvertDatum({ status: "Retired" })),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "fresh advert must be Active" });
  });

  it.each([
    { name: "more than five minutes in the future", advertisedAt: ADVERT_NOW_MS + FIVE_MIN_MS + 1 },
    { name: "more than five minutes in the past", advertisedAt: ADVERT_NOW_MS - FIVE_MIN_MS - 1 },
  ])("refuses an advertised_at $name", async ({ advertisedAt }) => {
    await expect(
      post(chainAtNow(), activeAdvertDatum({ advertised_at: advertisedAt })),
    ).rejects.toMatchObject({ name: "TxConstructionError", reason: "advertised_at out of validity range" });
  });

  it("accepts an advertised_at exactly five minutes after the tip", async () => {
    const chain = chainAtNow();
    const advert = activeAdvertDatum({ advertised_at: ADVERT_NOW_MS + FIVE_MIN_MS });
    const result = await post(chain, advert);
    expect((await chain.queryUtxo(result.advertOutputRef))?.datumHex).toBe(encodeAdvertDatum(advert));
  });
});
