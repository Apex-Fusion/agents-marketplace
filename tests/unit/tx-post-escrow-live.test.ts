/**
 * tx-post-escrow-live.test.ts: the live transactions of the legacy layout that start an escrow or an advert, the live lifecycle of
 * an escrow, and the time source of the mock chain, which the live path replaces. Lucid builds real Cardano CBOR; the fake Ogmios
 * and the pinned clock are in tests/fixtures/onchain-tx/legacy-live.ts. The pre-checks of the Post builder (buyer is supplier, no
 * messages, advert missing or retired, wrong payment) are shared with the mock path and are tested in tx-post-escrow.test.ts.
 *
 * Time source: the live path reads the clock (`Date.now()`), not the tip slot. The fake tip slot, read as slot x 1000, is far
 * from the clock, so the stamp cases fail when a builder reads the tip. The mock chain reads the tip slot as slot x 1000, and the
 * production CLIs in mock mode rely on it.
 */

import { describe, expect, it, vi } from "vitest";
import { Decoder } from "cbor-x";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildPostEscrowTx } from "../../packages/shared/src/tx/escrow/postEscrow.js";
import { buildClaimTx } from "../../packages/shared/src/tx/escrow/claim.js";
import { buildSubmitTx } from "../../packages/shared/src/tx/escrow/submit.js";
import { buildAcceptTx } from "../../packages/shared/src/tx/escrow/accept.js";
import { MIN_UTXO_LOVELACE, NETWORK_BUFFER_MS } from "../../packages/shared/src/tx/internal/constants.js";
import { inspectSignedTransaction, inspectSignedTransactionFinancials } from "../../packages/shared/src/tx/internal/signedTransaction.js";
import { TxConstructionError, type BuildResult, type ChatMessage } from "../../packages/shared/src/tx/types.js";
import { decodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { AdvertDatum, EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { runPostAdvert } from "../../supplier/src/cli/postAdvertFlow.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import { buildCliAdvertDatum } from "../fixtures/supplier-side/sample-advert-datum.js";
import { AP3X, outputOf } from "../fixtures/identity-builders/world.js";
import { activeAdvertDatum, seedAdvertUtxo } from "../fixtures/onchain-tx/legacy-advert.js";
import { legacyAdvertUtxo, legacyLive, lucidWallet } from "../fixtures/onchain-tx/legacy-live.js";

const NOW_MS = Date.UTC(2026, 3, 27, 12, 0, 0);
const ADVERT_REF = { txHash: "b".repeat(64), index: 0 };
const MESSAGES: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }];
const RECEIPT_HASH = "e".repeat(64);

const buyer = buildBuyerWalletKey();
const supplier = buildSupplierWalletKey();
const live = legacyLive(NOW_MS);

/** An advert on the fake chain (default: the advert of the fixtures), and a buyer wallet with `funds`. Returns the funds. */
function seedPost(funds: bigint[] = [100n * AP3X], advert: AdvertDatum = activeAdvertDatum()) {
  live.ogmios.add(legacyAdvertUtxo(advert, ADVERT_REF));
  return live.ogmios.fund(lucidWallet(buyer), ...funds);
}

const post = (extra: Partial<Parameters<typeof buildPostEscrowTx>[0]> = {}) =>
  buildPostEscrowTx({
    chain: live.ogmios.chain(),
    buyerKey: buyer,
    advertRef: ADVERT_REF,
    messages: MESSAGES,
    payment_lovelace: activeAdvertDatum().price_lovelace,
    ...extra,
  });

/** The escrow datum in output `index` of a built transaction. */
function escrowDatumAt(built: BuildResult, index = 0): EscrowDatum {
  const output = inspectSignedTransactionFinancials(built.txCborHex).outputs[index];
  return decodeEscrowDatum(output!.datumHex!);
}

describe("buildPostEscrowTx() [live]", () => {
  it("gives the transaction hash and the validity end that recovery needs", async () => {
    seedPost();

    const result = await post();

    const decoded: unknown = new Decoder({ mapsAsObjects: false }).decode(Buffer.from(result.txCborHex, "hex"));
    if (!Array.isArray(decoded) || !(decoded[0] instanceof Map)) throw new Error("live transaction has no CBOR body map");
    const inspected = inspectSignedTransaction(result.txCborHex);
    expect(inspected.txHash).toBe(result.expectedTxHash);
    expect(inspected.validUntilSlot).toBe(Number((decoded[0] as Map<number, unknown>).get(3)));
  });

  it("stamps posted_at and deliver_by from the clock, not from the tip slot", async () => {
    seedPost();

    const result = await post();

    expect(escrowDatumAt(result, result.escrowOutputRef.index)).toMatchObject({
      state: "Open",
      posted_at: NOW_MS,
      deliver_by: NOW_MS + activeAdvertDatum().max_processing_ms + NETWORK_BUFFER_MS,
      payment_lovelace: activeAdvertDatum().price_lovelace,
      advert_ref: ADVERT_REF,
    });
  });

  it("locks at least the 2 AP3X output floor when the price and both bonds are tiny", async () => {
    seedPost([100n * AP3X], activeAdvertDatum({ price_lovelace: 1n, supplier_bond_lovelace: 1n, buyer_bond_lovelace: 1n }));

    const result = await post({ payment_lovelace: 1n });

    const { outputs } = inspectSignedTransactionFinancials(result.txCborHex);
    expect(outputs[result.escrowOutputRef.index]!.lovelace).toBeGreaterThanOrEqual(MIN_UTXO_LOVELACE);
  });

  it("runs the persist hook with the signed CBOR before the broadcast", async () => {
    seedPost();
    let hookTxHash = "";

    const result = await post({
      beforeSubmit: async (built) => {
        hookTxHash = built.expectedTxHash;
        expect(live.ogmios.submitted).toEqual([]);
      },
    });

    expect(hookTxHash).toBe(result.expectedTxHash);
    expect(live.ogmios.submitted).toEqual([result.txCborHex]);
  });

  it("never spends a wallet output that a pending transaction spends", async () => {
    // Coin selection would fund from the larger output and keep the smaller one for collateral.
    const [kept, pending] = seedPost([100n * AP3X, 200n * AP3X]);

    const result = await post({ excludeInputs: [pending!.ref] });

    const { inputs } = inspectSignedTransactionFinancials(result.txCborHex);
    expect(inputs).not.toContainEqual(pending!.ref);
    expect(inputs).toContainEqual(kept!.ref);
  });

  it.each([
    ["a wallet with one small output", [1n * AP3X]],
    ["an empty wallet", []],
  ])("refuses %s with a collateral reason", async (_name, funds) => {
    seedPost(funds);

    const error = await post().then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(TxConstructionError);
    expect((error as TxConstructionError).reason).toContain("collateral");
  });
});

