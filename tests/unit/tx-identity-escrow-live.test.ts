/**
 * tx-identity-escrow-live.test.ts — the live (lucid-evolution) transactions
 * of the identity layout, against a fake Ogmios whose evaluation returns a
 * fixed budget. The script itself runs in tests/identity-builders
 * (offline evaluation with aiken); this file checks the transaction shape:
 * script inputs, reference inputs, reference scripts of both escrows during
 * the drain (Part 2 §6.5), outputs, required signers and validity ranges
 * (hi − lo ≤ 1 h), also for the legacy Post and Claim.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CML } from "@lucid-evolution/lucid";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { decodeIdentityEscrowDatum, encodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { decodeEscrowRedeemer } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { decodeAdvertRedeemer, encodeIdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { plutusAddressFromBech32 } from "../../packages/shared/src/cbor/address.js";
import { loadBlueprint, type IdentityBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { MAX_RANGE_MS } from "../../packages/shared/src/identity/constants.js";
import {
  buildAcceptTx, buildClaimTx, buildPostAdvertTx, buildPostEscrowTx, buildReclaimTx, buildRefundRevokedTx, buildReleaseTx,
  buildRetireAdvertTx, buildSubmitTx, buildUpdateAdvertTx, TxConstructionError, type RecordLookup,
} from "../../packages/shared/src/tx/index.js";
import { loadEscrowScript } from "../../packages/shared/src/tx/internal/liveCbor.js";
import { inspectSignedTransactionFinancials, type SignedTransactionFinancials } from "../../packages/shared/src/tx/internal/signedTransaction.js";
import { pkhToEnterpriseAddress } from "../../packages/shared/src/tx/internal/pkhAddress.js";
import { testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";
import {
  advertUtxo, AGENT_ID, agentRecord, AP3X, FakeOgmios, identityAdvert, recordUtxo, testWallet, tombstone,
  VECTOR_MAINNET_ZERO_TIME_MS,
} from "../fixtures/identity-builders/world.js";

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0, 500);
const ESCROW_REF: OutputReference = { txHash: "e0".repeat(32), index: 0 };
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
const ESCROW_SCRIPT_REF: OutputReference = { txHash: "5c".repeat(32), index: 0 };
const ADVERT_SCRIPT_REF: OutputReference = { txHash: "5c".repeat(32), index: 1 };
const LEGACY_SCRIPT_REF: OutputReference = { txHash: "1e".repeat(32), index: 0 };

const buyer = testWallet("buyer");
const supplier = testWallet("supplier");
const controller = testWallet("controller");
const stranger = testWallet("stranger");
let blueprint: IdentityBlueprint;
let ogmios: FakeOgmios;

beforeAll(() => {
  blueprint = testIdentityBlueprint();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("VECTOR_ZERO_TIME_MS", String(VECTOR_MAINNET_ZERO_TIME_MS));
  vi.stubEnv("ESCROW_REF_UTXO", "");
  vi.stubEnv("ADVERT_REF_UTXO", "");
  vi.stubEnv("IDENTITY_ESCROW_REF_UTXO", "");
  vi.stubEnv("IDENTITY_ADVERT_REF_UTXO", "");
  ogmios = new FakeOgmios();
  for (const wallet of [buyer, supplier, stranger]) ogmios.fund(wallet, 100n * AP3X, 6n * AP3X);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const slotMs = (slot: bigint | undefined): number => VECTOR_MAINNET_ZERO_TIME_MS + Number(slot) * 1000;
const refString = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

interface DecodedTx {
  lo: number;
  hi: number;
  inputs: string[];
  referenceInputs: string[];
  requiredSigners: string[];
  witnessScripts: string[];
  redeemers: Array<{ index: number; dataHex: string }>;
  outputs: SignedTransactionFinancials["outputs"];
}

function decodeTx(txCborHex: string): DecodedTx {
  const tx = CML.Transaction.from_cbor_hex(txCborHex);
  const body = tx.body();
  const witnesses = tx.witness_set();
  const list = <T>(items: { len(): number; get(i: number): T } | undefined): T[] =>
    items === undefined ? [] : Array.from({ length: items.len() }, (_, i) => items.get(i));
  const redeemers = witnesses.redeemers()?.to_flat_format();
  return {
    lo: slotMs(body.validity_interval_start()),
    hi: slotMs(body.ttl()),
    inputs: list(body.inputs()).map((input) => `${input.transaction_id().to_hex()}#${input.index()}`),
    referenceInputs: list(body.reference_inputs()).map((input) => `${input.transaction_id().to_hex()}#${input.index()}`),
    requiredSigners: list(body.required_signers()).map((hash) => hash.to_hex()),
    witnessScripts: list(witnesses.plutus_v3_scripts()).map((script) => script.hash().to_hex()),
    redeemers: list(redeemers).map((r) => ({ index: Number(r.index()), dataHex: r.data().to_cbor_hex() })),
    outputs: inspectSignedTransactionFinancials(txCborHex).outputs,
  };
}

function expectRange(tx: DecodedTx): void {
  expect(tx.hi).toBeGreaterThan(tx.lo);
  expect(tx.hi - tx.lo).toBeLessThanOrEqual(MAX_RANGE_MS);
  expect((tx.hi - VECTOR_MAINNET_ZERO_TIME_MS) % 1000).toBe(0);
}

const activeRecord = () => agentRecord(controller, supplier);

function lookupOf(record = activeRecord()): RecordLookup {
  const utxo = recordUtxo(blueprint, record);
  return async (agentId) => (agentId === AGENT_ID ? utxo : null);
}

function escrowDatum(changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
  return {
    buyer_pkh: buyer.pubKeyHash,
    supplier_pkh: supplier.pubKeyHash,
    advert_ref: ADVERT_REF,
    capability_id: "llm.text.generate.v1",
    request_spec_hash: "1b".repeat(32),
    prompt_hash: "c3".repeat(32),
    payment_lovelace: 2n * AP3X,
    buyer_bond_lovelace: AP3X,
    supplier_bond_lovelace: AP3X,
    deliver_by: NOW_MS + 90_000,
    posted_at: NOW_MS - 10_000,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    agent_id: AGENT_ID,
    refund: { address: plutusAddressFromBech32(buyer.address), datum: null },
    ...changes,
  };
}

function seedEscrow(datum: IdentityEscrowDatum, lovelace = 4_620_000n): Utxo {
  const utxo: Utxo = {
    ref: ESCROW_REF,
    address: blueprint.escrowScriptAddress(1),
    lovelace,
    assets: {},
    datumHex: encodeIdentityEscrowDatum(datum),
    scriptRef: null,
  };
  ogmios.add(utxo);
  return utxo;
}

/** Reference-script UTxOs of both escrows, as a spender holds them during the drain. */
function publishReferenceScripts(): void {
  const zeroKey = pkhToEnterpriseAddress("00".repeat(28), 1);
  ogmios.add(
    { ref: ESCROW_SCRIPT_REF, address: zeroKey, lovelace: 30n * AP3X, assets: {}, datumHex: null, scriptRef: blueprint.escrowCompiledCode },
    { ref: ADVERT_SCRIPT_REF, address: zeroKey, lovelace: 30n * AP3X, assets: {}, datumHex: null, scriptRef: blueprint.advertCompiledCode },
    { ref: LEGACY_SCRIPT_REF, address: zeroKey, lovelace: 30n * AP3X, assets: {}, datumHex: null, scriptRef: loadEscrowScript().script.script },
  );
  vi.stubEnv("IDENTITY_ESCROW_REF_UTXO", refString(ESCROW_SCRIPT_REF));
  vi.stubEnv("IDENTITY_ADVERT_REF_UTXO", refString(ADVERT_SCRIPT_REF));
  vi.stubEnv("ESCROW_REF_UTXO", refString(LEGACY_SCRIPT_REF));
}

