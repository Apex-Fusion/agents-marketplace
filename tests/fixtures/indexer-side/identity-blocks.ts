/**
 * tests/fixtures/indexer-side/identity-blocks.ts — identity registry fixtures for indexer tests.
 *
 * Builders for the new advert (14 fields, Part 2 §6.2), the new escrow
 * (16 fields with agent_id and refund, §6.1), identity record outputs at the
 * identity address, raw Ogmios v6 transactions, and identity gateway answers.
 *
 * Indexer-side only (see sample-blocks.ts). Addresses are testnet enterprise
 * script addresses of synthetic script hashes, so that the config validation
 * accepts them.
 */

import { plutusAddressToBech32, type PlutusAddress } from "../../../packages/shared/src/cbor/address.js";
import type { PlutusData } from "../../../packages/shared/src/cbor/plutus-data.js";
import { encodeIdentityAdvertDatum } from "../../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { encodeIdentityEscrowDatum, type Refund } from "../../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import {
  INDEXER_BUYER_PKH,
  INDEXER_SUPPLIER_ENDPOINT,
  INDEXER_SUPPLIER_PKH,
  SAMPLE_ADVERT_REF_INDEX,
  SAMPLE_ADVERT_REF_TX,
  SAMPLE_DELIVER_BY,
  SAMPLE_POSTED_AT,
  SAMPLE_PROMPT_HASH,
  SAMPLE_RECEIPT_HASH,
  SAMPLE_REQUEST_SPEC_HASH,
  SAMPLE_SUBMITTED_AT,
  escrowRedeemerHex,
  type AdvertDatumOpts,
  type EscrowDatumOpts,
  type EscrowRedeemerType,
  type MockTx,
  type MockTxOutput,
} from "./sample-blocks.js";

// ─── Addresses and identities ────────────────────────────────────────────────

const scriptAddress = (hash: string): string =>
  plutusAddressToBech32({ paymentCredential: { type: "Script", hash }, stakeCredential: null }, 0);

export const IDENTITY_POLICY_ID = "1d".repeat(28);
export const IDENTITY_ADDRESS = scriptAddress(IDENTITY_POLICY_ID);
export const IDENTITY_ADVERT_SCRIPT_HASH = "a2".repeat(28);
export const IDENTITY_ADVERT_SCRIPT_ADDRESS = scriptAddress(IDENTITY_ADVERT_SCRIPT_HASH);
export const IDENTITY_ESCROW_SCRIPT_HASH = "e2".repeat(28);
export const IDENTITY_ESCROW_SCRIPT_ADDRESS = scriptAddress(IDENTITY_ESCROW_SCRIPT_HASH);

/** The agent of the supplier key INDEXER_SUPPLIER_PKH. */
export const AGENT_ID = "7a".repeat(32);
export const OTHER_AGENT_ID = "7b".repeat(32);
/** A key that is neither the buyer nor the supplier (third-party Reclaim, RefundRevoked). */
export const THIRD_PARTY_PKH = "3d".repeat(28);
export const THIRD_PARTY_ADDRESS = plutusAddressToBech32(
  { paymentCredential: { type: "VerificationKey", hash: THIRD_PARTY_PKH }, stakeCredential: null },
  0,
);

/** Refund to the buyer key with no datum (what Post builders set, Part 2 §6.5). */
export const BUYER_REFUND: Refund = {
  address: { paymentCredential: { type: "VerificationKey", hash: INDEXER_BUYER_PKH }, stakeCredential: null },
  datum: null,
};

/** BUYER_REFUND.address as bech32 on the testnet (what the escrow view shows). */
export const BUYER_REFUND_ADDRESS = plutusAddressToBech32(BUYER_REFUND.address, 0);

/** Refund to a script address with an inline datum (vault refunds, Part 2 §5.3). */
export const VAULT_REFUND_DATUM: PlutusData = { kind: "constr", index: 0n, fields: [{ kind: "bytes", hex: "ab".repeat(4) }] };
export const VAULT_REFUND: Refund = {
  address: {
    paymentCredential: { type: "Script", hash: "5a".repeat(28) },
    stakeCredential: { type: "Inline", credential: { type: "VerificationKey", hash: "5b".repeat(28) } },
  } satisfies PlutusAddress,
  datum: VAULT_REFUND_DATUM,
};

// ─── Datums ──────────────────────────────────────────────────────────────────

export function buildIdentityAdvertDatumHex(opts: AdvertDatumOpts & { agentId?: string } = {}): string {
  return encodeIdentityAdvertDatum({
    supplier_pkh: opts.supplierPkh ?? INDEXER_SUPPLIER_PKH,
    capability_id: opts.capabilityId ?? "llm.text.generate.v1",
    model: opts.model ?? "qwen2.5:0.5b",
    max_output_tokens: opts.maxOutputTokens ?? 512,
    max_processing_ms: opts.maxProcessingMs ?? 60_000,
    price_lovelace: opts.priceLovelace ?? 2_000_000n,
    supplier_bond_lovelace: opts.supplierBondLovelace ?? 1_000_000n,
    buyer_bond_lovelace: opts.buyerBondLovelace ?? 1_000_000n,
    endpoint_url: opts.endpointUrl ?? INDEXER_SUPPLIER_ENDPOINT,
    detail_uri: opts.detailUri ?? "ipfs://QmIndexerIdentityTest",
    detail_hash: opts.detailHash ?? "b".repeat(64),
    advertised_at: opts.advertisedAt ?? 1_750_000_000_000,
    status: opts.status ?? "Active",
    agent_id: opts.agentId ?? AGENT_ID,
  });
}

