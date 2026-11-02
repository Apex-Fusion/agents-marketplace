/**
 * tests/unit/indexer-identity-backfill.test.ts — Part 2 §6.4 backfill.
 *
 * The release that adds identity support either syncs again from a block
 * before the identity deployment (SqliteCache.applyResync + the follower), or
 * loads the current outputs at the identity address when it starts
 * (loadIdentityOutputs, an Ogmios v6 queryLedgerState/utxo by address).
 */

import { describe, it, expect } from "vitest";

import type { Utxo } from "@marketplace/shared/chain";
import { SqliteCache } from "../../indexer/src/db/cache.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import type { IndexerBlock } from "../../indexer/src/follower/types.js";
import { loadIdentityOutputs } from "../../indexer/src/identity/backfill.js";
import { MockChainSyncSource, type MockChainEvent } from "./__helpers__/MockChainSyncSource.js";
import {
  ADVERT_SCRIPT_ADDRESS,
  ESCROW_SCRIPT_ADDRESS,
  buildMockBlock,
  buildPostAdvertTx,
  type MockTx,
} from "../fixtures/indexer-side/sample-blocks.js";
import {
  AGENT_ID,
  IDENTITY_ADDRESS,
  IDENTITY_ADVERT_SCRIPT_ADDRESS,
  IDENTITY_ESCROW_SCRIPT_ADDRESS,
  IDENTITY_POLICY_ID,
  OTHER_AGENT_ID,
  THIRD_PARTY_ADDRESS,
  buildIdentityPostAdvertTx,
  buildIdentityRecordTx,
} from "../fixtures/indexer-side/identity-blocks.js";

function utxo(txHash: string, address: string, assets: Record<string, bigint>, datumHex: string | null = "d87980"): Utxo {
  return { ref: { txHash, index: 0 }, address, lovelace: 10_000_000n, assets, datumHex, scriptRef: null };
}

const unit = (name: string): string => `${IDENTITY_POLICY_ID}.${name}`;

describe("loadIdentityOutputs — current outputs at the identity address", () => {
  it("inserts each record output with its agent and leaves the rows that the follower already holds", async () => {
    const cache = new SqliteCache(":memory:", { listing: { identityAddress: IDENTITY_ADDRESS } });
    cache.insertUtxo(`${"b1".repeat(32)}#0`, IDENTITY_ADDRESS, "d87980", 900, "b1".repeat(32), OTHER_AGENT_ID);
    const chain = {
      queryUtxosByAddress: async (address: string) => {
        expect(address).toBe(IDENTITY_ADDRESS);
        return [
          utxo("b0".repeat(32), IDENTITY_ADDRESS, { [unit(AGENT_ID)]: 1n }),
          utxo("b1".repeat(32), IDENTITY_ADDRESS, { [unit(OTHER_AGENT_ID)]: 1n }),
          utxo("b2".repeat(32), IDENTITY_ADDRESS, { [unit(AGENT_ID)]: 1n, [unit(OTHER_AGENT_ID)]: 1n }),
          utxo("b3".repeat(32), IDENTITY_ADDRESS, { [`${"c0".repeat(28)}.${AGENT_ID}`]: 1n }),
          utxo("b4".repeat(32), THIRD_PARTY_ADDRESS, { [unit(AGENT_ID)]: 1n }),
        ];
      },
    };
    const result = await loadIdentityOutputs({ cache, chain, identityAddress: IDENTITY_ADDRESS, policyId: IDENTITY_POLICY_ID });
    expect(result).toEqual({ outputs: 3, inserted: 2 });
    const rows = cache.getUnspentUtxos(IDENTITY_ADDRESS).map((u) => [u.ref, u.agent_id, u.created_slot]);
    expect(rows).toEqual([
      [`${"b1".repeat(32)}#0`, OTHER_AGENT_ID, 900],
      [`${"b0".repeat(32)}#0`, AGENT_ID, 0],
      [`${"b2".repeat(32)}#0`, null, 0],
    ]);
    cache.close();
  });

  it("a loaded record lets the refresher ask about the agent of a new advert", async () => {
    const cache = new SqliteCache(":memory:", { listing: { identityAddress: IDENTITY_ADDRESS } });
    const source = new MockChainSyncSource([]);
    const worker = new ChainSyncWorker({
      source,
      cache,
      networkId: 0,
      addresses: {
        advertAddress: ADVERT_SCRIPT_ADDRESS,
        escrowAddress: ESCROW_SCRIPT_ADDRESS,
        identityAdvertAddress: IDENTITY_ADVERT_SCRIPT_ADDRESS,
        identityEscrowAddress: IDENTITY_ESCROW_SCRIPT_ADDRESS,
        identityAddress: IDENTITY_ADDRESS,
        identityPolicyId: IDENTITY_POLICY_ID,
      },
    });
    await worker.start();
    source.pushEvent({ kind: "block", block: buildMockBlock({ slot: 1_000, transactions: [buildIdentityPostAdvertTx()] }) as IndexerBlock });
    expect(cache.listIdentityAgentsToResolve()).toEqual([]);
    await loadIdentityOutputs({
      cache,
      chain: { queryUtxosByAddress: async () => [utxo("b0".repeat(32), IDENTITY_ADDRESS, { [unit(AGENT_ID)]: 1n })] },
      identityAddress: IDENTITY_ADDRESS,
      policyId: IDENTITY_POLICY_ID,
    });
    expect(cache.listIdentityAgentsToResolve()).toEqual([AGENT_ID]);
    cache.close();
  });
});

