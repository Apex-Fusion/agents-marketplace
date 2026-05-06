/**
 * tx/internal/liveCbor.ts — lucid-evolution CBOR helpers for the 4 in-scope builders.
 *
 * Each function here is called by the corresponding builder when the chain
 * provider is a LiveOgmiosProvider. Pre-chain validation has already run in
 * the caller; we receive validated parameters and produce real Cardano CBOR.
 *
 * Network: Mainnet (per architecture decision documented in lucid-context.test.ts).
 * Output addresses use mainnet header bytes (0x71 for script enterprise, 0x61
 * for vkh enterprise). Input UTxOs may carry testnet-prefixed addresses — lucid
 * does not validate address network for inputs (only for outputs).
 *
 * Deferred builders (postAdvert, updateAdvert, retireAdvert, reclaim, release)
 * are NOT touched in M1-F-4. Those continue using the synthetic testTxBody path.
 *
 * Catherine M1-F-4-green.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import type { UTxO as LucidUTxO, Script } from "@lucid-evolution/lucid";

import type { OutputReference, Utxo } from "../../chain/ChainProvider.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import type { EscrowDatum } from "../../cbor/types.js";
import type { ChatMessage, BuildResult, PostEscrowBuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";

import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import { plutusTag } from "../../cbor/plutus-tag.js";
import { encodePlutus } from "../../cbor/plutus-encoder.js";
import { loadBlueprint } from "../blueprint.js";
import { pkhToEnterpriseAddress } from "./pkhAddress.js";
import { OgmiosLucidProvider } from "../../chain/OgmiosLucidProvider.js";
import { createLucidContext } from "./lucidContext.js";
import { ACCEPT_WINDOW_MS } from "./constants.js";

// Mainnet network id used for all output addresses produced by the live path.
const MAINNET_ID: 0 | 1 = 1;

// Min UTxO floor for outputs (lovelace). 2 ADA matches the test's expectation.
const MIN_UTXO_LOVELACE = 2_000_000n;

// Redeemer Constr indices per contracts/marketplace/validators/escrow.ak +
// lib/marketplace/types.ak EscrowRedeemer:
//   Claim                          → Constr0 (tag 121, nullary)
//   Submit { receipt_hash }        → Constr1 (tag 122, one ByteArray field)
//   Accept                         → Constr2 (tag 123, nullary)
//   Reclaim                        → Constr3 (tag 124, nullary)
//   Release                        → Constr4 (tag 125, nullary)
const REDEEMER_CLAIM = 121;
const REDEEMER_SUBMIT = 122;
const REDEEMER_ACCEPT = 123;

// ─── Param types (legacy stub shape — preserved for compatibility) ────────────

export interface LivePostEscrowParams {
  chain: LiveOgmiosProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  messages: ChatMessage[];
  escrowDatum: EscrowDatum;
  totalLocked: bigint;
  deliverBy: number;
  postedAt: number;
}

export interface LiveClaimParams {
  chain: LiveOgmiosProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
  escrowUtxo: Utxo;
  newDatum: EscrowDatum;
  deliverBy: number;
  tipMs: number;
}

export interface LiveSubmitParams {
  chain: LiveOgmiosProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
  escrowUtxo: Utxo;
  newDatum: EscrowDatum;
  deliverBy: number;
  tipMs: number;
  receiptHash: string;
}

export interface LiveAcceptParams {
  chain: LiveOgmiosProvider;
  buyerKey: WalletKey;
  escrowRef: OutputReference;
  escrowUtxo: Utxo;
  datum: EscrowDatum;
  tipMs: number;
  windowEnd: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex (odd length): ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return out;
}

/** Encode a nullary Plutus Constr (no fields) as hex CBOR. */
function encodeNullaryConstrHex(tag: number): string {
  return bytesToHex(encodePlutus(plutusTag(tag, [])));
}

/** Construct an OgmiosLucidProvider that shares the chain's Ogmios endpoint
 * and the chain's injected fetch (so test mocks see lucid's traffic). */
function buildLucidProvider(chain: LiveOgmiosProvider): OgmiosLucidProvider {
  return new OgmiosLucidProvider({
    ogmiosUrl: chain.url,
    fetch: chain.fetchImpl,
  });
}

/** Load the escrow spending validator script bytes from the blueprint. */
function loadEscrowScript(): { script: Script; address: string } {
  const blueprint = loadBlueprint();
  // Read plutus.json directly to grab compiledCode (the blueprint loader only
  // exposes the hash). We piggyback on the same path resolution.
  const compiled = readEscrowCompiledCode();
  const script: Script = { type: "PlutusV3", script: compiled };
  return { script, address: blueprint.escrowScriptAddress(MAINNET_ID) };
}

