/**
 * identity-refund-datum.test.ts — the refund datum of a new escrow, with the real decoder library.
 *
 * A new escrow carries `refund: { address, datum }`. The refund datum is Plutus data of any shape, and the whole escrow datum is read
 * from the chain. A chain client refuses CBOR that is nested deeper than 64 levels before it is decoded: it withholds a datum that
 * fails the check. The output stays in the answer and has no datum. The levels of the refund datum add to the levels around it in
 * the escrow datum, so the whole datum is the one that counts.
 *
 * The tests build the live transactions with the real library over a fake Ogmios (as tx-identity-escrow-live.test.ts does):
 * - A refund datum that nests 20 levels reaches the builders unchanged. They write it into the outputs that the escrow script
 *   checks: the continuing escrow output of Claim and Submit, and the refund output of Accept, Reclaim and RefundRevoked. Release
 *   reads the datum and writes no refund output.
 * - A refund datum that nests 70 levels makes the escrow datum nest more than 64 levels. The client withholds it, each builder
 *   refuses the escrow (TxConstructionError "escrow datum missing"), and no transaction is evaluated or submitted.
 * - After those refusals the library still decodes a known value, and the next escrow builds as usual.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { OgmiosLucidProvider } from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { cborDepth, MAX_CBOR_DEPTH } from "../../packages/shared/src/cbor-depth.js";
import { plutusAddressFromBech32 } from "../../packages/shared/src/cbor/address.js";
import { decodeIdentityEscrowDatum, encodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import type { IdentityDatum } from "../../packages/shared/src/cbor/IdentityDatum.js";
import { encodePlutusDataHex, type PlutusData } from "../../packages/shared/src/cbor/plutus-data.js";
import type { IdentityBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import {
  buildAcceptTx, buildClaimTx, buildReclaimTx, buildRefundRevokedTx, buildReleaseTx, buildSubmitTx, TxConstructionError,
  type BuildResult, type RecordLookup,
} from "../../packages/shared/src/tx/index.js";
import { decoderWorks } from "../../packages/shared/src/tx/internal/decoderHealth.js";
import { inspectSignedTransactionFinancials, type SignedTransactionFinancials } from "../../packages/shared/src/tx/internal/signedTransaction.js";
import { pkhToEnterpriseAddress } from "../../packages/shared/src/tx/internal/pkhAddress.js";
import { testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";
import { AGENT_ID, agentRecord, AP3X, FakeOgmios, recordUtxo, testWallet, tombstone, VECTOR_MAINNET_ZERO_TIME_MS } from "../fixtures/identity-builders/world.js";

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0, 500);
const SUBMITTED_AT = NOW_MS - 30_500;
const ESCROW_REF: OutputReference = { txHash: "e0".repeat(32), index: 0 };
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
const OGMIOS_URL = "http://ogmios.invalid";

const buyer = testWallet("refund datum buyer");
const supplier = testWallet("refund datum supplier");
const controller = testWallet("refund datum controller");
const stranger = testWallet("refund datum stranger");
let blueprint: IdentityBlueprint;
let ogmios: FakeOgmios;
let warn: MockInstance<typeof console.warn>;

beforeAll(() => {
  blueprint = testIdentityBlueprint();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("VECTOR_ZERO_TIME_MS", String(VECTOR_MAINNET_ZERO_TIME_MS));
  for (const key of ["ESCROW_REF_UTXO", "ADVERT_REF_UTXO", "IDENTITY_ESCROW_REF_UTXO", "IDENTITY_ADVERT_REF_UTXO"]) vi.stubEnv(key, "");
  // The chain clients write one line for each output that they withhold. The tests do not read it.
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  ogmios = new FakeOgmios();
  for (const wallet of [buyer, supplier, stranger]) ogmios.fund(wallet, 100n * AP3X, 6n * AP3X);
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** `levels` lists inside each other around the integer 7. */
function nest(levels: number): PlutusData {
  let data: PlutusData = { kind: "int", value: 7n };
  for (let level = 0; level < levels; level += 1) data = { kind: "list", items: [data] };
  return data;
}

function escrowDatum(refundDatum: PlutusData | null, changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
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
    refund: { address: plutusAddressFromBech32(buyer.address), datum: refundDatum },
    ...changes,
  };
}

/** The levels of nesting of the CBOR of an escrow datum, counted past the limit of the clients. */
function levelsOf(datum: IdentityEscrowDatum): number {
  return cborDepth(Buffer.from(encodeIdentityEscrowDatum(datum), "hex"), 1000);
}

function escrowUtxo(datum: IdentityEscrowDatum, ref: OutputReference = ESCROW_REF, lovelace = 4_620_000n): Utxo {
  return { ref, address: blueprint.escrowScriptAddress(1), lovelace, assets: {}, datumHex: encodeIdentityEscrowDatum(datum), scriptRef: null };
}

const active = agentRecord(controller, supplier);
const revoked = tombstone(active, { type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: NOW_MS - 1_000, invalidFrom: null, successor: null });

