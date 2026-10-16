/** Node-only discovery, free calls, and explicitly staged purchases of supplier-configured JSON MCP tools. */
import type { ChainProvider, OutputReference, Utxo } from "@marketplace/shared/chain";
import { decodeAdvertDatum, decodeEscrowDatum, encodeAdvertDatum, encodeEscrowDatum } from "@marketplace/shared/cbor";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import {
  buildPostEscrowTx, loadBlueprint, NETWORK_BUFFER_MS, TxConstructionError,
  type PostEscrowBuildResult, type WalletKey,
} from "@marketplace/shared/tx";
import { buildReceipt, receiptResultHash, type Receipt } from "@marketplace/shared/receipt";
import {
  PAPER2AGENT_CAPABILITY_ID, MAX_TOOL_MANIFEST_BYTES, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_RUNTIME_MS,
  PAPER2AGENT_DELIVERY_OVERHEAD_MS,
  parsePaper2AgentManifest, paper2AgentManifestHash, paper2AgentModel,
  paper2AgentRequestHash, paper2AgentRequestSpecHash, paper2AgentSupplierPkh,
  validatePaper2AgentInput, validatePaper2AgentOutput, verifyPaper2AgentReceipt,
  type JsonObject, type Paper2AgentManifest,
} from "@marketplace/shared/paper2agent";
import { ESCROW_CONFIRM_TIMEOUT_MS, SUPPLIER_SLACK_MS, supplierBudgetMs } from "./budget.js";
import { HttpError } from "./httpClient.js";
import { IndexerError, ReceiptVerificationError, SupplierError } from "./types.js";

export interface Paper2AgentOffer {
  advertRef: OutputReference;
  advert: AdvertDatum;
  manifest: Paper2AgentManifest;
  manifestHash: string;
  supplierPublicKeyHex: string;
  endpointUrl: string;
}
export interface PreparedPaper2Agent extends Paper2AgentOffer {
  input: JsonObject;
  requestHash: string;
}
export interface PostedPaper2Agent extends PreparedPaper2Agent {
  escrowRef: OutputReference;
  postedAt: number;
  deliverBy: number;
  escrowDatum: EscrowDatum;
  /** Exact confirmed Open output, retained for read-only result recovery. */
  escrowUtxo: Utxo;
}
export interface Paper2AgentResult {
  manifest_hash: string;
  result: JsonObject;
  receipt: Receipt;
  receipt_signature: string;
  pub_key_hex: string;
  escrow_ref: string;
  submitted_ref: string;
}
/** A free call result. It has no receipt, escrow, or chain record. */
export interface Paper2AgentCallResult {
  manifest_hash: string;
  result: JsonObject;
  wallclock_ms: number;
}

export interface Paper2AgentExecutionOptions {
  onJobAccepted?: (jobId: string) => Promise<void>;
  /** Cryptographic evidence only. Live Submitted lineage still needs verification. */
  onReceiptVerified?: (result: Paper2AgentResult) => Promise<void>;
}
export interface Paper2AgentRecoveryOptions extends Paper2AgentExecutionOptions {
  jobId?: string;
  timeoutMs?: number;
}

const PREFLIGHT_MS = 30_000;
const DISCOVERY_MS = 60_000;
const REQUEST_MS = 15_000;
const MAX_ADVERTS = 128;
const MAX_INDEXER_BYTES = 1_048_576;
const MAX_METADATA_BYTES = MAX_TOOL_MANIFEST_BYTES + 8192;
const MAX_RESULT_BYTES = MAX_TOOL_OUTPUT_BYTES + 16_384;
const POLL_MS = 1000;
const DISCOVERY_CONCURRENCY = 8;
const DISCOVERY_PROBE_MS = 3000;
const MAX_PROCESSING_MS = MAX_TOOL_RUNTIME_MS + PAPER2AGENT_DELIVERY_OVERHEAD_MS;
const MAX_EXECUTION_MS = MAX_PROCESSING_MS + NETWORK_BUFFER_MS + SUPPLIER_SLACK_MS;
/** Container start, tool discovery, and close around the declared tool runtime. */
const CALL_OVERHEAD_MS = 60_000;

