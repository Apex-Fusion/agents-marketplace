/**
 * publishReferenceScripts.ts — one-shot tx builder that publishes the escrow
 * and advert validator scripts as CIP-33 reference UTxOs.
 *
 * The two outputs are paid to a caller-supplied address (typically a known
 * burn address such as the all-zero-pkh enterprise address) with the script
 * bytes attached as `scriptRef`. Subsequent script-spending txs reference
 * these UTxOs via env (ESCROW_REF_UTXO, ADVERT_REF_UTXO) and skip inlining
 * the script bytes — saving ~5 KB per script-spending tx.
 *
 * One-shot operational tool. Invoke via supplier/src/cli/publish-reference-scripts.ts.
 */

import type { Script } from "@lucid-evolution/lucid";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { OgmiosLucidProvider } from "../../chain/OgmiosLucidProvider.js";
import { createLucidContext } from "./lucidContext.js";

export interface LivePublishRefScriptsParams {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  /** Address to publish the two reference-script UTxOs to. Typically a known
   *  burn address (cryptographically unspendable) so refs cannot be spent. */
  burnAddr: string;
  escrowScript: Script;
  advertScript: Script;
  /** Lovelace per output. Default 30_000_000n (30 AP3X) — covers min-UTxO for
   *  a ~5 KB script (4310 lovelace/byte × 5_140 bytes ≈ 22.2 AP3X) with headroom. */
  lovelacePerOutput?: bigint;
}

export interface PublishRefScriptsBuildResult extends BuildResult {
  /** Output index 0 — escrow script reference. */
  escrowRef: { txHash: string; outputIndex: number };
  /** Output index 1 — advert script reference. */
  advertRef: { txHash: string; outputIndex: number };
  formattedEscrowRef: string;
  formattedAdvertRef: string;
}

const DEFAULT_LOVELACE_PER_OUTPUT = 30_000_000n;

export async function buildLiveTxForPublishReferenceScripts(
  params: LivePublishRefScriptsParams,
): Promise<PublishRefScriptsBuildResult> {
  const { chain, walletKey, burnAddr, escrowScript, advertScript } = params;
  const lovelacePerOutput = params.lovelacePerOutput ?? DEFAULT_LOVELACE_PER_OUTPUT;

  const provider = new OgmiosLucidProvider({
    ogmiosUrl: chain.url,
    fetch: chain.fetchImpl,
  });
  const { lucid } = await createLucidContext(provider, walletKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const realWalletUtxos = await lucid.wallet().getUtxos();

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      // Output 0: escrow script reference.
      .pay.ToAddressWithData(
        burnAddr,
        undefined,
        { lovelace: lovelacePerOutput },
        escrowScript,
      )
      // Output 1: advert script reference.
      .pay.ToAddressWithData(
        burnAddr,
        undefined,
        { lovelace: lovelacePerOutput },
        advertScript,
      )
      .addSignerKey(walletKey.pubKeyHash)
      .setMinFee(200_000n);

    const completed = await txBuilder.complete({
      presetWalletInputs: realWalletUtxos,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TxConstructionError(`publish-reference-scripts build failed: ${msg}`);
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();

  await chain.submitTx(txCborHex);

  return {
    txCborHex,
    expectedTxHash,
    escrowRef: { txHash: expectedTxHash, outputIndex: 0 },
    advertRef: { txHash: expectedTxHash, outputIndex: 1 },
    formattedEscrowRef: `${expectedTxHash}#0`,
    formattedAdvertRef: `${expectedTxHash}#1`,
  };
}