function lookupOf(record: IdentityDatum = active): RecordLookup {
  const utxo = recordUtxo(blueprint, record);
  return async (agentId) => (agentId === AGENT_ID ? utxo : null);
}

type Outputs = SignedTransactionFinancials["outputs"];

interface Spend {
  name: string;
  /** What makes the escrow fit this spend. */
  escrow: Partial<IdentityEscrowDatum>;
  /** The time of the build. */
  now: number;
  build: (chain: LiveOgmiosProvider) => Promise<BuildResult>;
  /** Asserts the outputs of the built transaction: the refund datum is in the output that the escrow script checks, when the spend writes one. */
  expectOutputs: (outputs: Outputs, input: Utxo, datum: IdentityEscrowDatum) => void;
}

const refundHex = (datum: IdentityEscrowDatum): string => encodePlutusDataHex(datum.refund!.datum!);

/** The continuing escrow output holds the whole datum, and the refund datum inside it is the one of the input. */
function expectContinuingOutput(outputs: Outputs, input: Utxo, datum: IdentityEscrowDatum): void {
  expect(outputs[0]).toMatchObject({ address: blueprint.escrowScriptAddress(1), lovelace: input.lovelace });
  expect(decodeIdentityEscrowDatum(outputs[0]!.datumHex!).refund).toEqual(datum.refund);
}

const spends: Spend[] = [
  {
    name: "Claim",
    escrow: {},
    now: NOW_MS,
    build: (chain) => buildClaimTx({ chain, supplierKey: supplier, escrowRef: ESCROW_REF, lookupRecord: lookupOf(), identityBlueprint: blueprint }),
    expectOutputs: expectContinuingOutput,
  },
  {
    name: "Submit",
    escrow: { state: "Claimed", deliver_by: NOW_MS + 600_000 },
    now: NOW_MS,
    build: (chain) => buildSubmitTx({
      chain, supplierKey: supplier, escrowRef: ESCROW_REF, receiptHash: "e5".repeat(32), lookupRecord: lookupOf(), identityBlueprint: blueprint,
    }),
    expectOutputs: expectContinuingOutput,
  },
  {
    name: "Accept",
    escrow: { state: "Submitted", submitted_at: SUBMITTED_AT, result_receipt_hash: "e5".repeat(32) },
    now: NOW_MS,
    build: (chain) => buildAcceptTx({ chain, buyerKey: buyer, escrowRef: ESCROW_REF, identityBlueprint: blueprint }),
    // The buyer bond goes to the refund address with the refund datum, after the supplier payout.
    expectOutputs: (outputs, _input, datum) => {
      expect(outputs[0]).toEqual({ address: pkhToEnterpriseAddress(supplier.pubKeyHash, 1), lovelace: 3n * AP3X });
      expect(outputs[1]).toEqual({ address: buyer.address, lovelace: 2n * AP3X, datumHex: refundHex(datum) });
    },
  },
  {
    name: "Reclaim",
    escrow: { state: "Claimed" },
    now: NOW_MS + 100_000,
    build: (chain) => buildReclaimTx({ chain, buyerKey: stranger, escrowRef: ESCROW_REF, identityBlueprint: blueprint }),
    // The whole escrow value goes to the refund address with the refund datum.
    expectOutputs: (outputs, input, datum) => {
      expect(outputs[0]).toEqual({ address: buyer.address, lovelace: input.lovelace, datumHex: refundHex(datum) });
    },
  },
  {
    name: "RefundRevoked",
    escrow: {},
    now: NOW_MS,
    build: (chain) => buildRefundRevokedTx({
      chain, walletKey: stranger, escrowRef: ESCROW_REF, lookupRecord: lookupOf(revoked), identityBlueprint: blueprint,
    }),
    expectOutputs: (outputs, input, datum) => {
      expect(outputs[0]).toEqual({ address: buyer.address, lovelace: input.lovelace, datumHex: refundHex(datum) });
    },
  },
  {
    name: "Release",
    escrow: { state: "Submitted", submitted_at: SUBMITTED_AT, result_receipt_hash: "e5".repeat(32) },
    now: SUBMITTED_AT + 700_000,
    build: (chain) => buildReleaseTx({ chain, supplierKey: supplier, escrowRef: ESCROW_REF, identityBlueprint: blueprint }),
    // Release pays the supplier only: the refund datum is read, and it is not written.
    expectOutputs: (outputs) => {
      expect(outputs[0]).toEqual({ address: pkhToEnterpriseAddress(supplier.pubKeyHash, 1), lovelace: 4n * AP3X });
    },
  },
];

