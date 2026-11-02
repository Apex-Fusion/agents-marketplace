// did:vector resolution (Part 1 Section 7.1): one ledger tip for each request; the record and its
// ancestors read as of that tip; view, effective status, document and metadata built from them.
// A failed or inconsistent ledger read gives INTERNAL_ERROR, never NOT_FOUND or a partial document.

import type { ChainSource, ChainTip } from "../chain/types.js";
import { parseDid } from "./did.js";
import { buildDocument, type DidDocument } from "./document.js";
import { ERROR_HTTP_STATUS, ResolutionError, errorTypeUri } from "./errors.js";
import { loadHistory, type HistoryLookup, type LedgerSnapshot, type Origin, type RecordHistory, type Version } from "./history.js";
import { LegacyKeySearch } from "./legacy-key.js";
import { baseLedger, buildMetadata, type DidDocumentMetadata, type VectorLedger, type VectorMetadataError } from "./metadata.js";
import { parseResolutionOptions, type ResolutionOptionsInput } from "./options.js";
import type { FetchedFactsProvider } from "./fetched.js";
import { listRecords, type FirstMintCache, type RecordList } from "./records.js";
import { CONFIRMATION_DEPTH, MAX_ANCESTORS, checkRegistrySettings, type ResolverSettings } from "./settings.js";
import { evaluate, lineageOf, type Effective, type Evaluation, type Selection } from "./status.js";
import { blockTimeMs } from "./time.js";
import type { RecordView } from "./view.js";

/** Media type of the DID document representation. */
export const DID_MEDIA_TYPE = "application/did";

export interface DidResolutionMetadata {
  readonly contentType?: typeof DID_MEDIA_TYPE;
  readonly error?: { readonly type: string; readonly title: string };
}

export interface ResolutionResult {
  readonly didDocument: DidDocument | null;
  readonly didResolutionMetadata: DidResolutionMetadata;
  readonly didDocumentMetadata: DidDocumentMetadata;
}

export function errorResult(error: ResolutionError): ResolutionResult {
  return { didDocument: null, didResolutionMetadata: { error: { type: errorTypeUri(error.type), title: error.title } }, didDocumentMetadata: {} };
}

const STATUS_BY_TYPE_URI = new Map(Object.entries(ERROR_HTTP_STATUS).map(([type, status]): [string, number] => [`https://www.w3.org/ns/did#${type}`, status]));

/** Part 1 Section 7.4: 410 for `deactivated: true` (with or without a document), else by error type. */
export function httpStatus(result: ResolutionResult): number {
  if (result.didDocumentMetadata.deactivated) return 410;
  const error = result.didResolutionMetadata.error;
  return error ? (STATUS_BY_TYPE_URI.get(error.type) ?? 500) : 200;
}

const isEnded = (effective: Effective): boolean => effective.status === "revoked" || effective.status === "retired";

/** The record without resolution options, as everything that the gateway issues uses it (Part 2 Section 8.4). */
export interface CurrentRecord {
  readonly vectorId: string;
  readonly origin: Origin;
  /** The ledger tip that the values describe. */
  readonly tip: ChainTip;
  /** Block time of the first mint (POSIX ms). */
  readonly created: number;
  /** The base version. */
  readonly versionId: number;
  /** Transaction IDs of the pending versions, in ledger order. */
  readonly pending: readonly string[];
  readonly view: RecordView;
  readonly effective: Effective;
  /** The effective status is Revoked or Retired. */
  readonly deactivated: boolean;
  /** The earliest "invalid from" time of the record and its ancestors (POSIX ms). */
  readonly invalidFrom: number | null;
  /** Legacy views: the key that the legacy key search found for the owner; else null. */
  readonly legacyControllerKey: string | null;
  readonly ledger: VectorLedger;
}

export type CurrentLookup = { readonly found: true; readonly record: CurrentRecord } | { readonly found: false; readonly reason: string };

/** The effective status without options, for callers that need nothing else (status lists, token checks): no legacy key search. */
export type StatusLookup = { readonly found: true; readonly effective: Effective } | { readonly found: false; readonly reason: string };

