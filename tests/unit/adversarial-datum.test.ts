/**
 * Adversarial datum cases — M0-D
 *
 * Covers: ARCHITECTURE.md §7.3 adversarial cases testable at the datum layer.
 * Each untestable case is documented with a // TODO M1 comment and reason.
 *
 * Cases covered here:
 *   - request_spec_hash / prompt_hash mismatch → distinct CBOR hashes
 *   - Submit after deliver_by (datum-level: codec accepts, validator rejects)
 *   - Accept/Release/Reclaim timing (datum-level: codec permissive)
 *   - Double-submit idempotency (mock-level: re-submit same CBOR is idempotent)
 *   - Advert updated mid-flight / spec-lock: two adverts same supplier_pkh,
 *     different prices → distinct CBOR hashes
 *
 * Cases deferred to M1 (not testable at M0 datum layer):
 *   - Escrow to wrong script: requires chain/script validation code
 *   - Supplier claims escrow addressed to other supplier: requires validator
 *   - Concurrent escrows to single-slot supplier: requires supplier process code
 *   - Supplier status lies (free while working): requires HTTP supplier mock
 */

import { describe, it, expect } from "vitest";
import { encodeAdvertDatum, decodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeEscrowDatum, decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";

// ─── Base fixtures ────────────────────────────────────────────────────────────

const SUPPLIER_PKH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01";
const BUYER_PKH = "1234567890abcdef1234567890abcdef1234567890abcdef12345678";
const ADVERT_TX_HASH = "b".repeat(64);

const BASE_POSTED_AT = 1745500000000;
const BASE_DELIVER_BY = BASE_POSTED_AT + 60_000;
const BASE_SUBMITTED_AT = BASE_POSTED_AT + 10_000;

function makeBaseAdvert(overrides?: Partial<AdvertDatum>): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER_PKH,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com/v1",
    detail_uri: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    detail_hash: "a".repeat(64),
    advertised_at: BASE_POSTED_AT,
    status: "Active",
    ...overrides,
  };
}

function makeBaseEscrow(overrides?: Partial<EscrowDatum>): EscrowDatum {
  return {
    buyer_pkh: BUYER_PKH,
    supplier_pkh: SUPPLIER_PKH,
    advert_ref: { txHash: ADVERT_TX_HASH, index: 0 },
    capability_id: "llm.text.generate.v1",
    request_spec_hash: "c".repeat(64),
    prompt_hash: "d".repeat(64),
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: BASE_DELIVER_BY,
    posted_at: BASE_POSTED_AT,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    ...overrides,
  };
}

function makeUtxo(ref: OutputReference): Utxo {
  return {
    ref,
    address: "addr_test1vpqthemefkuvelrqprngush5adstneyesq2a4yh7jrfpheq3azpck",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: null,
    scriptRef: null,
  };
}

// ─── §7.3: request_spec_hash / prompt_hash mismatch ──────────────────────────

describe("Adversarial §7.3 — request_spec_hash / prompt_hash mismatch", () => {
  it("escrow with different request_spec_hash produces different CBOR", () => {
    const e1 = makeBaseEscrow({ request_spec_hash: "c".repeat(64) });
    const e2 = makeBaseEscrow({ request_spec_hash: "f".repeat(64) });
    expect(encodeEscrowDatum(e1)).not.toBe(encodeEscrowDatum(e2));
  });

  it("escrow with different prompt_hash produces different CBOR", () => {
    const e1 = makeBaseEscrow({ prompt_hash: "d".repeat(64) });
    const e2 = makeBaseEscrow({ prompt_hash: "9".repeat(64) });
    expect(encodeEscrowDatum(e1)).not.toBe(encodeEscrowDatum(e2));
  });

  it("request_spec_hash mismatch is detectable after round-trip", () => {
    const correct = makeBaseEscrow({ request_spec_hash: "c".repeat(64) });
    const tampered = makeBaseEscrow({ request_spec_hash: "f".repeat(64) });

    const hexCorrect = encodeEscrowDatum(correct);
    const hexTampered = encodeEscrowDatum(tampered);

    const decodedCorrect = decodeEscrowDatum(hexCorrect);
    const decodedTampered = decodeEscrowDatum(hexTampered);

    expect(decodedCorrect.request_spec_hash).toBe("c".repeat(64));
    expect(decodedTampered.request_spec_hash).toBe("f".repeat(64));
    expect(decodedCorrect.request_spec_hash).not.toBe(decodedTampered.request_spec_hash);
  });

  it("prompt_hash mismatch is detectable after round-trip", () => {
    const correct = makeBaseEscrow({ prompt_hash: "d".repeat(64) });
    const tampered = makeBaseEscrow({ prompt_hash: "9".repeat(64) });

    const decodedCorrect = decodeEscrowDatum(encodeEscrowDatum(correct));
    const decodedTampered = decodeEscrowDatum(encodeEscrowDatum(tampered));

    expect(decodedCorrect.prompt_hash).not.toBe(decodedTampered.prompt_hash);
  });

  it("both hashes identical across buyer/supplier encode to same CBOR", () => {
    // When hashes match (happy path) — codec produces identical output
    const buyerEscrow = makeBaseEscrow({
      request_spec_hash: "c".repeat(64),
      prompt_hash: "d".repeat(64),
    });
    const supplierView = makeBaseEscrow({
      request_spec_hash: "c".repeat(64),
      prompt_hash: "d".repeat(64),
    });
    expect(encodeEscrowDatum(buyerEscrow)).toBe(encodeEscrowDatum(supplierView));
  });
});

