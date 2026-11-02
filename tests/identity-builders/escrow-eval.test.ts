/**
 * escrow-eval.test.ts — the real compiled new escrow (Part 2 §6.1) runs
 * offline (`aiken tx simulate`, through tests/legacy-registry/harness)
 * against the transactions that the shared builders produce: Claim, Submit,
 * Accept, Reclaim, Release and RefundRevoked.
 *
 * - The escrow script: contracts/identity-marketplace (escrow.escrow.spend)
 *   with a test identity hash applied; inline in the witness set, and as a
 *   reference script (IDENTITY_ESCROW_REF_UTXO).
 * - The agent record: an authentic record output at the identity address of
 *   that hash (Script(identity_hash), no stake credential, 10 AP3X and the
 *   token identity_hash.agent_id), as a reference input.
 * - The builders run their live path (lucid-evolution). The fake Ogmios
 *   evaluates each draft with aiken, as Ogmios does in production, and each
 *   signed transaction is evaluated once more.
 * - Negative controls evaluate a passing transaction against a changed
 *   resolved input, to show that the script checks what the builders rely on.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeSimulation, aikenVersion, type Simulation } from "../legacy-registry/harness/index.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { decodeIdentityEscrowDatum, encodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import type { IdentityDatum } from "../../packages/shared/src/cbor/IdentityDatum.js";
import { plutusAddressFromBech32 } from "../../packages/shared/src/cbor/address.js";
import type { IdentityBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import {
  buildAcceptTx, buildClaimTx, buildPostEscrowTx, buildReclaimTx, buildRefundRevokedTx, buildReleaseTx, buildSubmitTx,
  type BuildResult, type RecordLookup,
} from "../../packages/shared/src/tx/index.js";
import { pkhToEnterpriseAddress } from "../../packages/shared/src/tx/internal/pkhAddress.js";
import { utf8ToHex } from "../../packages/shared/src/identity/id.js";
import { testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";
import {
  advertUtxo, agentRecord, AP3X, FakeOgmios, identityAdvert, outputOf, recordUtxo, testWallet, tombstone,
  VECTOR_MAINNET_ZERO_TIME_MS,
} from "../fixtures/identity-builders/world.js";
import { evaluateBuiltTx } from "../legacy-registry/harness/identity.js";

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0, 500);
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
const SCRIPT_REF: OutputReference = { txHash: "5c".repeat(32), index: 0 };
const RECEIPT_HASH = "e5".repeat(32);

const buyer = testWallet("eval buyer");
const supplier = testWallet("eval supplier");
const controller = testWallet("eval controller");
const stranger = testWallet("eval stranger");

let blueprint: IdentityBlueprint;
let ogmios: FakeOgmios;
const results: Array<{ mode: string; redeemer: string; mem?: number; cpu?: number }> = [];

const MODES = ["inline script", "reference script"] as const;
type Mode = (typeof MODES)[number];

beforeAll(() => {
  expect(aikenVersion()).toMatch(/^aiken v1\.1\.21/);
  blueprint = testIdentityBlueprint();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("VECTOR_ZERO_TIME_MS", String(VECTOR_MAINNET_ZERO_TIME_MS));
  vi.stubEnv("IDENTITY_ESCROW_REF_UTXO", "");
  ogmios = new FakeOgmios();
  for (const wallet of [buyer, supplier, stranger]) ogmios.fund(wallet, 100n * AP3X, 6n * AP3X);
  // As Ogmios evaluateTransaction: run the scripts of the draft, give the budget or the failure.
  ogmios.evaluate = (tx) => {
    const simulation = evaluateBuiltTx(tx, ogmios.utxos.values(), "escrow");
    if (!simulation.passed) return { code: 3010, message: describeSimulation(simulation) };
    return simulation.verdicts.map((verdict) => ({
      validator: { purpose: "spend" as const, index: Number(/\[(\d+)\]/.exec(verdict.purpose)![1]) },
      budget: { memory: verdict.mem!, cpu: verdict.cpu! },
    }));
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  // One line per evaluated redeemer: the execution units (memory / CPU) of the final signed transaction.
  console.info(results.map((r) => `[escrow-eval] ${r.mode} | ${r.redeemer} | ${r.mem} / ${r.cpu}`).join("\n"));
});

function useScript(mode: Mode): void {
  if (mode !== "reference script") return;
  ogmios.add({
    ref: SCRIPT_REF,
    address: pkhToEnterpriseAddress("00".repeat(28), 1),
    lovelace: 30n * AP3X,
    assets: {},
    datumHex: null,
    scriptRef: blueprint.escrowCompiledCode,
  });
  vi.stubEnv("IDENTITY_ESCROW_REF_UTXO", `${SCRIPT_REF.txHash}#${SCRIPT_REF.index}`);
}

/** Puts the record output on the test chain and returns a lookup for it. */
function useRecord(datum: IdentityDatum, ref?: OutputReference): RecordLookup {
  const utxo = recordUtxo(blueprint, datum, ref);
  ogmios.add(utxo);
  return async () => utxo;
}

