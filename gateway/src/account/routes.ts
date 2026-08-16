/**
 * gateway/src/account/routes.ts — signup, account, withdraw.
 *
 *   POST /signup            → mint a custodial wallet + API key (key shown once)
 *   GET  /account           → balance, collateral readiness, spend, recent usage
 *   POST /account/withdraw  → move unspent AP3X out to an external address (exit)
 */

import { randomBytes, randomUUID } from "crypto";
import type { Request, Response } from "express";
import { buildWithdrawTx } from "@marketplace/shared/tx/server";
import type { GatewayDeps } from "../deps.js";
import { genPrivKeyHex, deriveWalletKey } from "../wallet.js";
import { seal } from "../crypto/seal.js";
import { hashApiKey, requireKey } from "../middleware/apiKeyAuth.js";
import { asyncHandler } from "../middleware/http.js";
import { totalLovelace, hasCollateral } from "../onchain/preflight.js";
import { badRequest, forbidden } from "../openai/errors.js";

const ACTIVE_ESCROW_STATES = new Set(["Open", "Claimed", "Submitted"]);

/** Bound on per-request escrow liveness lookups; rows past the cap count as
 * locked unverified (a key with this many active escrows has bigger problems). */
const LIVENESS_CHECK_CAP = 32;

/** True when the escrow UTxO behind an indexer row is still unspent. The
 * indexer never updates rows on terminal spends (Accept/Reclaim/Release
 * consume the escrow without a new escrow output), so "active" rows can be
 * long spent. Unparseable refs and failed lookups count as live so errors
 * inflate the locked figure rather than hide funds. */
async function escrowUtxoIsLive(deps: GatewayDeps, utxoRef: string): Promise<boolean> {
  const m = /^([0-9a-fA-F]{64})#(\d+)$/.exec(utxoRef);
  if (!m) return true;
  try {
    const utxo = await deps.chain.queryUtxo({ txHash: m[1], index: Number(m[2]) });
    return utxo !== null;
  } catch {
    return true;
  }
}

function ap3x(lovelace: bigint): string {
  return (Number(lovelace) / 1e6).toFixed(2);
}

// ─── signup ──────────────────────────────────────────────────────────────────

export function makeSignupHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = typeof body.label === "string" ? body.label.slice(0, 120) : null;

    const privHex = genPrivKeyHex();
    const walletKey = deriveWalletKey(privHex, deps.config.networkId);
    const sealed = seal(privHex, deps.config.masterKeyHex);

    const rawKey = `vk_${deps.config.networkId === 1 ? "live" : "test"}_${randomBytes(24).toString("hex")}`;
    const keyPrefix = rawKey.slice(0, 12);

    deps.store.insertKey({
      id: randomUUID(),
      key_hash: hashApiKey(rawKey),
      key_prefix: keyPrefix,
      label,
      wallet_pkh: walletKey.pubKeyHash,
      deposit_address: walletKey.address,
      enc_priv_nonce: sealed.nonce,
      enc_priv_ct: sealed.ct,
      enc_priv_tag: sealed.tag,
      master_key_version: 1,
      created_at: Date.now(),
    });

    res.status(201).json({
      api_key: rawKey,
      key_prefix: keyPrefix,
      deposit_address: walletKey.address,
      note: "Save api_key now — it is shown only once. Fund deposit_address with AP3X to use the gateway.",
    });
  });
}

// ─── account ─────────────────────────────────────────────────────────────────

export function makeAccountHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    const utxos = await deps.chain.queryUtxosByAddress(keyRow.deposit_address);
    const available = totalLovelace(utxos);

    let lockedInEscrow = 0n;
    try {
      const r = await deps.fetchFn(`${deps.config.indexerUrl}/escrows?buyer=${keyRow.wallet_pkh}`);
      if (r.ok) {
        const rows = (await r.json()) as Array<Record<string, unknown>>;
        if (Array.isArray(rows)) {
          const active = rows.filter((row) => ACTIVE_ESCROW_STATES.has(String(row.state)));
          const liveness = await Promise.all(
            active.map((row, i) =>
              i < LIVENESS_CHECK_CAP ? escrowUtxoIsLive(deps, String(row.utxo_ref ?? "")) : Promise.resolve(true),
            ),
          );
          for (let i = 0; i < active.length; i++) {
            if (!liveness[i]) continue;
            const row = active[i];
            lockedInEscrow +=
              BigInt(String(row.payment_lovelace ?? "0")) +
              BigInt(String(row.buyer_bond_lovelace ?? "0")) +
              BigInt(String(row.supplier_bond_lovelace ?? "0"));
          }
        }
      }
    } catch {
      /* best-effort; report 0 locked on indexer hiccup */
    }

    res.status(200).json({
      key_prefix: keyRow.key_prefix,
      // The shared demo key's wallet is operator-funded; hiding the deposit
      // address keeps strangers from confusing it with their own wallet.
      deposit_address: keyRow.demo ? null : keyRow.deposit_address,
      ...(keyRow.demo ? { demo: true } : {}),
      balance: {
        available_lovelace: available.toString(),
        locked_in_escrow_lovelace: lockedInEscrow.toString(),
        ap3x: ap3x(available),
      },
      collateral_ok: hasCollateral(utxos),
      spend: {
        total_cost_lovelace: deps.store.sumCostLovelace(keyRow.id).toString(),
        request_count: deps.store.countUsage(keyRow.id),
      },
      recent_usage: deps.store.listUsage(keyRow.id, 20).map((u) => ({
        created_at: u.created_at,
        kind: u.kind,
        model: u.model,
        status: u.status,
        cost_lovelace: u.cost_lovelace,
        escrow_ref: u.escrow_ref,
        failure_reason: u.failure_reason,
      })),
    });
  });
}

// ─── withdraw ────────────────────────────────────────────────────────────────

export function makeWithdrawHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    if (keyRow.demo) {
      // The demo key is shared publicly; without this, anyone holding it
      // could drain the operator-funded wallet to their own address.
      throw forbidden("demo_key_restricted", "withdrawals are disabled for the shared demo key");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const toAddress = body.to_address;
    if (typeof toAddress !== "string" || !/^addr(_test)?1[0-9a-z]+$/.test(toAddress)) {
      throw badRequest("invalid_address", "`to_address` must be a bech32 Cardano address");
    }

    let amountLovelace: bigint | undefined;
    if (body.amount_lovelace !== undefined && body.amount_lovelace !== null) {
      try {
        amountLovelace = BigInt(String(body.amount_lovelace));
      } catch {
        throw badRequest("invalid_amount", "`amount_lovelace` must be an integer (string or number)");
      }
      if (amountLovelace <= 0n) throw badRequest("invalid_amount", "`amount_lovelace` must be positive");
    }

    const ctx = deps.registry.getContext(keyRow);
    await ctx.mutex.run(async () => {
      const built = await buildWithdrawTx({
        chain: deps.chain,
        walletKey: ctx.walletKey,
        toAddress,
        amountLovelace,
      });
      await deps.chain.awaitTx(built.expectedTxHash, 120_000);
      res.status(200).json({
        status: "submitted",
        tx_hash: built.expectedTxHash,
        amount_lovelace: built.amountLovelace.toString(),
        to_address: built.toAddress,
      });
    });
  });
}