export interface IdentityEscrowDatumOpts extends EscrowDatumOpts {
  agentId?: string;
  /** undefined: BUYER_REFUND; null: refund not set. */
  refund?: Refund | null;
}

export function buildIdentityEscrowDatumHex(opts: IdentityEscrowDatumOpts = {}): string {
  return encodeIdentityEscrowDatum({
    buyer_pkh: opts.buyerPkh ?? INDEXER_BUYER_PKH,
    supplier_pkh: opts.supplierPkh ?? INDEXER_SUPPLIER_PKH,
    advert_ref: { txHash: opts.advertRefTx ?? SAMPLE_ADVERT_REF_TX, index: opts.advertRefIndex ?? SAMPLE_ADVERT_REF_INDEX },
    capability_id: opts.capabilityId ?? "llm.text.generate.v1",
    request_spec_hash: opts.requestSpecHash ?? SAMPLE_REQUEST_SPEC_HASH,
    prompt_hash: opts.promptHash ?? SAMPLE_PROMPT_HASH,
    payment_lovelace: opts.paymentLovelace ?? 2_000_000n,
    buyer_bond_lovelace: opts.buyerBondLovelace ?? 1_000_000n,
    supplier_bond_lovelace: opts.supplierBondLovelace ?? 1_000_000n,
    deliver_by: opts.deliverBy ?? SAMPLE_DELIVER_BY,
    posted_at: opts.postedAt ?? SAMPLE_POSTED_AT,
    submitted_at: opts.submittedAt ?? null,
    result_receipt_hash: opts.resultReceiptHash ?? null,
    state: opts.state ?? "Open",
    agent_id: opts.agentId ?? AGENT_ID,
    refund: opts.refund === undefined ? BUYER_REFUND : opts.refund,
  });
}

export function submittedIdentityEscrowOpts(opts: IdentityEscrowDatumOpts = {}): IdentityEscrowDatumOpts {
  return { ...opts, state: "Submitted", submittedAt: SAMPLE_SUBMITTED_AT, resultReceiptHash: SAMPLE_RECEIPT_HASH };
}

// ─── Transactions (IndexerBlock shape) ───────────────────────────────────────

let counter = 0x7000;
const nextTxId = (): string => (counter++).toString(16).padStart(64, "0");
const fundingInput = (txId: string) => ({ transaction: { id: `f${txId.slice(1)}` }, index: 0 });

/** PostAdvert at the new advert address; `requiredSigners` defaults to the supplier key. */
export function buildIdentityPostAdvertTx(opts: {
  txId?: string;
  datum?: AdvertDatumOpts & { agentId?: string };
  requiredSigners?: string[];
} = {}): MockTx {
  const txId = opts.txId ?? nextTxId();
  return {
    id: txId,
    inputs: [fundingInput(txId)],
    outputs: [{
      address: IDENTITY_ADVERT_SCRIPT_ADDRESS,
      value: { ada: { lovelace: 2_000_000 } },
      datum: buildIdentityAdvertDatumHex(opts.datum),
    }],
    requiredSigners: opts.requiredSigners ?? [opts.datum?.supplierPkh ?? INDEXER_SUPPLIER_PKH],
  };
}

/** UpdateAdvert at the new advert address: spends `spentRef`, writes the new datum, signed by the supplier key. */
export function buildIdentityUpdateAdvertTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  datum?: AdvertDatumOpts & { agentId?: string };
}): MockTx {
  const txId = opts.txId ?? nextTxId();
  return {
    ...buildIdentityPostAdvertTx({ txId, datum: opts.datum }),
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }, fundingInput(txId)],
  };
}

/** PostEscrow at the new escrow address (state Open). */
export function buildIdentityPostEscrowTx(opts: { txId?: string; datum?: IdentityEscrowDatumOpts } = {}): MockTx {
  const txId = opts.txId ?? nextTxId();
  return {
    id: txId,
    inputs: [fundingInput(txId)],
    outputs: [{
      address: IDENTITY_ESCROW_SCRIPT_ADDRESS,
      value: { ada: { lovelace: 4_000_000 } },
      datum: buildIdentityEscrowDatumHex({ ...opts.datum, state: "Open" }),
    }],
  };
}

/**
 * Spend of a new escrow with `redeemer`. `continuing` adds the continuing
 * output (Claim, Submit); without it the spend is terminal and pays `payTo`.
 * `signers` lists the required signers (a third-party Reclaim has neither
 * the buyer nor the supplier).
 */