function fail(message: string): never {
  throw new TxConstructionError("paper2agent_validation_failed", message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected a JSON object");
  return value as Record<string, unknown>;
}
function refString(ref: OutputReference): string {
  return `${ref.txHash}#${ref.index}`;
}
function parseReceipt(value: unknown): Receipt {
  const raw = object(value);
  if (Object.keys(raw).length !== 8 ||
      typeof raw.prompt_hash !== "string" || typeof raw.response_hash !== "string" ||
      typeof raw.model !== "string" || typeof raw.supplier_pkh !== "string" ||
      typeof raw.escrow_ref !== "string" || typeof raw.prompt_tokens !== "number" ||
      typeof raw.completion_tokens !== "number" || typeof raw.wallclock_ms !== "number") {
    throw new ReceiptVerificationError("malformed_receipt");
  }
  return buildReceipt({
    prompt_hash: raw.prompt_hash, response_hash: raw.response_hash, model: raw.model,
    supplier_pkh: raw.supplier_pkh, escrow_ref: raw.escrow_ref, prompt_tokens: raw.prompt_tokens,
    completion_tokens: raw.completion_tokens, wallclock_ms: raw.wallclock_ms,
  });
}
function parseRef(value: unknown): OutputReference {
  if (typeof value !== "string") fail("invalid output reference");
  const match = /^([0-9a-f]{64})#(0|[1-9]\d*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) fail("invalid output reference");
  return { txHash: match[1]!, index: Number(match[2]) };
}
function baseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail("endpoint must be an HTTP URL without credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/, "");
}
function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new HttpError("timeout", "Paper2Agent call deadline exceeded");
  return ms;
}
/** All read waits share the stage deadline, including stream reads and chain queries. */
async function bounded<T>(operation: () => Promise<T>, deadline: number, abort?: () => void): Promise<T> {
  const ms = remaining(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort?.();
          reject(new HttpError("timeout", "Paper2Agent call deadline exceeded"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function pause(deadline: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(POLL_MS, remaining(deadline))));
  remaining(deadline);
}

const IMMUTABLE_FIELDS = [
  "buyer_pkh", "supplier_pkh", "capability_id", "request_spec_hash", "prompt_hash",
  "payment_lovelace", "buyer_bond_lovelace", "supplier_bond_lovelace", "deliver_by", "posted_at",
] as const;
function sameImmutable(actual: EscrowDatum, original: EscrowDatum): boolean {
  return refString(actual.advert_ref) === refString(original.advert_ref) &&
    IMMUTABLE_FIELDS.every((field) => actual[field] === original[field]);
}
function sameLineageImmutable(row: Record<string, unknown>, original: EscrowDatum): boolean {
  return row.advert_ref === refString(original.advert_ref) && IMMUTABLE_FIELDS.every((field) => {
    const expected = original[field];
    return row[field] === (typeof expected === "bigint" ? expected.toString() : expected);
  });
}

export class Paper2AgentClient {
  private readonly chain: ChainProvider;
  private readonly walletKey?: WalletKey;
  private readonly indexerUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly blueprint = loadBlueprint();

  /** `walletKey` is necessary only for the paid stages. Discovery and free calls do not sign. */
  constructor(options: { chain: ChainProvider; walletKey?: WalletKey; indexerUrl: string; fetchFn?: typeof fetch }) {
    this.chain = options.chain;
    this.walletKey = options.walletKey;
    this.indexerUrl = baseUrl(options.indexerUrl);
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  private wallet(): WalletKey {
    if (!this.walletKey) fail("a wallet key is required for paid calls");
    return this.walletKey;
  }

  private scriptUtxo(utxo: Utxo | null, kind: "advert" | "escrow", ref: OutputReference): Utxo {
    const address = kind === "advert" ? this.blueprint.advertScriptAddress : this.blueprint.escrowScriptAddress;
    if (!utxo?.datumHex || refString(utxo.ref) !== refString(ref) ||
        (utxo.address !== address(0) && utxo.address !== address(1))) {
      fail(`missing or invalid ${kind} script UTxO`);
    }
    return utxo;
  }

  private async json(url: string, maxBytes: number, deadline: number, init: RequestInit = {}, requestMs = REQUEST_MS): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return bounded(async () => {
      const response = await this.fetchFn(url, {
        ...init, redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { Accept: "application/json", ...init.headers },
      });
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        controller.abort();
        void response.body?.cancel().catch(() => {});
        throw new HttpError("parse_error", "Paper2Agent response exceeds byte limit");
      }
      if (!response.body) {
        controller.abort();
        if (response.status >= 500) return { status: response.status, body: null };
        throw new HttpError("parse_error", "Paper2Agent response has no body");
      }
      const reader = response.body.getReader();
      activeReader = reader;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) throw new HttpError("parse_error", "Paper2Agent response exceeds byte limit");
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let body: unknown;
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch {
          // A proxy's HTML error is a failed read, not evidence that a paid job failed.
          if (response.status >= 500) return { status: response.status, body: null };
          throw new HttpError("parse_error", "Paper2Agent response is not valid JSON");
        }
        return { status: response.status, body };
      } finally {
        controller.abort();
        void reader.cancel().catch(() => {});
      }
    }, Math.min(deadline, Date.now() + requestMs), () => {
      controller.abort();
      void activeReader?.cancel().catch(() => {});
    });
  }

  private async offer(advertRef: OutputReference, deadline: number): Promise<Paper2AgentOffer> {
    advertRef = parseRef(refString(advertRef));
    const utxo = this.scriptUtxo(await bounded(() => this.chain.queryUtxo(advertRef), deadline), "advert", advertRef);
    const advert = decodeAdvertDatum(utxo.datumHex!);
    if (advert.status !== "Active" || advert.capability_id !== PAPER2AGENT_CAPABILITY_ID ||
        advert.max_output_tokens !== 0 || advert.price_lovelace < 0n ||
        advert.buyer_bond_lovelace < 0n || advert.supplier_bond_lovelace < 0n ||
        !Number.isSafeInteger(advert.max_processing_ms) || advert.max_processing_ms <= 0 ||
        advert.max_processing_ms > MAX_PROCESSING_MS) {
      fail("advert does not describe an active bounded Paper2Agent tool");
    }
    const endpointUrl = baseUrl(advert.endpoint_url);
    const response = await this.json(`${endpointUrl}/capability`, MAX_METADATA_BYTES, deadline);
    if (response.status !== 200) throw new SupplierError("preflight_failed", { status: response.status });
    const metadata = object(response.body);
    const tool = object(metadata.paper2agent);
    const manifest = parsePaper2AgentManifest(tool.manifest);
    const manifestHash = paper2AgentManifestHash(manifest);
    if (metadata.advert_ref !== refString(advertRef) || metadata.supplier_pkh !== advert.supplier_pkh ||
        metadata.capability_id !== advert.capability_id || metadata.model !== advert.model ||
        metadata.max_output_tokens !== 0 || metadata.max_processing_ms !== advert.max_processing_ms ||
        metadata.price_lovelace !== advert.price_lovelace.toString() ||
        tool.manifest_hash !== manifestHash || advert.model !== paper2AgentModel(manifest) ||
        advert.max_processing_ms < manifest.limits.max_runtime_ms ||
        typeof metadata.pub_key_hex !== "string" || paper2AgentSupplierPkh(metadata.pub_key_hex) !== advert.supplier_pkh) {
      fail("supplier capability, manifest, or signing key does not match the advert");
    }
    return { advertRef, advert, manifest, manifestHash, supplierPublicKeyHex: metadata.pub_key_hex, endpointUrl };
  }

  /**
   * By default, only tools that the indexer reports as `free` are returned, because a busy
   * supplier rejects a paid admission. `includeBusy` also returns `working` and `unknown`
   * tools, for free calls that wait or report busy.
   */
  async discover(filters: { manifestHash?: string; supplierPkh?: string; includeBusy?: boolean } = {}): Promise<Paper2AgentOffer[]> {
    if ((filters.manifestHash !== undefined && !/^[0-9a-f]{64}$/.test(filters.manifestHash)) ||
        (filters.supplierPkh !== undefined && !/^[0-9a-f]{56}$/.test(filters.supplierPkh))) {
      fail("invalid discovery identity filter");
    }
    const deadline = Date.now() + DISCOVERY_MS;
    const response = await this.json(`${this.indexerUrl}/suppliers?capability_id=${encodeURIComponent(PAPER2AGENT_CAPABILITY_ID)}`, MAX_INDEXER_BYTES, deadline);
    if (response.status !== 200) throw new IndexerError("indexer_error", { status: response.status });
    if (!Array.isArray(response.body)) throw new IndexerError("malformed_response", { message: "supplier list is not an array" });
    const refs: OutputReference[] = [];
    const seen = new Set<string>();
    for (const value of response.body) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const listed = row.status === "free" || (filters.includeBusy === true && (row.status === "working" || row.status === "unknown"));
      if (row.capability_id !== PAPER2AGENT_CAPABILITY_ID || row.advert_status !== "Active" || !listed ||
          (filters.supplierPkh !== undefined && row.supplier_pkh !== filters.supplierPkh) ||
          (filters.manifestHash !== undefined && row.model !== `paper2agent:${filters.manifestHash}`)) continue;
      let ref;
      try { ref = parseRef(row.utxo_ref); } catch { continue; }
      const text = refString(ref);
      if (seen.has(text)) continue;
      seen.add(text);
      refs.push(ref);
    }
    // The current indexer ignores capability_id. Unrelated adverts must not
    // consume the tool catalogue's bound.
    if (refs.length > MAX_ADVERTS) throw new IndexerError("malformed_response", { message: "tool supplier list exceeds the discovery bound" });
    const offers = new Array<Paper2AgentOffer | undefined>(refs.length);
    let next = 0;
    const probeMs = filters.supplierPkh !== undefined || filters.manifestHash !== undefined ? REQUEST_MS : DISCOVERY_PROBE_MS;
    const probe = async (): Promise<void> => {
      while (next < refs.length && Date.now() < deadline) {
        const index = next++;
        try {
          const offer = await this.offer(refs[index]!, Math.min(deadline, Date.now() + probeMs));
          // Indexer fields are routing hints, never authority for an approval.
          if ((filters.supplierPkh === undefined || offer.advert.supplier_pkh === filters.supplierPkh) &&
              (filters.manifestHash === undefined || offer.manifestHash === filters.manifestHash)) offers[index] = offer;
        } catch {
          // One unavailable or invalid advert must not erase healthy offers.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, refs.length) }, probe));
    return offers.filter((offer): offer is Paper2AgentOffer => offer !== undefined);
  }

  /**
   * One free call through the tool's token-gated route. It has no escrow, receipt, or chain
   * transaction, and it never retries. The caller owns concurrency limits. Supplier and
   * transport failures are `SupplierError`s whose `reason` is the route's error code,
   * `timeout`, `unreachable`, `malformed_response`, or `invalid_tool_output`.
   */
  async call(offer: Paper2AgentOffer, input: unknown, options: { token: string }): Promise<Paper2AgentCallResult> {
    if (typeof options.token !== "string" || options.token.length < 32) fail("tool call token must have at least 32 characters");
    const manifest = parsePaper2AgentManifest(offer.manifest);
    if (paper2AgentManifestHash(manifest) !== offer.manifestHash) fail("offer manifest does not match its hash");
    const url = `${baseUrl(offer.endpointUrl)}/v1/paper2agent/call`;
    const body = JSON.stringify({ manifest_hash: offer.manifestHash, input: validatePaper2AgentInput(manifest, input) });
    const deadline = Date.now() + manifest.limits.max_runtime_ms + CALL_OVERHEAD_MS;
    let response: { status: number; body: unknown };
    try {
      response = await this.json(url, MAX_RESULT_BYTES, deadline, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token}` }, body,
      }, remaining(deadline));
    } catch (error) {
      const kind = error instanceof HttpError ? error.kind : undefined;
      throw new SupplierError(kind === "timeout" ? "timeout" : kind === "parse_error" ? "malformed_response" : "unreachable");
    }
    const value = response.body && typeof response.body === "object" && !Array.isArray(response.body)
      ? response.body as Record<string, unknown> : undefined;
    if (response.status !== 200) {
      const reason = value?.reason;
      throw new SupplierError(typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : "call_failed", { status: response.status });
    }
    const wallclock = value?.wallclock_ms;
    if (!value || value.manifest_hash !== offer.manifestHash || typeof wallclock !== "number" || !Number.isSafeInteger(wallclock) || wallclock < 0) {
      throw new SupplierError("malformed_response");
    }
    let result: JsonObject;
    try {
      result = validatePaper2AgentOutput(manifest, value.result);
    } catch {
      throw new SupplierError("invalid_tool_output");
    }
    return { manifest_hash: offer.manifestHash, result, wallclock_ms: wallclock };
  }

  async prepare(options: { advertRef: OutputReference; manifestHash: string; input: unknown; expectedSupplierPkh: string; maxPriceLovelace: bigint }): Promise<PreparedPaper2Agent> {
    if (typeof options.maxPriceLovelace !== "bigint" || options.maxPriceLovelace < 0n) fail("maxPriceLovelace must be a nonnegative bigint");
    const offer = await this.offer(options.advertRef, Date.now() + PREFLIGHT_MS);
    if (offer.manifestHash !== options.manifestHash || offer.advert.supplier_pkh !== options.expectedSupplierPkh ||
        offer.advert.price_lovelace > options.maxPriceLovelace || offer.advert.supplier_pkh === this.wallet().pubKeyHash) {
      fail("offer does not match the approved manifest, supplier, or price limit");
    }
    const input = validatePaper2AgentInput(offer.manifest, options.input);
    return { ...offer, input, requestHash: paper2AgentRequestHash(offer.manifestHash, input) };
  }

  private validatePrepared(prepared: PreparedPaper2Agent): void {
    const manifest = parsePaper2AgentManifest(prepared.manifest);
    const input = validatePaper2AgentInput(manifest, prepared.input);
    if (paper2AgentManifestHash(manifest) !== prepared.manifestHash ||
        prepared.advert.model !== paper2AgentModel(manifest) ||
        prepared.advert.capability_id !== PAPER2AGENT_CAPABILITY_ID || prepared.advert.max_output_tokens !== 0 ||
        prepared.endpointUrl !== baseUrl(prepared.advert.endpoint_url) ||
        paper2AgentSupplierPkh(prepared.supplierPublicKeyHex) !== prepared.advert.supplier_pkh ||
        paper2AgentRequestHash(prepared.manifestHash, input) !== prepared.requestHash) {
      fail("prepared tool commitments changed");
    }
  }

  private validateOpen(posted: PostedPaper2Agent): void {
    this.validatePrepared(posted);
    const datum = posted.escrowDatum;
    if (datum.state !== "Open" || datum.buyer_pkh !== this.wallet().pubKeyHash ||
        datum.supplier_pkh !== posted.advert.supplier_pkh || refString(datum.advert_ref) !== refString(posted.advertRef) ||
        datum.capability_id !== PAPER2AGENT_CAPABILITY_ID || datum.prompt_hash !== posted.requestHash ||
        datum.request_spec_hash !== paper2AgentRequestSpecHash(posted.manifest) ||
        datum.payment_lovelace !== posted.advert.price_lovelace || datum.buyer_bond_lovelace !== posted.advert.buyer_bond_lovelace ||
        datum.supplier_bond_lovelace !== posted.advert.supplier_bond_lovelace ||
        !Number.isSafeInteger(datum.posted_at) || !Number.isSafeInteger(datum.deliver_by) ||
        datum.posted_at !== posted.postedAt || datum.deliver_by !== posted.deliverBy ||
        datum.deliver_by !== datum.posted_at + posted.advert.max_processing_ms + NETWORK_BUFFER_MS ||
        datum.submitted_at !== null || datum.result_receipt_hash !== null) {
      fail("original Open escrow does not match the prepared purchase");
    }
    const original = this.scriptUtxo(posted.escrowUtxo, "escrow", posted.escrowRef);
    if (encodeEscrowDatum(decodeEscrowDatum(original.datumHex!)) !== encodeEscrowDatum(datum) ||
        typeof original.lovelace !== "bigint" ||
        original.lovelace < datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace ||
        Object.values(object(original.assets)).some((amount) => typeof amount !== "bigint" || amount < 0n)) {
      fail("original Open escrow snapshot is invalid");
    }
  }

  async post(prepared: PreparedPaper2Agent, beforeSubmit?: (built: PostEscrowBuildResult) => Promise<void>): Promise<PostedPaper2Agent> {
    this.validatePrepared(prepared);
    const refreshed = await this.prepare({
      advertRef: prepared.advertRef, manifestHash: prepared.manifestHash, input: prepared.input,
      expectedSupplierPkh: prepared.advert.supplier_pkh, maxPriceLovelace: prepared.advert.price_lovelace,
    });
    if (encodeAdvertDatum(refreshed.advert) !== encodeAdvertDatum(prepared.advert) ||
        refreshed.supplierPublicKeyHex !== prepared.supplierPublicKeyHex || refreshed.requestHash !== prepared.requestHash) {
      fail("prepared offer changed before payment");
    }
    const deadline = Date.now() + PREFLIGHT_MS + ESCROW_CONFIRM_TIMEOUT_MS;
    const built = await bounded(() => buildPostEscrowTx({
      chain: this.chain, buyerKey: this.wallet(), advertRef: refreshed.advertRef,
      prompt_hash: refreshed.requestHash, payment_lovelace: refreshed.advert.price_lovelace,
      beforeSubmit: async (candidate) => {
        remaining(deadline);
        await beforeSubmit?.(candidate);
        remaining(deadline);
      },
    }), deadline);
    // A timeout is an unresolved financial outcome, never a reason to post again.
    await bounded(() => this.chain.awaitTx(built.expectedTxHash, Math.min(ESCROW_CONFIRM_TIMEOUT_MS, remaining(deadline))), deadline);
    const utxo = this.scriptUtxo(await bounded(() => this.chain.queryUtxo(built.escrowOutputRef), deadline), "escrow", built.escrowOutputRef);
    const escrowDatum = decodeEscrowDatum(utxo.datumHex!);
    const posted: PostedPaper2Agent = {
      ...refreshed, escrowRef: built.escrowOutputRef, escrowDatum, escrowUtxo: utxo,
      postedAt: escrowDatum.posted_at, deliverBy: escrowDatum.deliver_by,
    };
    this.validateOpen(posted);
    return posted;
  }

  private async verifySubmitted(posted: PostedPaper2Agent, result: Paper2AgentResult, original: Utxo, deadline: number): Promise<void> {
    const ref = parseRef(result.submitted_ref);
    const expectedHash = receiptResultHash({ receipt: result.receipt, signature: result.receipt_signature });
    let utxo: Utxo;
    for (;;) {
      try {
        const visible = await bounded(() => this.chain.queryUtxo(ref), Math.min(deadline, Date.now() + REQUEST_MS));
        if (visible) {
          utxo = this.scriptUtxo(visible, "escrow", ref);
          break;
        }
      } catch (error) {
        if (error instanceof TxConstructionError) throw error;
      }
      // Supplier and buyer nodes can observe Submit at different times.
      await pause(deadline);
    }
    const datum = decodeEscrowDatum(utxo.datumHex!);
    if (datum.state !== "Submitted" || !sameImmutable(datum, posted.escrowDatum) ||
        datum.result_receipt_hash !== expectedHash || datum.submitted_at === null ||
        datum.submitted_at < datum.posted_at || datum.submitted_at > datum.deliver_by ||
        utxo.address !== original.address || utxo.lovelace !== original.lovelace ||
        Object.keys(utxo.assets).length !== Object.keys(original.assets).length ||
        Object.entries(original.assets).some(([key, amount]) => utxo.assets[key] !== amount)) {
      throw new ReceiptVerificationError("submitted_escrow_mismatch");
    }
    const originalRef = refString(posted.escrowRef);
    for (;;) {
      let response;
      try {
        response = await this.json(`${this.indexerUrl}/escrows/${encodeURIComponent(originalRef)}/lineage`, MAX_METADATA_BYTES, deadline);
      } catch (error) {
        if (error instanceof HttpError && error.kind === "parse_error") throw error;
        await pause(deadline);
        continue;
      }
      if (response.status === 404 || response.status >= 500) { await pause(deadline); continue; }
      if (response.status !== 200) throw new IndexerError("indexer_error", { status: response.status });
      const lineage = object(response.body);
      if (lineage.original_ref !== originalRef || lineage.terminal !== null ||
          !Array.isArray(lineage.rows) || lineage.rows.length === 0 || lineage.rows.length > 3) {
        throw new ReceiptVerificationError("escrow_lineage_mismatch");
      }
      const rows = lineage.rows.map(object);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const rowRef = parseRef(row.utxo_ref);
        if (!sameLineageImmutable(row, posted.escrowDatum) || row.state !== ["Open", "Claimed", "Submitted"][index] ||
            (index === 0 && row.utxo_ref !== originalRef) ||
            (index > 0 && rows[index - 1]!.spent_tx !== rowRef.txHash) ||
            (index < 2 && (row.submitted_at !== null || row.result_receipt_hash !== null))) {
          throw new ReceiptVerificationError("escrow_lineage_mismatch");
        }
      }
      if (rows.length < 3) { await pause(deadline); continue; }
      const submitted = rows[2]!;
      if (submitted.utxo_ref !== result.submitted_ref || submitted.spent_tx !== null ||
          submitted.result_receipt_hash !== expectedHash || submitted.submitted_at !== datum.submitted_at) {
        throw new ReceiptVerificationError("escrow_lineage_mismatch");
      }
      // Indexer catch-up can take time. Do not return a stale Submitted snapshot.
      const current = this.scriptUtxo(await bounded(() => this.chain.queryUtxo(ref), deadline), "escrow", ref);
      if (current.datumHex !== utxo.datumHex || current.address !== utxo.address ||
          current.lovelace !== utxo.lovelace || Object.keys(current.assets).length !== Object.keys(utxo.assets).length ||
          Object.entries(utxo.assets).some(([key, amount]) => current.assets[key] !== amount)) {
        throw new ReceiptVerificationError("submitted_escrow_mismatch");
      }
      return;
    }
  }

  private async pollResult(posted: PostedPaper2Agent, jobId: string, deadline: number, options: Paper2AgentExecutionOptions): Promise<Paper2AgentResult> {
    const escrowRef = refString(posted.escrowRef);
    for (;;) {
      let response;
      try {
        response = await this.json(`${posted.endpointUrl}/v1/paper2agent/run/${encodeURIComponent(jobId)}`, MAX_RESULT_BYTES, deadline);
      } catch (error) {
        if (error instanceof HttpError && error.kind === "parse_error") throw error;
        await pause(deadline);
        continue;
      }
      const body = response.body && typeof response.body === "object" && !Array.isArray(response.body)
        ? response.body as Record<string, unknown> : undefined;
      // A failed Submit confirmation can still carry a genuine signed result.
      // Preserve it before waiting for our node or indexer to catch up.
      if (response.status === 200 || (body?.receipt !== undefined && typeof body.submitted_ref === "string" && typeof body.receipt_signature === "string")) {
        if (!body || body.manifest_hash !== posted.manifestHash || body.escrow_ref !== escrowRef ||
            body.pub_key_hex !== posted.supplierPublicKeyHex || typeof body.receipt_signature !== "string") {
          throw new ReceiptVerificationError("supplier_result_identity_mismatch");
        }
        const result: Paper2AgentResult = {
          manifest_hash: posted.manifestHash, result: validatePaper2AgentOutput(posted.manifest, body.result),
          receipt: parseReceipt(body.receipt), receipt_signature: body.receipt_signature,
          pub_key_hex: posted.supplierPublicKeyHex, escrow_ref: escrowRef, submitted_ref: refString(parseRef(body.submitted_ref)),
        };
        verifyPaper2AgentReceipt({ manifest: posted.manifest, input: posted.input, result: result.result,
          receipt: result.receipt, signature: result.receipt_signature, publicKeyHex: result.pub_key_hex,
          supplierPkh: posted.advert.supplier_pkh, escrowRef });
        if (options.onReceiptVerified) await bounded(() => options.onReceiptVerified!(result), deadline);
        await this.verifySubmitted(posted, result, posted.escrowUtxo, deadline);
        return result;
      }
      if (response.status === 202) {
        if (!body || body.escrow_ref !== escrowRef || !["accepted", "running"].includes(String(body.status))) {
          throw new SupplierError("malformed_response");
        }
      } else if (response.status < 500) {
        throw new SupplierError("execution_failed", { status: response.status });
      }
      await pause(deadline);
    }
  }

  async execute(posted: PostedPaper2Agent, options: Paper2AgentExecutionOptions = {}): Promise<Paper2AgentResult> {
    this.validateOpen(posted);
    if (Date.now() >= posted.deliverBy) fail("escrow delivery deadline has passed");
    const deadline = Date.now() + Math.min(supplierBudgetMs(posted.deliverBy), MAX_EXECUTION_MS);
    const original = this.scriptUtxo(await bounded(() => this.chain.queryUtxo(posted.escrowRef), deadline), "escrow", posted.escrowRef);
    if (encodeEscrowDatum(decodeEscrowDatum(original.datumHex!)) !== encodeEscrowDatum(posted.escrowDatum) ||
        original.address !== posted.escrowUtxo.address || original.lovelace !== posted.escrowUtxo.lovelace ||
        Object.keys(original.assets).length !== Object.keys(posted.escrowUtxo.assets).length ||
        Object.entries(original.assets).some(([asset, amount]) => posted.escrowUtxo.assets[asset] !== amount)) {
      fail("original escrow changed before execution");
    }
    const escrowRef = refString(posted.escrowRef);
    // Exactly one paid admission. Its response includes discovery and confirmed
    // Claim, so it needs the stage deadline rather than a metadata read timeout.
    const admission = await this.json(`${posted.endpointUrl}/v1/paper2agent/run`, MAX_METADATA_BYTES, deadline, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Escrow-Ref": escrowRef },
      body: JSON.stringify({ manifest_hash: posted.manifestHash, input: validatePaper2AgentInput(posted.manifest, posted.input) }),
    }, remaining(deadline));
    if (admission.status !== 202) throw new SupplierError("admission_failed", { status: admission.status });
    const accepted = object(admission.body);
    if (accepted.status !== "accepted" || accepted.escrow_ref !== escrowRef ||
        typeof accepted.job_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(accepted.job_id)) {
      throw new SupplierError("malformed_response");
    }
    if (options.onJobAccepted) await bounded(() => options.onJobAccepted!(accepted.job_id as string), deadline);
    return this.pollResult(posted, accepted.job_id, deadline, options);
  }

  /** Read an existing job after a disconnect or restart. Never admits or pays. */
  async recover(posted: PostedPaper2Agent, options: Paper2AgentRecoveryOptions = {}): Promise<Paper2AgentResult> {
    this.validateOpen(posted);
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) fail("recovery timeout must be a positive integer");
    const deadline = Date.now() + Math.min(timeout, MAX_EXECUTION_MS);
    let jobId = options.jobId;
    if (jobId === undefined) {
      const lookup = await this.json(`${posted.endpointUrl}/v1/paper2agent/lookup`, MAX_METADATA_BYTES, deadline, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Escrow-Ref": refString(posted.escrowRef) },
        body: JSON.stringify({ manifest_hash: posted.manifestHash, input: validatePaper2AgentInput(posted.manifest, posted.input) }),
      });
      if (lookup.status !== 200) throw new SupplierError("job_lookup_failed", { status: lookup.status });
      const found = object(lookup.body);
      if (found.escrow_ref !== refString(posted.escrowRef) || found.manifest_hash !== posted.manifestHash ||
          !["accepted", "running", "done", "failed"].includes(String(found.status)) || typeof found.job_id !== "string") {
        throw new SupplierError("malformed_response");
      }
      jobId = found.job_id;
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new SupplierError("malformed_response");
    if (options.onJobAccepted) await bounded(() => options.onJobAccepted!(jobId), deadline);
    return this.pollResult(posted, jobId, deadline, options);
  }
}