// ─── §7.3: Submit after deliver_by (datum-level) ─────────────────────────────

describe("Adversarial §7.3 — Submit after deliver_by (datum-level: codec permissive)", () => {
  it("datum with submitted_at > deliver_by encodes and decodes without error", () => {
    // The codec does NOT validate timing — that is the validator's responsibility.
    const escrow: EscrowDatum = {
      ...makeBaseEscrow(),
      state: "Submitted",
      submitted_at: BASE_DELIVER_BY + 5_000, // 5s after deadline
      result_receipt_hash: "e".repeat(64),
    };
    const hex = encodeEscrowDatum(escrow);
    const decoded = decodeEscrowDatum(hex);
    expect(decoded.submitted_at).toBe(BASE_DELIVER_BY + 5_000);
    expect(decoded.state).toBe("Submitted");
  });

  it("submitted_at equal to deliver_by encodes and decodes without error", () => {
    const escrow: EscrowDatum = {
      ...makeBaseEscrow(),
      state: "Submitted",
      submitted_at: BASE_DELIVER_BY,
      result_receipt_hash: "e".repeat(64),
    };
    const decoded = decodeEscrowDatum(encodeEscrowDatum(escrow));
    expect(decoded.submitted_at).toBe(BASE_DELIVER_BY);
  });
});

// ─── §7.3: Accept timing / Accept after ACCEPT_WINDOW ────────────────────────

describe("Adversarial §7.3 — Accept/Release/Reclaim timing (datum-level: codec permissive)", () => {
  it("Accepted datum encodes and decodes regardless of elapsed time since Submitted", () => {
    // Timing of Accept is validator-level; codec is permissive.
    const escrow: EscrowDatum = {
      ...makeBaseEscrow(),
      state: "Accepted",
      submitted_at: BASE_SUBMITTED_AT,
      result_receipt_hash: "e".repeat(64),
    };
    const decoded = decodeEscrowDatum(encodeEscrowDatum(escrow));
    expect(decoded.state).toBe("Accepted");
    expect(decoded.submitted_at).toBe(BASE_SUBMITTED_AT);
  });

  it("Released datum (past ACCEPT_WINDOW) encodes and decodes correctly", () => {
    const escrow: EscrowDatum = {
      ...makeBaseEscrow(),
      state: "Released",
      submitted_at: BASE_SUBMITTED_AT,
      result_receipt_hash: "e".repeat(64),
    };
    const decoded = decodeEscrowDatum(encodeEscrowDatum(escrow));
    expect(decoded.state).toBe("Released");
  });

  it("Reclaimed datum before deliver_by encodes without error (codec permissive — validator rejects)", () => {
    // deliver_by = BASE_DELIVER_BY; we set a reclaim before it — codec must not care.
    const escrow: EscrowDatum = {
      ...makeBaseEscrow(),
      state: "Reclaimed",
      // No submitted_at or receipt hash for Reclaimed
    };
    const decoded = decodeEscrowDatum(encodeEscrowDatum(escrow));
    expect(decoded.state).toBe("Reclaimed");
  });
});

// ─── §7.3: Double-submit idempotency (mock-level) ────────────────────────────

