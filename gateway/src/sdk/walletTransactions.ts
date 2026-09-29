import { AsyncLocalStorage } from "async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { OgmiosSubmitError, type LiveOgmiosProvider } from "@marketplace/shared/chain";
import { inspectSignedTransaction, type SignedTransactionInfo } from "@marketplace/shared/tx/server";
import type { GatewayStore, PendingWalletTransaction } from "../db/store.js";

const RECONCILIATION_CONFIRM_TIMEOUT_MS = 120_000;
const CONFIRM_POLL_INTERVAL_MS = 1_000;

export class WalletTransactionGuardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WalletTransactionGuardError";
  }
}

interface GuardScope {
  token: symbol;
}

type PendingTransactionStore = Pick<
  GatewayStore,
  | "getPendingWalletTransaction"
  | "putPendingWalletTransaction"
  | "getWalletTransactionOutcome"
  | "resolvePendingWalletTransaction"
>;

export interface WalletTransactionGuardOptions {
  keyId: string;
  chain: LiveOgmiosProvider;
  store: PendingTransactionStore;
}

/**
 * Couples a wallet's submission capability to its mutex execution scope and
 * durable pending-transaction journal.
 */
export class WalletTransactionGuard {
  readonly chain: LiveOgmiosProvider;

  private readonly keyId: string;
  private readonly baseChain: LiveOgmiosProvider;
  private readonly store: PendingTransactionStore;
  private readonly scope = new AsyncLocalStorage<GuardScope>();
  private activeToken: symbol | null = null;

