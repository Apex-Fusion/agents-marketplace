/**
 * consolidateWallet.ts — wallet re-shaping tx builder.
 *
 * Re-shapes any wallet to {collateral UTxO (default 5 AP3X), working UTxO
 * (remainder)} so lucid-evolution's coin selection for Plutus-script spends
 * (Claim/Submit/Accept/Reclaim/RetireAdvert) reliably finds a pure-AP3X
 * UTxO ≥ setCollateral (default 5_000_000n) as collateral candidate,
 * distinct from the fee/change input.
 *
 * Handles two modes via the same tx shape (driven by planConsolidate):
 *   - consolidate: N > 1 fragmented UTxOs → 2 outputs.
 *   - split:       1 large UTxO → 2 outputs.
 *
 * No script witness, no datum, no native assets. One output to wallet vkh
 * with exactly `collateralLovelace`, one output to wallet vkh with the
 * remainder (lucid balances residual fee from the working output via
 * change-balancing on top of the explicit `lovelace: workingOutput` value).
 *
 * Operational use only. Invoke via supplier/src/cli/consolidate-wallet.ts
 * or buyer/src/cli/consolidate-wallet.ts.
 */

import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { OgmiosLucidProvider } from "../../chain/OgmiosLucidProvider.js";
import { createLucidContext } from "../internal/lucidContext.js";
import { checkedShelleyAddress } from "../internal/addressText.js";
import {
  DEFAULT_COLLATERAL_LOVELACE,
  DEFAULT_FEE_RESERVE,
  planConsolidate,
  type ConsolidateLimits,
  type ConsolidateReason,
} from "./planConsolidate.js";

export interface ConsolidateWalletParams {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  /** Lovelace value for output #0 (the collateral candidate).
   *  Default 5_000_000n (matches lucid's default `setCollateral`). */
  collateralLovelace?: bigint;
  /** When the wallet is reshaped. Default: the planner defaults. */
  limits?: ConsolidateLimits;
}

export interface ConsolidateWalletBuildResult extends BuildResult {
  inputCount: number;
  totalLovelaceIn: bigint;
  collateralOutputLovelace: bigint;
  workingOutputLovelace: bigint;
  reason: ConsolidateReason;
  /** Wallet UTxOs that this run left: one run spends at most MAX_CONSOLIDATE_INPUTS. */
  remainingUtxos: number;
  /** True when the wallet was already at {≥collateral, working} — no tx submitted. */
  alreadyHealthy: boolean;
}

export async function buildConsolidateWalletTx(
  params: ConsolidateWalletParams,
): Promise<ConsolidateWalletBuildResult> {
  const { chain, walletKey } = params;
  const collateralLovelace =
    params.collateralLovelace ?? DEFAULT_COLLATERAL_LOVELACE;

  const provider = new OgmiosLucidProvider({
    ogmiosUrl: chain.url,
    fetch: chain.fetchImpl,
  });
  const { lucid } = await createLucidContext(
    provider,
    walletKey,
    { networkId: 1, systemStartUnix: 0, slotLengthMs: 1000 },
    { usePresetProtocolParameters: true },
  );

  const realWalletUtxos = await lucid.wallet().getUtxos();
  const plan = planConsolidate(realWalletUtxos, collateralLovelace, DEFAULT_FEE_RESERVE, params.limits);

  if (plan.alreadyHealthy) {
    return {
      txCborHex: "",
      expectedTxHash: "",
      inputCount: plan.inputCount,
      totalLovelaceIn: plan.totalLovelaceIn,
      collateralOutputLovelace: plan.collateralOutput,
      workingOutputLovelace: plan.workingOutput,
      reason: plan.reason,
      remainingUtxos: plan.remainingUtxos,
      alreadyHealthy: true,
    };
  }

  // The address comes from the environment of the process, and the text can be empty or wrong: it is read here before Lucid reads it.
  const walletAddress = checkedShelleyAddress(walletKey.address, "the wallet address");

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      .pay.ToAddress(walletAddress, { lovelace: collateralLovelace })
      .pay.ToAddress(walletAddress, { lovelace: plan.workingOutput })
      .addSignerKey(walletKey.pubKeyHash)
      // 500K floor matches commit 4f1ec9a's setMinFee bump across live builders.
      // The workingOutput already deducts a 2M fee reserve in planConsolidate;
      // lucid balances the actual fee out of that reserve via change.
      // Lucid computes the fee with the Cardano values (44 lovelace for each byte plus 155,381), and Vector asks more
      // (45 and 156,253). The floor is above the Vector fee only while the plan keeps to MAX_CONSOLIDATE_INPUTS.
      .setMinFee(500_000n);

    // Lucid selects only from these UTxOs, and the two outputs need all of them.
    const completed = await txBuilder.complete({
      presetWalletInputs: plan.inputs,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TxConstructionError("consolidate_wallet_build_failed", msg);
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();

  await chain.submitTx(txCborHex);

  return {
    txCborHex,
    expectedTxHash,
    inputCount: plan.inputCount,
    totalLovelaceIn: plan.totalLovelaceIn,
    collateralOutputLovelace: collateralLovelace,
    workingOutputLovelace: plan.workingOutput,
    reason: plan.reason,
    remainingUtxos: plan.remainingUtxos,
    alreadyHealthy: false,
  };
}
