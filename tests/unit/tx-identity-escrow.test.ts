/**
 * tx-identity-escrow.test.ts — the escrow builders on the identity layout
 * (new escrow, Part 2 §6.1, §6.5), mock backend.
 *
 * Covers, for Post, Claim, Submit, Accept, Reclaim, Release and
 * RefundRevoked: the datum they write, the agent record as a reference input,
 * the validity range (hi − lo ≤ 1 h), the value cap of Post and Claim, the
 * listing rule of Post, the record checks of Claim and Submit, and the refund
 * rules (refund address and datum, Reclaim by any wallet, RefundRevoked).
 * For the legacy layout during the drain: the value cap of Post and the
 * range rule of the spends (the legacy builders' own tests cover the rest).
 * The live builders and the script itself: tx-identity-escrow-live.test.ts
 * and tests/identity-builders (offline evaluation with aiken).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import {
  decodeIdentityEscrowDatum, encodeIdentityEscrowDatum, type IdentityEscrowDatum,
} from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodePlutusDataHex } from "../../packages/shared/src/cbor/plutus-data.js";
import { plutusAddressFromBech32 } from "../../packages/shared/src/cbor/address.js";
import type { IdentityDatum } from "../../packages/shared/src/cbor/IdentityDatum.js";
import type { IdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import type { IdentityBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import {
  buildAcceptTx, buildClaimTx, buildPostChatEscrowTx, buildPostEscrowTx, buildPostOcrEscrowTx, buildPostTtsEscrowTx,
  buildReclaimTx, buildRefundRevokedTx, buildReleaseTx, buildSubmitTx, escrowLockFloor, MAX_RANGE_MS, refundAllowed,
  TxConstructionError, type ClaimParams, type PostEscrowParams, type RecordLookup, type SubmitParams,
} from "../../packages/shared/src/tx/index.js";
import { pkhToEnterpriseAddress } from "../../packages/shared/src/tx/internal/pkhAddress.js";
import { utf8ToHex } from "../../packages/shared/src/identity/id.js";
import { testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";
import {
  accountableParty, advertUtxo, AGENT_ID, agentRecord, AP3X, CAPABILITY, identityAdvert, recordUtxo, testWallet, tombstone,
} from "../fixtures/identity-builders/world.js";

const NOW_MS = 1_780_000_000_000;
const PROMPT_HASH = "c3".repeat(32);
const RECEIPT_HASH = "e5".repeat(32);
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
const ESCROW_REF: OutputReference = { txHash: "e0".repeat(32), index: 0 };

const buyer = testWallet("buyer", 0);
const supplier = testWallet("supplier", 0);
const controller = testWallet("controller");
const stranger = testWallet("stranger", 0);
let blueprint: IdentityBlueprint;

beforeAll(() => {
  blueprint = testIdentityBlueprint();
});

interface MockBody {
  type: string;
  inputs: OutputReference[];
  referenceInputs?: OutputReference[];
  outputs: Array<{ address: string; lovelace: bigint; datumHex: string | null; assets: Record<string, bigint> }>;
  requiredSigners: string[];
  validityRange?: { lowerBoundMs: number; upperBoundMs: number };
  redeemer?: string;
  meta?: Record<string, unknown>;
}

/** The JSON of a synthetic (mock backend) transaction. */
function mockBody(txCborHex: string): MockBody {
  const length = parseInt(txCborHex.slice(0, 8), 16);
  const json = Buffer.from(txCborHex.slice(8, 8 + 2 * length), "hex").toString("utf8");
  return JSON.parse(json, (_key, value) => (typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value));
}

function expectRangeWithinOneHour(body: MockBody): void {
  const range = body.validityRange!;
  expect(range.upperBoundMs - range.lowerBoundMs).toBeGreaterThan(0);
  expect(range.upperBoundMs - range.lowerBoundMs).toBeLessThanOrEqual(MAX_RANGE_MS);
}

function chainAt(ms: number): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor(ms / 1000));
  return chain;
}

function lookupOf(record: IdentityDatum | Utxo | null): RecordLookup {
  const utxo = record === null || "ref" in record ? record : recordUtxo(blueprint, record);
  return async (agentId) => (agentId === AGENT_ID ? utxo : null);
}

const activeRecord = (): IdentityDatum => agentRecord(controller, supplier);

/** An identity escrow at the new escrow address (mock: testnet). */
function escrowDatum(changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
  return {
    buyer_pkh: buyer.pubKeyHash,
    supplier_pkh: supplier.pubKeyHash,
    advert_ref: ADVERT_REF,
    capability_id: CAPABILITY,
    request_spec_hash: "1b".repeat(32),
    prompt_hash: PROMPT_HASH,
    payment_lovelace: 2n * AP3X,
    buyer_bond_lovelace: AP3X,
    supplier_bond_lovelace: AP3X,
    deliver_by: NOW_MS + 90_000,
    posted_at: NOW_MS,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    agent_id: AGENT_ID,
    refund: { address: plutusAddressFromBech32(buyer.address), datum: null },
    ...changes,
  };
}

