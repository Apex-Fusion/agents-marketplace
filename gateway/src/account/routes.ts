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
import { badRequest } from "../openai/errors.js";

const ACTIVE_ESCROW_STATES = new Set(["Open", "Claimed", "Submitted"]);

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
          for (const row of rows) {
            if (!ACTIVE_ESCROW_STATES.has(String(row.state))) continue;
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
      deposit_address: keyRow.deposit_address,
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