export interface VectorResolverOptions {
  /** Error log. Messages never contain the requested DID. */
  readonly log?: (message: string) => void;
  /** Record histories kept for the current tip (Part 1 Section 9, denial of service). */
  readonly historyCacheSize?: number;
  /** The legacy key search and its caches; resolvers of the same chain source may share one. Default: a new one. */
  readonly legacyKeys?: LegacyKeySearch;
  /** Verified domains, verified organisations and detected protocols that background jobs stored. Default: none. */
  readonly fetchedFacts?: FetchedFactsProvider;
}

const VECTOR_ID = /^[0-9a-f]{64}$/;

export class VectorResolver {
  private readonly log: (message: string) => void;
  private readonly historyCacheSize: number;
  private readonly legacyKeys: LegacyKeySearch;
  private readonly fetchedFacts: FetchedFactsProvider;
  private networkChecked: Promise<void> | null = null;
  private histories: { tipHash: string; entries: Map<string, Promise<HistoryLookup>> } = { tipHash: "", entries: new Map() };
  /** First mints with 30 confirmations, kept between `listRecords` calls. */
  private readonly firstMints: FirstMintCache = new Map();

  constructor(
    private readonly chain: ChainSource,
    readonly settings: ResolverSettings,
    options: VectorResolverOptions = {},
  ) {
    checkRegistrySettings(settings.registries);
    this.log = options.log ?? ((message) => console.error(message));
    this.historyCacheSize = options.historyCacheSize ?? 512;
    this.legacyKeys = options.legacyKeys ?? new LegacyKeySearch(chain);
    this.fetchedFacts = options.fetchedFacts ?? (() => undefined);
  }

  /**
   * Resolves a DID (Part 1 Section 7.1). Never throws: every outcome is a resolution result, and a
   * failed ledger read is INTERNAL_ERROR.
   */
  async resolveDid(did: string, options: ResolutionOptionsInput = {}): Promise<ResolutionResult> {
    try {
      return await this.resolveOrThrow(did, options);
    } catch (e) {
      if (e instanceof ResolutionError) return errorResult(e);
      this.log(`identity-gateway: resolution failed: ${e instanceof Error ? e.message : String(e)}`);
      return errorResult(new ResolutionError("INTERNAL_ERROR", "Internal error: the resolver could not read the ledger"));
    }
  }

  /**
   * The current view and effective status of one identifier (no resolution options). Not found:
   * `{ found: false }`. A failed ledger read throws.
   */
  async currentRecord(vectorId: string): Promise<CurrentLookup> {
    const now = await this.currentEvaluation(vectorId);
    if (!now.found) return now;
    const { snapshot, history, evaluation, selection } = now;
    const { base, pending, view } = evaluation.state;
    const deactivated = isEnded(evaluation.effective);
    const legacy = view.kind === "legacy" && !deactivated ? await this.legacyKey(history, base, view, selection) : null;
    return {
      found: true,
      record: {
        vectorId,
        origin: history.origin,
        tip: snapshot.tip,
        created: history.firstMint.timeMs,
        versionId: base.number,
        pending: pending.map((v) => v.made.tx.txHash),
        view,
        effective: evaluation.effective,
        deactivated,
        invalidFrom: evaluation.invalidFrom,
        legacyControllerKey: legacy?.key ?? null,
        ledger: baseLedger(base, selection.counts),
      },
    };
  }

  /** The effective status without options, as `currentRecord` gives it, without the legacy key search. A failed ledger read throws. */
  async currentStatus(vectorId: string): Promise<StatusLookup> {
    const now = await this.currentEvaluation(vectorId);
    return now.found ? { found: true, effective: now.evaluation.effective } : now;
  }

  /** Every identifier that resolves, with its first mint and status-list index (Part 2 Section 8.6). A failed read throws. */
  async listRecords(): Promise<RecordList> {
    return listRecords(this.chain, await this.snapshot(), this.firstMints);
  }

