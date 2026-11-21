/**
 * tx/lucidFree.ts — the server-side exports that do NOT load @lucid-evolution/lucid.
 *
 * "./server.js" re-exports every name of this module and adds the builders that bind the lucid-evolution + CML WASM dep graph at
 * import time. A file that needs only names of this module imports it (package subpath "@marketplace/shared/tx/lucid-free"), so
 * that its process does not load lucid.
 *
 * RULE: no module that this file re-exports may import "@lucid-evolution/*", directly or through another module. A name that needs
 * lucid belongs in "./server.js" only.
 *
 * Like "./server.js", this module is not in the "./index.js" barrel: the buyer UI bundle does not use these names.
 */

export { pkhToEnterpriseAddress } from "./internal/pkhAddress.js";

// ── Reference-script publisher ──────────────────────────────────────────
export type {
  PublishedReference,
  PublishReferenceScriptsArgs,
  PublishReferenceScriptsTx,
  ReferenceScript,
} from "./internal/publishReferenceScripts.js";
export {
  buildPublishReferenceScripts,
  REFERENCE_SCRIPT_KEY_HASH,
  referenceScriptAddress,
} from "./internal/publishReferenceScripts.js";

// ── Wallet consolidate planner (pure; the builder and the flow are in "./server.js") ──
export type {
  ConsolidateLimits,
  ConsolidateReason,
  PlannedConsolidate,
  UtxoLike,
} from "./wallet/planConsolidate.js";
export {
  DEFAULT_COLLATERAL_LOVELACE,
  DEFAULT_FEE_RESERVE,
  planConsolidate,
} from "./wallet/planConsolidate.js";

// ── Address text checks (before Lucid reads an address text) ────────────
export { MAX_ADDRESS_TEXT_LENGTH, checkedAddressText, checkedShelleyAddress, isAddressRefusal } from "./internal/addressText.js";
