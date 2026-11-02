// Internal API of the resolver core, for the gateway services that build on it (renderings, token
// service, status lists, catalogs). Everything that the gateway issues uses the view without
// options (Part 2 Section 8.4): `VectorResolver.currentRecord`.

export { VectorResolver, DID_MEDIA_TYPE, errorResult, httpStatus } from "./resolve/resolver.js";
export type { CurrentLookup, CurrentRecord, DidResolutionMetadata, ResolutionResult, VectorResolverOptions } from "./resolve/resolver.js";
export type { RecordList, RecordListEntry, FirstMint } from "./resolve/records.js";
export type { Effective, EffectiveReason, EffectiveStatus } from "./resolve/status.js";
export type { IdentityView, LegacyProfile, LegacyView, RecordView, ViewKey } from "./resolve/view.js";
export type { Origin } from "./resolve/history.js";
export { DID_CONTEXT, PURPOSE, buildDocument, type DidDocument, type VerificationMethod } from "./resolve/document.js";
export type { FetchedFacts, FetchedFactsProvider } from "./resolve/fetched.js";
export { REASON_NAMES, purposeNames, reasonName, signerName } from "./resolve/metadata.js";
export type {
  DidDocumentMetadata,
  VectorFetched,
  VectorHold,
  VectorKey,
  VectorLedger,
  VectorMetadataError,
  VectorParent,
  VectorParty,
  VectorProfile,
  VectorRecovery,
  VectorStatus,
} from "./resolve/metadata.js";
export { parseResolutionOptions, NO_OPTIONS, type ResolutionOptions, type ResolutionOptionsInput } from "./resolve/options.js";
export { parseDid, canonicalDid, legacyDid, type DidForm, type ParsedDid } from "./resolve/did.js";
export { ResolutionError, errorTypeUri, ERROR_HTTP_STATUS, type ResolutionErrorType } from "./resolve/errors.js";
export {
  CONFIRMATION_DEPTH,
  LEGACY_REGISTRY,
  MAX_ANCESTORS,
  VECTOR_MAINNET,
  registryOf,
  type NetworkParameters,
  type Registry,
  type RegistrySettings,
  type ResolverSettings,
} from "./resolve/settings.js";
export { blockTimeMs, formatTime, parseVersionTime } from "./resolve/time.js";
export { canonicalize } from "./resolve/jcs.js";
export { createResolverServer, type DidResolver, type ServerOptions } from "./server/http.js";
export { negotiate, RESOLUTION_MEDIA_TYPE, type Representation } from "./server/accept.js";
export { keyHash, multikey, p256PopValid } from "./codec/keys.js";
export { recordText } from "./codec/text.js";
export {
  decodeIdentityDatum,
  encodeIdentityDatum,
  identityDatumFromData,
  identityDatumToData,
  signerEquals,
  MAX_TIME_MS,
  type Hold,
  type IdentityDatum,
  type Key,
  type KeyType,
  type Lineage,
  type Party,
  type PendingRecovery,
  type Role,
  type Signer,
  type Status,
} from "./codec/identity-datum.js";
export { decodeLegacyDatum, encodeLegacyDatum, legacyDatumFromData, type LegacyDatum, type LegacyOwner } from "./codec/legacy-datum.js";
export { decodePlutusData, encodePlutusData, plutusDataEqual, type PlutusData } from "./codec/plutus-data.js";
export { KoiosOgmiosChainSource, type KoiosOgmiosSourceOptions } from "./chain/koios-ogmios-source.js";
export { KoiosClient, type KoiosClientOptions } from "./chain/koios.js";
export type { Asset, BlockWitnesses, ChainSource, ChainTip, GenesisParameters, LedgerTx, PolicyAsset, TxInput, TxOutput, TxWitnesses } from "./chain/types.js";
