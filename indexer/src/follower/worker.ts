/**
 * indexer/src/follower/worker.ts — ChainSyncWorker for the indexer.
 *
 * Drives a ChainSyncSource, persists events to SqliteCache, handles rollbacks,
 * and exposes an EventEmitter for the SSE layer and the identity refresher.
 * Each block is written in one SQLite transaction; listeners hear about it
 * after the commit.
 *
 * Emitted events:
 *   "chain-event"     — { type, ref, slot, txHash, address }  (on each MarketplaceEvent)
 *   "sync-progress"   — { currentSlot, tipSlot }
 *   "identity-change" — string[]: agent ids whose identity record changed
 *                       (outputs at the identity address, or a rollback of them)
 *   "error"           — { message, stale }
 */

import { EventEmitter } from "events";
import type { NetworkId } from "@marketplace/shared";
import {
  decodeAnyAdvertDatum,
  decodeAnyEscrowDatum,
  encodePlutusAddress,
  encodePlutusDataHex,
  plutusAddressToBech32,
  type PlutusAddress,
} from "@marketplace/shared/cbor";
import type { ChainSyncSource, IndexerBlock, RollbackPoint, MarketplaceEvent } from "./types.js";
import type { SqliteCache } from "../db/cache.js";
import { processBlock, type ScriptAddresses, type KnownUtxoInfo } from "./blockProcessor.js";

export interface ChainSyncWorkerOpts {
  source: ChainSyncSource;
  cache: SqliteCache;
  addresses: ScriptAddresses;
  /** Network of the escrow refund addresses (bech32 prefix). */
  networkId: NetworkId;
  skipBeforeSlot?: number;
  /** Clock for identity invalidation times (tests). */
  now?: () => number;
}

interface ChainEventPayload {
  type: string;
  ref: string;
  slot: number;
  txHash: string;
  address: string;
}

/** Refund address as bech32; Plutus Data CBOR hex when it has no bech32 form (negative pointer values). */
function refundAddressText(address: PlutusAddress, networkId: NetworkId): string {
  try {
    return plutusAddressToBech32(address, networkId);
  } catch {
    return encodePlutusAddress(address);
  }
}

export class ChainSyncWorker extends EventEmitter {
  private source: ChainSyncSource;
  private cache: SqliteCache;
  private addresses: ScriptAddresses;
  private networkId: NetworkId;
  private skipBeforeSlot: number;
  private now: () => number;
  private watched: Set<string>;

  private currentSlot: number = 0;
  private tipSlot: number = 0;
  private stopped: boolean = false;

  constructor(opts: ChainSyncWorkerOpts) {
    super();
    this.source = opts.source;
    this.cache = opts.cache;
    this.addresses = opts.addresses;
    this.networkId = opts.networkId;
    this.skipBeforeSlot = opts.skipBeforeSlot ?? 0;
    this.now = opts.now ?? Date.now;
    const a = opts.addresses;
    this.watched = new Set(
      [
        a.advertAddress,
        a.escrowAddress,
        a.identityAdvertAddress,
        a.identityEscrowAddress,
        a.identityPolicyId ? a.identityAddress : undefined,
      ].filter((x): x is string => typeof x === "string" && x.length > 0),
    );

    const cursor = this.cache.getCursor();
    if (cursor) {
      this.currentSlot = cursor.slot;
    }

    this.source.on("block", (data: { block: IndexerBlock; tip?: { slot: number } }) => {
      this.handleBlock(data);
    });
    this.source.on("rollback", (data: { point: RollbackPoint }) => {
      this.handleRollback(data);
    });
    this.source.on("error", (err: Error) => {
      this.emit("error", { message: err.message ?? String(err), stale: true });
    });
  }

  getCurrentSlot(): number {
    return this.currentSlot;
  }

  getTipSlot(): number {
    return this.tipSlot;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const cursor = this.cache.getCursor();
    const intersect = cursor ? { slot: cursor.slot, id: cursor.blockHash } : null;
    await this.source.start(intersect);
  }