function seedEscrow(chain: MockChainProvider, datum: IdentityEscrowDatum, lovelace = 4_500_000n, address?: string): Utxo {
  const utxo: Utxo = {
    ref: ESCROW_REF,
    address: address ?? blueprint.escrowScriptAddress(0),
    lovelace,
    assets: {},
    datumHex: encodeIdentityEscrowDatum(datum),
    scriptRef: null,
  };
  chain.seed(utxo);
  return utxo;
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TxConstructionError);
    return (err as TxConstructionError).reason;
  }
  throw new Error("expected a TxConstructionError");
}

// ─── Post ──────────────────────────────────────────────────────────────

describe("Post on a new advert (identity layout)", () => {
  const signers = async (): Promise<string[]> => [supplier.pubKeyHash];

  function postChain(advertChanges: Partial<IdentityAdvertDatum> = {}, address?: string): MockChainProvider {
    const chain = chainAt(NOW_MS);
    const utxo = advertUtxo(blueprint, identityAdvert(supplier, advertChanges), ADVERT_REF, 0);
    chain.seed(address === undefined ? utxo : { ...utxo, address });
    return chain;
  }

  const post = (chain: MockChainProvider, changes: Partial<PostEscrowParams> = {}) =>
    buildPostEscrowTx({
      chain,
      buyerKey: buyer,
      advertRef: ADVERT_REF,
      prompt_hash: PROMPT_HASH,
      payment_lovelace: 2n * AP3X,
      lookupRecord: lookupOf(activeRecord()),
      lookupAdvertSigners: signers,
      identityBlueprint: blueprint,
      ...changes,
    });

  it("writes the 16-field datum: agent_id from the advert, refund = the buyer's own address with no datum", async () => {
    const chain = postChain();
    const built = await post(chain);
    const output = mockBody(built.txCborHex).outputs[0]!;
    expect(output.address).toBe(blueprint.escrowScriptAddress(0));
    const datum = decodeIdentityEscrowDatum(output.datumHex!);
    expect(datum.agent_id).toBe(AGENT_ID);
    expect(datum.refund).toEqual({
      address: { paymentCredential: { type: "VerificationKey", hash: buyer.pubKeyHash }, stakeCredential: null },
      datum: null,
    });
    expect(datum.state).toBe("Open");
    expect(datum.supplier_pkh).toBe(supplier.pubKeyHash);
    expect(output.lovelace).toBe(escrowLockFloor(datum, 4n * AP3X));
    expect((await chain.queryUtxo(built.escrowOutputRef))?.address).toBe(blueprint.escrowScriptAddress(0));
  });

  it("sets hi = min(deliver_by, lo + 1 h): a 60-minute advert gets a one-hour range", async () => {
    const long = mockBody((await post(postChain({ max_processing_ms: 3_600_000 }))).txCborHex);
    expect(long.validityRange).toEqual({ lowerBoundMs: NOW_MS, upperBoundMs: NOW_MS + MAX_RANGE_MS });
    const short = mockBody((await post(postChain())).txCborHex);
    expect(short.validityRange).toEqual({ lowerBoundMs: NOW_MS, upperBoundMs: NOW_MS + 60_000 + 30_000 });
  });

  it("refuses payment + bonds above 10,000 AP3X (F-29) and accepts exactly 10,000 AP3X", async () => {
    const over = { price_lovelace: 9_998n * AP3X, buyer_bond_lovelace: AP3X, supplier_bond_lovelace: AP3X + 1n };
    expect(await reason(post(postChain(over), { payment_lovelace: 9_998n * AP3X }))).toBe("escrow above value cap");
    const exact = { price_lovelace: 9_998n * AP3X, buyer_bond_lovelace: AP3X, supplier_bond_lovelace: AP3X };
    const built = await post(postChain(exact), { payment_lovelace: 9_998n * AP3X });
    expect(mockBody(built.txCborHex).outputs[0]!.lovelace).toBe(10_000n * AP3X);
  });

  it("refuses a negative bond", async () => {
    expect(await reason(post(postChain({ buyer_bond_lovelace: -1n })))).toBe("negative escrow amount");
  });

  it("applies the listing rule: creating transaction signed by supplier_pkh, record checks", async () => {
    expect(await reason(post(postChain(), { lookupAdvertSigners: async () => [buyer.pubKeyHash] }))).toBe("advert not listed");
    expect(await reason(post(postChain(), { lookupAdvertSigners: async () => null }))).toBe("advert signers unknown");
    expect(await reason(post(postChain(), { lookupAdvertSigners: undefined }))).toBe("advert signers lookup required");
    expect(await reason(post(postChain(), { lookupRecord: undefined }))).toBe("agent record lookup required");
    expect(await reason(post(postChain(), { lookupRecord: lookupOf(null) }))).toBe("agent record not found");
    const record = activeRecord();
    expect(await reason(post(postChain(), { lookupRecord: lookupOf({ ...record, capabilities: [utf8ToHex("other.v1")] }) })))
      .toBe("capability not listed");
    expect(await reason(post(postChain(), { lookupRecord: lookupOf({ ...record, keys: [{ ...record.keys[0]!, purposes: 1 }] }) })))
      .toBe("supplier key not listed");
    const suspended = { ...record, status: { type: "Suspended" as const, holds: [{ by: { type: "ControllerSet" as const }, reason: 1, since: NOW_MS - 1000, until: NOW_MS + 1000 }] } };
    expect(await reason(post(postChain(), { lookupRecord: lookupOf(suspended) }))).toBe("agent not active");
    expect(await reason(post(postChain(), { lookupRecord: lookupOf({ ...record, parties: [] }) }))).toBe("agent not active");
    const revoked = tombstone(record, { type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: NOW_MS - 5000, invalidFrom: null, successor: null });
    expect(await reason(post(postChain(), { lookupRecord: lookupOf(revoked) }))).toBe("agent not active");
    const child = { ...record, lineage: { type: "Subagent" as const, parent: "ee".repeat(32), parentEpoch: 0, depth: 1 } };
    expect(await reason(post(postChain(), { lookupRecord: lookupOf(child) }))).toBe("agent not independent");
  });

  it("refuses a record output that is not authentic", async () => {
    const utxo = recordUtxo(blueprint, activeRecord());
    const notAuthentic: Utxo[] = [
      { ...utxo, address: blueprint.escrowScriptAddress(1) },
      { ...utxo, assets: { ...utxo.assets, [`${blueprint.identityHash}${"00".repeat(32)}`]: 1n } },
      { ...utxo, assets: { [`${blueprint.identityHash}${AGENT_ID}`]: 2n } },
      { ...utxo, assets: {} },
      { ...utxo, datumHex: null },
      { ...utxo, datumHex: encodePlutusDataHex({ kind: "int", value: 1n }) },
    ];
    for (const record of notAuthentic) {
      expect(await reason(post(postChain(), { lookupRecord: async () => record }))).toBe("agent record not authentic");
    }
    // The Ogmios chain providers write units as "policy.name".
    const dotted = { ...utxo, assets: { [`${blueprint.identityHash}.${AGENT_ID}`]: 1n } };
    await expect(post(postChain(), { lookupRecord: async () => dotted })).resolves.toBeDefined();
  });

  it("refuses a 14-field advert that is not at the new advert script", async () => {
    expect(await reason(post(postChain({}, loadBlueprint().advertScriptAddress(0))))).toBe("advert not listed");
  });

  it("pins the layout with escrowLayout, and keeps legacy adverts on the legacy escrow", async () => {
    expect(await reason(post(postChain(), { escrowLayout: "legacy" }))).toBe("advert layout mismatch");
    const chain = chainAt(NOW_MS);
    const { agent_id: _agentId, ...legacyAdvert } = identityAdvert(supplier);
    chain.seed({ ...advertUtxo(blueprint, identityAdvert(supplier), ADVERT_REF, 0), address: loadBlueprint().advertScriptAddress(0), datumHex: encodeAdvertDatum(legacyAdvert) });
    expect(await reason(post(chain, { escrowLayout: "identity" }))).toBe("advert layout mismatch");
    const built = await post(chain, { escrowLayout: "legacy" });
    const output = mockBody(built.txCborHex).outputs[0]!;
    expect(output.address).toBe(loadBlueprint().escrowScriptAddress(0));
    expect(decodeEscrowDatum(output.datumHex!).state).toBe("Open");
    expect(mockBody(built.txCborHex).validityRange!.upperBoundMs - mockBody(built.txCborHex).validityRange!.lowerBoundMs)
      .toBeLessThanOrEqual(MAX_RANGE_MS);
  });

  it("refuses a buyer address that does not pay to the buyer key", async () => {
    expect(await reason(post(postChain(), { buyerKey: { ...buyer, address: stranger.address } }))).toBe("buyer address mismatch");
  });

  it("gives the chat, OCR and TTS Post builders the same layout handling", async () => {
    const options = { lookupRecord: lookupOf(activeRecord()), lookupAdvertSigners: signers, identityBlueprint: blueprint };
    const base = { buyerKey: buyer, advertRef: ADVERT_REF, payment_lovelace: 2n * AP3X, ...options };
    const built = [
      await buildPostChatEscrowTx({ chain: postChain(), session_nonce: "n1", ...base }),
      await buildPostOcrEscrowTx({ chain: postChain(), prompt_hash: PROMPT_HASH, ...base }),
      await buildPostTtsEscrowTx({ chain: postChain(), prompt_hash: PROMPT_HASH, ...base }),
    ];
    for (const result of built) {
      const body = mockBody(result.txCborHex);
      expect(decodeIdentityEscrowDatum(body.outputs[0]!.datumHex!).agent_id).toBe(AGENT_ID);
      expectRangeWithinOneHour(body);
    }
    const over = { price_lovelace: 10_001n * AP3X };
    expect(await reason(buildPostChatEscrowTx({ chain: postChain(over), session_nonce: "n1", ...base, payment_lovelace: 10_001n * AP3X })))
      .toBe("escrow above value cap");
  });
});

