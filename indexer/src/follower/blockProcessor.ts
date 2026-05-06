/**
 * indexer/src/follower/blockProcessor.ts — processes a single Ogmios block.
 *
 * processBlock(block, knownUtxos, addresses) inspects each transaction,
 * decodes datums at watched script addresses (advertScript, escrowScript),
 * and emits typed MarketplaceEvent objects.
 *
 * Detection rules (all output-driven unless noted):
 *   PostAdvert   — new output at advertAddr with Active AdvertDatum, no spent advert input
 *   UpdateAdvert — output at advertAddr + spends prior advert UTxO
 *   RetireAdvert — spends advert UTxO, no continuing output at advertAddr
 *   PostEscrow   — new output at escrowAddr with Open EscrowDatum, no spent escrow input
 *   ClaimEscrow  — spend-driven: spends Open escrow, Claimed output continues
 *   SubmitEscrow — spend-driven: spends Claimed escrow, Submitted output continues
 *   AcceptEscrow — spends Submitted escrow, no continuing output (terminal)
 *   ReclaimEscrow — spends Open/Claimed escrow, no continuing output (terminal)
 *   ReleaseEscrow — spends Submitted escrow, no continuing output (terminal)
 *
 * Malformed datum at a watched address → console.warn, no event emitted.
 * Byron-era blocks (no transactions field) → handled gracefully.
 */

import { decodeAdvertDatum, decodeEscrowDatum } from "@marketplace/shared/cbor";
import type {
  EscrowRedeemerTag,
  IndexerBlock,
  IndexerTx,
  MarketplaceEvent,
  MarketplaceEventType,
} from "./types.js";

export interface KnownUtxoInfo {
  address: string;
  datumHex?: string;
}

export interface ScriptAddresses {
  advertAddress: string;
  escrowAddress: string;
}

export interface ProcessBlockResult {
  events: MarketplaceEvent[];
  spentRefs: Array<{ ref: string; slot: number; txHash: string }>;
}

interface SpentInfo {
  ref: string;
  prior: KnownUtxoInfo;
}

function tryDecodeAdvert(datumHex: string): ReturnType<typeof decodeAdvertDatum> | null {
  try {
    return decodeAdvertDatum(datumHex);
  } catch (err) {
    console.warn(`[blockProcessor] failed to decode AdvertDatum: ${(err as Error).message}`);
    return null;
  }
}

function tryDecodeEscrow(datumHex: string): ReturnType<typeof decodeEscrowDatum> | null {
  try {
    return decodeEscrowDatum(datumHex);
  } catch (err) {
    console.warn(`[blockProcessor] failed to decode EscrowDatum: ${(err as Error).message}`);
    return null;
  }
}

