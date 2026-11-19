/**
 * Build-level check of the wallet consolidation: real lucid builds the
 * transaction of a wallet above the input limit, and the result keeps to the
 * two limits of Vector that stopped the supplier wallets on 2026-11-19 (size
 * and fee). Only the Ogmios HTTP endpoint is faked.
 */
import { describe, it, expect, vi } from "vitest";
import { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import { inspectSignedTransactionFinancials } from "../server.js";
import type { WalletKey } from "../types.js";
import { buildConsolidateWalletTx } from "./consolidateWallet.js";
import {
  DEFAULT_COLLATERAL_LOVELACE,
  DEFAULT_FEE_RESERVE,
  MAX_CONSOLIDATE_INPUTS,
} from "./planConsolidate.js";

// Deterministic test key: priv = sha256("buyer-test-seed-m1b"), with its address on the main network.
const WALLET: WalletKey = {
  privateKeyHex: "90787d55b2be1ea57e633d5cc85b1dad2e49603bdbc24e40d0928fca8e92f424",
  pubKeyHex: "6e2902cf80ab89e44701470ce41c044a9bbffe3d8af15af2009cc9c6c805271a",
  pubKeyHash: "f79cd20a58306c2277cfced6924befbd0f68c95e2187830d707b20b5",
  address: "addr1v8mee5s2tqcxcgnhel8ddyjta77s76xftcsc0qcdwpajpdgf9eguk",
};

// Vector mainnet (Ogmios protocol parameters, 2026-11-19). Lucid builds with the Cardano values, which are lower.
const VECTOR_MAX_TX_BYTES = 16_384;
const VECTOR_FEE_PER_BYTE = 45n;
const VECTOR_FEE_CONSTANT = 156_253n;

// The wallet of the Qwen juror supplier on 2026-11-19: two UTxOs below the collateral value and 453 payouts.
const WALLET_LOVELACE = [4_718_055, 4_498_372, ...Array.from({ length: 453 }, () => 2_000_000)];

function fakeChain(): LiveOgmiosProvider {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    let result: unknown = {};
    if (body.method === "queryLedgerState/utxo") {
      result = WALLET_LOVELACE.map((lovelace, i) => ({
        transaction: { id: i.toString(16).padStart(64, "0") }, index: 0, address: WALLET.address,
        value: { ada: { lovelace } }, datum: null, datumHash: null, script: null,
      }));
    } else if (body.method === "submitTransaction") {
      result = { transaction: { id: "9".repeat(64) } };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", result }) };
  });
  return new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: fetch as unknown as typeof globalThis.fetch });
}

describe("wallet consolidation above the input limit", () => {
  it("builds a transaction that Vector accepts and leaves the other UTxOs", async () => {
    const built = await buildConsolidateWalletTx({ chain: fakeChain(), walletKey: WALLET });

    const tx = inspectSignedTransactionFinancials(built.txCborHex);
    const bytes = built.txCborHex.length / 2;
    const spent = 4_718_055n + 4_498_372n + BigInt(MAX_CONSOLIDATE_INPUTS - 2) * 2_000_000n;
    expect(tx.inputs).toHaveLength(MAX_CONSOLIDATE_INPUTS);
    expect(built.remainingUtxos).toBe(WALLET_LOVELACE.length - MAX_CONSOLIDATE_INPUTS);
    expect(bytes).toBeLessThanOrEqual(VECTOR_MAX_TX_BYTES);
    expect(tx.feeLovelace).toBeGreaterThanOrEqual(VECTOR_FEE_PER_BYTE * BigInt(bytes) + VECTOR_FEE_CONSTANT);
    expect(tx.outputs.slice(0, 2).map((output) => output.lovelace)).toEqual([
      DEFAULT_COLLATERAL_LOVELACE,
      spent - DEFAULT_COLLATERAL_LOVELACE - DEFAULT_FEE_RESERVE,
    ]);
    expect(tx.outputs.every((output) => output.address === WALLET.address)).toBe(true);
  });
});
