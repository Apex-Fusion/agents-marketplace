/**
 * tests/unit/indexer-identity-listing.test.ts — listing rule, switch and value cap.
 *
 * Part 2 §6.2 listing rule, §6.4 (agent_id in the supplier view, switch,
 * RefundRevoked, third-party Reclaim), §6.5 F-29 (value cap). The integration
 * cases run blocks through ChainSyncWorker into a real SqliteCache and read
 * the HTTP views.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";

import { advertListing, withinValueCap, type IdentityFacts, type ListingCandidate } from "../../indexer/src/listing/rule.js";
import { SqliteCache } from "../../indexer/src/db/cache.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import type { ScriptAddresses } from "../../indexer/src/follower/blockProcessor.js";
import type { IndexerBlock } from "../../indexer/src/follower/types.js";
import { createApp, type IndexerDeps } from "../../indexer/src/server.js";
import { MockChainSyncSource, type MockChainEvent } from "./__helpers__/MockChainSyncSource.js";
import {
  ADVERT_SCRIPT_ADDRESS,
  ESCROW_SCRIPT_ADDRESS,
  INDEXER_BUYER_PKH,
  INDEXER_SUPPLIER_PKH,
  buildMockBlock,
  buildPostAdvertTx,
  type MockTx,
} from "../fixtures/indexer-side/sample-blocks.js";
import {
  AGENT_ID,
  BUYER_REFUND_ADDRESS,
  IDENTITY_ADDRESS,
  IDENTITY_ADVERT_SCRIPT_ADDRESS,
  IDENTITY_ESCROW_SCRIPT_ADDRESS,
  IDENTITY_POLICY_ID,
  OTHER_AGENT_ID,
  THIRD_PARTY_PKH,
  VAULT_REFUND,
  buildIdentityEscrowSpendTx,
  buildIdentityPostAdvertTx,
  buildIdentityPostEscrowTx,
  buildIdentityRecordTx,
  submittedIdentityEscrowOpts,
} from "../fixtures/indexer-side/identity-blocks.js";

const CAP = 10_000_000_000n; // 10,000 AP3X
const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Pure rule ────────────────────────────────────────────────────────────────

function candidate(overrides: Partial<ListingCandidate> = {}): ListingCandidate {
  return {
    layout: "identity",
    supplier_pkh: INDEXER_SUPPLIER_PKH,
    capability_id: "llm.text.generate.v1",
    agent_id: AGENT_ID,
    creator_signed: 1,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    ...overrides,
  };
}

function facts(overrides: Partial<IdentityFacts> = {}): IdentityFacts {
  return {
    agent_id: AGENT_ID,
    found: 1,
    effective: "active",
    independent: 1,
    origin: "native",
    transaction_keys: JSON.stringify([INDEXER_SUPPLIER_PKH]),
    capabilities: JSON.stringify(["llm.text.generate.v1"]),
    detail: null,
    resolved_at: NOW - 1_000,
    invalidated_at: null,
    ...overrides,
  };
}

const CTX = { currentSlot: 1_000, switchSlot: null, nowMs: NOW, maxAgeMs: 600_000 };
const LIVE = { hasRecord: true, facts: facts() };

describe("advertListing — legacy adverts and the switch", () => {
  const legacy = candidate({ layout: "legacy", agent_id: null, creator_signed: 0 });

  it("lists a legacy advert when no switch slot is configured", () => {
    expect(advertListing(legacy, { hasRecord: false, facts: null }, CTX)).toEqual({ listed: true });
  });

  it("lists a legacy advert before the switch slot and not from it on", () => {
    expect(advertListing(legacy, { hasRecord: false, facts: null }, { ...CTX, switchSlot: 1_001 }).listed).toBe(true);
    expect(advertListing(legacy, { hasRecord: false, facts: null }, { ...CTX, switchSlot: 1_000 }))
      .toEqual({ listed: false, reason: "afterSwitch" });
  });

  it("the switch does not touch new adverts", () => {
    expect(advertListing(candidate(), LIVE, { ...CTX, switchSlot: 0 })).toEqual({ listed: true });
  });
});

describe("advertListing — value cap (F-29)", () => {
  it("lists payment + bonds of exactly 10,000 AP3X and refuses one base unit more, in both layouts", () => {
    const at = { price_lovelace: (CAP - 2n).toString(), supplier_bond_lovelace: "1", buyer_bond_lovelace: "1" };
    const over = { ...at, buyer_bond_lovelace: "2" };
    expect(advertListing(candidate(at), LIVE, CTX).listed).toBe(true);
    expect(advertListing(candidate(over), LIVE, CTX)).toEqual({ listed: false, reason: "valueCap" });
    expect(advertListing(candidate({ ...over, layout: "legacy", agent_id: null }), LIVE, CTX))
      .toEqual({ listed: false, reason: "valueCap" });
  });

  it("withinValueCap refuses values that are not integers", () => {
    expect(withinValueCap("1", "1", "1")).toBe(true);
    expect(withinValueCap("1.5", "1", "1")).toBe(false);
    expect(withinValueCap(CAP.toString(), "0", "1")).toBe(false);
  });
});

describe("advertListing — new adverts (§6.2 listing rule)", () => {
  it("lists an advert whose checks all pass", () => {
    expect(advertListing(candidate(), LIVE, CTX)).toEqual({ listed: true });
  });

  it.each([
    ["the creating tx did not list supplier_pkh as a required signer", candidate({ creator_signed: 0 }), LIVE, "notSigned"],
    ["no live record output at the identity address", candidate(), { hasRecord: false, facts: facts() }, "noRecord"],
    ["no gateway answer yet", candidate(), { hasRecord: true, facts: null }, "noIdentityResult"],
    ["a record change after the answer", candidate(), { hasRecord: true, facts: facts({ invalidated_at: NOW }) }, "identityChanged"],
    ["an answer older than 10 minutes", candidate(), { hasRecord: true, facts: facts({ resolved_at: NOW - 600_001 }) }, "identityResultExpired"],
    ["the gateway answered NOT_FOUND", candidate(), { hasRecord: true, facts: facts({ found: 0, effective: null }) }, "notFound"],
    ["effective status suspended", candidate(), { hasRecord: true, facts: facts({ effective: "suspended" }) }, "notActive"],
    ["effective status revoked", candidate(), { hasRecord: true, facts: facts({ effective: "revoked" }) }, "notActive"],
    ["a subagent", candidate(), { hasRecord: true, facts: facts({ independent: 0 }) }, "notIndependent"],
    ["a legacy record", candidate(), { hasRecord: true, facts: facts({ origin: "legacy" }) }, "legacyRecord"],
    ["supplier_pkh is not a transaction key", candidate(), { hasRecord: true, facts: facts({ transaction_keys: "[]" }) }, "keyNotListed"],
    ["the capability is missing", candidate({ capability_id: "ocr.extract.v1" }), LIVE, "capabilityMissing"],
  ] as const)("refuses when %s", (_name, advert, record, reason) => {
    expect(advertListing(advert, record, CTX)).toEqual({ listed: false, reason });
  });

  it("an answer exactly 10 minutes old still counts", () => {
    expect(advertListing(candidate(), { hasRecord: true, facts: facts({ resolved_at: NOW - 600_000 }) }, CTX).listed).toBe(true);
  });

  it("an adopted record counts like a native one", () => {
    expect(advertListing(candidate(), { hasRecord: true, facts: facts({ origin: "adopted" }) }, CTX).listed).toBe(true);
  });
});

// ─── Worker + cache + HTTP views ──────────────────────────────────────────────

const ADDRESSES: ScriptAddresses = {
  advertAddress: ADVERT_SCRIPT_ADDRESS,
  escrowAddress: ESCROW_SCRIPT_ADDRESS,
  identityAdvertAddress: IDENTITY_ADVERT_SCRIPT_ADDRESS,
  identityEscrowAddress: IDENTITY_ESCROW_SCRIPT_ADDRESS,
  identityAddress: IDENTITY_ADDRESS,
  identityPolicyId: IDENTITY_POLICY_ID,
};

const RECORD_TX = "52".repeat(32);
const ADVERT_TX = "53".repeat(32);
const ESCROW_TX = "54".repeat(32);

function block(slot: number, txs: MockTx[]): MockChainEvent {
  return { kind: "block", block: buildMockBlock({ slot, id: slot.toString(16).padStart(64, "0"), transactions: txs }) as IndexerBlock };
}

interface World {
  clock: { now: number };
  cache: SqliteCache;
  source: MockChainSyncSource;
  worker: ChainSyncWorker;
  changes: string[][];
}

function world(opts: { switchSlot?: number } = {}): World {
  const clock = { now: NOW };
  const cache = new SqliteCache(":memory:", {
    listing: { identityAddress: IDENTITY_ADDRESS, switchSlot: opts.switchSlot ?? null, now: () => clock.now },
  });
  const source = new MockChainSyncSource([]);
  const worker = new ChainSyncWorker({ source, cache, addresses: ADDRESSES, networkId: 0, now: () => clock.now });
  const changes: string[][] = [];
  worker.on("identity-change", (ids: string[]) => changes.push(ids));
  return { clock, cache, source, worker, changes };
}

/** What the refresher stores after a "found" answer for AGENT_ID. */
function storeActiveFacts(cache: SqliteCache, at: number): void {
  cache.saveIdentityFacts({
    agent_id: AGENT_ID, found: 1, effective: "active", independent: 1, origin: "native",
    transaction_keys: JSON.stringify([INDEXER_SUPPLIER_PKH]), capabilities: JSON.stringify(["llm.text.generate.v1"]),
    detail: null, resolved_at: at,
  });
}

