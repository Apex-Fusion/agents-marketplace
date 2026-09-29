import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiveOgmiosProvider,
  OgmiosSubmitError,
  type OutputReference,
  type TxEvaluationResult,
  type Utxo,
} from "@marketplace/shared/chain";
import { inspectSignedTransaction } from "@marketplace/shared/tx/server";
import { seal } from "../src/crypto/seal.js";
import { GatewayStore, type ApiKeyRow } from "../src/db/store.js";
import { Mutex, MutexTimeoutError, SdkRegistry } from "../src/sdk/registry.js";
import { WalletTransactionGuardError } from "../src/sdk/walletTransactions.js";
import { deriveWalletKey, genPrivKeyHex } from "../src/wallet.js";

const MASTER_KEY = "ab".repeat(32);

function syntheticTransaction(validUntilSlot = 100, outputCount = 2): string {
  const body = {
    type: "wallet-safety-test",
    inputs: [],
    outputs: Array.from({ length: outputCount }, (_unused, index) => ({
      ref: { txHash: "$self", index },
      address: "addr_test1_wallet_safety",
      lovelace: "2000000n",
    })),
    requiredSigners: [],
    validityRange: { lowerBoundMs: 0, upperBoundMs: validUntilSlot * 1_000 },
  };
  const json = Buffer.from(JSON.stringify(body), "utf8");
  return json.byteLength.toString(16).padStart(8, "0") + json.toString("hex");
}

function keyRow(id = randomUUID(), privateKeyHex = genPrivKeyHex()): ApiKeyRow {
  const wallet = deriveWalletKey(privateKeyHex, 0);
  const encrypted = seal(privateKeyHex, MASTER_KEY);
  return {
    id,
    key_hash: `hash-${id}`,
    key_prefix: "vk_test_safe",
    label: null,
    wallet_pkh: wallet.pubKeyHash,
    deposit_address: wallet.address,
    enc_priv_nonce: encrypted.nonce,
    enc_priv_ct: encrypted.ct,
    enc_priv_tag: encrypted.tag,
    master_key_version: 1,
    created_at: Date.now(),
    disabled: 0,
    demo: 0,
  };
}

class FakeLiveChain extends LiveOgmiosProvider {
  slot = 0;
  submitError: Error | null = null;
  confirmOnSubmitIndex: number | null = null;
  readonly submissions: string[] = [];
  readonly outputs = new Map<string, Utxo>();

  constructor() {
    super({ ogmiosUrl: "http://unused.invalid" });
  }

  override async tip(): Promise<number> {
    return this.slot;
  }

  override async queryUtxo(ref: OutputReference): Promise<Utxo | null> {
    return this.outputs.get(`${ref.txHash}#${ref.index}`) ?? null;
  }

  override async queryUtxosByAddress(): Promise<Utxo[]> {
    return [];
  }

  override async evaluateTx(): Promise<TxEvaluationResult> {
    return { ok: true };
  }

  override async submitTx(txCborHex: string): Promise<string> {
    this.submissions.push(txCborHex);
    if (this.submitError !== null) throw this.submitError;
    const info = inspectSignedTransaction(txCborHex);
    if (this.confirmOnSubmitIndex !== null) {
      const ref = { txHash: info.txHash, index: this.confirmOnSubmitIndex };
      this.outputs.set(`${ref.txHash}#${ref.index}`, {
        ref,
        address: "addr_test1_wallet_safety",
        lovelace: 2_000_000n,
        assets: {},
        datumHex: null,
        scriptRef: null,
      });
    }
    return info.txHash;
  }
}

function registry(store: GatewayStore, chain: FakeLiveChain, max = 10): SdkRegistry {
  return new SdkRegistry({
    chain,
    store,
    indexerUrl: "http://indexer.invalid",
    networkId: 0,
    masterKeyHex: MASTER_KEY,
    max,
  });
}