/** Output `index` of a built transaction, now on the test chain. */
function take(built: BuildResult, index = 0): Utxo {
  const utxo = outputOf(built.txCborHex, built.expectedTxHash, index);
  ogmios.add(utxo);
  return utxo;
}

/** Builds with the live builder and evaluates the signed transaction once more; it must pass. */
async function passes(mode: Mode, redeemer: string, build: () => Promise<BuildResult>): Promise<BuildResult> {
  const built = await build();
  const simulation = evaluateBuiltTx(built.txCborHex, ogmios.utxos.values(), redeemer);
  expect(simulation.passed, describeSimulation(simulation)).toBe(true);
  results.push({ mode, redeemer, mem: simulation.verdicts[0]!.mem, cpu: simulation.verdicts[0]!.cpu });
  return built;
}

/** The same signed transaction with one resolved input changed: the script must reject it. */
function rejectsWith(built: BuildResult, changed: Utxo): Simulation {
  const utxos = new Map([...ogmios.utxos.values()].map((u) => [`${u.ref.txHash}#${u.ref.index}`, u]));
  utxos.set(`${changed.ref.txHash}#${changed.ref.index}`, changed);
  const simulation = evaluateBuiltTx(built.txCborHex, utxos.values(), "escrow");
  expect(simulation.passed).toBe(false);
  expect(simulation.verdicts[0]!.reason).toMatch(/validator crashed|exited prematurely/);
  return simulation;
}

/** A Post on a new advert; the escrow output joins the test chain. */
async function post(lookupRecord: RecordLookup, maxProcessingMs = 60_000): Promise<Utxo> {
  ogmios.add(advertUtxo(blueprint, identityAdvert(supplier, { max_processing_ms: maxProcessingMs }), ADVERT_REF));
  const built = await buildPostEscrowTx({
    chain: ogmios.chain(), buyerKey: buyer, advertRef: ADVERT_REF, prompt_hash: "c3".repeat(32), payment_lovelace: 2n * AP3X,
    lookupRecord, lookupAdvertSigners: async () => [supplier.pubKeyHash], identityBlueprint: blueprint,
  });
  return take(built);
}

const claim = (lookupRecord: RecordLookup, escrow: Utxo) => () =>
  buildClaimTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: escrow.ref, lookupRecord, identityBlueprint: blueprint });

const submit = (lookupRecord: RecordLookup, escrow: Utxo) => () =>
  buildSubmitTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: escrow.ref, receiptHash: RECEIPT_HASH, lookupRecord, identityBlueprint: blueprint });

const escrowDatumOf = (utxo: Utxo): IdentityEscrowDatum => decodeIdentityEscrowDatum(utxo.datumHex!);
const withDatum = (utxo: Utxo, datum: IdentityEscrowDatum): Utxo => ({ ...utxo, datumHex: encodeIdentityEscrowDatum(datum) });
const revokedAt = (record: IdentityDatum, invalidFrom: number | null) =>
  tombstone(record, { type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: NOW_MS, invalidFrom, successor: null });

