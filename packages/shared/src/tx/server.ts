/**
 * tx/server.ts — server-only re-exports.
 *
 * These bind the lucid-evolution + CML WASM dep graph at import time, so
 * they MUST NOT be imported from anything that gets bundled by Vite (i.e.
 * the buyer UI). The buyer SDK uses /* @vite-ignore *\/ dynamic imports
 * to reach the live-CBOR builders for the same reason.
 *
 * Consumers: supplier CLIs and Node-only tx tooling.
 *
 * The names that need no lucid are defined in "./lucidFree.js" (package subpath
 * "@marketplace/shared/tx/lucid-free"). This module re-exports all of them, so this path keeps
 * every name. A file that needs only those names imports "./lucidFree.js": its process then
 * does not load lucid.
 */

export * from "./lucidFree.js";

export { loadEscrowScript, loadAdvertScript } from "./internal/liveCbor.js";
export type { RefUtxoEnvKey } from "./internal/liveCbor.js";
export { loadIdentityEscrowScript, loadIdentityAdvertScript } from "./internal/liveIdentityCbor.js";
export type { SignedTransactionInfo, SignedTransactionFinancials } from "./internal/signedTransaction.js";
export { inspectSignedTransaction, inspectSignedTransactionFinancials } from "./internal/signedTransaction.js";

// ── Health of the decoder library in a process ──────────────────────────
// Only a process that loads the library imports this barrel, so only such a process can start the check.
export type { DecoderHealth, DecoderHealthOptions } from "./internal/decoderHealth.js";
export { startDecoderHealth } from "./internal/decoderHealth.js";

// ── Wallet consolidate (one-shot operational tx; live-only) ─────────────
export type {
  ConsolidateWalletParams,
  ConsolidateWalletBuildResult,
} from "./wallet/consolidateWallet.js";
export { buildConsolidateWalletTx } from "./wallet/consolidateWallet.js";
export type {
  ConsolidateWalletFlowParams,
  ConsolidateWalletFlowResult,
} from "./wallet/runConsolidateWallet.js";
export { runConsolidateWallet } from "./wallet/runConsolidateWallet.js";

// ── Wallet withdraw (custodial exit; live-only) ─────────────────────────
export type {
  WithdrawWalletParams,
  WithdrawWalletBuildResult,
} from "./wallet/withdrawWallet.js";
export { buildWithdrawTx } from "./wallet/withdrawWallet.js";

// ── Surplus Merkle-batch anchor (live-only) ────────────────────────────
export type {
  AnchorMetadataParams,
  SurplusSaleProofAnchorMetadata,
} from "./wallet/anchorMetadata.js";
export {
  MAX_TRANSACTION_METADATA_TEXT_BYTES,
  SURPLUS_SALE_PROOF_METADATA_LABEL,
  SURPLUS_SALE_PROOF_PROTOCOL,
  buildAnchorMetadataTx,
  validateSurplusSaleProofAnchorMetadata,
} from "./wallet/anchorMetadata.js";
