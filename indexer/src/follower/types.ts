/**
 * indexer/src/follower/types.ts — ChainSyncSource interface and block types.
 *
 * ChainSyncSource is the seam that allows tests to inject synthetic block streams
 * without touching a real Ogmios WebSocket. OgmiosSource implements this interface
 * for production; MockChainSyncSource implements it for tests.
 *
 * IndexerBlock is the indexer's own block shape. OgmiosSource converts each
 * Ogmios v6 block into it (ogmiosBlock.ts): transactions that failed script
 * validation are left out, spend redeemers are keyed by the spent output, and
 * the transaction metadata becomes Metadatum values (follower/metadata.ts).
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
 * Transaction metadatum (Conway CDDL `transaction_metadatum`). A text value
 * keeps its exact characters, so its UTF-8 bytes are the bytes on chain.
 */
export type Metadatum =
  | { kind: "int"; value: bigint }
  | { kind: "bytes"; hex: string }
  | { kind: "text"; value: string }
  | { kind: "list"; items: Metadatum[] }
  | { kind: "map"; entries: Array<[Metadatum, Metadatum]> };

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
  /** Transaction metadata. Key: the label in decimal (for example "22084"). */
  metadata?: Record<string, Metadatum>;
  /** Minted (+) and burned (−) quantities: policy id → asset name → quantity (lowercase hex). */
  mint?: Record<string, Record<string, number>>;
}

export interface IndexerBlock {
  slot: number;
  id: string;           // block hash
  /** Block number (Ogmios `height`); absent for blocks without one. */
  height?: number;
  ancestor?: string;
  transactions?: IndexerTx[] | null;
}

/** A block on the chain: its slot and block header hash (Ogmios v6 `Point`). */
export interface ChainPoint {
  slot: number;
  id: string;
}

/** A chain-sync point: a block, or the origin (before the first block). */
export type RollbackPoint = ChainPoint | "origin";

/** The last block of the node's chain, as Ogmios reports it. */
export type ChainTip = ChainPoint;

/**
 * ChainSyncSource — the mockable seam for the chain follower.
 *
 * Implementations emit:
 *   "connected"       — ()  the connection to the node is open
 *   "disconnected"    — ()  the connection closed; the source connects again
 *   "intersection"    — { point: RollbackPoint, tip: ChainTip | null }
 *                       the node found one of the points; a rollback to it comes next
 *   "no-intersection" — { tip: ChainTip | null }
 *                       the node found none of the points; the source asks again later
 *   "block"           — { block: IndexerBlock, tip: ChainTip | null }
 *   "rollback"        — { point: RollbackPoint, tip: ChainTip | null }
 *   "tip"             — ChainTip  a tip report outside chain-sync (queryNetwork/tip)
 *   "error"           — (err: Error)
 *
 * The worker calls start() to begin streaming, stop() to tear down.
 * requestNextBlock() is called after each block to pipeline requests.
 */
export interface ChainSyncSource extends EventEmitter {
  /**
   * Start streaming. At each connect, the source sends the points that
   * `points` returns (newest first) to findIntersection, so a reconnect
   * resumes from the blocks that the worker saved last. An empty list is a
   * new database: the source starts at the origin. A non-empty list never
   * falls back to the origin.
   */
  start(points: () => ChainPoint[]): Promise<void>;
  stop(): void;
  requestNextBlock(): void;
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
