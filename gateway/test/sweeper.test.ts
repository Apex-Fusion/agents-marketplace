/**
 * sweeper.test.ts — reclaim/close decoupling + settled-refs memory.
 *
 * Ticket mode: reclaiming a live session's Open escrow must NOT close the
 * session row or drop its transcript mirror (the conversation continues on a
 * spent ticket). Full mode keeps close-on-reclaim. Claimed rows close even
 * under ticket config (they can only come from full-mode suppliers). The
 * settled-refs memory prevents re-attempting refs already settled, and the
 * deliver_by gate skips reclaims the validator would reject.
 *
 * New escrows (Part 2 §6.1, §9.6): RefundRevoked when the agent's record
 * allows it, Accept and Reclaim otherwise, one read of the identity address
 * per sweep.
 *
 * Receipt check before the Accept (Part 2 §6.3): the chat end keeps the
 * supplier's receipt and records a receipt that names another agent as
 * failed; the sweeper Accepts a new escrow only with a kept receipt that
 * names its agent, and refuses a kept receipt that fails the check for both
 * layouts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, type Mock } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, randomUUID } from "crypto";
import type { Utxo } from "@marketplace/shared/chain";
import {
  encodeEscrowDatum,
  encodeIdentityEscrowDatum,
  plutusAddressFromBech32,
  type EscrowDatum,
  type IdentityDatum,
  type IdentityEscrowDatum,
  type Status,
} from "@marketplace/shared/cbor";
import { buildReceipt, receiptResultHash, signReceipt, type SignedReceipt } from "@marketplace/shared/receipt";
import type { IdentityBlueprint, RecordLookup, WalletKey } from "@marketplace/shared/tx";
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
import { keepReceipt } from "../src/onchain/receipts.js";
import { TEST_IDENTITY_HASH, testIdentityBlueprint } from "../../tests/fixtures/identity-builders/blueprint.js";
import { agentRecord, recordUtxo, testWallet, tombstone } from "../../tests/fixtures/identity-builders/world.js";

const MASTER = "ab".repeat(32);

function makeSweepDeps(opts: {
  chatSettleMode: "full" | "ticket";
  escrows: EscrowRow[];
  chain?: GatewayDeps["chain"];
  privHex?: string;
  /** Answers a request first; undefined falls through to the indexer stub. */
  fetch?: (url: string, init?: RequestInit) => Response | undefined;
}) {
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
    oneShotConcurrency: 4, oneShotMaxOutstanding: 64, oneShotQueueTimeoutMs: 60_000,
    mcpIpRate: { max: 1000, windowMs: 60_000 },
    mcpCallIpRate: { max: 1000, windowMs: 60_000 },
    mcpCallIpConcurrency: 1,
    mcpCallConcurrency: 2,
    mcpCallQueueTimeoutMs: 60_000,
    mcpCatalogTtlMs: 30_000,
    ocrCapabilityId: "ocr.page.extract.chandra-ocr-2.v1",
    corsOrigins: [],
    identityPolicyId: null,
    switchSlot: null,
  };
  const chain = opts.chain ?? ({ queryUtxo: async () => null } as unknown as GatewayDeps["chain"]);
  const registry = new SdkRegistry({
    chain,
    store,
    indexerUrl: config.indexerUrl,
    networkId: config.networkId,
    masterKeyHex: config.masterKeyHex,
    max: config.sdkRegistryMax,
  });
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const answer = opts.fetch?.(String(url), init);
    if (answer) return answer;
    if (String(url).includes("/escrows")) return new Response(JSON.stringify(opts.escrows), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const deps: GatewayDeps = { config, store, chain, registry, fetchFn };

  const rawKey = `vk_test_${randomBytes(24).toString("hex")}`;
  const privHex = opts.privHex ?? genPrivKeyHex();
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

function insertOpenSession(
  deps: GatewayDeps,
  keyId: string,
  escrowRef: string,
  changes: { state?: string; managed_demo?: number; agent_id?: string | null } = {},
): string {
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
    ...changes,
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
  refundRevoked: vi.fn(async () => undefined) as never,
});