describe("live Post", () => {
  it("locks the 16-field datum at the new escrow script with a range of at most one hour", async () => {
    ogmios.add(advertUtxo(blueprint, identityAdvert(supplier, { max_processing_ms: 3_600_000 }), ADVERT_REF));
    const built = await buildPostEscrowTx({
      chain: ogmios.chain(), buyerKey: buyer, advertRef: ADVERT_REF, prompt_hash: "c3".repeat(32), payment_lovelace: 2n * AP3X,
      lookupRecord: lookupOf(), lookupAdvertSigners: async () => [supplier.pubKeyHash], identityBlueprint: blueprint,
    });
    const tx = decodeTx(built.txCborHex);
    expect(tx.outputs[0]!.address).toBe(blueprint.escrowScriptAddress(1));
    const datum = decodeIdentityEscrowDatum(tx.outputs[0]!.datumHex!);
    expect(datum.agent_id).toBe(AGENT_ID);
    expect(datum.deliver_by).toBe(NOW_MS + 3_600_000 + 30_000);
    expect(tx.requiredSigners).toEqual([buyer.pubKeyHash]);
    // lo = slot of posted_at − 60 s; hi = lo + 1 h (< deliver_by).
    expect(tx.lo).toBe(NOW_MS - 500 - 60_000);
    expect(tx.hi).toBe(tx.lo + MAX_RANGE_MS);
    expect(ogmios.submitted).toEqual([built.txCborHex]);
  });

  it("caps the legacy Post range at one hour too", async () => {
    const { agent_id: _id, ...legacy } = identityAdvert(supplier, { max_processing_ms: 3_600_000 });
    ogmios.add({ ...advertUtxo(blueprint, identityAdvert(supplier), ADVERT_REF), address: loadBlueprint().advertScriptAddress(1), datumHex: encodeAdvertDatum(legacy) });
    const built = await buildPostEscrowTx({ chain: ogmios.chain(), buyerKey: buyer, advertRef: ADVERT_REF, prompt_hash: "c3".repeat(32), payment_lovelace: 2n * AP3X });
    const tx = decodeTx(built.txCborHex);
    expect(tx.outputs[0]!.address).toBe(loadBlueprint().escrowScriptAddress(1));
    expect(tx.hi - tx.lo).toBe(MAX_RANGE_MS);
  });
});

