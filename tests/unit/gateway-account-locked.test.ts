/**
 * gateway-account-locked.test.ts — /account locked_in_escrow_lovelace accuracy.
 *
 * The indexer never updates escrow rows on terminal spends (Accept/Reclaim/
 * Release consume the UTxO without producing a new escrow output), so rows
 * can sit in an "active" state long after the funds moved. The account
 * handler must verify each active row's UTxO is still unspent on-chain
 * before counting it as locked; a spent ref is a stale row, not locked funds.
 *
 * Note: supplier_bond stays in the sum on purpose — the buyer fronts
 * payment + buyer_bond + supplier_bond at PostEscrow (see postEscrow.ts
 * totalLocked), so all three legs are the key's money while the escrow lives.
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { makeAccountHandler } from "../../gateway/src/account/routes.js";

const LIVE_REF = "a".repeat(64) + "#0";
const STALE_REF = "b".repeat(64) + "#1";

function escrowRow(utxoRef: string, state: string) {
  return {
    utxo_ref: utxoRef,
    state,
    payment_lovelace: "2000000",
    buyer_bond_lovelace: "1000000",
    supplier_bond_lovelace: "1000000",
  };
}

function fakeKeyRow() {
  return {
    id: "key-1",
    key_hash: "h",
    key_prefix: "vk_live_abc",
    label: null,
    wallet_pkh: "c".repeat(56),
    deposit_address: "addr1_deposit",
    enc_priv_nonce: "",
    enc_priv_ct: "",
    enc_priv_tag: "",
    master_key_version: 1,
    created_at: 0,
    disabled: 0,
    demo: 0,
  };
}

function makeDeps(rows: Array<Record<string, unknown>>, opts?: { queryUtxo?: (ref: { txHash: string; index: number }) => Promise<unknown> }) {
  const queryUtxo =
    opts?.queryUtxo ??
    (async (ref: { txHash: string; index: number }) => {
      const canonical = `${ref.txHash}#${ref.index}`;
      return canonical === LIVE_REF ? { ref, lovelace: 4_000_000n } : null;
    });
  return {
    config: { indexerUrl: "http://indexer.test", networkId: 1, masterKeyHex: "00" },
    store: {
      sumCostLovelace: () => 0n,
      countUsage: () => 0,
      listUsage: () => [],
    },
    chain: {
      queryUtxosByAddress: async () => [],
      queryUtxo: vi.fn(queryUtxo),
    },
    registry: {},
    fetchFn: vi.fn(async () => ({
      ok: true,
      json: async () => rows,
    })),
  } as never;
}

/**
 * asyncHandler returns a fire-and-forget (req, res) => void wrapper, so the
 * test must await the res.json() call itself, not the handler invocation.
 * Errors also surface through json() (sendError maps them to a JSON body).
 */
async function callAccount(deps: never): Promise<Record<string, never>> {
  const handler = makeAccountHandler(deps);
  const req = { gatewayKey: fakeKeyRow() } as unknown as Request;
  const body = await new Promise<unknown>((resolveBody, rejectBody) => {
    const timer = setTimeout(() => rejectBody(new Error("handler never responded")), 2_000);
    const res = {
      status: (_code: number) => res,
      json: (b: unknown) => {
        clearTimeout(timer);
        resolveBody(b);
        return res;
      },
    } as unknown as Response;
    handler(req, res);
  });
  if ((body as { error?: unknown }).error) {
    throw new Error(`handler returned error body: ${JSON.stringify(body)}`);
  }
  return body as Record<string, never>;
}

describe("GET /account — locked_in_escrow_lovelace", () => {
  it("counts payment + both bonds for an active escrow whose UTxO is live", async () => {
    const body = await callAccount(makeDeps([escrowRow(LIVE_REF, "Open")]));
    expect(body.balance.locked_in_escrow_lovelace).toBe("4000000");
  });

  it("excludes an active-state row whose UTxO is terminally spent (stale indexer row)", async () => {
    const body = await callAccount(
      makeDeps([escrowRow(LIVE_REF, "Open"), escrowRow(STALE_REF, "Submitted")]),
    );
    // Only the live escrow counts: 4_000_000, not 8_000_000.
    expect(body.balance.locked_in_escrow_lovelace).toBe("4000000");
  });

  it("skips terminal-state rows without a chain lookup", async () => {
    const deps = makeDeps([escrowRow(LIVE_REF, "Accepted"), escrowRow(STALE_REF, "Reclaimed")]);
    const body = await callAccount(deps);
    expect(body.balance.locked_in_escrow_lovelace).toBe("0");
    expect((deps as { chain: { queryUtxo: ReturnType<typeof vi.fn> } }).chain.queryUtxo).not.toHaveBeenCalled();
  });

  it("counts a row conservatively when the chain lookup fails (best-effort)", async () => {
    const deps = makeDeps([escrowRow(LIVE_REF, "Open")], {
      queryUtxo: async () => {
        throw new Error("ogmios unreachable");
      },
    });
    const body = await callAccount(deps);
    expect(body.balance.locked_in_escrow_lovelace).toBe("4000000");
  });
});
