import { existsSync } from "node:fs";
import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import { decodeAdvertDatum, decodeEscrowDatum, type AdvertDatum, type EscrowDatum } from "@marketplace/shared/cbor";
import { buildClaimTx, buildSubmitTx, detectCborBackend, mockSlotToWallclockMs, loadBlueprint,
  NETWORK_BUFFER_MS, type WalletKey } from "@marketplace/shared/tx";
import { buildReceipt, signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
import { PAPER2AGENT_CAPABILITY_ID, PAPER2AGENT_SUPPLIER_OVERHEAD_MS, paper2AgentModel, paper2AgentManifestHash,
  paper2AgentRequestHash, paper2AgentRequestSpecHash, paper2AgentResultHash,
  parsePaper2AgentRequest, validatePaper2AgentOutput, type JsonObject, type Paper2AgentManifest } from "@marketplace/shared/paper2agent";
import type { Paper2AgentConfig } from "../config.js";
import type { SupplierState } from "../state.js";
import { checkSupplierKey } from "./identity.js";
import { ToolJournal, type ToolJob } from "./journal.js";
import { LocalToolSession, checkTool, readManifest, verifyPackage,
  type ToolSession, type ToolSessionFactory } from "./local.js";

export interface ToolRuntimeDeps {
  chain: ChainProvider;
  state: SupplierState;
  supplierKey: WalletKey;
  networkId: 0 | 1;
  advertRef: OutputReference;
  config: Paper2AgentConfig;
  sessionFactory?: ToolSessionFactory;
}

export class ToolAdmissionError extends Error {
  constructor(readonly status: number, readonly reason: string, readonly job?: ToolJob) {
    super(reason);
  }
}

/** The journal's duplicate key: admission and lookup accept only this spelling. */
function escrowRefText(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}#(?:0|[1-9]\d*)$/.test(value) ||
      !Number.isSafeInteger(Number(value.slice(65)))) throw new ToolAdmissionError(400, "escrow_ref_malformed");
  return value;
}

export class Paper2AgentRuntime {
  readonly manifest: Paper2AgentManifest;
  readonly manifestHash: string;
  readonly journal: ToolJournal;
  private readonly sessions = new Set<ToolSession>();
  private readonly tasks = new Set<Promise<unknown>>();
  private closing = false;

  private constructor(private readonly deps: ToolRuntimeDeps) {
    checkSupplierKey(deps.supplierKey, deps.networkId);
    this.manifest = readManifest(deps.config.manifestPath);
    this.manifestHash = paper2AgentManifestHash(this.manifest);
    this.journal = new ToolJournal(deps.config.journalDir);
  }

  static async create(deps: ToolRuntimeDeps): Promise<Paper2AgentRuntime> {
    const runtime = new Paper2AgentRuntime(deps);
    await verifyPackage(deps.config, runtime.manifest);
    await runtime.advert();
    return runtime;
  }

  async advert(): Promise<AdvertDatum> {
    const { chain, advertRef, networkId, supplierKey } = this.deps;
    const utxo = await chain.queryUtxo(advertRef);
    if (!utxo?.datumHex || utxo.address !== loadBlueprint().advertScriptAddress(networkId)) {
      throw new ToolAdmissionError(503, "advert_unavailable");
    }
    const advert = decodeAdvertDatum(utxo.datumHex);
    if (advert.status !== "Active" || advert.supplier_pkh !== supplierKey.pubKeyHash ||
        advert.capability_id !== PAPER2AGENT_CAPABILITY_ID || advert.model !== paper2AgentModel(this.manifest) ||
        advert.max_output_tokens !== 0 || advert.price_lovelace < 0n ||
        advert.supplier_bond_lovelace < 0n || advert.buyer_bond_lovelace < 0n ||
        !Number.isSafeInteger(advert.max_processing_ms) ||
        advert.max_processing_ms < this.manifest.limits.max_runtime_ms + PAPER2AGENT_SUPPLIER_OVERHEAD_MS) {
      throw new ToolAdmissionError(503, "configured_advert_mismatch");
    }
    return advert;
  }

  admit(refText: unknown, body: unknown): Promise<ToolJob> {
    const task = this.admitJob(refText, body);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    return task;
  }

  private async now(): Promise<number> {
    return detectCborBackend(this.deps.chain) === "live" ? Date.now()
      : mockSlotToWallclockMs(await this.deps.chain.tip());
  }