describe("live Claim and Submit", () => {
  it("Claim: one script input, the record as a reference input, the inline script, the exact continuing output", async () => {
    const before = escrowDatum();
    const input = seedEscrow(before);
    const built = await buildClaimTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: ESCROW_REF, lookupRecord: lookupOf(), identityBlueprint: blueprint });
    const tx = decodeTx(built.txCborHex);
    expect(tx.inputs.filter((ref) => ref === refString(ESCROW_REF))).toHaveLength(1);
    expect(tx.referenceInputs).toEqual([refString(recordUtxo(blueprint, activeRecord()).ref)]);
    expect(tx.witnessScripts).toEqual([blueprint.escrowScriptHash]);
    expect(tx.redeemers).toHaveLength(1);
    expect(decodeEscrowRedeemer(tx.redeemers[0]!.dataHex)).toEqual({ type: "Claim" });
    expect(tx.requiredSigners).toEqual([supplier.pubKeyHash]);
    expect(tx.outputs[0]).toEqual({
      address: blueprint.escrowScriptAddress(1),
      lovelace: input.lovelace,
      datumHex: encodeIdentityEscrowDatum({ ...before, state: "Claimed" }),
    });
    expect(tx.lo).toBe(NOW_MS - 500 - 60_000);
    expect(tx.hi).toBe(before.deliver_by - 500);
    expectRange(tx);
  });

  it("Claim: hi = lo + 1 h when deliver_by is further away", async () => {
    seedEscrow(escrowDatum({ deliver_by: NOW_MS + 5_000_000 }));
    const built = await buildClaimTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: ESCROW_REF, lookupRecord: lookupOf(), identityBlueprint: blueprint });
    const tx = decodeTx(built.txCborHex);
    expect(tx.hi - tx.lo).toBe(MAX_RANGE_MS);
  });

  it("caps the legacy Claim range at one hour too", async () => {
    const { agent_id: _id, refund: _refund, ...legacy } = escrowDatum({ deliver_by: NOW_MS + 5_000_000 });
    ogmios.add({ ref: ESCROW_REF, address: loadBlueprint().escrowScriptAddress(1), lovelace: 4n * AP3X, assets: {}, datumHex: encodeEscrowDatum(legacy), scriptRef: null });
    const built = await buildClaimTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: ESCROW_REF });
    const tx = decodeTx(built.txCborHex);
    expect(tx.hi - tx.lo).toBeLessThanOrEqual(MAX_RANGE_MS);
    expect(tx.referenceInputs).toEqual([]);
  });

  it("Submit: submitted_at equals the upper bound that the script sees", async () => {
    const claimed = escrowDatum({ state: "Claimed", deliver_by: NOW_MS + 600_000 });
    seedEscrow(claimed);
    const built = await buildSubmitTx({
      chain: ogmios.chain(), supplierKey: supplier, escrowRef: ESCROW_REF, receiptHash: "E5".repeat(32),
      lookupRecord: lookupOf(), identityBlueprint: blueprint,
    });
    const tx = decodeTx(built.txCborHex);
    expect(tx.hi).toBe(NOW_MS - 500 + 120_000);
    expect(decodeIdentityEscrowDatum(tx.outputs[0]!.datumHex!)).toEqual({
      ...claimed, state: "Submitted", submitted_at: tx.hi, result_receipt_hash: "e5".repeat(32),
    });
    expect(decodeEscrowRedeemer(tx.redeemers[0]!.dataHex)).toEqual({ type: "Submit", receipt_hash: "e5".repeat(32) });
    expect(tx.referenceInputs).toHaveLength(1);
    expectRange(tx);
  });

  it("refuses an escrow whose continuing output would need more than its value", async () => {
    seedEscrow(escrowDatum(), 1_000_000n);
    await expect(buildClaimTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: ESCROW_REF, lookupRecord: lookupOf(), identityBlueprint: blueprint }))
      .rejects.toMatchObject({ reason: "escrow below min-UTxO" });
  });
});

