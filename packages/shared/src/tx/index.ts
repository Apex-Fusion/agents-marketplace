/**
 * tx/index.ts — public exports for M1-B tx builders.
 */

export type { ChatMessage, WalletKey, BuildResult, PostAdvertBuildResult, PostEscrowBuildResult } from "./types.js";
export { TxConstructionError } from "./types.js";
export { mockSlotToWallclockMs, mockWallclockMsToSlot, NETWORK_BUFFER_MS } from "./internal/constants.js";
export { detectCborBackend, type CborBackend } from "./internal/cborBackend.js";
export type { Signer } from "./signer.js";
export { MockSigner } from "./signer.js";
export type { Blueprint } from "./blueprint.js";
export { loadBlueprint } from "./blueprint.js";
// Script-bytes loaders (used by the publish-reference-scripts CLI).
export { loadEscrowScript, loadAdvertScript } from "./internal/liveCbor.js";
export { pkhToEnterpriseAddress } from "./internal/pkhAddress.js";
export type {
  LivePublishRefScriptsParams,
  PublishRefScriptsBuildResult,
} from "./internal/publishReferenceScripts.js";
export { buildLiveTxForPublishReferenceScripts } from "./internal/publishReferenceScripts.js";

// Advert builders
export type { PostAdvertParams } from "./advert/postAdvert.js";
export { buildPostAdvertTx } from "./advert/postAdvert.js";
export type { UpdateAdvertParams } from "./advert/updateAdvert.js";
export { buildUpdateAdvertTx } from "./advert/updateAdvert.js";
export type { RetireAdvertParams } from "./advert/retireAdvert.js";
export { buildRetireAdvertTx } from "./advert/retireAdvert.js";

// Escrow builders
export type { PostEscrowParams } from "./escrow/postEscrow.js";
export { buildPostEscrowTx } from "./escrow/postEscrow.js";
export type { PostTtsEscrowParams, TtsRequest } from "./escrow/postTtsEscrow.js";
export {
  buildPostTtsEscrowTx,
  ttsPromptHash,
  ALLOWED_TTS_VOICES,
  ALLOWED_TTS_FORMATS,
} from "./escrow/postTtsEscrow.js";
export type { ClaimParams } from "./escrow/claim.js";
export { buildClaimTx } from "./escrow/claim.js";
export type { SubmitParams } from "./escrow/submit.js";
export { buildSubmitTx } from "./escrow/submit.js";
export type { AcceptParams } from "./escrow/accept.js";
export { buildAcceptTx, ACCEPT_WINDOW_MS } from "./escrow/accept.js";
export type { ReclaimParams } from "./escrow/reclaim.js";
export { buildReclaimTx } from "./escrow/reclaim.js";
export type { ReleaseParams } from "./escrow/release.js";
export { buildReleaseTx } from "./escrow/release.js";