  /**
   * Read-only recovery of a lost admission reply. It never admits a job, takes a
   * slot, starts a tool, signs, or calls the chain. The caller must prove the
   * original request preimage; the public on-chain request hash is not enough.
   */
  lookup(refHeader: unknown, body: unknown): ToolJob | undefined {
    const refText = escrowRefText(refHeader);
    let manifestHash: string;
    let requestHash: string;
    try {
      // Admission's exact envelope and bounds, but not the current tool schema:
      // the manifest version that admitted a stored input already validated it.
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 2 ||
          !Object.hasOwn(body, "manifest_hash") || !Object.hasOwn(body, "input")) throw new Error("Invalid request envelope");
      const request = body as { manifest_hash: string; input: JsonObject };
      manifestHash = request.manifest_hash;
      requestHash = paper2AgentRequestHash(manifestHash, request.input);
    } catch { throw new ToolAdmissionError(400, "invalid_tool_request"); }
    const job = this.journal.byEscrow(refText);
    return job?.manifest_hash === manifestHash &&
      paper2AgentRequestHash(job.manifest_hash, job.input) === requestHash ? job : undefined;
  }

  private async admitJob(refHeader: unknown, body: unknown): Promise<ToolJob> {
    if (this.closing || existsSync("/dev/shm/marketplace-draining")) throw new ToolAdmissionError(503, "supplier_draining");
    const refText = escrowRefText(refHeader);
    const [txHash, indexText] = refText.split("#");
    const escrowRef = { txHash, index: Number(indexText) };
    let request;
    try { request = parsePaper2AgentRequest(this.manifest, body); }
    catch { throw new ToolAdmissionError(400, "invalid_tool_request"); }
    if (this.journal.hasEscrow(refText)) throw new ToolAdmissionError(409, "escrow_already_admitted");
    const { chain, state, supplierKey, config, networkId, advertRef } = this.deps;
    const advert = await this.advert();
    const utxo = await chain.queryUtxo(escrowRef);
    if (!utxo?.datumHex || utxo.address !== loadBlueprint().escrowScriptAddress(networkId)) {
      throw new ToolAdmissionError(404, "escrow_unavailable");
    }
    let escrow: EscrowDatum;
    try { escrow = decodeEscrowDatum(utxo.datumHex); }
    catch { throw new ToolAdmissionError(400, "invalid_escrow"); }
    const now = await this.now();
    if (escrow.state !== "Open" || escrow.submitted_at !== null || escrow.result_receipt_hash !== null ||
        escrow.supplier_pkh !== supplierKey.pubKeyHash || escrow.buyer_pkh === supplierKey.pubKeyHash ||
        escrow.advert_ref.txHash !== advertRef.txHash || escrow.advert_ref.index !== advertRef.index ||
        escrow.capability_id !== PAPER2AGENT_CAPABILITY_ID ||
        escrow.request_spec_hash !== paper2AgentRequestSpecHash(this.manifest) ||
        escrow.prompt_hash !== paper2AgentRequestHash(this.manifestHash, request.input) ||
        escrow.payment_lovelace !== advert.price_lovelace ||
        escrow.buyer_bond_lovelace !== advert.buyer_bond_lovelace ||
        escrow.supplier_bond_lovelace !== advert.supplier_bond_lovelace ||
        utxo.lovelace < escrow.payment_lovelace + escrow.buyer_bond_lovelace + escrow.supplier_bond_lovelace ||
        !Number.isSafeInteger(escrow.posted_at) || escrow.posted_at > now ||
        !Number.isSafeInteger(escrow.deliver_by) ||
        escrow.deliver_by !== escrow.posted_at + advert.max_processing_ms + NETWORK_BUFFER_MS ||
        escrow.deliver_by - now < this.manifest.limits.max_runtime_ms + PAPER2AGENT_SUPPLIER_OVERHEAD_MS) {
      throw new ToolAdmissionError(409, "escrow_commitment_or_economics_mismatch");
    }
    if (this.closing || !state.tryAcquire(refText)) throw new ToolAdmissionError(409, "supplier_busy");
    let session: ToolSession | undefined;
    let job: ToolJob | undefined;
    let handedOff = false;
    try {
      // Recheck after acquiring the slot, including durable duplicate protection.
      if (this.journal.hasEscrow(refText)) throw new ToolAdmissionError(409, "escrow_already_admitted");
      await verifyPackage(config, this.manifest);
      session = this.deps.sessionFactory?.(config) ?? new LocalToolSession(config);
      this.sessions.add(session);
      checkTool(this.manifest, await session.discover());
      if (this.closing) throw new ToolAdmissionError(503, "supplier_draining");
      if (escrow.deliver_by - await this.now() < this.manifest.limits.max_runtime_ms + 120000) {
        throw new ToolAdmissionError(408, "insufficient_delivery_time");
      }
      job = this.journal.create(refText, this.manifestHash, request.input);
      const currentJob = job;
      const claim = await state.walletMutex.run(async () => {
        if (this.closing) throw new Error("Supplier is stopping");
        const built = await buildClaimTx({ chain, supplierKey, escrowRef,
          beforeSubmit: async (candidate) => {
            currentJob.phase = "claiming";
            currentJob.claimed_ref = `${candidate.expectedTxHash}#0`;
            this.journal.save(currentJob);
          },
        });
        await chain.awaitTx(built.expectedTxHash, 60000);
        return built;
      });
      job.claimed_ref = `${claim.expectedTxHash}#0`;
      job.phase = "claimed";
      this.journal.save(job);
      // No tool execution until Claim confirmation succeeds.
      const task = this.run(job, session, escrow, advert);
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
      handedOff = true;
      return job;
    } catch (error) {
      if (job) {
        job.status = "failed";
        job.reason = job.phase === "claiming" ? "claim_financial_status_unknown" : "tool_admission_failed";
        try { this.journal.save(job); } catch { state.markOffline(); }
        throw new ToolAdmissionError(503, job.reason, job);
      }
      if (error instanceof ToolAdmissionError) throw error;
      throw new ToolAdmissionError(503, "tool_preflight_failed");
    } finally {
      if (!handedOff) await this.release(session, refText);
    }
  }

  private async release(session: ToolSession | undefined, ref: string): Promise<void> {
    try {
      await session?.close();
      if (session) this.sessions.delete(session);
      this.deps.state.release(ref);
    } catch {
      // Never admit another job if process termination is uncertain.
      this.closing = true;
      this.deps.state.markOffline();
    }
  }

  private async run(job: ToolJob, session: ToolSession, escrow: EscrowDatum, advert: AdvertDatum): Promise<void> {
    const { chain, supplierKey, state } = this.deps;
    try {
      if (this.closing || escrow.deliver_by - await this.now() < this.manifest.limits.max_runtime_ms + 60000) {
        throw new Error("Insufficient execution time");
      }
      job.status = "running";
      job.phase = "executing";
      this.journal.save(job);
      const started = performance.now();
      const result = validatePaper2AgentOutput(this.manifest,
        await session.execute(this.manifest.name, job.input, this.manifest.limits.max_runtime_ms));
      // Monotonic elapsed time, rounded up. The shared verifier rejects a receipt
      // over the manifest runtime, so a late result leaves the Claim reclaimable.
      const wallclockMs = Math.ceil(performance.now() - started);
      if (wallclockMs > this.manifest.limits.max_runtime_ms) throw new Error("Tool exceeded its manifest runtime");
      // Terminate before signing/submission. A cleanup failure is not success.
      await session.close();
      this.sessions.delete(session);
      const receipt = buildReceipt({ prompt_hash: escrow.prompt_hash,
        response_hash: paper2AgentResultHash(this.manifestHash, escrow.prompt_hash, result),
        model: advert.model, prompt_tokens: 0, completion_tokens: 0, wallclock_ms: wallclockMs,
        supplier_pkh: supplierKey.pubKeyHash, escrow_ref: job.escrow_ref });
      const signed = signReceipt(receipt, supplierKey.privateKeyHex);
      Object.assign(job, { result, receipt: signed.receipt, receipt_signature: signed.signature,
        pub_key_hex: supplierKey.pubKeyHex, phase: "signed" });
      this.journal.save(job);
      await state.walletMutex.run(async () => {
        if (this.closing) throw new Error("Supplier is stopping");
        const [txHash, index] = job.claimed_ref!.split("#");
        const built = await buildSubmitTx({ chain, supplierKey, escrowRef: { txHash, index: Number(index) },
          receiptHash: receiptResultHash(signed),
          beforeSubmit: async (candidate) => {
            job.phase = "submitting";
            job.submitted_ref = `${candidate.expectedTxHash}#0`;
            this.journal.save(job);
          },
        });
        await chain.awaitTx(built.expectedTxHash, 60000);
      });
      job.phase = "submitted";
      job.status = "done";
      this.journal.save(job);
    } catch {
      job.status = "failed";
      job.reason = job.phase === "submitting" ? "submit_financial_status_unknown" : "tool_execution_failed";
      try { this.journal.save(job); } catch { state.markOffline(); }
    } finally {
      await this.release(session, job.escrow_ref);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    // Stop processes first; an in-flight chain confirmation must not delay this.
    await Promise.all([...this.sessions].map((session) => session.close()));
    await Promise.allSettled([...this.tasks]);
  }
}