// ─── Claim ─────────────────────────────────────────────────────────────

describe("Claim on the new escrow", () => {
  const claim = (chain: MockChainProvider, changes: Partial<ClaimParams> = {}) =>
    buildClaimTx({
      chain,
      supplierKey: supplier,
      escrowRef: ESCROW_REF,
      lookupRecord: lookupOf(activeRecord()),
      identityBlueprint: blueprint,
      ...changes,
    });

  it("keeps the value, writes Claimed with agent_id and refund unchanged, and reads the record", async () => {
    const chain = chainAt(NOW_MS + 10_000);
    const before = escrowDatum();
    const input = seedEscrow(chain, before);
    const body = mockBody((await claim(chain)).txCborHex);
    expect(body.inputs).toEqual([ESCROW_REF]);
    expect(body.referenceInputs).toEqual([recordUtxo(blueprint, activeRecord()).ref]);
    expect(body.redeemer).toBe("Claim");
    expect(body.requiredSigners).toEqual([supplier.pubKeyHash]);
    expect(body.outputs).toHaveLength(1);
    expect(body.outputs[0]!.address).toBe(blueprint.escrowScriptAddress(0));
    expect(body.outputs[0]!.lovelace).toBe(input.lovelace);
    expect(decodeIdentityEscrowDatum(body.outputs[0]!.datumHex!)).toEqual({ ...before, state: "Claimed" });
    expect(body.validityRange).toEqual({ lowerBoundMs: NOW_MS + 10_000 - 60_000, upperBoundMs: before.deliver_by });
  });

  it("sets hi = min(deliver_by, lo + 1 h) for a long deadline", async () => {
    const chain = chainAt(NOW_MS + 10_000);
    seedEscrow(chain, escrowDatum({ deliver_by: NOW_MS + 3_630_000 }));
    const body = mockBody((await claim(chain)).txCborHex);
    const lo = NOW_MS + 10_000 - 60_000;
    expect(body.validityRange).toEqual({ lowerBoundMs: lo, upperBoundMs: lo + MAX_RANGE_MS });
    expectRangeWithinOneHour(body);
  });

  it("checks the record over the claim window [lo, hi]", async () => {
    const chain = chainAt(NOW_MS + 10_000);
    seedEscrow(chain, escrowDatum());
    const record = activeRecord();
    // The Accountable Party ends before hi = deliver_by.
    const ending = { ...record, parties: [accountableParty(0, NOW_MS + 60_000)] };
    expect(await reason(claim(chain, { lookupRecord: lookupOf(ending) }))).toBe("agent not active");
    // A hold that ends before lo is not in force.
    const oldHold = { ...record, status: { type: "Suspended" as const, holds: [{ by: { type: "ControllerSet" as const }, reason: 1, since: NOW_MS - 100_000, until: NOW_MS - 60_000 }] } };
    await expect(claim(chain, { lookupRecord: lookupOf(oldHold) })).resolves.toBeDefined();
  });

  it("refuses when a §6.1 check fails", async () => {
    const record = activeRecord();
    const fresh = (datum = escrowDatum(), lovelace?: bigint) => {
      const chain = chainAt(NOW_MS + 10_000);
      seedEscrow(chain, datum, lovelace);
      return chain;
    };
    expect(await reason(claim(fresh(), { lookupRecord: undefined }))).toBe("agent record lookup required");
    expect(await reason(claim(fresh(), { lookupRecord: lookupOf({ ...record, capabilities: [] }) }))).toBe("capability not listed");
    expect(await reason(claim(fresh(), { lookupRecord: lookupOf({ ...record, keys: [] }) }))).toBe("supplier key not listed");
    expect(await reason(claim(fresh(escrowDatum({ payment_lovelace: 10_000n * AP3X })))))
      .toBe("escrow above value cap");
    expect(await reason(claim(fresh(escrowDatum(), 10_005_000_001n)))).toBe("escrow input above cap");
    expect(await reason(claim(fresh(escrowDatum({ supplier_bond_lovelace: -1n }))))).toBe("negative escrow amount");
    expect(await reason(claim(fresh(escrowDatum({ state: "Claimed" }))))).toBe("wrong state");
    expect(await reason(claim(fresh(), { supplierKey: stranger }))).toBe("supplier signature mismatch");
    const late = chainAt(NOW_MS + 90_000);
    seedEscrow(late, escrowDatum());
    expect(await reason(claim(late))).toBe("claim after deliver_by");
  });

  it("refuses a 16-field datum that is not at the new escrow script", async () => {
    const chain = chainAt(NOW_MS + 10_000);
    seedEscrow(chain, escrowDatum(), 4_500_000n, loadBlueprint().escrowScriptAddress(0));
    expect(await reason(claim(chain))).toBe("escrow layout mismatch");
  });
});

