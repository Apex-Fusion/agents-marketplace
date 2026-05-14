/**
 * tx/server.ts — server-only re-exports.
 *
 * These bind the lucid-evolution + CML WASM dep graph at import time, so
 * they MUST NOT be imported from anything that gets bundled by Vite (i.e.
 * the buyer UI). The buyer SDK uses /* @vite-ignore *\/ dynamic imports
 * to reach the live-CBOR builders for the same reason.
 *
 * Consumers: supplier CLIs and Node-only tx tooling.
 */

export { loadEscrowScript, loadAdvertScript } from "./internal/liveCbor.js";
export { pkhToEnterpriseAddress } from "./internal/pkhAddress.js";
export type {
  LivePublishRefScriptsParams,
  PublishRefScriptsBuildResult,
} from "./internal/publishReferenceScripts.js";
export { buildLiveTxForPublishReferenceScripts } from "./internal/publishReferenceScripts.js";