  /** The record and its ancestors at the current tip, evaluated without options. */
  private async currentEvaluation(
    vectorId: string,
  ): Promise<
    | { readonly found: true; readonly snapshot: LedgerSnapshot; readonly history: RecordHistory; readonly evaluation: Evaluation; readonly selection: Selection }
    | { readonly found: false; readonly reason: string }
  > {
    if (!VECTOR_ID.test(vectorId)) throw new Error("an identifier is 64 lowercase hex characters");
    const snapshot = await this.snapshot();
    const lookup = await this.history(snapshot, vectorId);
    if (!lookup.found) return lookup;
    const chain = await this.lineage(snapshot, lookup.history);
    const selection = this.currentSelection(snapshot);
    const evaluation = evaluate(chain, selection, selection, this.settings);
    if (!evaluation) return { found: false, reason: "the record has no confirmed version" };
    return { found: true, snapshot, history: lookup.history, evaluation, selection };
  }

  private async resolveOrThrow(did: string, rawOptions: ResolutionOptionsInput): Promise<ResolutionResult> {
    const parsed = parseDid(did);
    const options = parseResolutionOptions(rawOptions);
    if (parsed.form === "testnet") throw new ResolutionError("FEATURE_NOT_SUPPORTED", "Feature not supported: the testnet form is reserved");
    const legacyPolicy = this.settings.registries.legacy.policyId;
    if (parsed.form === "legacy" && parsed.legacyPolicyId !== legacyPolicy) {
      throw new ResolutionError("NOT_FOUND", "DID not found: the legacy form names another policy");
    }

    const snapshot = await this.snapshot();
    const lookup = await this.history(snapshot, parsed.vectorId);
    if (!lookup.found) throw new ResolutionError("NOT_FOUND", `DID not found: ${lookup.reason}`);
    const history = lookup.history;
    if (parsed.form === "legacy" && !history.legacyMinted) {
      throw new ResolutionError("NOT_FOUND", "DID not found: the legacy registry never minted this identifier");
    }
    const chain = await this.lineage(snapshot, history);

    const current = this.currentSelection(snapshot);
    let selection = current;
    let ancestorSelection = current;
    if (options.versionId !== null) {
      const version = options.versionId < BigInt(history.versions.length) ? history.versions[Number(options.versionId)] : undefined;
      if (!version) throw new ResolutionError("NOT_FOUND", "DID not found: the version does not exist");
      if (version.made.confirmations < CONFIRMATION_DEPTH) throw new ResolutionError("NOT_FOUND", "DID not found: the version is not confirmed");
      const t = version.made.timeMs;
      selection = { t, counts: () => true, version: version.number };
      ancestorSelection = { t, counts: (at) => at.timeMs <= t, version: null };
    } else if (options.versionTime !== null) {
      const requested = options.versionTime;
      selection = { t: Math.min(requested, current.t), counts: (at) => at.timeMs < requested, version: null };
      ancestorSelection = selection;
    }

    const evaluation = evaluate(chain, selection, ancestorSelection, this.settings);
    if (!evaluation) throw new ResolutionError("NOT_FOUND", "DID not found: no confirmed version at the requested time");
    const versionOption = options.versionId !== null || options.versionTime !== null;
    const now: Evaluation | null = versionOption ? evaluate(chain, current, current, this.settings) : evaluation;
    if (!now) throw new Error("the record has a confirmed version in the past but none now");

    const deactivatedAtT = isEnded(evaluation.effective);
    const { base, pending, view } = evaluation.state;
    let metadataError: VectorMetadataError | null = null;
    let legacyKey: string | null = null;
    if (view.kind === "identity") {
      if (view.keys.some((k) => !k.popValid)) metadataError = "keyProofInvalid";
    } else if (!deactivatedAtT) {
      const legacy = await this.legacyKey(history, base, view, selection);
      legacyKey = legacy?.key ?? null;
      metadataError = legacy?.error ?? null;
    }

    // The stored facts count only while their inputs apply to the view that the result shows (its
    // endpoint, its domains, its assertion keys), also for a view at a requested version or time.
    const facts = this.fetchedFacts({ vectorId: parsed.vectorId, origin: history.origin, view, legacyControllerKey: legacyKey }, legacyPolicy);
    const didDocument = deactivatedAtT ? null : buildDocument(parsed.did, view, legacyKey, options.expandRelativeUrls, facts?.alsoKnownAs);
    return {
      didDocument,
      didResolutionMetadata: didDocument ? { contentType: DID_MEDIA_TYPE } : {},
      didDocumentMetadata: buildMetadata({
        history,
        base,
        pending,
        view,
        effective: evaluation.effective,
        invalidFrom: evaluation.invalidFrom,
        counts: selection.counts,
        canonicalRequest: parsed.form === "canonical",
        legacyPolicyId: legacyPolicy,
        deactivated: deactivatedAtT || isEnded(now.effective),
        current: versionOption ? now.effective : null,
        metadataError,
        facts,
      }),
    };
  }

