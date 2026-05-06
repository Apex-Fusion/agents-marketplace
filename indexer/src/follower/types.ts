/**
 * indexer/src/follower/types.ts — ChainSyncSource interface and block types.
 *
 * ChainSyncSource is the seam that allows tests to inject synthetic block streams
 * without touching a real Ogmios WebSocket. OgmiosSource implements this interface
 * for production; MockChainSyncSource implements it for tests.
 *
 * Block/Tx/Output shapes mirror the apex-dashboard block-processor shapes
 * (Ogmios JSON over WebSocket).
 */
import { EventEmitter } from "events";

export interface TxOutput {
  address: string;
  value: Record<string, unknown>;
  datum?: string;    // inline CBOR hex
  datumHash?: string;
}

export interface TxInput {
  transaction: { id: string };
  index: number;
}

/**
 * EscrowRedeemerTag — the five redeemer constructors from escrow.ak.
 * Keyed in IndexerTx.redeemers by "<spentTxHash>#<spentIndex>".
 */
export type EscrowRedeemerTag = "Claim" | "Submit" | "Accept" | "Reclaim" | "Release";

export interface IndexerTx {
  id: string;
  inputs: TxInput[];
  outputs: TxOutput[];
  /**
   * Optional redeemer map populated from Ogmios redeemer info.
   * Key: "<spentTxHash>#<outputIndex>" of the spent UTxO.
   * Value: EscrowRedeemerTag identifying which redeemer was used.
   */
  redeemers?: Record<string, EscrowRedeemerTag>;
}

export interface IndexerBlock {
  slot: number;
  id: string;           // block hash
  ancestor?: string;
  transactions?: IndexerTx[] | null;
}

export interface RollbackPoint {
  slot: number;
  id: string;
}

/**
 * ChainSyncSource — the mockable seam for the chain follower.
 *
 * Implementations emit:
 *   "block"     — { block: IndexerBlock, tip: { slot: number } }
 *   "rollback"  — { point: RollbackPoint }
 *   "connected" — ()
 *   "error"     — (err: Error)
 *
 * The worker calls start() to begin streaming, stop() to tear down.
 * requestNextBlock() is called after each block to pipeline requests.
 */
export interface ChainSyncSource extends EventEmitter {
  start(intersectAt?: { slot: number; id: string } | null): Promise<void>;
  stop(): void;
  requestNextBlock(): void;
}

/**
 * MarketplaceEvent — emitted by blockProcessor for each detected state transition.
 */
export type MarketplaceEventType =
  | "PostAdvert"
  | "UpdateAdvert"
  | "RetireAdvert"
  | "PostEscrow"
  | "ClaimEscrow"
  | "SubmitEscrow"
  | "AcceptEscrow"
  | "ReclaimEscrow"
  | "ReleaseEscrow";

export interface MarketplaceEvent {
  type: MarketplaceEventType;
  slot: number;
  txHash: string;
  utxoRef: string;       // "<txHash>#<outputIndex>"
  datumHex: string;
  address: string;
}