describe("reference scripts of both escrows during the drain", () => {
  it("an identity spend reads IDENTITY_ESCROW_REF_UTXO, a legacy spend ESCROW_REF_UTXO", async () => {
    publishReferenceScripts();
    seedEscrow(escrowDatum());
    const identity = decodeTx((await buildClaimTx({
      chain: ogmios.chain(), supplierKey: supplier, escrowRef: ESCROW_REF, lookupRecord: lookupOf(), identityBlueprint: blueprint,
    })).txCborHex);
    expect(identity.witnessScripts).toEqual([]);
    expect(identity.referenceInputs.sort()).toEqual([refString(ESCROW_SCRIPT_REF), refString(recordUtxo(blueprint, activeRecord()).ref)].sort());

    const { agent_id: _id, refund: _refund, ...legacy } = escrowDatum();
    const legacyRef = { txHash: "e1".repeat(32), index: 0 };
    ogmios.add({ ref: legacyRef, address: loadBlueprint().escrowScriptAddress(1), lovelace: 4n * AP3X, assets: {}, datumHex: encodeEscrowDatum(legacy), scriptRef: null });
    const legacyTx = decodeTx((await buildClaimTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: legacyRef })).txCborHex);
    expect(legacyTx.referenceInputs).toEqual([refString(LEGACY_SCRIPT_REF)]);
  });

  it("refuses a reference UTxO that holds another script", async () => {
    publishReferenceScripts();
    vi.stubEnv("IDENTITY_ESCROW_REF_UTXO", refString(LEGACY_SCRIPT_REF));
    seedEscrow(escrowDatum());
    await expect(buildClaimTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: ESCROW_REF, lookupRecord: lookupOf(), identityBlueprint: blueprint }))
      .rejects.toMatchObject({ reason: "reference script mismatch" });
  });
});