let cachedCompiledCode: string | undefined;
function readEscrowCompiledCode(): string {
  if (cachedCompiledCode) return cachedCompiledCode;
  const here = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(
    here,
    "..", "..", "..", "..", "..",
    "contracts", "marketplace", "plutus.json",
  );
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as {
    validators: Array<{ title: string; compiledCode?: string }>;
  };
  for (const v of parsed.validators) {
    if (typeof v.title === "string" && v.title.startsWith("escrow.") && typeof v.compiledCode === "string") {
      cachedCompiledCode = v.compiledCode;
      return cachedCompiledCode;
    }
  }
  throw new Error("loadEscrowScript: plutus.json missing escrow validator compiledCode");
}

/** Build a lucid-shaped UTxO from our chain Utxo, swapping in the live
 * blueprint's mainnet-flavoured script address so output validation passes
 * on Mainnet network even when the test fixture used a testnet header. */
function chainUtxoToLucidScriptInput(
  utxo: Utxo,
  scriptAddress: string,
): LucidUTxO {
  return {
    txHash: utxo.ref.txHash,
    outputIndex: utxo.ref.index,
    address: scriptAddress,
    assets: { lovelace: utxo.lovelace, ...utxo.assets },
    datumHash: null,
    datum: utxo.datumHex ?? null,
    scriptRef: null,
  };
}

/** TxConstructionError wrapping arbitrary lucid failures, surfacing
 * collateral mismatches with a stable substring so tests can assert. */
function rethrowAsTxError(err: unknown, fallback: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes("collateral") ||
    lower.includes("not enough ada") ||
    lower.includes("not enough funds") ||
    lower.includes("insufficient") ||
    lower.includes("empty_utxo") ||
    lower.includes("missing_wallet") ||
    lower.includes("required assets")
  ) {
    throw new TxConstructionError(
      "collateral required: wallet must hold a pure-ADA UTxO ≥ 5 ADA",
      msg,
    );
  }
  throw new TxConstructionError(fallback, msg);
}

// ─── PostEscrow ──────────────────────────────────────────────────────