  /** Part 1 Section 8.1, legacy record: the controller key of a legacy view, or why there is none. Null: the view has no controller. */
  private async legacyKey(
    history: RecordHistory,
    base: Version,
    view: Extract<RecordView, { kind: "legacy" }>,
    selection: Selection,
  ): Promise<{ key: string | null; error: VectorMetadataError | null } | null> {
    if (view.datumError) return { key: null, error: view.datumError };
    if (!view.owner) return null;
    if (view.owner.kind === "script") return { key: null, error: "controllerIsScript" };
    const key = await this.legacyKeys.find(history, base, view.owner.hash, selection.counts);
    return { key, error: key === null ? "controllerKeyNotFound" : null };
  }

  private currentSelection(snapshot: LedgerSnapshot): Selection {
    return { t: blockTimeMs(snapshot.tip.slot, this.settings.network), counts: () => true, version: null };
  }

  /** The tip, after a check that the ledger source serves the configured network (Part 1 Section 4: by genesis values, not by magic). */
  private async snapshot(): Promise<LedgerSnapshot> {
    if (!this.networkChecked) {
      const check = this.chain.genesis().then((genesis) => {
        const n = this.settings.network;
        if (
          genesis.networkMagic !== n.networkMagic ||
          genesis.systemStart !== n.systemStart ||
          genesis.slotLength !== n.slotLength ||
          genesis.securityParam !== n.securityParam
        ) {
          throw new Error("the ledger source serves another network: its genesis values differ from the configuration");
        }
      });
      this.networkChecked = check;
      check.catch(() => {
        if (this.networkChecked === check) this.networkChecked = null;
      });
    }
    const [tip] = await Promise.all([this.chain.tip(), this.networkChecked]);
    return { tip, settings: this.settings };
  }

  /** Record histories, kept while the tip stays the same. */
  private history(snapshot: LedgerSnapshot, vectorId: string): Promise<HistoryLookup> {
    if (this.histories.tipHash !== snapshot.tip.blockHash) this.histories = { tipHash: snapshot.tip.blockHash, entries: new Map() };
    const entries = this.histories.entries;
    let lookup = entries.get(vectorId);
    if (!lookup) {
      if (entries.size >= this.historyCacheSize) entries.clear();
      const loading = loadHistory(this.chain, snapshot, vectorId);
      lookup = loading;
      entries.set(vectorId, loading);
      loading.catch(() => {
        if (entries.get(vectorId) === loading) entries.delete(vectorId);
      });
    }
    return lookup;
  }

  /** The record and its ancestors: chain[i + 1] is the parent of chain[i]. */
  private async lineage(snapshot: LedgerSnapshot, subject: RecordHistory): Promise<RecordHistory[]> {
    const chain = [subject];
    for (;;) {
      const lineage = lineageOf(chain[chain.length - 1]!);
      if (lineage.type === "Root") return chain;
      if (chain.length > MAX_ANCESTORS) throw new Error("a lineage is deeper than the method allows");
      if (chain.some((h) => h.vectorId === lineage.parent)) throw new Error("a lineage names one of its own records");
      const parent = await this.history(snapshot, lineage.parent);
      if (!parent.found) throw new Error("the parent record of a subagent does not resolve");
      chain.push(parent.history);
    }
  }
}
