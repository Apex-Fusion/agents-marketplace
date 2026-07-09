/**
 * sweeper.test.ts — reclaim/close decoupling + settled-refs memory.
 *
 * Ticket mode: reclaiming a live session's Open escrow must NOT close the
 * session row or drop its transcript mirror (the conversation continues on a
 * spent ticket). Full mode keeps close-on-reclaim. Claimed rows close even
 * under ticket config (they can only come from full-mode suppliers). The
 * settled-refs memory prevents re-attempting refs already settled, and the
 * deliver_by gate skips reclaims the validator would reject.
 */

import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, randomUUID } from "crypto";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import { genPrivKeyHex, deriveWalletKey } from "../src/wallet.js";
import { seal } from "../src/crypto/seal.js";
import { hashApiKey } from "../src/middleware/apiKeyAuth.js";
import { runSweepOnce } from "../src/sweeper.js";
import { transcripts } from "../src/openai/transcripts.js";
import type { GatewayConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";
import type { EscrowRow } from "../src/onchain/settle.js";

const MASTER = "ab".repeat(32);

function makeSweepDeps(opts: { chatSettleMode: "full" | "ticket"; escrows: EscrowRow[] }) {
  const dbDir = join(tmpdir(), `gw-sweep-${randomUUID()}`);
  const store = new GatewayStore(dbDir);
  const config: GatewayConfig = {
    masterKeyHex: MASTER,
    indexerUrl: "http://ix",
    ogmiosUrl: "http://og",
    networkId: 0,
    liveChain: true,
    port: 0,
    dbDir,
    signupRate: { max: 1000, windowMs: 60_000 },
    keyRate: { max: 1000, windowMs: 60_000 },
    demoIpRate: { max: 1000, windowMs: 60_000 },
    sweeperIntervalMs: 60_000,
    demoSessionIdleMs: 180_000,
    chatSettleMode: opts.chatSettleMode,
    walletHealthIntervalMs: 600_000,
    sdkRegistryMax: 100,
    corsOrigins: [],
  };
  const chain = { queryUtxo: async () => null } as unknown as GatewayDeps["chain"];
  const registry = new SdkRegistry({
    chain,
    indexerUrl: config.indexerUrl,
    networkId: config.networkId,
    masterKeyHex: config.masterKeyHex,
    max: config.sdkRegistryMax,
  });
  const fetchFn = (async (url: unknown) => {
    if (String(url).includes("/escrows")) return new Response(JSON.stringify(opts.escrows), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const deps: GatewayDeps = { config, store, chain, registry, fetchFn };

  const rawKey = `vk_test_${randomBytes(24).toString("hex")}`;
  const privHex = genPrivKeyHex();
  const walletKey = deriveWalletKey(privHex, 0);
  const sealed = seal(privHex, MASTER);
  store.insertKey({
    id: randomUUID(),
    key_hash: hashApiKey(rawKey),
    key_prefix: rawKey.slice(0, 12),
    label: "sweep-test",
    wallet_pkh: walletKey.pubKeyHash,
    deposit_address: walletKey.address,
    enc_priv_nonce: sealed.nonce,
    enc_priv_ct: sealed.ct,
    enc_priv_tag: sealed.tag,
    master_key_version: 1,
    created_at: Date.now(),
    demo: 1,
  });
  const keyRow = store.getKeyByHash(hashApiKey(rawKey))!;
  return { deps, keyRow };
}

function insertOpenSession(deps: GatewayDeps, keyId: string, escrowRef: string): string {
  const id = randomUUID();
  deps.store.insertSession({
    id,
    key_id: keyId,
    escrow_ref: escrowRef,
    session_nonce: "nonce",
    supplier_base_url: "http://sup",
    supplier_pkh: "s1",
    model: "kimi",
    price_lovelace: "200000",
    state: "open",
    opened_at: Date.now() - 40 * 60 * 1000,
  });
  return id;
}

function openRow(refChar: string, opts?: Partial<EscrowRow>): EscrowRow {
  return {
    utxo_ref: `${refChar.repeat(64)}#0`,
    state: "Open",
    posted_at: Date.now() - 40 * 60 * 1000,
    deliver_by: Date.now() - 5 * 60 * 1000,
    ...opts,
  };
}

const settleOk = () => ({
  accept: vi.fn(async () => undefined) as never,
  reclaim: vi.fn(async () => undefined) as never,
});

describe("sweeper — ticket-mode reclaim/close decoupling", () => {
  it("reclaims a live session's Open ticket but keeps the session (and mirror) alive", async () => {
    const row = openRow("1");
    const { deps, keyRow } = makeSweepDeps({ chatSettleMode: "ticket", escrows: [row] });
    const sessionId = insertOpenSession(deps, keyRow.id, row.utxo_ref);
    transcripts.set(sessionId, [{ role: "user", content: "hi" }]);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.reclaim).toHaveBeenCalledTimes(1);
    expect(deps.store.getSession(sessionId)!.state).toBe("open"); // NOT closed
    expect(transcripts.get(sessionId)).toBeDefined(); // mirror intact
    expect(deps.store.listUsage(keyRow.id, 10)).toHaveLength(0); // nothing billed

    transcripts.delete(sessionId);
  });

  it("full mode: reclaim closes the session row", async () => {
    const row = openRow("2");
    const { deps, keyRow } = makeSweepDeps({ chatSettleMode: "full", escrows: [row] });
    const sessionId = insertOpenSession(deps, keyRow.id, row.utxo_ref);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.reclaim).toHaveBeenCalledTimes(1);
    expect(deps.store.getSession(sessionId)!.state).toBe("closed");
    const usage = deps.store.listUsage(keyRow.id, 10);
    expect(usage.some((u) => u.status === "reclaimed")).toBe(true);
  });

  it("ticket config still closes sessions behind Claimed rows (full-mode suppliers)", async () => {
    const row = openRow("3", { state: "Claimed" });
    const { deps, keyRow } = makeSweepDeps({ chatSettleMode: "ticket", escrows: [row] });
    const sessionId = insertOpenSession(deps, keyRow.id, row.utxo_ref);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.reclaim).toHaveBeenCalledTimes(1);
    expect(deps.store.getSession(sessionId)!.state).toBe("closed");
  });
});

describe("sweeper — reclaim gating + settled-refs memory", () => {
  it("skips reclaim while deliver_by has not passed", async () => {
    const row = openRow("4", { deliver_by: Date.now() + 10 * 60 * 1000 });
    const { deps, keyRow } = makeSweepDeps({ chatSettleMode: "ticket", escrows: [row] });
    insertOpenSession(deps, keyRow.id, row.utxo_ref);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.reclaim).not.toHaveBeenCalled();
  });

  it("does not re-attempt refs it already settled (in-process memory)", async () => {
    const row = openRow("5");
    const { deps, keyRow } = makeSweepDeps({ chatSettleMode: "ticket", escrows: [row] });
    insertOpenSession(deps, keyRow.id, row.utxo_ref);
    const settle = settleOk();

    await runSweepOnce(deps, settle);
    await runSweepOnce(deps, settle);

    expect(settle.reclaim).toHaveBeenCalledTimes(1);
  });
});
