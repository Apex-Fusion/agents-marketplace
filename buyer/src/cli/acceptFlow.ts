/**
 * acceptFlow.ts — pure logic layer for the `tx:accept` CLI.
 *
 * Mirrors supplier/src/cli/postAdvertFlow.ts: validate, build, submit, await,
 * return tx hash. Tests exercise the interface declared here; do not change
 * exported types without updating tests first.
 */

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import {
  buildAcceptTx,
  TxConstructionError,
  type WalletKey,
} from "@marketplace/shared/tx";

export interface AcceptFlowParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  escrowRef: OutputReference;
  /** Milliseconds to wait for on-chain confirmation. Default: 120_000. */
  awaitTimeoutMs?: number;
  /**
   * Progress logger. Called with human-readable status lines. Must be called
   * at minimum with:
   *   "accepting escrow"
   *   "submitted tx <hash>"
   *   "awaiting confirmation"
   *   "confirmed"
   * in that order. Defaults to console.log.
   */
  log?: (line: string) => void;
}

export interface AcceptFlowResult {
  /** Hex-encoded transaction hash (64 chars). */
  txHash: string;
}

/**
 * runAccept — build and submit an Accept transaction (Submitted → Accepted, terminal).
 *
 * Validates (via buildAcceptTx):
 *   - walletKey.pubKeyHash === datum.buyer_pkh   (TxConstructionError "buyer signature mismatch")
 *   - datum.state === "Submitted"                 (TxConstructionError "wrong state")
 *   - tip ≤ submitted_at + ACCEPT_WINDOW_MS       (TxConstructionError "accept window expired")
 *
 * On chain.submitTx rejection: re-throws underlying error as-is.
 * On awaitTx timeout: rejects with a timeout error that includes the txHash so
 *   the operator can recover manually.
 *
 * Default awaitTimeoutMs: 120_000.
 * Default log: console.log.
 */
export async function runAccept(
  params: AcceptFlowParams,
): Promise<AcceptFlowResult> {
  const { chain, walletKey, escrowRef } = params;
  const writeLog =
    params.log ??
    ((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });
  const timeoutMs = params.awaitTimeoutMs ?? 120_000;

  writeLog("accepting escrow");

  const built = await buildAcceptTx({
    chain,
    buyerKey: walletKey,
    escrowRef,
  });

  writeLog(`submitted tx ${built.expectedTxHash}`);
  writeLog("awaiting confirmation");

  try {
    await chain.awaitTx(built.expectedTxHash, timeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      reason.includes(built.expectedTxHash)
        ? reason
        : `awaitTx failed for txHash ${built.expectedTxHash}: ${reason}`,
    );
    throw wrapped;
  }

  writeLog("confirmed");

  return { txHash: built.expectedTxHash };
}

/** Re-export for tests / consumers that want to discriminate. */
export { TxConstructionError };