describe.each(MODES)("new escrow, %s", (mode) => {
  beforeEach(() => useScript(mode));

  it("Claim, Submit and Accept pass; a 60-minute advert gets a one-hour Claim range", async () => {
    const active = agentRecord(controller, supplier);
    const lookup = useRecord(active);
    const escrow = await post(lookup, 3_600_000);

    vi.setSystemTime(NOW_MS + 10_000);
    const claimed = await passes(mode, "Claim", claim(lookup, escrow));
    // Negative controls: a held record, a record without the capability, a key without the transaction purpose.
    const record = recordUtxo(blueprint, active);
    rejectsWith(claimed, recordUtxo(blueprint, {
      ...active, status: { type: "Suspended", holds: [{ by: { type: "ControllerSet" }, reason: 1, since: NOW_MS, until: NOW_MS + 86_400_000 }] },
    }, record.ref));
    rejectsWith(claimed, recordUtxo(blueprint, { ...active, capabilities: [utf8ToHex("other.v1")] }, record.ref));
    rejectsWith(claimed, recordUtxo(blueprint, { ...active, keys: [{ ...active.keys[0]!, purposes: 1 }] }, record.ref));

    vi.setSystemTime(NOW_MS + 30_000);
    const submitted = await passes(mode, "Submit", submit(lookup, take(claimed)));
    const submittedEscrow = take(submitted);
    expect(escrowDatumOf(submittedEscrow).state).toBe("Submitted");

    vi.setSystemTime(NOW_MS + 60_000);
    const accepted = await passes(mode, "Accept", () =>
      buildAcceptTx({ chain: ogmios.chain(), buyerKey: buyer, escrowRef: submittedEscrow.ref, identityBlueprint: blueprint }));
    // With the buyer bond sent to the buyer key instead of the refund address, Accept fails.
    rejectsWith(accepted, withDatum(submittedEscrow, {
      ...escrowDatumOf(submittedEscrow),
      refund: { address: plutusAddressFromBech32(stranger.address), datum: null },
    }));
  });

  it("Release passes after the accept window", async () => {
    const lookup = useRecord(agentRecord(controller, supplier));
    const escrow = await post(lookup);
    vi.setSystemTime(NOW_MS + 10_000);
    const claimed = take(await passes(mode, "Claim", claim(lookup, escrow)));
    vi.setSystemTime(NOW_MS + 20_000);
    const submitted = take(await passes(mode, "Submit", submit(lookup, claimed)));
    vi.setSystemTime(escrowDatumOf(submitted).submitted_at! + 600_000 + 1_000);
    await passes(mode, "Release", () =>
      buildReleaseTx({ chain: ogmios.chain(), supplierKey: supplier, escrowRef: submitted.ref, identityBlueprint: blueprint }));
  });

  it("Reclaim with refund passes from another wallet, without the buyer's signature", async () => {
    const escrow = await post(useRecord(agentRecord(controller, supplier)));
    vi.setSystemTime(escrowDatumOf(escrow).deliver_by + 1_000);
    const reclaimed = await passes(mode, "Reclaim (refund set, any wallet)", () =>
      buildReclaimTx({ chain: ogmios.chain(), buyerKey: stranger, escrowRef: escrow.ref, identityBlueprint: blueprint }));
    // With another refund address in the datum, the same payout does not count. (Not the submitting
    // wallet's address: its change output also counts as a payout to that address, with no datum.)
    rejectsWith(reclaimed, withDatum(escrow, {
      ...escrowDatumOf(escrow),
      refund: { address: plutusAddressFromBech32(controller.address), datum: null },
    }));
  });

  it("Reclaim without refund passes when the buyer signs", async () => {
    const escrow: Utxo = {
      ref: { txHash: "e7".repeat(32), index: 0 },
      address: blueprint.escrowScriptAddress(1),
      lovelace: 4_620_000n,
      assets: {},
      datumHex: null,
      scriptRef: null,
    };
    const datum: IdentityEscrowDatum = {
      ...decodeIdentityEscrowDatum((await post(useRecord(agentRecord(controller, supplier)))).datumHex!),
      refund: null,
    };
    ogmios.add(withDatum(escrow, datum));
    vi.setSystemTime(datum.deliver_by + 1_000);
    const reclaimed = await passes(mode, "Reclaim (no refund, buyer)", () =>
      buildReclaimTx({ chain: ogmios.chain(), buyerKey: buyer, escrowRef: escrow.ref, identityBlueprint: blueprint }));
    // With a refund address in the datum, the buyer-key payout does not count.
    rejectsWith(reclaimed, withDatum(escrow, { ...datum, refund: { address: plutusAddressFromBech32(stranger.address), datum: null } }));
  });

  it("RefundRevoked passes: Open + Revoked, Claimed + Retired, Submitted + Revoked with invalid_from ≤ submitted_at", async () => {
    const active = agentRecord(controller, supplier);
    const activeLookup = useRecord(active);

    // Open escrow, the record is revoked.
    const open = await post(activeLookup);
    const revokedRef = { txHash: "7f".repeat(32), index: 0 };
    vi.setSystemTime(NOW_MS + 5_000);
    const refundedOpen = await passes(mode, "RefundRevoked (Open, Revoked)", () =>
      buildRefundRevokedTx({ chain: ogmios.chain(), walletKey: stranger, escrowRef: open.ref, lookupRecord: useRecord(revokedAt(active, null), revokedRef), identityBlueprint: blueprint }));
    // Against the live record, RefundRevoked fails.
    rejectsWith(refundedOpen, recordUtxo(blueprint, active, revokedRef));

    // Claimed escrow, the record is retired.
    vi.setSystemTime(NOW_MS + 10_000);
    const claimed = take(await passes(mode, "Claim", claim(activeLookup, await post(activeLookup))));
    const retiredRef = { txHash: "7d".repeat(32), index: 0 };
    await passes(mode, "RefundRevoked (Claimed, Retired)", () =>
      buildRefundRevokedTx({
        chain: ogmios.chain(), walletKey: stranger, escrowRef: claimed.ref,
        lookupRecord: useRecord(tombstone(active, { type: "Retired", at: NOW_MS, successor: null }), retiredRef), identityBlueprint: blueprint,
      }));

    // Submitted escrow, revoked with invalid_from at submitted_at.
    vi.setSystemTime(NOW_MS + 20_000);
    const submittedClaim = take(await passes(mode, "Claim", claim(activeLookup, await post(activeLookup))));
    vi.setSystemTime(NOW_MS + 30_000);
    const submitted = take(await passes(mode, "Submit", submit(activeLookup, submittedClaim)));
    const submittedAt = escrowDatumOf(submitted).submitted_at!;
    const compromisedRef = { txHash: "7c".repeat(32), index: 0 };
    vi.setSystemTime(NOW_MS + 40_000);
    const refundedSubmitted = await passes(mode, "RefundRevoked (Submitted, invalid_from ≤ submitted_at)", () =>
      buildRefundRevokedTx({
        chain: ogmios.chain(), walletKey: stranger, escrowRef: submitted.ref,
        lookupRecord: useRecord(revokedAt(active, submittedAt), compromisedRef), identityBlueprint: blueprint,
      }));
    // With invalid_from after submitted_at, the delivery stands: RefundRevoked fails.
    rejectsWith(refundedSubmitted, recordUtxo(blueprint, revokedAt(active, submittedAt + 1), compromisedRef));
  });

  it("RefundRevoked returns every asset of the escrow input, not only its AP3X", async () => {
    const active = agentRecord(controller, supplier);
    const posted = await post(useRecord(active));
    // The posted escrow with a token next to its AP3X. The builders lock AP3X only; the script also protects other assets.
    const unit = `${"7e".repeat(28)}${Buffer.from("token").toString("hex")}`;
    const escrow: Utxo = { ...posted, ref: { txHash: "e8".repeat(32), index: 0 }, assets: { [unit]: 1n } };
    ogmios.add(escrow);
    vi.setSystemTime(NOW_MS + 5_000);
    const refunded = await passes(mode, "RefundRevoked (escrow with a token)", () =>
      buildRefundRevokedTx({
        chain: ogmios.chain(), walletKey: stranger, escrowRef: escrow.ref,
        lookupRecord: useRecord(revokedAt(active, null), { txHash: "7b".repeat(32), index: 0 }), identityBlueprint: blueprint,
      }));
    // When the escrow input holds one more unit than the refund output carries, RefundRevoked fails.
    rejectsWith(refunded, { ...escrow, assets: { [unit]: 2n } });
  });
});
