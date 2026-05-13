/**
 * indexer/src/follower/worker.ts — ChainSyncWorker for the indexer.
 *
 * Drives a ChainSyncSource, persists events to SqliteCache, handles rollbacks,
 * and exposes an EventEmitter for the SSE layer.
 *
 * Emitted events (for SSE consumers):
 *   "chain-event"     — { type, ref, slot, datum? }  (on each MarketplaceEvent)
 *   "sync-progress"   — { currentSlot, tipSlot }
 *   "error"           — { message, stale }
 */

import { EventEmitter } from "events";
import { decodeAdvertDatum, decodeEscrowDatum } from "@marketplace/shared/cbor";
import type { ChainSyncSource, IndexerBlock, RollbackPoint, MarketplaceEvent } from "./types.js";
import type { SqliteCache } from "../db/cache.js";
import { processBlock, type ScriptAddresses, type KnownUtxoInfo } from "./blockProcessor.js";

export interface ChainSyncWorkerOpts {
  source: ChainSyncSource;
  cache: SqliteCache;
  addresses: ScriptAddresses;
  skipBeforeSlot?: number;
}

export class ChainSyncWorker extends EventEmitter {
  private source: ChainSyncSource;
  private cache: SqliteCache;
  private addresses: ScriptAddresses;
  private skipBeforeSlot: number;

  private currentSlot: number = 0;
  private tipSlot: number = 0;
  private stopped: boolean = false;

  constructor(opts: ChainSyncWorkerOpts) {
    super();
    this.source = opts.source;
    this.cache = opts.cache;
    this.addresses = opts.addresses;
    this.skipBeforeSlot = opts.skipBeforeSlot ?? 0;

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

  private buildKnownUtxosMap(): Map<string, KnownUtxoInfo> {
    const map = new Map<string, KnownUtxoInfo>();
    for (const addr of [this.addresses.advertAddress, this.addresses.escrowAddress]) {
      for (const utxo of this.cache.getUnspentUtxos(addr)) {
        map.set(utxo.ref, { address: utxo.address, datumHex: utxo.datum_hex || undefined });
      }
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

    const knownUtxos = this.buildKnownUtxosMap();
    const { events, spentRefs } = processBlock(block, knownUtxos, this.addresses);

    for (const event of events) {
      this.persistEvent(event);
      this.emit("chain-event", {
        type: event.type,
        ref: event.utxoRef,
        slot: event.slot,
        txHash: event.txHash,
        address: event.address,
      } as { type: string; ref: string; slot: number; txHash: string; address: string });
    }

    // Spend known UTxOs after inserts (handles self-referencing edge case in apex pattern)
    for (const s of spentRefs) {
      this.cache.spendUtxo(s.ref, s.slot, s.txHash);
      // Also update advert/escrow domain rows: mark terminal for spend-no-continue cases.
      this.markDomainSpend(s.ref, slot, events);
    }

    // Insert UTxOs for new outputs at watched addresses (so spend detection works for next block)
    for (const tx of block.transactions ?? []) {
      for (let i = 0; i < (tx.outputs ?? []).length; i++) {
        const out = tx.outputs[i];
        if (!out.datum) continue;
        if (out.address === this.addresses.advertAddress || out.address === this.addresses.escrowAddress) {
          const ref = `${tx.id}#${i}`;
          this.cache.insertUtxo(ref, out.address, out.datum, slot, tx.id);
        }
      }
    }

    this.cache.saveCursor(slot, block.id);
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
        const d = decodeAdvertDatum(event.datumHex);
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
        const d = decodeEscrowDatum(event.datumHex);
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
        });
      } catch {
        // already warned
      }
    }
  }

  private markDomainSpend(ref: string, _slot: number, events: MarketplaceEvent[]): void {
    // For terminal events (Retire / Accept / Reclaim / Release), the spend has no continuing
    // output so the domain row stays at its prior state (caller can interpret via events table).
    // For Update / Claim / Submit, a fresh upsertAdvertisement/upsertEscrow happens via persistEvent
    // for the NEW utxo_ref. We could also update the OLD row's status here if needed.
    void ref; void events;
  }

  private handleRollback(data: { point: RollbackPoint }): void {
    if (this.stopped) return;
    const slot = data.point?.slot ?? 0;
    this.cache.rollbackToSlot(slot);
    this.currentSlot = slot;
    this.emit("sync-progress", { currentSlot: slot, tipSlot: this.tipSlot });
    this.source.requestNextBlock();
  }
}