async function marketplace(w: World): Promise<void> {
  await w.worker.start();
  w.source.pushEvent(block(100, [buildPostAdvertTx({ txId: "51".repeat(32) })]));
  w.source.pushEvent(block(200, [buildIdentityRecordTx({ txId: RECORD_TX, agentId: AGENT_ID })]));
  w.source.pushEvent(block(300, [
    buildIdentityPostAdvertTx({ txId: ADVERT_TX }),
    buildIdentityPostAdvertTx({ txId: "55".repeat(32), requiredSigners: [THIRD_PARTY_PKH] }),
    buildIdentityPostAdvertTx({ txId: "56".repeat(32), datum: { priceLovelace: CAP } }),
    buildIdentityPostAdvertTx({ txId: "57".repeat(32), datum: { agentId: OTHER_AGENT_ID } }),
  ]));
}

describe("ChainSyncWorker + SqliteCache — listing", () => {
  it("stores layout, agent_id and the required-signer check of each advert", async () => {
    const w = world();
    await marketplace(w);
    expect(w.cache.getAdvertisementByRef(`${ADVERT_TX}#0`)).toMatchObject({ layout: "identity", agent_id: AGENT_ID, creator_signed: 1 });
    expect(w.cache.getAdvertisementByRef(`${"55".repeat(32)}#0`)).toMatchObject({ creator_signed: 0 });
    expect(w.cache.getAdvertisementByRef(`${"51".repeat(32)}#0`)).toMatchObject({ layout: "legacy", agent_id: null });
    expect(w.cache.getUnspentUtxos(IDENTITY_ADDRESS).map((u) => [u.ref, u.agent_id])).toEqual([[`${RECORD_TX}#0`, AGENT_ID]]);
    expect(w.changes).toEqual([[AGENT_ID]]);
    w.cache.close();
  });

  it("lists the legacy advert and only the new advert that passes the rule", async () => {
    const w = world();
    await marketplace(w);
    expect(w.cache.listIdentityAgentsToResolve()).toEqual([AGENT_ID]);
    expect(w.cache.listActiveAdvertisements().map((a) => a.utxo_ref)).toEqual([`${"51".repeat(32)}#0`]);
    storeActiveFacts(w.cache, NOW);
    expect(w.cache.listActiveAdvertisements().map((a) => a.utxo_ref)).toEqual([`${ADVERT_TX}#0`, `${"51".repeat(32)}#0`]);
    w.cache.close();
  });

  it("from the switch slot on, only listed new adverts appear", async () => {
    const w = world({ switchSlot: 300 });
    await marketplace(w);
    storeActiveFacts(w.cache, NOW);
    expect(w.cache.listActiveAdvertisements().map((a) => a.utxo_ref)).toEqual([`${ADVERT_TX}#0`]);
    w.cache.close();
  });

  it("a record change at the identity address unlists the advert until the next answer", async () => {
    const w = world();
    await marketplace(w);
    storeActiveFacts(w.cache, NOW);
    w.clock.now = NOW + 5_000;
    w.source.pushEvent(block(400, [buildIdentityRecordTx({ txId: "58".repeat(32), agentId: AGENT_ID, spentRef: { txId: RECORD_TX, index: 0 } })]));
    expect(w.changes.at(-1)).toEqual([AGENT_ID]);
    expect(w.cache.getIdentityFacts([AGENT_ID]).get(AGENT_ID)!.invalidated_at).toBe(NOW + 5_000);
    expect(w.cache.listActiveAdvertisements().map((a) => a.layout)).toEqual(["legacy"]);
    storeActiveFacts(w.cache, NOW + 6_000);
    expect(w.cache.listActiveAdvertisements().map((a) => a.layout)).toEqual(["identity", "legacy"]);
    w.cache.close();
  });

  it("a rollback of a record change invalidates the answer too", async () => {
    const w = world();
    await marketplace(w);
    w.source.pushEvent(block(400, [buildIdentityRecordTx({ txId: "58".repeat(32), agentId: AGENT_ID, spentRef: { txId: RECORD_TX, index: 0 } })]));
    storeActiveFacts(w.cache, NOW + 1);
    w.source.pushEvent({ kind: "rollback", point: { slot: 350, id: "abc" } });
    expect(w.changes.at(-1)).toEqual([AGENT_ID]);
    expect(w.cache.getIdentityFacts([AGENT_ID]).get(AGENT_ID)!.invalidated_at).not.toBeNull();
    expect(w.cache.getUnspentUtxos(IDENTITY_ADDRESS).map((u) => u.ref)).toEqual([`${RECORD_TX}#0`]);
    w.cache.close();
  });

  it("GET /suppliers shows agent_id for the new advert and null for the legacy advert", async () => {
    const w = world();
    await marketplace(w);
    storeActiveFacts(w.cache, NOW);
    const app = createApp({ cache: w.cache, worker: w.worker } as IndexerDeps);
    const res = await request(app).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body.map((s: { utxo_ref: string; agent_id: string | null }) => [s.utxo_ref, s.agent_id])).toEqual([
      [`${ADVERT_TX}#0`, AGENT_ID],
      [`${"51".repeat(32)}#0`, null],
    ]);
    const caps = await request(app).get("/capabilities");
    expect(caps.body).toEqual([{ capability_id: "llm.text.generate.v1", supplier_count: 2 }]);
    w.cache.close();
  });
});