function newStore(): GatewayStore {
  return new GatewayStore(join(tmpdir(), `gateway-wallet-safety-${randomUUID()}`));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wallet mutation safety", () => {
  it("keeps the real operation at the mutex head after its caller times out", async () => {
    vi.useFakeTimers();
    const mutex = new Mutex();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = mutex.run(() => new Promise<void>((resolve) => {
      release = resolve;
      markStarted();
    }), "slow", 10);
    await started;

    const rejected = expect(first).rejects.toBeInstanceOf(MutexTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;

    let secondStarted = false;
    const second = mutex.run(async () => { secondStarted = true; }, "next", 0);
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    release();
    await second;
    expect(secondStarted).toBe(true);
  });

  it("keeps one wallet mutex and guarded provider across SDK LRU eviction", async () => {
    const store = newStore();
    const chain = new FakeLiveChain();
    const firstKey = keyRow();
    const secondKey = keyRow();
    const sdkRegistry = registry(store, chain, 1);
    const original = sdkRegistry.getContext(firstKey);
    expect(original.chain).toBeInstanceOf(LiveOgmiosProvider);

    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const holding = original.mutex.run(() => new Promise<void>((resolve) => {
      release = resolve;
      markStarted();
    }), "hold", 0);
    await started;

    sdkRegistry.getContext(secondKey);
    const rebuilt = sdkRegistry.getContext(firstKey);
    expect(rebuilt).not.toBe(original);
    expect(rebuilt.mutex).toBe(original.mutex);
    expect(rebuilt.chain).toBe(original.chain);

    let overlap = false;
    const queued = rebuilt.mutex.run(async () => { overlap = true; }, "queued", 0);
    await Promise.resolve();
    expect(overlap).toBe(false);
    release();
    await holding;
    await queued;
  });

  it("refuses a wallet broadcast outside its shared mutex", async () => {
    const store = newStore();
    const chain = new FakeLiveChain();
    const key = keyRow();
    const ctx = registry(store, chain).getContext(key);
    const tx = syntheticTransaction();

    await expect(ctx.chain.submitTx(tx)).rejects.toThrow("inside the wallet mutex");
    expect(chain.submissions).toEqual([]);
    expect(store.getPendingWalletTransaction(key.id)).toBeUndefined();
  });

  it("retains an ambiguous signed transaction and blocks replacement spending", async () => {
    const store = newStore();
    const chain = new FakeLiveChain();
    chain.submitError = new Error("transport disconnected after request write");
    const key = keyRow();
    const ctx = registry(store, chain).getContext(key);
    const tx = syntheticTransaction();
    const txHash = inspectSignedTransaction(tx).txHash;

    await expect(ctx.mutex.run(() => ctx.chain.submitTx(tx), "submit", 0)).rejects.toThrow(
      "transport disconnected",
    );
    expect(store.getPendingWalletTransaction(key.id)?.tx_hash).toBe(txHash);
    expect(store.getWalletTransactionOutcome(key.id, txHash)).toBeUndefined();

    const replacement = syntheticTransaction(101);
    await expect(ctx.mutex.run(() => ctx.chain.submitTx(replacement), "replace", 0)).rejects.toThrow(
      "remains unresolved",
    );
    expect(chain.submissions).toEqual([tx, tx]);
  });

  it("keeps the pending record when confirmation times out", async () => {
    const store = newStore();
    const chain = new FakeLiveChain();
    const key = keyRow();
    const ctx = registry(store, chain).getContext(key);
    const tx = syntheticTransaction();
    const txHash = inspectSignedTransaction(tx).txHash;
    await expect(ctx.mutex.run(async () => {
      await ctx.chain.submitTx(tx);
      await ctx.chain.awaitTx(txHash, 10);
    }, "confirm", 0)).rejects.toBeInstanceOf(WalletTransactionGuardError);
    expect(store.getPendingWalletTransaction(key.id)?.tx_hash).toBe(txHash);
    expect(store.getWalletTransactionOutcome(key.id, txHash)).toBeUndefined();
  });

  it("restarts by resubmitting only the exact durable transaction", async () => {
    const store = newStore();
    const key = keyRow();
    const tx = syntheticTransaction();
    const firstChain = new FakeLiveChain();
    firstChain.submitError = new Error("ambiguous submit");
    const firstContext = registry(store, firstChain).getContext(key);
    await expect(firstContext.mutex.run(() => firstContext.chain.submitTx(tx), "submit", 0)).rejects.toThrow();

    const recoveredChain = new FakeLiveChain();
    recoveredChain.confirmOnSubmitIndex = 1;
    const recovered = registry(store, recoveredChain).getContext(key);
    await recovered.mutex.run(async () => undefined, "recover", 0);

    const txHash = inspectSignedTransaction(tx).txHash;
    expect(recoveredChain.submissions).toEqual([tx]);
    expect(store.getPendingWalletTransaction(key.id)).toBeUndefined();
    expect(store.getWalletTransactionOutcome(key.id, txHash)?.state).toBe("confirmed");
  });

  it("recognizes a confirmed nonzero output and never resubmits it", async () => {
    const store = newStore();
    const key = keyRow();
    const tx = syntheticTransaction();
    const info = inspectSignedTransaction(tx);
    expect(store.putPendingWalletTransaction({
      key_id: key.id,
      tx_hash: info.txHash,
      tx_cbor: tx,
      created_at: Date.now(),
      valid_until_slot: info.validUntilSlot,
    })).toBe(true);

    const chain = new FakeLiveChain();
    const ref = { txHash: info.txHash, index: 1 };
    chain.outputs.set(`${ref.txHash}#${ref.index}`, {
      ref,
      address: "addr_test1_wallet_safety",
      lovelace: 2_000_000n,
      assets: {},
      datumHex: null,
      scriptRef: null,
    });
    const ctx = registry(store, chain).getContext(key);
    await ctx.mutex.run(async () => undefined, "observe", 0);

    expect(chain.submissions).toEqual([]);
    expect(store.getWalletTransactionOutcome(key.id, info.txHash)?.state).toBe("confirmed");
  });

  it("uses chain slot expiry to release a pending transaction without resubmission", async () => {
    const store = newStore();
    const key = keyRow();
    const tx = syntheticTransaction(50);
    const info = inspectSignedTransaction(tx);
    store.putPendingWalletTransaction({
      key_id: key.id,
      tx_hash: info.txHash,
      tx_cbor: tx,
      created_at: Date.now(),
      valid_until_slot: info.validUntilSlot,
    });

    const chain = new FakeLiveChain();
    chain.slot = 50;
    const ctx = registry(store, chain).getContext(key);
    await ctx.mutex.run(async () => undefined, "expire", 0);

    expect(chain.submissions).toEqual([]);
    expect(store.getWalletTransactionOutcome(key.id, info.txHash)?.state).toBe("expired");
  });

  it("records a definite first-submit rejection instead of leaving ambiguity", async () => {
    const store = newStore();
    const key = keyRow();
    const tx = syntheticTransaction();
    const info = inspectSignedTransaction(tx);
    const chain = new FakeLiveChain();
    chain.submitError = new OgmiosSubmitError("bad transaction", 3117);
    const ctx = registry(store, chain).getContext(key);

    await expect(ctx.mutex.run(() => ctx.chain.submitTx(tx), "reject", 0)).rejects.toBeInstanceOf(
      OgmiosSubmitError,
    );
    expect(store.getPendingWalletTransaction(key.id)).toBeUndefined();
    expect(store.getWalletTransactionOutcome(key.id, info.txHash)?.state).toBe("rejected");
  });
});