describe("live terminal spends", () => {
  const SUBMITTED_AT = NOW_MS - 30_500;
  const submitted = (changes: Partial<IdentityEscrowDatum> = {}) =>
    escrowDatum({ state: "Submitted", submitted_at: SUBMITTED_AT, result_receipt_hash: "e5".repeat(32), ...changes });

  it("Accept: supplier payout, buyer bond to the refund address, buyer signs", async () => {
    seedEscrow(submitted());
    const tx = decodeTx((await buildAcceptTx({ chain: ogmios.chain(), buyerKey: buyer, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(tx.outputs.slice(0, 2)).toEqual([
      { address: pkhToEnterpriseAddress(supplier.pubKeyHash, 1), lovelace: 3n * AP3X },
      { address: buyer.address, lovelace: 2n * AP3X },
    ]);
    expect(tx.requiredSigners).toEqual([buyer.pubKeyHash]);
    expect(tx.referenceInputs).toEqual([]);
    expect(tx.hi).toBe(SUBMITTED_AT + 600_000);
    expectRange(tx);
  });

  it("Reclaim with refund: a stranger's wallet, no buyer signature, the whole value to the refund address", async () => {
    vi.setSystemTime(NOW_MS + 100_000);
    const input = seedEscrow(escrowDatum({ state: "Claimed" }));
    const tx = decodeTx((await buildReclaimTx({ chain: ogmios.chain(), buyerKey: stranger, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(tx.requiredSigners).toEqual([]);
    expect(tx.outputs[0]).toEqual({ address: buyer.address, lovelace: input.lovelace });
    expect(tx.lo).toBeGreaterThanOrEqual(escrowDatum().deliver_by);
    expectRange(tx);
  });

  it("Release: the supplier gets payment and both bonds", async () => {
    vi.setSystemTime(SUBMITTED_AT + 700_000);
    seedEscrow(submitted());
    const tx = decodeTx((await buildReleaseTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: ESCROW_REF, identityBlueprint: blueprint })).txCborHex);
    expect(tx.outputs[0]).toEqual({ address: pkhToEnterpriseAddress(supplier.pubKeyHash, 1), lovelace: 4n * AP3X });
    expect(tx.requiredSigners).toEqual([supplier.pubKeyHash]);
    expect(tx.lo).toBeGreaterThanOrEqual(SUBMITTED_AT + 600_000);
    expectRange(tx);
  });

  it("RefundRevoked: the record as a reference input, any wallet, the whole value to the refund address", async () => {
    const input = seedEscrow(escrowDatum());
    const revoked = tombstone(activeRecord(), { type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: NOW_MS - 1_000, invalidFrom: null, successor: null });
    const tx = decodeTx((await buildRefundRevokedTx({
      chain: ogmios.chain(), walletKey: stranger, escrowRef: ESCROW_REF, lookupRecord: lookupOf(revoked), identityBlueprint: blueprint,
    })).txCborHex);
    expect(decodeEscrowRedeemer(tx.redeemers[0]!.dataHex)).toEqual({ type: "RefundRevoked" });
    expect(tx.referenceInputs).toEqual([refString(recordUtxo(blueprint, revoked).ref)]);
    expect(tx.requiredSigners).toEqual([]);
    expect(tx.outputs[0]).toEqual({ address: buyer.address, lovelace: input.lovelace });
    expectRange(tx);
  });
});

describe("live advert spends", () => {
  it("Post, Update (keeps agent_id) and Retire use the new advert script", async () => {
    const advert = identityAdvert(supplier, { advertised_at: NOW_MS });
    const posted = decodeTx((await buildPostAdvertTx({
      chain: ogmios.chain(), walletKey: supplier, advertDatum: advert, deposit_lovelace: 2n * AP3X,
      lookupRecord: lookupOf(), identityBlueprint: blueprint,
    })).txCborHex);
    expect(posted.outputs[0]).toEqual({ address: blueprint.advertScriptAddress(1), lovelace: 2n * AP3X, datumHex: encodeIdentityAdvertDatum(advert) });

    publishReferenceScripts();
    ogmios.add(advertUtxo(blueprint, advert, ADVERT_REF));
    const next = { ...advert, price_lovelace: 3n * AP3X };
    const updated = decodeTx((await buildUpdateAdvertTx({
      chain: ogmios.chain(), walletKey: supplier, advertRef: ADVERT_REF, newAdvertDatum: next, deposit_lovelace: 2n * AP3X,
      lookupRecord: lookupOf(), identityBlueprint: blueprint,
    })).txCborHex);
    expect(decodeAdvertRedeemer(updated.redeemers[0]!.dataHex)).toEqual({ type: "UpdateAdvert" });
    expect(updated.referenceInputs).toEqual([refString(ADVERT_SCRIPT_REF)]);
    expect(updated.outputs[0]).toEqual({ address: blueprint.advertScriptAddress(1), lovelace: 2n * AP3X, datumHex: encodeIdentityAdvertDatum(next) });
    expect(updated.requiredSigners).toEqual([supplier.pubKeyHash]);

    const retired = decodeTx((await buildRetireAdvertTx({ chain: ogmios.chain(), walletKey: supplier, advertRef: ADVERT_REF, identityBlueprint: blueprint })).txCborHex);
    expect(decodeAdvertRedeemer(retired.redeemers[0]!.dataHex)).toEqual({ type: "RetireAdvert" });
    expect(retired.outputs[0]).toEqual({ address: pkhToEnterpriseAddress(supplier.pubKeyHash, 1), lovelace: 2n * AP3X });
  });

  it("refuses a missing record lookup before any network call for a new advert", async () => {
    await expect(buildPostAdvertTx({
      chain: ogmios.chain(), walletKey: supplier, advertDatum: identityAdvert(supplier, { advertised_at: NOW_MS }),
      deposit_lovelace: 2n * AP3X, identityBlueprint: blueprint,
    })).rejects.toBeInstanceOf(TxConstructionError);
    expect(ogmios.submitted).toEqual([]);
  });
});