describe("ChainSyncWorker + SqliteCache — new escrows", () => {
  async function escrowWorld() {
    const w = world();
    await w.worker.start();
    w.source.pushEvent(block(500, [buildIdentityPostEscrowTx({ txId: ESCROW_TX })]));
    return w;
  }

  it("stores the layout, agent_id and the refund of a new escrow", async () => {
    const w = await escrowWorld();
    expect(w.cache.getEscrowByRef(`${ESCROW_TX}#0`)).toMatchObject({
      layout: "identity",
      agent_id: AGENT_ID,
      refund_address: BUYER_REFUND_ADDRESS,
      refund_datum: null,
    });
    w.cache.close();
  });

  it("stores a refund datum as Plutus Data CBOR hex", async () => {
    const w = world();
    await w.worker.start();
    w.source.pushEvent(block(500, [buildIdentityPostEscrowTx({ txId: "59".repeat(32), datum: { refund: VAULT_REFUND } })]));
    const row = w.cache.getEscrowByRef(`${"59".repeat(32)}#0`)!;
    expect(row.refund_address).toMatch(/^addr_test1z/); // script payment, key stake credential
    expect(row.refund_datum).toBe("d8799f44ababababff"); // Constr 0 [bytes abababab]
    w.cache.close();
  });

  it("Claim → Submit → RefundRevoked by a third party ends the lineage with RefundRevokedEscrow", async () => {
    const w = await escrowWorld();
    const claimTx = "5a".repeat(32);
    const submitTx = "5b".repeat(32);
    const revokedTx = "5c".repeat(32);
    w.source.pushEvent(block(510, [buildIdentityEscrowSpendTx({
      txId: claimTx, spentRef: { txId: ESCROW_TX, index: 0 }, redeemer: "Claim", continuing: { state: "Claimed" },
    })]));
    w.source.pushEvent(block(520, [buildIdentityEscrowSpendTx({
      txId: submitTx, spentRef: { txId: claimTx, index: 0 }, redeemer: "Submit", continuing: submittedIdentityEscrowOpts(),
    })]));
    w.source.pushEvent(block(530, [buildIdentityEscrowSpendTx({
      txId: revokedTx, spentRef: { txId: submitTx, index: 0 }, redeemer: "RefundRevoked", signers: [THIRD_PARTY_PKH],
    })]));

    const lineage = w.cache.getEscrowLineage(`${ESCROW_TX}#0`)!;
    expect(lineage.rows.map((r) => r.state)).toEqual(["Open", "Claimed", "Submitted"]);
    expect(lineage.terminal).toEqual({ type: "RefundRevokedEscrow", tx_hash: revokedTx });

    const app = createApp({ cache: w.cache, worker: w.worker } as IndexerDeps);
    const res = await request(app).get(`/escrows/${encodeURIComponent(`${ESCROW_TX}#0`)}/lineage`);
    expect(res.status).toBe(200);
    expect(res.body.terminal).toEqual({ type: "RefundRevokedEscrow", tx_hash: revokedTx });
    expect(res.body.rows[0]).toMatchObject({ layout: "identity", agent_id: AGENT_ID, refund: { address: BUYER_REFUND_ADDRESS, datum: null } });
    w.cache.close();
  });

  it("a third-party Reclaim is recorded as a Reclaim", async () => {
    const w = await escrowWorld();
    w.source.pushEvent(block(540, [buildIdentityEscrowSpendTx({
      txId: "5d".repeat(32), spentRef: { txId: ESCROW_TX, index: 0 }, redeemer: "Reclaim", signers: [THIRD_PARTY_PKH],
    })]));
    expect(w.cache.getEscrowLineage(`${ESCROW_TX}#0`)!.terminal).toEqual({ type: "ReclaimEscrow", tx_hash: "5d".repeat(32) });
    w.cache.close();
  });

  it("an escrow above the value cap is not routable and not in the supplier list, but the buyer still sees it", async () => {
    const w = await escrowWorld();
    w.source.pushEvent(block(550, [buildIdentityPostEscrowTx({ txId: "5e".repeat(32), datum: { paymentLovelace: CAP } })]));
    const app = createApp({ cache: w.cache, worker: w.worker } as IndexerDeps);

    const buyer = await request(app).get(`/escrows?buyer=${INDEXER_BUYER_PKH}`);
    expect(buyer.body.map((e: { utxo_ref: string; routable: boolean }) => [e.utxo_ref, e.routable])).toEqual([
      [`${"5e".repeat(32)}#0`, false],
      [`${ESCROW_TX}#0`, true],
    ]);
    const supplier = await request(app).get(`/escrows?supplier=${INDEXER_SUPPLIER_PKH}`);
    expect(supplier.body.map((e: { utxo_ref: string }) => e.utxo_ref)).toEqual([`${ESCROW_TX}#0`]);
    const single = await request(app).get(`/escrows/${encodeURIComponent(`${"5e".repeat(32)}#0`)}`);
    expect(single.body).toMatchObject({ routable: false, layout: "identity", agent_id: AGENT_ID });
    w.cache.close();
  });
});