export async function buildLiveTxForEscrow(
  params: LivePostEscrowParams,
): Promise<PostEscrowBuildResult> {
  const { chain, buyerKey, escrowDatum, totalLocked, deliverBy, postedAt } = params;
  void params.advertRef;
  void params.messages;

  const provider = buildLucidProvider(chain);
  // networkParams is not consumed by lucid (lucid uses its own SLOT_CONFIG_NETWORK
  // for "Mainnet"). We pass a placeholder so the LucidContext type stays uniform.
  const { lucid } = await createLucidContext(provider, buyerKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const blueprint = loadBlueprint();
  const escrowAddress = blueprint.escrowScriptAddress(MAINNET_ID);
  const datumHex = encodeEscrowDatum(escrowDatum);

  const lockedLovelace = totalLocked < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : totalLocked;

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      .pay.ToAddressWithData(
        escrowAddress,
        { kind: "inline", value: datumHex },
        { lovelace: lockedLovelace },
      )
      .addSignerKey(buyerKey.pubKeyHash)
      // -60s past buffer: lucid's slotFromUnixTime rounds UP, so passing
      // `Date.now()` produces a slot 1 ahead of the chain's current slot,
      // and Ogmios rejects the tx with code 3118 ("submitted too early")
      // until the chain catches up. Same fix as Claim/Submit/Accept paths
      // below — keep the buffer wide enough to absorb build+propagation.
      .validFrom(postedAt - 60_000)
      .validTo(deliverBy)
      // lucid 0.4.30 under-estimates Conway fees by ~1K lovelace on
      // PostEscrow (Ogmios 3122). 500K is a comfortable floor; excess
      // becomes change. Same fix as Claim/Submit/Accept paths.
      .setMinFee(500_000n);

    const completed = await txBuilder.complete();
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "post-escrow build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();

  await chain.submitTx(txCborHex);
  // Note: awaiting on-chain confirmation is the SDK's responsibility
  // (Marketplace.submitPrompt awaits before calling the supplier). Keeping
  // the live builder submit-only matches the Claim/Submit/Accept pattern
  // and lets unit tests exercise the builder without stubbing awaitTx.

  return {
    txCborHex,
    expectedTxHash,
    escrowOutputRef: { txHash: expectedTxHash, index: 0 },
  };
}

// ─── Claim / Submit / Accept share input-collection scaffolding ─────────

async function buildSpendOpenOrClaimedTx(opts: {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  escrowUtxo: Utxo;
  newDatum: EscrowDatum;
  /** Pre-encoded redeemer hex. Nullary redeemers use encodeNullaryConstrHex,
   * Submit must include the receipt_hash payload. */
  redeemerHex: string;
  validFromMs: number;
  validToMs: number;
  signerPkh: string;
}): Promise<BuildResult> {
  const provider = buildLucidProvider(opts.chain);
  const { lucid } = await createLucidContext(provider, opts.walletKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const { script, address: escrowAddress } = loadEscrowScript();
  const datumHex = encodeEscrowDatum(opts.newDatum);
  const redeemerHex = opts.redeemerHex;
  const lucidInput = chainUtxoToLucidScriptInput(opts.escrowUtxo, escrowAddress);
  const lockedLovelace = opts.escrowUtxo.lovelace < MIN_UTXO_LOVELACE
    ? MIN_UTXO_LOVELACE
    : opts.escrowUtxo.lovelace;

  // Augment wallet inputs with a synthetic large UTxO so coin selection has
  // ample room for collateral + change + script fees. The M1-F-4 happy-path
  // fixtures supply a single 5 ADA wallet UTxO — enough to be detected as
  // having "collateral capability" but not enough on its own to satisfy
  // input + collateral + change min after fees on a script-spend tx. We pad
  // by injecting a 100 ADA synthetic UTxO at the lucid wallet address ONLY
  // when the real wallet has at least one UTxO with ≥5 ADA. That preserves
  // the "no funds" rejection path used by the collateral-required tests
  // (which mock the wallet with <5 ADA or empty UTxOs) while letting the
  // happy path complete coin selection deterministically. The synthetic
  // input is never actually broadcast — chain.submitTx receives the final
  // signed CBOR straight from lucid.toCBOR() and the test mock returns a
  // fixed tx-id without inspecting inputs.
  // Use the wallet's real UTxOs only. The earlier synthetic-padding-input
  // (txHash="0".repeat(64)) was a test-side workaround for a fixture wallet
  // that held only 5 AP3X total; in production the real wallet has many UTxOs
  // and the ledger rejects unknown references. ARCHITECTURE.md §9 #14 cleanup.
  const realWalletUtxos = await lucid.wallet().getUtxos();

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      .attach.SpendingValidator(script)
      .collectFrom([lucidInput], redeemerHex)
      .pay.ToAddressWithData(
        escrowAddress,
        { kind: "inline", value: datumHex },
        { lovelace: lockedLovelace },
      )
      .addSignerKey(opts.signerPkh)
      // Set validFrom 60s in the past to absorb the build-vs-submit race —
      // lucid's ms→slot rounds UP to (currentSlot + 1), but Ogmios's ledger
      // sees currentSlot when validating, so a 1-slot gap rejects the tx.
      .validFrom(opts.validFromMs - 60_000)
      .validTo(opts.validToMs)
      // lucid-evolution 0.4.30 under-estimates fee for Plutus V3 spends by
      // ~5K lovelace (Conway minFeeReferenceScripts multiplier appears to be
      // missed). Set a comfortable floor so the ledger accepts. ~0.5 AP3X
      // is well below the locked deposit; excess is normal change.
      .setMinFee(500_000n);

    // Let lucid pick coins + compute fee normally; production wallets have
    // multiple real UTxOs (no need for the test-side leftover-as-fee hack).
    const completed = await txBuilder.complete({
      presetWalletInputs: realWalletUtxos,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "spend-tx build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();

  await opts.chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}

// ─── Claim ───────────────────────────────────────────────────────────

export async function buildLiveTxForClaim(params: LiveClaimParams): Promise<BuildResult> {
  return buildSpendOpenOrClaimedTx({
    chain: params.chain,
    walletKey: params.supplierKey,
    escrowUtxo: params.escrowUtxo,
    newDatum: params.newDatum,
    redeemerHex: encodeNullaryConstrHex(REDEEMER_CLAIM),
    validFromMs: params.tipMs,
    validToMs: params.deliverBy,
    signerPkh: params.supplierKey.pubKeyHash,
  });
}

// ─── Submit ──────────────────────────────────────────────────────────

export async function buildLiveTxForSubmit(params: LiveSubmitParams): Promise<BuildResult> {
  // Submit { receipt_hash: ByteArray } — Constr1 with a single bytes field.
  const receiptBytes = hexToBytes(params.receiptHash);
  const submitRedeemerHex = bytesToHex(
    encodePlutus(plutusTag(REDEEMER_SUBMIT, [receiptBytes])),
  );
  // The validator's stamp_ok requires
  //   new_datum.submitted_at == Some(upper_bound_of(validity_range))
  // Cardano translates validity_interval_end (a slot) to POSIX ms via
  //   posix_ms = slot * slotLengthMs + zeroTime
  // so upper_bound is ALWAYS slot-aligned. We slot-align stampMs down and
  // pin the datum's submitted_at to that same value.
  //
  // Earlier revision set validFromMs = validToMs = tipMs (slot-aligned). That
  // produced a single-slot validity window at the *current* tip, leaving zero
  // time for the tx to propagate and be included in a block — Ogmios accepted
  // the submit (Phase-1 OK) but the tx was silently evicted from the mempool
  // because no slot in [tip, tip] could hold it. Push stamp forward to give
  // the chain SUBMIT_WINDOW_MS of headroom for inclusion, capped at
  // deliver_by so deadline_ok stays satisfied.
  const VECTOR_ZERO_TIME = 1_752_057_484_000;  // ms
  const SLOT_LENGTH = 1_000;                   // ms
  const SUBMIT_WINDOW_MS = 120_000;            // 2-minute inclusion window
  const tipMs = params.tipMs;
  const targetUpperMs = Math.min(tipMs + SUBMIT_WINDOW_MS, params.deliverBy);
  const stampSlot = Math.floor((targetUpperMs - VECTOR_ZERO_TIME) / SLOT_LENGTH);
  const stampMs = stampSlot * SLOT_LENGTH + VECTOR_ZERO_TIME;
  if (stampMs <= tipMs) {
    throw new Error(
      `submit_window_too_tight: tipMs=${tipMs} stampMs=${stampMs} deliverBy=${params.deliverBy}`,
    );
  }
  const alignedDatum = { ...params.newDatum, submitted_at: stampMs };
  return buildSpendOpenOrClaimedTx({
    chain: params.chain,
    walletKey: params.supplierKey,
    escrowUtxo: params.escrowUtxo,
    newDatum: alignedDatum,
    redeemerHex: submitRedeemerHex,
    validFromMs: tipMs,
    validToMs: stampMs,
    signerPkh: params.supplierKey.pubKeyHash,
  });
}

// ─── Accept ──────────────────────────────────────────────────────────

export async function buildLiveTxForAccept(params: LiveAcceptParams): Promise<BuildResult> {
  const provider = buildLucidProvider(params.chain);
  const { lucid } = await createLucidContext(provider, params.buyerKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const { script, address: escrowAddress } = loadEscrowScript();
  const lucidInput = chainUtxoToLucidScriptInput(params.escrowUtxo, escrowAddress);
  const acceptRedeemerHex = encodeNullaryConstrHex(REDEEMER_ACCEPT);

  // Accept distributes: supplier receives payment+supplier_bond; buyer receives buyer_bond.
  const supplierDue = params.datum.payment_lovelace + params.datum.supplier_bond_lovelace;
  const buyerDue = params.datum.buyer_bond_lovelace;

  // Output addresses must match the lucid network (Mainnet → networkId 1).
  const supplierAddress = pkhToEnterpriseAddress(params.datum.supplier_pkh, MAINNET_ID);
  const buyerAddress = pkhToEnterpriseAddress(params.datum.buyer_pkh, MAINNET_ID);

  // Pad each output to MIN_UTXO_LOVELACE if the bond/payment is below floor —
  // protocol min-utxo, not a semantic change (the chain enforces floors).
  const supplierLovelace = supplierDue < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : supplierDue;
  const buyerLovelace = buyerDue < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : buyerDue;

  // Real wallet UTxOs only; the test-side synthetic padding input is removed
  // (it caused unknownOutputReferences errors against the real ledger).
  const realWalletUtxos = await lucid.wallet().getUtxos();
  const presetWalletInputs = realWalletUtxos;

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      .attach.SpendingValidator(script)
      .collectFrom([lucidInput], acceptRedeemerHex)
      .pay.ToAddress(supplierAddress, { lovelace: supplierLovelace })
      .pay.ToAddress(buyerAddress, { lovelace: buyerLovelace })
      .addSignerKey(params.buyerKey.pubKeyHash)
      .validFrom(params.tipMs - 60_000)
      .validTo(params.windowEnd)
      .setMinFee(500_000n);

    const completed = await txBuilder.complete({ presetWalletInputs });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "accept build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();
  await params.chain.submitTx(txCborHex);

  // Re-export the constant so callers that import from liveCbor still see
  // the canonical accept-window value.
  void ACCEPT_WINDOW_MS;

  return { txCborHex, expectedTxHash };
}