export function buildIdentityEscrowSpendTx(opts: {
  txId?: string;
  spentRef: { txId: string; index: number };
  redeemer: EscrowRedeemerType;
  continuing?: IdentityEscrowDatumOpts;
  payTo?: string;
  signers?: string[];
  extraOutputs?: MockTxOutput[];
}): MockTx {
  const txId = opts.txId ?? nextTxId();
  const spentKey = `${opts.spentRef.txId}#${opts.spentRef.index}`;
  const outputs: MockTxOutput[] = opts.continuing
    ? [{ address: IDENTITY_ESCROW_SCRIPT_ADDRESS, value: { ada: { lovelace: 4_000_000 } }, datum: buildIdentityEscrowDatumHex(opts.continuing) }]
    : [{ address: opts.payTo ?? THIRD_PARTY_ADDRESS, value: { ada: { lovelace: 4_000_000 } } }];
  return {
    id: txId,
    inputs: [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }, fundingInput(txId)],
    outputs: [...outputs, ...(opts.extraOutputs ?? [])],
    requiredSigners: opts.signers ?? [],
    spendRedeemers: { [spentKey]: escrowRedeemerHex(opts.redeemer, SAMPLE_RECEIPT_HASH) },
  };
}

/** An output at the identity address holding `tokens` of the identity policy (asset name → quantity). */
export function identityRecordOutput(tokens: Record<string, number>, datum = "d87980"): MockTxOutput {
  return {
    address: IDENTITY_ADDRESS,
    value: { ada: { lovelace: 10_000_000 }, [IDENTITY_POLICY_ID]: tokens },
    datum,
  };
}

/** Register (no spent record) or update (spends `spentRef`) of the record of `agentId`. */
export function buildIdentityRecordTx(opts: {
  txId?: string;
  agentId?: string;
  spentRef?: { txId: string; index: number };
  datum?: string;
}): MockTx {
  const txId = opts.txId ?? nextTxId();
  return {
    id: txId,
    inputs: [
      ...(opts.spentRef ? [{ transaction: { id: opts.spentRef.txId }, index: opts.spentRef.index }] : []),
      fundingInput(txId),
    ],
    outputs: [identityRecordOutput({ [opts.agentId ?? AGENT_ID]: 1 }, opts.datum)],
  };
}

// ─── Raw Ogmios v6 shapes (v6.14.0 docs/static/cardano.json) ─────────────────

export interface OgmiosRedeemerFixture {
  validator: { purpose: "spend" | "mint" | "publish" | "withdraw" | "vote" | "propose"; index: number };
  redeemer: string;
  executionUnits: { memory: number; cpu: number };
}

export function ogmiosRedeemer(purpose: OgmiosRedeemerFixture["validator"]["purpose"], index: number, redeemer: string): OgmiosRedeemerFixture {
  return { validator: { purpose, index }, redeemer, executionUnits: { memory: 1_000, cpu: 1_000_000 } };
}

// ─── Identity gateway answers (Part 1 §8.2 metadata members) ─────────────────

export interface ResolutionFixtureOpts {
  effective?: "active" | "suspended" | "revoked" | "retired";
  origin?: "native" | "adopted" | "legacy";
  parent?: string;
  keys?: Array<{ keyHash: string; type?: "Ed25519" | "P-256"; purposes: string[] }>;
  capabilities?: string[];
}

/** A resolution result with the members that the indexer reads, for `did:vector:<agentId>`. */
export function resolutionResult(agentId: string, opts: ResolutionFixtureOpts = {}): Record<string, unknown> {
  const did = `did:vector:${agentId}`;
  const keys = opts.keys ?? [{ keyHash: INDEXER_SUPPLIER_PKH, purposes: ["authentication", "transaction"] }];
  const capabilities = opts.capabilities ?? ["llm.text.generate.v1"];
  return {
    didDocument: { "@context": "https://www.w3.org/ns/did/v1.1", id: did },
    didDocumentMetadata: {
      canonicalId: did,
      created: "2026-11-02T10:00:00Z",
      vectorOrigin: opts.origin ?? "native",
      ...(opts.parent ? { vectorParent: { parent: `did:vector:${opts.parent}`, parentEpoch: 0, depth: 1 } } : {}),
      vectorStatus: { status: "active", effective: opts.effective ?? "active" },
      ...(keys.length > 0
        ? { vectorKeys: keys.map((k) => ({ id: `#${k.keyHash}`, type: k.type ?? "Ed25519", purposes: k.purposes })) }
        : {}),
      vectorProfile: { name: "indexer test agent", ...(capabilities.length > 0 ? { capabilities } : {}), createdAt: "2026-11-02T10:00:00Z" },
      versionId: "0",
    },
    didResolutionMetadata: { contentType: "application/did" },
  };
}

export function resolutionError(name: "NOT_FOUND" | "INVALID_DID" | "INTERNAL_ERROR"): Record<string, unknown> {
  return {
    didDocument: null,
    didDocumentMetadata: {},
    didResolutionMetadata: { error: { type: `https://www.w3.org/ns/did#${name}`, title: name } },
  };
}