describe("sweeper — ticket-mode reclaim/close decoupling", () => {
  it("reclaims a live session's Open ticket but keeps the session (and mirror) alive", async () => {
    const row = openRow("1");
    const { deps, keyRow } = makeSweepDeps({ chatSettleMode: "ticket", escrows: [row] });
    const sessionId = insertOpenSession(deps, keyRow.id, row.utxo_ref);
    transcripts.set(sessionId, [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    }]);
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

describe("sweeper — legacy Submitted settlement", () => {
  it("closes a session whose Submitted escrow was already spent elsewhere", async () => {
    const row = openRow("6", { state: "Submitted" });
    const { deps, keyRow } = makeSweepDeps({ chatSettleMode: "full", escrows: [row] });
    const sessionId = insertOpenSession(deps, keyRow.id, row.utxo_ref);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.accept).not.toHaveBeenCalled();
    expect(deps.store.getSession(sessionId)!.state).toBe("closed");
    expect(deps.store.listUsage(keyRow.id, 10)).toMatchObject([{ status: "completed", cost_lovelace: "200000" }]);
  });
});

describe("sweeper — new escrows (identity layout)", () => {
  const AGENT = "a1".repeat(32);
  const OTHER_AGENT = "b2".repeat(32);
  const controller = testWallet("sweeper controller");
  const supplier = testWallet("sweeper supplier", 0);
  let blueprint: IdentityBlueprint;

  beforeAll(() => {
    vi.stubEnv("IDENTITY_POLICY_ID", TEST_IDENTITY_HASH);
    blueprint = testIdentityBlueprint();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const revoked = (invalidFrom: number | null): Status => ({
    type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: Date.now() - 60_000, invalidFrom, successor: null,
  });
  const activeRecord = (): IdentityDatum => agentRecord(controller, supplier);

  function escrowDatum(wallet: WalletKey, changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
    const now = Date.now();
    return {
      buyer_pkh: wallet.pubKeyHash,
      supplier_pkh: supplier.pubKeyHash,
      advert_ref: { txHash: "ad".repeat(32), index: 0 },
      capability_id: "llm.chat.v1",
      request_spec_hash: "1b".repeat(32),
      prompt_hash: "c3".repeat(32),
      payment_lovelace: 200_000n,
      buyer_bond_lovelace: 1_000_000n,
      supplier_bond_lovelace: 1_000_000n,
      deliver_by: now + 10 * 60 * 1000,
      posted_at: now - 5 * 60 * 1000,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Open",
      agent_id: AGENT,
      refund: { address: plutusAddressFromBech32(wallet.address), datum: null },
      ...changes,
    };
  }

  /** The indexer row (identity view) and the live escrow output at the new escrow address. */
  function escrowAt(refChar: string, wallet: WalletKey, datum: IdentityEscrowDatum): { row: EscrowRow; utxo: Utxo } {
    return escrowAtRef(refChar.repeat(64), wallet, datum);
  }

  function escrowAtRef(txHash: string, wallet: WalletKey, datum: IdentityEscrowDatum): { row: EscrowRow; utxo: Utxo } {
    const ref = { txHash, index: 0 };
    return {
      row: {
        utxo_ref: `${ref.txHash}#0`,
        state: datum.state,
        posted_at: datum.posted_at,
        deliver_by: datum.deliver_by,
        submitted_at: datum.submitted_at,
        layout: "identity",
        agent_id: datum.agent_id,
        refund: { address: wallet.address, datum: null },
        routable: true,
      },
      utxo: {
        ref,
        address: blueprint.escrowScriptAddress(0),
        lovelace: datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace,
        assets: {},
        datumHex: encodeIdentityEscrowDatum(datum),
        scriptRef: null,
      },
    };
  }

  function setup(opts: {
    chatSettleMode: "full" | "ticket";
    privHex: string;
    escrows: Array<{ row: EscrowRow; utxo: Utxo }>;
    record: IdentityDatum;
    fetch?: (url: string, init?: RequestInit) => Response | undefined;
  }) {
    const record: Utxo = {
      ...recordUtxo(blueprint, opts.record, { txHash: "7e".repeat(32), index: 0 }, AGENT),
      address: blueprint.identityScriptAddress(0),
    };
    const queryUtxosByAddress = vi.fn(async (address: string) => (address === record.address ? [record] : []));
    const queryUtxo = vi.fn(async (ref: { txHash: string; index: number }) =>
      opts.escrows.find(({ utxo }) => utxo.ref.txHash === ref.txHash && utxo.ref.index === ref.index)?.utxo ?? null);
    const chain = { queryUtxo, queryUtxosByAddress } as unknown as GatewayDeps["chain"];
    const world = makeSweepDeps({
      chatSettleMode: opts.chatSettleMode,
      escrows: opts.escrows.map(({ row }) => row),
      chain,
      privHex: opts.privHex,
      fetch: opts.fetch,
    });
    return { ...world, record, queryUtxosByAddress };
  }

  /** A receipt of `supplier` for `escrowRef`, with agent_did when given (9 fields), else the 8 legacy fields. */
  function signedReceipt(escrowRef: string, agentDid?: string): SignedReceipt {
    return signReceipt(buildReceipt({
      prompt_hash: "c3".repeat(32), response_hash: "f1".repeat(32), model: "kimi", prompt_tokens: 1,
      completion_tokens: 1, wallclock_ms: 10, supplier_pkh: supplier.pubKeyHash, escrow_ref: escrowRef,
      ...(agentDid === undefined ? {} : { agent_did: agentDid }),
    }), supplier.privateKeyHex);
  }

  /** A Submitted new escrow at a fresh ref that commits to `receipt`. */
  function submittedFor(wallet: WalletKey, receipt: (escrowRef: string) => SignedReceipt) {
    const txHash = randomBytes(32).toString("hex");
    const signed = receipt(`${txHash}#0`);
    const escrow = escrowAtRef(txHash, wallet, escrowDatum(wallet, {
      state: "Submitted", submitted_at: Date.now() - 2 * 60 * 1000, result_receipt_hash: receiptResultHash(signed),
    }));
    return { escrow, signed };
  }

  /** The supplier's /v1/chat/end answer with `signed`. */
  function endAnswer(escrowRef: string, signed: SignedReceipt): Response {
    return new Response(JSON.stringify({
      status: "submitted", escrow_ref: escrowRef, submitted_ref: escrowRef,
      receipt: signed.receipt, receipt_signature: signed.signature,
    }), { status: 200 });
  }

  it("refunds an Open new escrow of a revoked agent before deliver_by and closes its session", async () => {
    const privHex = genPrivKeyHex();
    const wallet = deriveWalletKey(privHex, 0);
    const escrow = escrowAt("7", wallet, escrowDatum(wallet));
    const { deps, keyRow, record } = setup({
      chatSettleMode: "full", privHex, escrows: [escrow], record: tombstone(activeRecord(), revoked(null)),
    });
    const sessionId = insertOpenSession(deps, keyRow.id, escrow.row.utxo_ref);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    const refund = settle.refundRevoked as unknown as Mock;
    expect(refund).toHaveBeenCalledTimes(1);
    const [, walletKey, ref, lookupRecord] = refund.mock.calls[0] as [unknown, WalletKey, unknown, RecordLookup];
    expect(walletKey.pubKeyHash).toBe(wallet.pubKeyHash);
    expect(ref).toEqual(escrow.utxo.ref);
    expect(await lookupRecord(AGENT)).toBe(record);
    expect(settle.reclaim).not.toHaveBeenCalled();
    expect(deps.store.getSession(sessionId)!.state).toBe("closed");
    expect(deps.store.listUsage(keyRow.id, 10)).toMatchObject([{ status: "reclaimed", cost_lovelace: null }]);
  });

  it("ticket mode keeps the live session open after a refund of its Open escrow", async () => {
    const privHex = genPrivKeyHex();
    const wallet = deriveWalletKey(privHex, 0);
    const escrow = escrowAt("8", wallet, escrowDatum(wallet));
    const { deps, keyRow } = setup({
      chatSettleMode: "ticket", privHex, escrows: [escrow],
      record: tombstone(activeRecord(), { type: "Retired", at: Date.now() - 60_000, successor: null }),
    });
    const sessionId = insertOpenSession(deps, keyRow.id, escrow.row.utxo_ref);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.refundRevoked).toHaveBeenCalledTimes(1);
    expect(deps.store.getSession(sessionId)!.state).toBe("open");
    expect(deps.store.listUsage(keyRow.id, 10)).toHaveLength(0);
  });

  it("leaves an Open new escrow of an Active agent until deliver_by", async () => {
    const privHex = genPrivKeyHex();
    const wallet = deriveWalletKey(privHex, 0);
    const escrow = escrowAt("9", wallet, escrowDatum(wallet));
    const { deps, keyRow } = setup({ chatSettleMode: "full", privHex, escrows: [escrow], record: activeRecord() });
    const sessionId = insertOpenSession(deps, keyRow.id, escrow.row.utxo_ref);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.refundRevoked).not.toHaveBeenCalled();
    expect(settle.reclaim).not.toHaveBeenCalled();
    expect(deps.store.getSession(sessionId)!.state).toBe("open");
  });

  it("refunds a Submitted new escrow instead of the Accept when the agent was revoked from before submitted_at", async () => {
    const privHex = genPrivKeyHex();
    const wallet = deriveWalletKey(privHex, 0);
    const submittedAt = Date.now() - 2 * 60 * 1000;
    const escrow = escrowAt("a", wallet, escrowDatum(wallet, {
      state: "Submitted", submitted_at: submittedAt, result_receipt_hash: "e5".repeat(32),
    }));
    const { deps } = setup({
      chatSettleMode: "full", privHex, escrows: [escrow], record: tombstone(activeRecord(), revoked(submittedAt - 1_000)),
    });
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.refundRevoked).toHaveBeenCalledTimes(1);
    expect(settle.accept).not.toHaveBeenCalled();
  });

  it("accepts a Submitted new escrow when its record allows no refund and the kept receipt names its agent", async () => {
    const privHex = genPrivKeyHex();
    const wallet = deriveWalletKey(privHex, 0);
    const submittedAt = Date.now() - 2 * 60 * 1000;
    const receipt = signedReceipt(`${"b".repeat(64)}#0`, `did:vector:${AGENT}`);
    const escrow = escrowAt("b", wallet, escrowDatum(wallet, {
      state: "Submitted", submitted_at: submittedAt, result_receipt_hash: receiptResultHash(receipt),
    }));
    const { deps, keyRow } = setup({
      chatSettleMode: "full", privHex, escrows: [escrow], record: tombstone(activeRecord(), revoked(submittedAt + 1)),
    });
    keepReceipt(deps.store, keyRow.id, escrow.row.utxo_ref, receipt.receipt, receipt.signature);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.accept).toHaveBeenCalledTimes(1);
    expect(settle.refundRevoked).not.toHaveBeenCalled();
  });

  it("reads the identity address once per sweep for several new escrows", async () => {
    const privHex = genPrivKeyHex();
    const wallet = deriveWalletKey(privHex, 0);
    const submittedAt = Date.now() - 2 * 60 * 1000;
    const receipt = signedReceipt(`${"e".repeat(64)}#0`, `did:vector:${AGENT}`);
    const escrows = [
      escrowAt("c", wallet, escrowDatum(wallet)),
      escrowAt("d", wallet, escrowDatum(wallet, { state: "Claimed" })),
      escrowAt("e", wallet, escrowDatum(wallet, {
        state: "Submitted", submitted_at: submittedAt, result_receipt_hash: receiptResultHash(receipt),
      })),
    ];
    const { deps, keyRow, queryUtxosByAddress } = setup({ chatSettleMode: "full", privHex, escrows, record: activeRecord() });
    keepReceipt(deps.store, keyRow.id, escrows[2]!.row.utxo_ref, receipt.receipt, receipt.signature);
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(queryUtxosByAddress).toHaveBeenCalledTimes(1);
    expect(settle.accept).toHaveBeenCalledTimes(1);
    expect(settle.refundRevoked).not.toHaveBeenCalled();
  });

  it("reclaims a new escrow past deliver_by without reading its record", async () => {
    const privHex = genPrivKeyHex();
    const wallet = deriveWalletKey(privHex, 0);
    const escrow = escrowAt("f", wallet, escrowDatum(wallet, {
      posted_at: Date.now() - 40 * 60 * 1000, deliver_by: Date.now() - 5 * 60 * 1000,
    }));
    const { deps, queryUtxosByAddress } = setup({
      chatSettleMode: "full", privHex, escrows: [escrow], record: tombstone(activeRecord(), revoked(null)),
    });
    const settle = settleOk();

    await runSweepOnce(deps, settle);

    expect(settle.reclaim).toHaveBeenCalledTimes(1);
    expect(settle.refundRevoked).not.toHaveBeenCalled();
    expect(queryUtxosByAddress).not.toHaveBeenCalled();
  });

  describe("receipt check before the Accept (Part 2 §6.3)", () => {
    it("refuses the Accept when the kept receipt names another agent or no agent, and records the session as failed", async () => {
      for (const agentDid of [`did:vector:${OTHER_AGENT}`, undefined]) {
        const privHex = genPrivKeyHex();
        const wallet = deriveWalletKey(privHex, 0);
        const { escrow, signed } = submittedFor(wallet, (ref) => signedReceipt(ref, agentDid));
        const { deps, keyRow } = setup({ chatSettleMode: "full", privHex, escrows: [escrow], record: activeRecord() });
        keepReceipt(deps.store, keyRow.id, escrow.row.utxo_ref, signed.receipt, signed.signature);
        const sessionId = insertOpenSession(deps, keyRow.id, escrow.row.utxo_ref, { state: "invalid", agent_id: AGENT });
        const settle = settleOk();

        await runSweepOnce(deps, settle);
        await runSweepOnce(deps, settle);

        expect(settle.accept).not.toHaveBeenCalled();
        expect(deps.store.getSession(sessionId)!.state).toBe("closed");
        expect(deps.store.listUsage(keyRow.id, 10)).toMatchObject([
          { kind: "chat_session", status: "failed", cost_lovelace: null, failure_reason: "agent_did_mismatch" },
        ]);
      }
    });

    it("does not Accept a Submitted new escrow without a kept receipt", async () => {
      const privHex = genPrivKeyHex();
      const wallet = deriveWalletKey(privHex, 0);
      const { escrow } = submittedFor(wallet, (ref) => signedReceipt(ref, `did:vector:${AGENT}`));
      const { deps } = setup({ chatSettleMode: "full", privHex, escrows: [escrow], record: activeRecord() });
      const settle = settleOk();

      await runSweepOnce(deps, settle);

      expect(settle.accept).not.toHaveBeenCalled();
      expect(settle.refundRevoked).not.toHaveBeenCalled();
    });

    it("asks the supplier for the end result of an invalidated session, then Accepts with its receipt", async () => {
      const privHex = genPrivKeyHex();
      const wallet = deriveWalletKey(privHex, 0);
      const { escrow, signed } = submittedFor(wallet, (ref) => signedReceipt(ref, `did:vector:${AGENT}`));
      const ends: string[] = [];
      const { deps, keyRow } = setup({
        chatSettleMode: "full", privHex, escrows: [escrow], record: activeRecord(),
        fetch: (url, init) => {
          if (!url.endsWith("/v1/chat/end")) return undefined;
          ends.push(new Headers(init?.headers).get("X-Escrow-Ref") ?? "");
          return endAnswer(escrow.row.utxo_ref, signed);
        },
      });
      const sessionId = insertOpenSession(deps, keyRow.id, escrow.row.utxo_ref, { state: "invalid", agent_id: AGENT });
      const settle = settleOk();

      await runSweepOnce(deps, settle);

      expect(ends).toEqual([escrow.row.utxo_ref]);
      expect(settle.accept).toHaveBeenCalledTimes(1);
      expect(deps.store.getSession(sessionId)!.state).toBe("closed");
      expect(deps.store.listUsage(keyRow.id, 10)).toMatchObject([{ status: "completed", cost_lovelace: "200000" }]);
    });

    it("the chat end keeps the receipt, records another agent's receipt as failed, and the sweep refuses its Accept", async () => {
      for (const [agentDid, accepted] of [[`did:vector:${OTHER_AGENT}`, false], [`did:vector:${AGENT}`, true]] as const) {
        const privHex = genPrivKeyHex();
        const wallet = deriveWalletKey(privHex, 0);
        const { escrow, signed } = submittedFor(wallet, (ref) => signedReceipt(ref, agentDid));
        const { deps, keyRow } = setup({
          chatSettleMode: "full", privHex, escrows: [escrow], record: activeRecord(),
          fetch: (url) => (url.endsWith("/v1/chat/end") ? endAnswer(escrow.row.utxo_ref, signed) : undefined),
        });
        // An idle managed demo session: the sweep's janitor ends it first.
        const sessionId = insertOpenSession(deps, keyRow.id, escrow.row.utxo_ref, { managed_demo: 1, agent_id: AGENT });
        const settle = settleOk();

        await runSweepOnce(deps, settle);

        expect(deps.store.getSession(sessionId)!.state).toBe("closed");
        expect(deps.store.getEscrowReceipt(receiptResultHash(signed))).toMatchObject({ escrow_ref: escrow.row.utxo_ref });
        expect(deps.store.listUsage(keyRow.id, 10)).toMatchObject([accepted
          ? { kind: "chat_session", status: "completed", cost_lovelace: "200000", failure_reason: null }
          : { kind: "chat_session", status: "failed", cost_lovelace: null, failure_reason: "agent_did_mismatch" }]);
        expect(settle.accept).toHaveBeenCalledTimes(accepted ? 1 : 0);
      }
    });

    it("keeps the legacy Accept without a kept receipt, and refuses a kept legacy receipt with agent_did", async () => {
      for (const kept of [false, true]) {
        const privHex = genPrivKeyHex();
        const wallet = deriveWalletKey(privHex, 0);
        const txHash = randomBytes(32).toString("hex");
        const signed = signedReceipt(`${txHash}#0`, `did:vector:${AGENT}`);
        const { agent_id: _agent, refund: _refund, ...legacy } = escrowDatum(wallet, {
          state: "Submitted", submitted_at: Date.now() - 2 * 60 * 1000, result_receipt_hash: receiptResultHash(signed),
        });
        const datum: EscrowDatum = legacy;
        const escrow = escrowAtRef(txHash, wallet, escrowDatum(wallet));
        escrow.row = { ...escrow.row, state: "Submitted", layout: "legacy", agent_id: null, refund: null };
        escrow.utxo = { ...escrow.utxo, address: "addr_test1_legacy_escrow", datumHex: encodeEscrowDatum(datum) };
        const { deps, keyRow } = setup({ chatSettleMode: "full", privHex, escrows: [escrow], record: activeRecord() });
        if (kept) keepReceipt(deps.store, keyRow.id, escrow.row.utxo_ref, signed.receipt, signed.signature);
        const settle = settleOk();

        await runSweepOnce(deps, settle);

        expect(settle.accept).toHaveBeenCalledTimes(kept ? 0 : 1);
      }
    });
  });
});