describe("Adversarial §7.3 — double-submit idempotency", () => {
  it("re-submitting the same escrow CBOR to MockChainProvider is idempotent", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "1".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref));

    const txHex = MockChainProvider.buildTestTx({ inputs: [ref] });
    const hash1 = await mock.submitTx(txHex);
    const hash2 = await mock.submitTx(txHex);

    // Same hash returned for identical CBOR
    expect(hash1).toBe(hash2);
  });

  it("double-submit does not corrupt UTxO state", async () => {
    const mock = new MockChainProvider({});
    const ref: OutputReference = { txHash: "2".repeat(64), index: 0 };
    mock.seed(makeUtxo(ref));

    const txHex = MockChainProvider.buildTestTx({ inputs: [ref] });
    await mock.submitTx(txHex);
    await mock.submitTx(txHex); // idempotent re-submit

    // UTxO was spent exactly once — still null after second submit
    expect(await mock.queryUtxo(ref)).toBeNull();
  });

  it("re-submitting escrow datum CBOR (not spending-tx) is also idempotent", async () => {
    const mock = new MockChainProvider({});
    const escrowHex = encodeEscrowDatum(makeBaseEscrow());

    // escrowHex is not a spending tx (not JSON-in-hex), so MockChainProvider
    // stores it as an opaque transaction — no UTxO side effects.
    const hash1 = await mock.submitTx(escrowHex);
    const hash2 = await mock.submitTx(escrowHex);
    expect(hash1).toBe(hash2);
  });
});

// ─── §7.3: Advert updated mid-flight / spec-lock ─────────────────────────────

describe("Adversarial §7.3 — advert spec-lock (mid-flight update)", () => {
  it("two adverts from same supplier with different prices produce distinct CBOR", () => {
    const advert1 = makeBaseAdvert({ price_lovelace: 2_000_000n });
    const advert2 = makeBaseAdvert({ price_lovelace: 3_000_000n });

    const hex1 = encodeAdvertDatum(advert1);
    const hex2 = encodeAdvertDatum(advert2);

    expect(hex1).not.toBe(hex2);
  });

  it("buyer's advert_ref encodes the specific UTxO the buyer locked onto", () => {
    // Spec-lock: the escrow references the exact ad UTxO (txHash#index).
    // If the supplier posts a new ad with a different price at a new UTxO,
    // the escrow still encodes the OLD advert_ref — codec must preserve it.
    const oldAdvertRef = { txHash: ADVERT_TX_HASH, index: 0 };
    const newAdvertRef = { txHash: "e".repeat(64), index: 0 };

    const escrowAtOldAd = makeBaseEscrow({ advert_ref: oldAdvertRef });
    const escrowAtNewAd = makeBaseEscrow({ advert_ref: newAdvertRef });

    const decodedOld = decodeEscrowDatum(encodeEscrowDatum(escrowAtOldAd));
    const decodedNew = decodeEscrowDatum(encodeEscrowDatum(escrowAtNewAd));

    expect(decodedOld.advert_ref.txHash).toBe(ADVERT_TX_HASH);
    expect(decodedNew.advert_ref.txHash).toBe("e".repeat(64));
    // Different advert refs → different CBOR → spec-lock holds at datum level
    expect(encodeEscrowDatum(escrowAtOldAd)).not.toBe(encodeEscrowDatum(escrowAtNewAd));
  });

  it("two adverts with same supplier_pkh but different prices have distinct CBOR hashes (minimum baseline)", () => {
    const advertV1 = makeBaseAdvert({
      price_lovelace: 2_000_000n,
      advertised_at: BASE_POSTED_AT,
    });
    const advertV2 = makeBaseAdvert({
      price_lovelace: 2_500_000n,
      advertised_at: BASE_POSTED_AT + 60_000,
    });

    expect(advertV1.supplier_pkh).toBe(advertV2.supplier_pkh);
    expect(encodeAdvertDatum(advertV1)).not.toBe(encodeAdvertDatum(advertV2));
  });

  it("retired advert encodes differently from active advert (Update → Retire flow)", () => {
    const active = makeBaseAdvert({ status: "Active" });
    const retired = makeBaseAdvert({ status: "Retired" });

    expect(encodeAdvertDatum(active)).not.toBe(encodeAdvertDatum(retired));
    expect(decodeAdvertDatum(encodeAdvertDatum(retired)).status).toBe("Retired");
  });
});

// ─── §7.3: Deferred to M1 ─────────────────────────────────────────────────────
// TODO M1: "Escrow to wrong script" — requires a live script hash and on-chain
//   address derivation to test that the escrow UTxO is locked at the wrong script.
//   Not testable at the datum codec layer.
//
// TODO M1: "Supplier claims escrow addressed to other supplier" — requires a
//   validator that checks supplier_pkh == signing key hash.  The datum codec
//   is permissive; this constraint is enforced on-chain.
//
// TODO M1: "Concurrent escrows to single-slot supplier" — requires a running
//   supplier process with a slot-lock mechanism.  Not testable at M0 datum layer.
//
// TODO M1: "Supplier status lies (free while actually working)" — requires an
//   HTTP supplier mock that can serve /status while also processing a job.
//   Out of scope for the datum-layer test suite.
//
// TODO M1: "Replay of Accept/Release" — requires the validator to track spent
//   UTxO refs.  The datum codec itself does not prevent replay; that is
//   enforced by the UTXO model (a spent UTxO cannot be re-spent).