  stop(): void {
    this.stopped = true;
    this.source.stop();
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  /** Unspent watched UTxOs that the block's transactions spend. */
  private knownUtxosFor(block: IndexerBlock): Map<string, KnownUtxoInfo> {
    const refs = new Set<string>();
    for (const tx of block.transactions ?? []) {
      for (const input of tx?.inputs ?? []) refs.add(`${input.transaction.id}#${input.index}`);
    }
    const map = new Map<string, KnownUtxoInfo>();
    for (const utxo of this.cache.getUnspentUtxosByRefs([...refs])) {
      if (!this.watched.has(utxo.address)) continue;
      map.set(utxo.ref, { address: utxo.address, datumHex: utxo.datum_hex || undefined, agentId: utxo.agent_id });
    }
    return map;
  }

  private handleBlock(data: { block: IndexerBlock; tip?: { slot: number } }): void {
    if (this.stopped) return;
    const block = data.block;
    if (!block) return;

    if (data.tip?.slot && data.tip.slot > this.tipSlot) {
      this.tipSlot = data.tip.slot;
    }

    // Byron Epoch-Boundary Blocks (EBBs) and some pre-Shelley blocks have no `slot`.
    // We can't save a NULL cursor (SQLite NOT NULL). When chain-syncing from origin
    // before SKIP_BEFORE_SLOT, just request the next block without persisting cursor.
    const slot = block.slot;
    if (slot === undefined || slot === null) {
      this.source.requestNextBlock();
      return;
    }

    // Fast-forward path
    if (slot < this.skipBeforeSlot) {
      this.cache.saveCursor(slot, block.id);
      this.currentSlot = slot;
      this.emit("sync-progress", { currentSlot: slot, tipSlot: this.tipSlot });
      this.source.requestNextBlock();
      return;
    }

    const { events, spentRefs, created, identityChanges } = processBlock(
      block,
      this.knownUtxosFor(block),
      this.addresses,
    );

    this.cache.transaction(() => {
      // Outputs first: a later transaction of the same block may spend one.
      for (const c of created) {
        this.cache.insertUtxo(c.ref, c.address, c.datumHex, slot, c.txHash, c.agentId);
      }
      for (const event of events) this.persistEvent(event);
      for (const s of spentRefs) this.cache.spendUtxo(s.ref, s.slot, s.txHash);
      if (identityChanges.length > 0) this.cache.invalidateIdentityFacts(identityChanges, this.now());
      this.cache.saveCursor(slot, block.id);
    });

    for (const event of events) {
      const payload: ChainEventPayload = {
        type: event.type,
        ref: event.utxoRef,
        slot: event.slot,
        txHash: event.txHash,
        address: event.address,
      };
      this.emit("chain-event", payload);
    }
    if (identityChanges.length > 0) this.emit("identity-change", identityChanges);

    // Mirror the saved cursor into the source's reconnect-intersect so that
    // a WebSocket drop+reconnect resumes from here rather than rewinding to
    // the startup intersect point.
    this.source.updateIntersect({ slot, id: block.id });
    this.currentSlot = slot;
    this.emit("sync-progress", { currentSlot: slot, tipSlot: this.tipSlot });

    this.source.requestNextBlock();
  }

  private persistEvent(event: MarketplaceEvent): void {
    this.cache.appendEvent({
      type: event.type,
      slot: event.slot,
      tx_hash: event.txHash,
      utxo_ref: event.utxoRef,
      datum_hex: event.datumHex,
      metadata_json: "{}",
      rolled_back: 0,
    });

    // Update domain projections (advertisements, escrows)
    if (event.type === "PostAdvert" || event.type === "UpdateAdvert") {
      try {
        const decoded = decodeAnyAdvertDatum(event.datumHex);
        const d = decoded.datum;
        this.cache.upsertAdvertisement({
          utxo_ref: event.utxoRef,
          supplier_pkh: d.supplier_pkh,
          capability_id: d.capability_id,
          model: d.model,
          max_output_tokens: d.max_output_tokens,
          max_processing_ms: d.max_processing_ms,
          price_lovelace: d.price_lovelace.toString(),
          supplier_bond_lovelace: d.supplier_bond_lovelace.toString(),
          buyer_bond_lovelace: d.buyer_bond_lovelace.toString(),
          endpoint_url: d.endpoint_url,
          detail_uri: d.detail_uri,
          detail_hash: d.detail_hash,
          advertised_at: d.advertised_at,
          status: d.status,
          created_slot: event.slot,
          datum_hex: event.datumHex,
          rolled_back: 0,
          layout: decoded.layout,
          agent_id: decoded.layout === "identity" ? decoded.datum.agent_id.toLowerCase() : null,
          creator_signed: event.requiredSigners.includes(d.supplier_pkh.toLowerCase()) ? 1 : 0,
        });
      } catch {
        // already warned by processBlock
      }
    } else if (event.type === "RetireAdvert") {
      // The advert UTxO was spent with no continuing output → flip the row's
      // status to Retired so listActiveAdvertisements drops it.
      this.cache.markAdvertisementRetired(event.utxoRef);
    } else if (event.type === "PostEscrow" || event.type === "ClaimEscrow" || event.type === "SubmitEscrow") {
      try {
        const decoded = decodeAnyEscrowDatum(event.datumHex);
        const d = decoded.datum;
        const refund = decoded.layout === "identity" ? decoded.datum.refund : null;
        this.cache.upsertEscrow({
          utxo_ref: event.utxoRef,
          buyer_pkh: d.buyer_pkh,
          supplier_pkh: d.supplier_pkh,
          advert_ref_tx: d.advert_ref.txHash,
          advert_ref_index: d.advert_ref.index,
          capability_id: d.capability_id,
          request_spec_hash: d.request_spec_hash,
          prompt_hash: d.prompt_hash,
          payment_lovelace: d.payment_lovelace.toString(),
          buyer_bond_lovelace: d.buyer_bond_lovelace.toString(),
          supplier_bond_lovelace: d.supplier_bond_lovelace.toString(),
          deliver_by: d.deliver_by,
          posted_at: d.posted_at,
          submitted_at: d.submitted_at,
          result_receipt_hash: d.result_receipt_hash,
          state: d.state,
          created_slot: event.slot,
          datum_hex: event.datumHex,
          rolled_back: 0,
          layout: decoded.layout,
          agent_id: decoded.layout === "identity" ? decoded.datum.agent_id.toLowerCase() : null,
          refund_address: refund ? refundAddressText(refund.address, this.networkId) : null,
          refund_datum: refund?.datum ? encodePlutusDataHex(refund.datum) : null,
        });
      } catch {
        // already warned
      }
    }
  }

  private handleRollback(data: { point: RollbackPoint }): void {
    if (this.stopped) return;
    const slot = data.point?.slot ?? 0;
    const touched = this.cache.rollbackToSlot(slot);
    if (touched.length > 0) {
      this.cache.invalidateIdentityFacts(touched, this.now());
      this.emit("identity-change", touched);
    }
    this.currentSlot = slot;
    // Also slide the source's reconnect-intersect back so a subsequent WS
    // drop doesn't resume past the rollback point.
    if (data.point && typeof data.point.id === "string") {
      this.source.updateIntersect({ slot, id: data.point.id });
    }
    this.emit("sync-progress", { currentSlot: slot, tipSlot: this.tipSlot });
    this.source.requestNextBlock();
  }
}