function processTx(
  tx: IndexerTx,
  block: IndexerBlock,
  knownUtxos: Map<string, KnownUtxoInfo>,
  addresses: ScriptAddresses,
  events: MarketplaceEvent[],
  spentRefs: Array<{ ref: string; slot: number; txHash: string }>,
): void {
  const slot = block.slot;
  const txHash = tx.id;

  // 1) Identify spent inputs that hit our known watched UTxOs.
  const spentAdvert: SpentInfo[] = [];
  const spentEscrow: SpentInfo[] = [];

  for (const input of tx.inputs ?? []) {
    const ref = `${input.transaction.id}#${input.index}`;
    const prior = knownUtxos.get(ref);
    if (!prior) continue;
    spentRefs.push({ ref, slot, txHash });
    if (prior.address === addresses.advertAddress) {
      spentAdvert.push({ ref, prior });
    } else if (prior.address === addresses.escrowAddress) {
      spentEscrow.push({ ref, prior });
    }
  }

  // 2) Identify outputs at watched addresses.
  type WatchedOutput = { index: number; address: string; datumHex: string };
  const advertOutputs: WatchedOutput[] = [];
  const escrowOutputs: WatchedOutput[] = [];

  for (let i = 0; i < (tx.outputs ?? []).length; i++) {
    const out = tx.outputs[i];
    if (!out.datum) continue;
    if (out.address === addresses.advertAddress) {
      advertOutputs.push({ index: i, address: out.address, datumHex: out.datum });
    } else if (out.address === addresses.escrowAddress) {
      escrowOutputs.push({ index: i, address: out.address, datumHex: out.datum });
    }
  }

  // 3) Advertisement event detection
  if (advertOutputs.length > 0) {
    // Output(s) at advert script — either PostAdvert (no input) or UpdateAdvert (has prior input)
    for (const out of advertOutputs) {
      const decoded = tryDecodeAdvert(out.datumHex);
      if (!decoded) continue;
      const type: MarketplaceEventType = spentAdvert.length > 0 ? "UpdateAdvert" : "PostAdvert";
      events.push({
        type,
        slot,
        txHash,
        utxoRef: `${txHash}#${out.index}`,
        datumHex: out.datumHex,
        address: out.address,
      });
    }
  } else if (spentAdvert.length > 0) {
    // Spend with no continuing output → RetireAdvert
    for (const s of spentAdvert) {
      events.push({
        type: "RetireAdvert",
        slot,
        txHash,
        utxoRef: s.ref,
        datumHex: s.prior.datumHex ?? "",
        address: s.prior.address,
      });
    }
  }

  // 4) Escrow event detection
  if (escrowOutputs.length > 0) {
    // Continuing output exists. The state in the new datum tells us which transition.
    for (const out of escrowOutputs) {
      const decoded = tryDecodeEscrow(out.datumHex);
      if (!decoded) continue;
      let type: MarketplaceEventType | null = null;
      if (decoded.state === "Open" && spentEscrow.length === 0) {
        type = "PostEscrow";
      } else if (decoded.state === "Claimed" && spentEscrow.length > 0) {
        type = "ClaimEscrow";
      } else if (decoded.state === "Submitted" && spentEscrow.length > 0) {
        type = "SubmitEscrow";
      }
      if (type !== null) {
        events.push({
          type,
          slot,
          txHash,
          utxoRef: `${txHash}#${out.index}`,
          datumHex: out.datumHex,
          address: out.address,
        });
      }
    }
  } else if (spentEscrow.length > 0) {
    // Terminal spend (no continuing escrow output). Disambiguate via tx.redeemers.
    // Per ARCHITECTURE.md §4.3 the prior state + redeemer uniquely determines the
    // intended transition. Mismatches are logged and emit no event.
    const redeemers: Record<string, EscrowRedeemerTag> = tx.redeemers ?? {};
    for (const s of spentEscrow) {
      const priorDatumHex = s.prior.datumHex ?? "";
      const decoded = priorDatumHex ? tryDecodeEscrow(priorDatumHex) : null;
      if (!decoded) continue;
      const redeemer = redeemers[s.ref];
      const priorState = decoded.state;

      let type: MarketplaceEventType | null = null;

      if (redeemer === undefined) {
        // No redeemer attached — defensive default: assume the canonical
        // "happy-path" redeemer for the prior state. Always warn so this
        // surfaces in operations even when behaviour is benign.
        if (priorState === "Submitted") {
          type = "AcceptEscrow";
          console.warn(
            `[blockProcessor] terminal escrow spend ${s.ref} (priorState=Submitted) carried no redeemer; defaulting to AcceptEscrow`,
          );
        } else if (priorState === "Open" || priorState === "Claimed") {
          type = "ReclaimEscrow";
          console.warn(
            `[blockProcessor] terminal escrow spend ${s.ref} (priorState=${priorState}) carried no redeemer; defaulting to ReclaimEscrow`,
          );
        } else {
          console.warn(
            `[blockProcessor] terminal escrow spend ${s.ref} carried no redeemer and prior state ${priorState} is non-terminal; emitting no event`,
          );
        }
      } else if (priorState === "Submitted") {
        if (redeemer === "Accept") {
          type = "AcceptEscrow";
        } else if (redeemer === "Release") {
          type = "ReleaseEscrow";
        } else {
          console.warn(
            `[blockProcessor] redeemer/state mismatch on terminal spend ${s.ref}: redeemer=${redeemer} but priorState=Submitted; emitting no event`,
          );
        }
      } else if (priorState === "Open" || priorState === "Claimed") {
        if (redeemer === "Reclaim") {
          type = "ReclaimEscrow";
        } else {
          console.warn(
            `[blockProcessor] redeemer/state mismatch on terminal spend ${s.ref}: redeemer=${redeemer} but priorState=${priorState}; emitting no event`,
          );
        }
      } else {
        console.warn(
          `[blockProcessor] terminal escrow spend ${s.ref} has unexpected prior state ${priorState} with redeemer=${redeemer}; emitting no event`,
        );
      }

      if (type !== null) {
        events.push({
          type,
          slot,
          txHash,
          utxoRef: s.ref,
          datumHex: priorDatumHex,
          address: s.prior.address,
        });
      }
    }
  }
}

export function processBlock(
  block: IndexerBlock,
  knownUtxos: Map<string, KnownUtxoInfo>,
  addresses: ScriptAddresses,
): ProcessBlockResult {
  const events: MarketplaceEvent[] = [];
  const spentRefs: Array<{ ref: string; slot: number; txHash: string }> = [];

  // Byron / null transactions → graceful no-op
  if (!block || !block.transactions) {
    return { events, spentRefs };
  }

  for (const tx of block.transactions) {
    if (!tx) continue;
    processTx(tx, block, knownUtxos, addresses, events, spentRefs);
  }

  return { events, spentRefs };
}
