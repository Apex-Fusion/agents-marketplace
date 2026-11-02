/**
 * indexer/src/follower/types.ts — ChainSyncSource interface and block types.
 *
 * ChainSyncSource is the seam that allows tests to inject synthetic block streams
 * without touching a real Ogmios WebSocket. OgmiosSource implements this interface
 * for production; MockChainSyncSource implements it for tests.
 *
 * IndexerBlock is the indexer's own block shape. OgmiosSource converts each
 * Ogmios v6 block into it (ogmiosBlock.ts): transactions that failed script
 * validation are left out, and spend redeemers are keyed by the spent output.
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

export interface IndexerTx {
  id: string;
  inputs: TxInput[];
  outputs: TxOutput[];
  /** Key hashes (56 lowercase hex) that the transaction lists as required signers. */
  requiredSigners?: string[];
  /**
   * Spend redeemers. Key: "<spentTxHash>#<outputIndex>" of the spent output.
   * Value: the redeemer as Plutus Data CBOR hex. The block processor decodes
   * the redeemers of escrow inputs with the escrow redeemer codec.
   */
  spendRedeemers?: Record<string, string>;
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
  /** Update the cached intersect point used on reconnect. Without this,
   * Ogmios WebSocket disconnects rewind the cursor to the startup point. */
  updateIntersect(point: { slot: number; id: string }): void;
}

/**
 * Datum layout of an advert or escrow output: "legacy" (13-field advert,
 * 14-field escrow) or "identity" (Part 2 §6.1–6.2: 14-field advert with
 * agent_id, 16-field escrow with agent_id and refund). Each script address
 * has one layout.
 */
export type DatumLayout = "legacy" | "identity";

/**
 * MarketplaceEvent — emitted by blockProcessor for each detected state transition.
 * RefundRevokedEscrow is the terminal spend with the RefundRevoked redeemer
 * (new escrow only, Part 2 §6.1).
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
  | "ReleaseEscrow"
  | "RefundRevokedEscrow";

export interface MarketplaceEvent {
  type: MarketplaceEventType;
  slot: number;
  txHash: string;
  utxoRef: string;       // "<txHash>#<outputIndex>"
  datumHex: string;
  address: string;
  /** Layout of the datum in `datumHex`. */
  layout: DatumLayout;
  /** Required signers of the transaction that made the event (lowercase hex). */
  requiredSigners: string[];
}