describe("resync from a block before the identity deployment", () => {
  function block(slot: number, txs: MockTx[]): MockChainEvent {
    return { kind: "block", block: buildMockBlock({ slot, id: slot.toString(16).padStart(64, "0"), transactions: txs }) as IndexerBlock };
  }

  const chain = [
    block(100, [buildPostAdvertTx({ txId: "c1".repeat(32) })]),
    block(200, [buildIdentityRecordTx({ txId: "c2".repeat(32), agentId: AGENT_ID })]),
    block(300, [buildIdentityPostAdvertTx({ txId: "c3".repeat(32) })]),
    block(400, [buildPostAdvertTx({ txId: "c4".repeat(32) })]),
  ];

  it("a database that followed only the legacy addresses learns the identity outputs after the resync", async () => {
    const legacyOnly = { advertAddress: ADVERT_SCRIPT_ADDRESS, escrowAddress: ESCROW_SCRIPT_ADDRESS };
    const cache = new SqliteCache(":memory:", { listing: { identityAddress: IDENTITY_ADDRESS } });

    // Old release: legacy addresses only.
    const before = new ChainSyncWorker({ source: new MockChainSyncSource(chain), cache, addresses: legacyOnly, networkId: 0 });
    await before.start();
    expect(cache.getCursor()!.slot).toBe(400);
    expect(cache.getUnspentUtxos(IDENTITY_ADDRESS)).toEqual([]);
    expect(cache.getAdvertisementByRef(`${"c3".repeat(32)}#0`)).toBeNull();

    // New release: resync from slot 100 (before the identity deployment) and follow all addresses.
    expect(cache.applyResync({ slot: 100, blockHash: (100).toString(16).padStart(64, "0") })).toBe(true);
    const after = new ChainSyncWorker({
      source: new MockChainSyncSource(chain.slice(1)),
      cache,
      networkId: 0,
      addresses: {
        ...legacyOnly,
        identityAdvertAddress: IDENTITY_ADVERT_SCRIPT_ADDRESS,
        identityEscrowAddress: IDENTITY_ESCROW_SCRIPT_ADDRESS,
        identityAddress: IDENTITY_ADDRESS,
        identityPolicyId: IDENTITY_POLICY_ID,
      },
    });
    await after.start();

    expect(cache.getCursor()!.slot).toBe(400);
    expect(cache.getUnspentUtxos(IDENTITY_ADDRESS).map((u) => u.agent_id)).toEqual([AGENT_ID]);
    expect(cache.getAdvertisementByRef(`${"c3".repeat(32)}#0`)).toMatchObject({ layout: "identity", agent_id: AGENT_ID });
    // The legacy event of slot 400 exists once: the old copy was rolled back.
    expect(cache.listEventsAfterSlot(0).map((e) => [e.slot, e.type])).toEqual([
      [100, "PostAdvert"],
      [300, "PostAdvert"],
      [400, "PostAdvert"],
    ]);
    cache.close();
  });
});