// ─── Submit ────────────────────────────────────────────────────────────

describe("Submit on the new escrow", () => {
  const submit = (chain: MockChainProvider, changes: Partial<SubmitParams> = {}) =>
    buildSubmitTx({
      chain,
      supplierKey: supplier,
      escrowRef: ESCROW_REF,
      receiptHash: RECEIPT_HASH,
      lookupRecord: lookupOf(activeRecord()),
      identityBlueprint: blueprint,
      ...changes,
    });

  it("stores submitted_at = hi and the receipt hash, reads the record, keeps agent_id and refund", async () => {
    const chain = chainAt(NOW_MS + 20_000);
    const claimed = escrowDatum({ state: "Claimed" });
    seedEscrow(chain, claimed);
    const body = mockBody((await submit(chain)).txCborHex);
    const hi = NOW_MS + 20_000 + 120_000 > claimed.deliver_by ? claimed.deliver_by : NOW_MS + 140_000;
    expect(body.validityRange).toEqual({ lowerBoundMs: NOW_MS + 20_000 - 60_000, upperBoundMs: hi });
    expect(body.redeemer).toBe("Submit");
    expect(body.referenceInputs).toHaveLength(1);
    expect(decodeIdentityEscrowDatum(body.outputs[0]!.datumHex!)).toEqual({
      ...claimed,
      state: "Submitted",
      submitted_at: hi,
      result_receipt_hash: RECEIPT_HASH,
    });
  });

  it("does not check the capability, but checks the key and the status", async () => {
    const record = activeRecord();
    const fresh = () => {
      const chain = chainAt(NOW_MS + 20_000);
      seedEscrow(chain, escrowDatum({ state: "Claimed" }));
      return chain;
    };
    await expect(submit(fresh(), { lookupRecord: lookupOf({ ...record, capabilities: [] }) })).resolves.toBeDefined();
    expect(await reason(submit(fresh(), { lookupRecord: lookupOf({ ...record, keys: [] }) }))).toBe("supplier key not listed");
    const retired = tombstone(record, { type: "Retired", at: NOW_MS, successor: null });
    expect(await reason(submit(fresh(), { lookupRecord: lookupOf(retired) }))).toBe("agent not active");
    expect(await reason(submit(fresh(), { lookupRecord: undefined }))).toBe("agent record lookup required");
  });

  it("refuses a second Submit and a late Submit", async () => {
    const chain = chainAt(NOW_MS + 20_000);
    seedEscrow(chain, escrowDatum({ state: "Submitted", submitted_at: NOW_MS, result_receipt_hash: RECEIPT_HASH }));
    expect(await reason(submit(chain))).toBe("double submit");
    const late = chainAt(NOW_MS + 90_000);
    seedEscrow(late, escrowDatum({ state: "Claimed" }));
    expect(await reason(submit(late))).toBe("submit after deliver_by");
  });
});