describe("runPostAdvert() [live]", () => {
  it("stamps advertised_at from the clock, not from the tip slot", async () => {
    live.ogmios.fund(lucidWallet(supplier), 10n * AP3X);
    const chain = live.ogmios.chain();
    vi.spyOn(chain, "awaitTx").mockResolvedValue(undefined); // the fake chain never confirms a transaction

    await runPostAdvert({ chain, walletKey: supplier, advertDatum: buildCliAdvertDatum(), log: () => {} });

    expect(live.ogmios.submitted).toHaveLength(1);
    const advert = inspectSignedTransactionFinancials(live.ogmios.submitted[0]!).outputs.find((output) => output.datumHex !== undefined);
    expect(decodeAdvertDatum(advert!.datumHex!).advertised_at).toBe(NOW_MS);
  });
});

describe("the mock chain reads the tip slot as slot x 1000", () => {
  it("stamps posted_at of a Post from the tip slot, not from the clock", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    seedAdvertUtxo(chain, activeAdvertDatum(), ADVERT_REF);

    const result = await buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: ADVERT_REF,
      messages: MESSAGES,
      payment_lovelace: activeAdvertDatum().price_lovelace,
    });

    const stored = await chain.queryUtxo(result.escrowOutputRef);
    expect(decodeEscrowDatum(stored!.datumHex!).posted_at).toBe(1_000_000);
  });

  it("stamps advertised_at of runPostAdvert from the tip slot, not from the datum or the clock", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(1_000);

    // buildCliAdvertDatum() carries advertised_at 0: the flow replaces it.
    const result = await runPostAdvert({ chain, walletKey: supplier, advertDatum: buildCliAdvertDatum(), log: () => {} });

    const stored = await chain.queryUtxo(result.advertRef);
    expect(decodeAdvertDatum(stored!.datumHex!).advertised_at).toBe(1_000_000);
  });
});

describe("the legacy lifecycle on the live path", () => {
  it("builds Post, Claim, Submit and Accept, each from the output of the step before", async () => {
    const chain = live.ogmios.chain();
    seedPost();
    live.ogmios.fund(lucidWallet(supplier), 100n * AP3X);

    const posted = await post();
    live.ogmios.add(outputOf(posted.txCborHex, posted.expectedTxHash, posted.escrowOutputRef.index));
    expect(escrowDatumAt(posted, posted.escrowOutputRef.index).state).toBe("Open");

    const claimed = await buildClaimTx({ chain, supplierKey: supplier, escrowRef: posted.escrowOutputRef });
    live.ogmios.add(outputOf(claimed.txCborHex, claimed.expectedTxHash, 0));
    expect(escrowDatumAt(claimed).state).toBe("Claimed");

    const submitted = await buildSubmitTx({
      chain,
      supplierKey: supplier,
      escrowRef: { txHash: claimed.expectedTxHash, index: 0 },
      receiptHash: RECEIPT_HASH,
    });
    live.ogmios.add(outputOf(submitted.txCborHex, submitted.expectedTxHash, 0));
    // The Submit changes the state, the receipt hash and the stamp, and nothing else. The stamp is the end of the validity range:
    // 2 minutes past the clock, capped at deliver_by (90 s here).
    const claimedDatum = escrowDatumAt(claimed);
    expect(escrowDatumAt(submitted)).toEqual({
      ...claimedDatum,
      state: "Submitted",
      submitted_at: claimedDatum.deliver_by,
      result_receipt_hash: RECEIPT_HASH,
    });

    const accepted = await buildAcceptTx({ chain, buyerKey: buyer, escrowRef: { txHash: submitted.expectedTxHash, index: 0 } });
    const { inputs, outputs } = inspectSignedTransactionFinancials(accepted.txCborHex);
    expect(inputs).toContainEqual({ txHash: submitted.expectedTxHash, index: 0 });
    expect(outputs.filter((output) => output.datumHex !== undefined)).toEqual([]);
  });
});