describe("a refund datum that nests 20 levels (the whole escrow datum is inside 64 levels)", () => {
  it("reaches the caller unchanged through both chain clients", async () => {
    const datum = escrowDatum(nest(20));
    expect(levelsOf(datum)).toBeLessThanOrEqual(MAX_CBOR_DEPTH);
    const input = escrowUtxo(datum);
    ogmios.add(input);

    expect(await ogmios.chain().queryUtxo(ESCROW_REF)).toEqual(input);
    const [lucidOutput] = await new OgmiosLucidProvider({ ogmiosUrl: OGMIOS_URL, fetch: ogmios.fetch })
      .getUtxosByOutRef([{ txHash: ESCROW_REF.txHash, outputIndex: ESCROW_REF.index }]);
    expect(lucidOutput?.datum).toBe(input.datumHex);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(spends)("builds $name with the real library and writes the outputs that the script checks", async (spend) => {
    const datum = escrowDatum(nest(20), spend.escrow);
    const input = escrowUtxo(datum);
    ogmios.add(input);
    vi.setSystemTime(spend.now);

    const built = await spend.build(ogmios.chain());

    expect(ogmios.submitted).toEqual([built.txCborHex]);
    spend.expectOutputs(inspectSignedTransactionFinancials(built.txCborHex).outputs, input, datum);
  });
});

describe("a refund datum that nests 70 levels (the whole escrow datum is past 64 levels)", () => {
  const datum = escrowDatum(nest(70));

  it("is a datum that nests more than 64 levels, although the encoder writes it", () => {
    expect(levelsOf(datum)).toBeGreaterThan(MAX_CBOR_DEPTH);
    expect(decodeIdentityEscrowDatum(encodeIdentityEscrowDatum(datum)).refund).toEqual(datum.refund);
  });

  it("is withheld by both chain clients, and the output stays with its address and its value", async () => {
    ogmios.add(escrowUtxo(datum));

    expect(await ogmios.chain().queryUtxo(ESCROW_REF)).toEqual({ ...escrowUtxo(datum), datumHex: null });
    const [lucidOutput] = await new OgmiosLucidProvider({ ogmiosUrl: OGMIOS_URL, fetch: ogmios.fetch })
      .getUtxosByOutRef([{ txHash: ESCROW_REF.txHash, outputIndex: ESCROW_REF.index }]);
    expect(lucidOutput).toMatchObject({
      txHash: ESCROW_REF.txHash, outputIndex: ESCROW_REF.index, address: blueprint.escrowScriptAddress(1), assets: { lovelace: 4_620_000n }, datum: null,
    });
  });

  it.each(spends)("$name refuses the escrow with TxConstructionError \"escrow datum missing\" and sends no transaction", async (spend) => {
    ogmios.add(escrowUtxo(datum));
    vi.setSystemTime(spend.now);

    await expect(spend.build(ogmios.chain())).rejects.toSatisfy(
      (error: unknown) => error instanceof TxConstructionError && error.reason === "escrow datum missing",
    );

    expect(ogmios.evaluated).toEqual([]);
    expect(ogmios.submitted).toEqual([]);
  });

  it("the library still decodes a known value after each refusal, and the next escrow builds as usual", async () => {
    ogmios.add(escrowUtxo(datum));
    for (const spend of spends) {
      vi.setSystemTime(spend.now);
      await expect(spend.build(ogmios.chain())).rejects.toBeInstanceOf(TxConstructionError);
      expect(decoderWorks()).toBe(true);
    }

    // The next escrow is another output at the same script, with a refund datum inside the limit.
    const reclaim = spends.find((spend) => spend.name === "Reclaim")!;
    const nextRef: OutputReference = { txHash: "e1".repeat(32), index: 0 };
    ogmios.add(escrowUtxo(escrowDatum(nest(20), reclaim.escrow), nextRef));
    vi.setSystemTime(reclaim.now);
    const built = await buildReclaimTx({ chain: ogmios.chain(), buyerKey: stranger, escrowRef: nextRef, identityBlueprint: blueprint });
    expect(ogmios.submitted).toEqual([built.txCborHex]);
  });
});

describe("the limit counts the levels of the whole escrow datum", () => {
  // Each list of the refund datum adds one level to the deepest branch of the escrow datum. The levels around the first list are
  // measured, not assumed. The probe is deeper than the other branches of the escrow datum (the refund address, for example).
  const probe = 20;
  const around = levelsOf(escrowDatum(nest(probe))) - probe;
  const lastInside = MAX_CBOR_DEPTH - around;

  it("passes an escrow datum of exactly 64 levels and withholds one of 65 levels", async () => {
    const inside = escrowDatum(nest(lastInside));
    const past = escrowDatum(nest(lastInside + 1));
    expect(levelsOf(inside)).toBe(MAX_CBOR_DEPTH);
    expect(levelsOf(past)).toBe(MAX_CBOR_DEPTH + 1);
    const insideRef: OutputReference = { txHash: "e2".repeat(32), index: 0 };
    const pastRef: OutputReference = { txHash: "e3".repeat(32), index: 0 };
    ogmios.add(escrowUtxo(inside, insideRef), escrowUtxo(past, pastRef));

    const chain = ogmios.chain();
    expect((await chain.queryUtxo(insideRef))?.datumHex).toBe(encodeIdentityEscrowDatum(inside));
    expect((await chain.queryUtxo(pastRef))?.datumHex).toBeNull();
  });
});