// ─── Accept and Release ────────────────────────────────────────────────

describe("Accept and Release on the new escrow", () => {
  const SUBMITTED_AT = NOW_MS + 50_000;
  const submitted = (changes: Partial<IdentityEscrowDatum> = {}) =>
    escrowDatum({ state: "Submitted", submitted_at: SUBMITTED_AT, result_receipt_hash: RECEIPT_HASH, ...changes });

  it("Accept pays the supplier and sends the buyer bond to the refund address; the buyer signs", async () => {
    const chain = chainAt(SUBMITTED_AT + 30_000);
    seedEscrow(chain, submitted());
    const body = mockBody((await buildAcceptTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(body.redeemer).toBe("Accept");
    expect(body.requiredSigners).toEqual([buyer.pubKeyHash]);
    expect(body.referenceInputs).toEqual([]);
    expect(body.outputs.map((o) => [o.address, o.lovelace, o.datumHex])).toEqual([
      [pkhToEnterpriseAddress(supplier.pubKeyHash, 0), 3n * AP3X, null],
      [buyer.address, 2n * AP3X, null],
    ]);
    expect(body.validityRange).toEqual({ lowerBoundMs: SUBMITTED_AT + 30_000 - 60_000, upperBoundMs: SUBMITTED_AT + 600_000 });
  });

  it("Accept pays the buyer bond with exactly the refund datum, at exactly the refund address", async () => {
    const chain = chainAt(SUBMITTED_AT + 30_000);
    const refundDatum = { kind: "constr" as const, index: 0n, fields: [{ kind: "bytes" as const, hex: "0a0b" }] };
    const refund = { address: plutusAddressFromBech32(stranger.address), datum: refundDatum };
    seedEscrow(chain, submitted({ refund }));
    const body = mockBody((await buildAcceptTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(body.outputs[1]).toMatchObject({ address: stranger.address, datumHex: encodePlutusDataHex(refundDatum) });
  });

  it("Accept without refund pays the buyer key; another key cannot accept; the window still applies", async () => {
    const chain = chainAt(SUBMITTED_AT + 30_000);
    seedEscrow(chain, submitted({ refund: null }));
    expect(await reason(buildAcceptTx({ chain, buyerKey: stranger, escrowRef: ESCROW_REF, identityBlueprint: blueprint })))
      .toBe("buyer signature mismatch");
    const body = mockBody((await buildAcceptTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(body.outputs[1]!.address).toBe(pkhToEnterpriseAddress(buyer.pubKeyHash, 0));
    const late = chainAt(SUBMITTED_AT + 600_001);
    seedEscrow(late, submitted());
    expect(await reason(buildAcceptTx({ chain: late, buyerKey: buyer, escrowRef: ESCROW_REF, identityBlueprint: blueprint })))
      .toBe("accept window expired");
  });

  it("Release pays everything to the supplier after the accept window", async () => {
    const early = chainAt(SUBMITTED_AT + 599_000);
    seedEscrow(early, submitted());
    expect(await reason(buildReleaseTx({ chain: early, supplierKey: supplier, escrowRef: ESCROW_REF, identityBlueprint: blueprint })))
      .toBe("release before accept window");
    const chain = chainAt(SUBMITTED_AT + 700_000);
    seedEscrow(chain, submitted());
    const body = mockBody((await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(body.redeemer).toBe("Release");
    expect(body.requiredSigners).toEqual([supplier.pubKeyHash]);
    expect(body.outputs.map((o) => [o.address, o.lovelace])).toEqual([[pkhToEnterpriseAddress(supplier.pubKeyHash, 0), 4n * AP3X]]);
    expect(body.validityRange!.lowerBoundMs).toBeGreaterThanOrEqual(SUBMITTED_AT + 600_000);
    expectRangeWithinOneHour(body);
  });
});

// ─── Reclaim ───────────────────────────────────────────────────────────

describe("Reclaim on the new escrow", () => {
  it("with refund: any wallet, no buyer signature, the whole value to refund.address", async () => {
    const chain = chainAt(NOW_MS + 100_000);
    const input = seedEscrow(chain, escrowDatum({ state: "Claimed" }), 4_620_000n);
    const body = mockBody((await buildReclaimTx({ chain, buyerKey: stranger, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(body.redeemer).toBe("Reclaim");
    expect(body.requiredSigners).toEqual([]);
    expect(body.outputs.map((o) => [o.address, o.lovelace, o.datumHex])).toEqual([[buyer.address, input.lovelace, null]]);
    expect(body.validityRange!.lowerBoundMs).toBeGreaterThanOrEqual(escrowDatum().deliver_by);
    expectRangeWithinOneHour(body);
  });

  it("without refund: the buyer signs and gets payment + bonds; another wallet is refused", async () => {
    const chain = chainAt(NOW_MS + 100_000);
    seedEscrow(chain, escrowDatum({ refund: null }));
    expect(await reason(buildReclaimTx({ chain, buyerKey: stranger, escrowRef: ESCROW_REF, identityBlueprint: blueprint })))
      .toBe("buyer signature mismatch");
    const body = mockBody((await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(body.requiredSigners).toEqual([buyer.pubKeyHash]);
    expect(body.outputs.map((o) => [o.address, o.lovelace])).toEqual([[pkhToEnterpriseAddress(buyer.pubKeyHash, 0), 4n * AP3X]]);
  });

  it("keeps the legacy timing and states", async () => {
    const early = chainAt(NOW_MS + 89_000);
    seedEscrow(early, escrowDatum());
    expect(await reason(buildReclaimTx({ chain: early, buyerKey: stranger, escrowRef: ESCROW_REF, identityBlueprint: blueprint })))
      .toBe("reclaim before deliver_by");
    const chain = chainAt(NOW_MS + 100_000);
    seedEscrow(chain, escrowDatum({ state: "Submitted", submitted_at: NOW_MS, result_receipt_hash: RECEIPT_HASH }));
    expect(await reason(buildReclaimTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF, identityBlueprint: blueprint })))
      .toBe("wrong state");
  });
});

// ─── RefundRevoked ─────────────────────────────────────────────────────

describe("RefundRevoked", () => {
  const revoked = (invalidFrom: number | null) => tombstone(activeRecord(), {
    type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: NOW_MS, invalidFrom, successor: null,
  });
  const retired = () => tombstone(activeRecord(), { type: "Retired", at: NOW_MS, successor: null });

  const refund = (chain: MockChainProvider, record: IdentityDatum | null) =>
    buildRefundRevokedTx({ chain, walletKey: stranger, escrowRef: ESCROW_REF, lookupRecord: lookupOf(record), identityBlueprint: blueprint });

  it("Open or Claimed with a Revoked or Retired record: any wallet, before deliver_by, full refund", async () => {
    for (const [state, record] of [["Open", revoked(null)], ["Claimed", retired()], ["Open", retired()]] as const) {
      const chain = chainAt(NOW_MS + 5_000);
      const input = seedEscrow(chain, escrowDatum({ state }), 4_620_000n);
      const body = mockBody((await refund(chain, record)).txCborHex);
      expect(body.redeemer).toBe("RefundRevoked");
      expect(body.requiredSigners).toEqual([]);
      expect(body.referenceInputs).toEqual([recordUtxo(blueprint, record).ref]);
      expect(body.outputs.map((o) => [o.address, o.lovelace, o.datumHex])).toEqual([[buyer.address, input.lovelace, null]]);
      expectRangeWithinOneHour(body);
    }
  });

  it("Submitted: only Revoked with invalid_from ≤ submitted_at", async () => {
    const submittedAt = NOW_MS - 1_000;
    const run = async (record: IdentityDatum) => {
      const chain = chainAt(NOW_MS + 5_000);
      seedEscrow(chain, escrowDatum({ state: "Submitted", submitted_at: submittedAt, result_receipt_hash: RECEIPT_HASH }));
      return refund(chain, record);
    };
    await expect(run(revoked(submittedAt))).resolves.toBeDefined();
    expect(await reason(run(revoked(submittedAt + 1)))).toBe("refund not allowed");
    expect(await reason(run(revoked(null)))).toBe("refund not allowed");
    expect(await reason(run(retired()))).toBe("refund not allowed");
  });

  it("refuses a live record, a missing lookup, and a legacy escrow", async () => {
    const chain = chainAt(NOW_MS + 5_000);
    seedEscrow(chain, escrowDatum());
    expect(await reason(refund(chain, activeRecord()))).toBe("refund not allowed");
    const suspended = { ...activeRecord(), status: { type: "Suspended" as const, holds: [{ by: { type: "ControllerSet" as const }, reason: 1, since: NOW_MS, until: NOW_MS + 10_000 }] } };
    expect(await reason(refund(chain, suspended))).toBe("refund not allowed");
    expect(await reason(buildRefundRevokedTx({ chain, walletKey: stranger, escrowRef: ESCROW_REF, lookupRecord: undefined as unknown as RecordLookup, identityBlueprint: blueprint })))
      .toBe("agent record lookup required");
    const legacy = chainAt(NOW_MS + 5_000);
    const { agent_id: _id, refund: _refund, ...legacyDatum } = escrowDatum();
    legacy.seed({ ref: ESCROW_REF, address: loadBlueprint().escrowScriptAddress(0), lovelace: 4n * AP3X, assets: {}, datumHex: encodeEscrowDatum(legacyDatum), scriptRef: null });
    expect(await reason(refund(legacy, revoked(null)))).toBe("escrow layout mismatch");
  });

  it("without refund pays the enterprise address of buyer_pkh", async () => {
    const chain = chainAt(NOW_MS + 5_000);
    seedEscrow(chain, escrowDatum({ refund: null }));
    const body = mockBody((await refund(chain, revoked(null))).txCborHex);
    expect(body.outputs[0]!.address).toBe(pkhToEnterpriseAddress(buyer.pubKeyHash, 0));
  });

  it("refundAllowed follows §6.1 for each state", () => {
    const active = { type: "Active" as const };
    const revokedAt = (invalidFrom: number | null) => ({ type: "Revoked" as const, by: { type: "ControllerSet" as const }, reason: 1, at: 0, invalidFrom, successor: null });
    expect(refundAllowed(escrowDatum(), active)).toBe(false);
    expect(refundAllowed(escrowDatum({ state: "Claimed" }), revokedAt(null))).toBe(true);
    expect(refundAllowed(escrowDatum({ state: "Submitted", submitted_at: 10 }), revokedAt(10))).toBe(true);
    expect(refundAllowed(escrowDatum({ state: "Submitted", submitted_at: 10 }), revokedAt(11))).toBe(false);
    expect(refundAllowed(escrowDatum({ state: "Accepted" }), revokedAt(0))).toBe(false);
  });
});

// ─── Legacy layout during the drain ────────────────────────────────────

describe("legacy layout during the drain (Part 2 §6.5, §9.6)", () => {
  /** A legacy escrow (14 fields) at the legacy escrow address. */
  function legacyEscrowChain(tipMs: number, changes: Partial<IdentityEscrowDatum> = {}): MockChainProvider {
    const chain = chainAt(tipMs);
    const { agent_id: _id, refund: _refund, ...legacy } = escrowDatum(changes);
    chain.seed({
      ref: ESCROW_REF, address: loadBlueprint().escrowScriptAddress(0), lovelace: 4n * AP3X, assets: {},
      datumHex: encodeEscrowDatum(legacy), scriptRef: null,
    });
    return chain;
  }

  /** A legacy advert (13 fields) at the legacy advert address. */
  function legacyAdvertChain(changes: Partial<IdentityAdvertDatum> = {}): MockChainProvider {
    const chain = chainAt(NOW_MS);
    const { agent_id: _id, ...legacy } = identityAdvert(supplier, changes);
    chain.seed({
      ref: ADVERT_REF, address: loadBlueprint().advertScriptAddress(0), lovelace: 2n * AP3X, assets: {},
      datumHex: encodeAdvertDatum(legacy), scriptRef: null,
    });
    return chain;
  }

  it("Post refuses payment + bonds above 10,000 AP3X (F-29) and a negative bond, as for a new escrow", async () => {
    const post = (chain: MockChainProvider, payment: bigint) =>
      buildPostEscrowTx({ chain, buyerKey: buyer, advertRef: ADVERT_REF, prompt_hash: PROMPT_HASH, payment_lovelace: payment });
    const over = { price_lovelace: 9_998n * AP3X, buyer_bond_lovelace: AP3X, supplier_bond_lovelace: AP3X + 1n };
    expect(await reason(post(legacyAdvertChain(over), 9_998n * AP3X))).toBe("escrow above value cap");
    const exact = { price_lovelace: 9_998n * AP3X, buyer_bond_lovelace: AP3X, supplier_bond_lovelace: AP3X };
    const output = mockBody((await post(legacyAdvertChain(exact), 9_998n * AP3X)).txCborHex).outputs[0]!;
    expect(output.address).toBe(loadBlueprint().escrowScriptAddress(0));
    expect(decodeEscrowDatum(output.datumHex!).payment_lovelace).toBe(9_998n * AP3X);
    expect(output.lovelace).toBe(10_000n * AP3X);
    expect(await reason(post(legacyAdvertChain({ buyer_bond_lovelace: -1n }), 2n * AP3X))).toBe("negative escrow amount");
  });

  it("Claim, Accept, Reclaim and Release keep hi − lo ≤ 1 h, also long after deliver_by and the accept window", async () => {
    const TWO_HOURS = 7_200_000;

    // Claim with deliver_by 2 h away: hi = lo + 1 h.
    let chain = legacyEscrowChain(NOW_MS, { deliver_by: NOW_MS + TWO_HOURS });
    let body = mockBody((await buildClaimTx({ chain, supplierKey: supplier, escrowRef: ESCROW_REF })).txCborHex);
    expect(body.validityRange).toEqual({ lowerBoundMs: NOW_MS, upperBoundMs: NOW_MS + MAX_RANGE_MS });

    // Accept within the window.
    chain = legacyEscrowChain(NOW_MS + 30_000, { state: "Submitted", submitted_at: NOW_MS, result_receipt_hash: RECEIPT_HASH });
    body = mockBody((await buildAcceptTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF })).txCborHex);
    expect(body.validityRange).toEqual({ lowerBoundMs: NOW_MS + 30_000, upperBoundMs: NOW_MS + 600_000 });

    // Reclaim just after deliver_by starts at deliver_by; 2 h later it starts at tip − 60 s.
    const deliverBy = escrowDatum().deliver_by;
    chain = legacyEscrowChain(deliverBy + 10_000);
    body = mockBody((await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF })).txCborHex);
    expect(body.validityRange).toEqual({ lowerBoundMs: deliverBy, upperBoundMs: deliverBy + 70_000 });
    chain = legacyEscrowChain(deliverBy + TWO_HOURS);
    body = mockBody((await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF })).txCborHex);
    expect(body.validityRange).toEqual({ lowerBoundMs: deliverBy + TWO_HOURS - 60_000, upperBoundMs: deliverBy + TWO_HOURS + 60_000 });

    // Release 2 h after the accept window starts at tip − 60 s.
    const threshold = NOW_MS + 600_000;
    chain = legacyEscrowChain(threshold + TWO_HOURS, { state: "Submitted", submitted_at: NOW_MS, result_receipt_hash: RECEIPT_HASH });
    body = mockBody((await buildReleaseTx({ chain, supplierKey: supplier, escrowRef: ESCROW_REF })).txCborHex);
    expect(body.validityRange).toEqual({ lowerBoundMs: threshold + TWO_HOURS - 60_000, upperBoundMs: threshold + TWO_HOURS + 60_000 });
    expectRangeWithinOneHour(body);
  });
});