  constructor(options: WalletTransactionGuardOptions) {
    this.keyId = options.keyId;
    this.baseChain = options.chain;
    this.store = options.store;

    this.chain = new Proxy(options.chain, {
      get: (target, property) => {
        if (property === "submitTx") return this.submitTx.bind(this);
        if (property === "awaitTx") return this.awaitTx.bind(this);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Run one mutex-owned operation with permission to submit and confirm. */
  async runInScope<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeToken !== null) {
      throw new WalletTransactionGuardError("wallet transaction scope overlapped another active operation");
    }
    const token = Symbol(this.keyId);
    this.activeToken = token;
    try {
      return await this.scope.run({ token }, operation);
    } finally {
      this.activeToken = null;
    }
  }

  /** Resolve the durable record before any new wallet operation can start. */
  async reconcilePendingWalletTransaction(): Promise<void> {
    const pending = this.store.getPendingWalletTransaction(this.keyId);
    if (pending === undefined) return;
    const priorOutcome = this.store.getWalletTransactionOutcome(this.keyId, pending.tx_hash);
    if (priorOutcome !== undefined) {
      this.resolvePending(pending.tx_hash, priorOutcome.state);
      return;
    }

    const inspected = this.inspectPending(pending);
    const observed = await this.observeTransaction(inspected);
    if (observed !== "pending") {
      this.resolvePending(pending.tx_hash, observed);
      return;
    }

    let submittedHash: string;
    try {
      submittedHash = await this.baseChain.submitTx(pending.tx_cbor);
    } catch (error) {
      throw new WalletTransactionGuardError(
        `pending wallet transaction ${pending.tx_hash} remains unresolved after exact resubmission failed`,
        { cause: error },
      );
    }
    if (submittedHash.toLowerCase() !== pending.tx_hash) {
      throw new WalletTransactionGuardError(
        `pending wallet transaction hash mismatch: signed ${pending.tx_hash}, provider returned ${submittedHash}`,
      );
    }

    let outcome: "confirmed" | "expired";
    try {
      outcome = await this.waitForTransactionOutcome(inspected, RECONCILIATION_CONFIRM_TIMEOUT_MS);
    } catch (error) {
      throw new WalletTransactionGuardError(
        `pending wallet transaction ${pending.tx_hash} remains unresolved after exact resubmission`,
        { cause: error },
      );
    }
    this.resolvePending(pending.tx_hash, outcome);
  }

  private requireActiveScope(): void {
    const scope = this.scope.getStore();
    if (scope === undefined || scope.token !== this.activeToken) {
      throw new WalletTransactionGuardError(
        "wallet transaction submission and confirmation must run inside the wallet mutex",
      );
    }
  }

  private async submitTx(txCborHex: string): Promise<string> {
    this.requireActiveScope();
    const inspected = inspectSignedTransaction(txCborHex);
    const priorOutcome = this.store.getWalletTransactionOutcome(this.keyId, inspected.txHash);
    if (priorOutcome !== undefined) {
      throw new WalletTransactionGuardError(
        `wallet transaction ${inspected.txHash} already has durable ${priorOutcome.state} outcome`,
      );
    }
    const existing = this.store.getPendingWalletTransaction(this.keyId);
    if (
      existing !== undefined &&
      existing.tx_hash === inspected.txHash &&
      existing.tx_cbor === txCborHex
    ) {
      this.inspectPending(existing);
    }
    const row: PendingWalletTransaction = {
      key_id: this.keyId,
      tx_hash: inspected.txHash,
      tx_cbor: txCborHex,
      created_at: existing?.tx_hash === inspected.txHash && existing.tx_cbor === txCborHex
        ? existing.created_at
        : Date.now(),
      valid_until_slot: inspected.validUntilSlot,
    };
    if (!this.store.putPendingWalletTransaction(row)) {
      throw new WalletTransactionGuardError(
        `wallet already has a different unresolved transaction (${existing?.tx_hash ?? "unknown"})`,
      );
    }

    try {
      const submittedHash = await this.baseChain.submitTx(txCborHex);
      if (submittedHash.toLowerCase() !== inspected.txHash) {
        throw new WalletTransactionGuardError(
          `submitted transaction hash mismatch: signed ${inspected.txHash}, provider returned ${submittedHash}`,
        );
      }
      return submittedHash;
    } catch (error) {
      // A structured JSON-RPC rejection proves that a first submission did not
      // enter the mempool. A retry of an older pending tx can instead be
      // rejected because that exact tx already landed, so it remains pending.
      if (error instanceof OgmiosSubmitError && existing === undefined) {
        this.resolvePending(inspected.txHash, "rejected");
      }
      throw error;
    }
  }

  private async awaitTx(txHash: string, timeoutMs: number): Promise<void> {
    this.requireActiveScope();
    const normalizedHash = txHash.toLowerCase();
    const pending = this.store.getPendingWalletTransaction(this.keyId);
    if (pending === undefined) {
      await this.baseChain.awaitTx(txHash, timeoutMs);
      return;
    }
    if (pending.tx_hash !== normalizedHash) {
      throw new WalletTransactionGuardError(
        `cannot await ${normalizedHash}; wallet is blocked by pending transaction ${pending.tx_hash}`,
      );
    }

    const inspected = this.inspectPending(pending);
    let outcome: "confirmed" | "expired";
    try {
      outcome = await this.waitForTransactionOutcome(inspected, timeoutMs);
    } catch (error) {
      throw new WalletTransactionGuardError(
        `wallet transaction ${normalizedHash} is still awaiting confirmation`,
        { cause: error },
      );
    }
    this.resolvePending(normalizedHash, outcome);
    if (outcome === "expired") {
      throw new WalletTransactionGuardError(
        `wallet transaction ${normalizedHash} expired before confirmation at chain slot ${pending.valid_until_slot}`,
      );
    }
  }

  private inspectPending(pending: PendingWalletTransaction): SignedTransactionInfo {
    let inspected: SignedTransactionInfo;
    try {
      inspected = inspectSignedTransaction(pending.tx_cbor);
    } catch (error) {
      throw new WalletTransactionGuardError(
        `cannot inspect durable pending wallet transaction ${pending.tx_hash}`,
        { cause: error },
      );
    }
    if (inspected.txHash !== pending.tx_hash) {
      throw new WalletTransactionGuardError(
        `durable pending wallet transaction is corrupt: stored ${pending.tx_hash}, signed ${inspected.txHash}`,
      );
    }
    if (inspected.validUntilSlot !== pending.valid_until_slot) {
      throw new WalletTransactionGuardError(
        `durable pending wallet transaction validity mismatch for ${pending.tx_hash}`,
      );
    }
    return inspected;
  }

  private resolvePending(txHash: string, state: "confirmed" | "rejected" | "expired"): void {
    if (!this.store.resolvePendingWalletTransaction(this.keyId, txHash, state)) {
      throw new WalletTransactionGuardError(
        `failed to record ${state} outcome for durable wallet transaction ${txHash}`,
      );
    }
  }

  private async observeTransaction(
    inspected: SignedTransactionInfo,
  ): Promise<"confirmed" | "expired" | "pending"> {
    for (const index of inspected.outputIndexes) {
      if (await this.baseChain.queryUtxo({ txHash: inspected.txHash, index }) !== null) return "confirmed";
    }

    if (inspected.validUntilSlot !== null) {
      const tip = await this.baseChain.tip();
      if (tip >= inspected.validUntilSlot) return "expired";
    }
    return "pending";
  }

  private async waitForTransactionOutcome(
    inspected: SignedTransactionInfo,
    timeoutMs: number,
  ): Promise<"confirmed" | "expired"> {
    // A synthetic transaction can have no outputs. Its mock provider tracks
    // submission directly, so use that provider's confirmation primitive.
    if (inspected.outputIndexes.length === 0) {
      await this.baseChain.awaitTx(inspected.txHash, timeoutMs);
      return "confirmed";
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      const outcome = await this.observeTransaction(inspected);
      if (outcome !== "pending") return outcome;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `awaitTx_timeout: tx ${inspected.txHash} not observed within ${timeoutMs}ms`,
        );
      }
      await delay(Math.min(CONFIRM_POLL_INTERVAL_MS, remaining));
    }
  }
}
