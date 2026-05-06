/**
 * Diagnostic: test Submit with small timestamps to isolate large-int issue
 */
import { describe, it, expect, vi } from "vitest";
import { buildSupplierWalletKey } from "../../tests/fixtures/supplier-side/wallet-keys.js";
import { buildBuyerWalletKey } from "../../tests/fixtures/buyer-side/wallet-keys.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { buildSubmitTx } from "../../packages/shared/src/tx/escrow/submit.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../packages/shared/src/cbor/types.js";
import { SUPPLIER_PKH } from "../../tests/fixtures/supplier-side/wallet-keys.js";
import { BUYER_PKH } from "../../tests/fixtures/buyer-side/wallet-keys.js";
import { SLOT_CONFIG_NETWORK } from "../../packages/shared/node_modules/@lucid-evolution/lucid/dist/index.js";

const mockFetch = vi.fn();

function rpcOk<T>(result: T) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) };
}
function makeOgmiosUtxo(txId: string, index: number, address: string, lovelace: number, datumHex?: string) {
  return { transaction: { id: txId }, index, address, value: { ada: { lovelace } }, datum: datumHex ?? null, datumHash: null, script: null };
}
function protocolParamsResponse() {
  return rpcOk({
    minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } },
    maxTransactionSize: { bytes: 16384 }, maxValueSize: { bytes: 5000 },
    stakeCredentialDeposit: { ada: { lovelace: 2000000 } }, stakePoolDeposit: { ada: { lovelace: 500000000 } },
    prices: { memory: "0.0577", steps: "0.0000721" },
    maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
    coinsPerUtxoByte: { ada: { lovelace: 4310 } }, collateralPercentage: 150, maxCollateralInputs: 3,
    plutusCostModels: { "plutus:v1": {}, "plutus:v2": {}, "plutus:v3": {} },
    monetaryExpansion: "0.003", treasuryExpansion: "0.2",
    minStakePoolCost: { ada: { lovelace: 340000000 } },
    minFeeReferenceScripts: { base: 15 },
    governanceActionDeposit: { ada: { lovelace: 100000000000 } },
    delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
  });
}

describe("Diagnostic - small timestamps", () => {
  // Vector zero time = 1_752_057_484_000 ms. We need deliver_by >> VECTOR_ZERO_TIME + current slot
  // Use small deliver_by = VECTOR_ZERO_TIME + 100_000_000 (100_000 slots from genesis)
  // so that validTo slot = positive small number
  const VECTOR_ZERO_TIME = 1_752_057_484_000;
  const SMALL_DELIVER_BY = VECTOR_ZERO_TIME + 100_000_000;  // 100_000 slots from genesis
  const SMALL_TIP_MS = VECTOR_ZERO_TIME + 50_000_000;       // 50_000 slots from genesis, before deliver_by
  
  it("Submit with small timestamps (within 100k slots of genesis)", async () => {
    const slotCfg = SLOT_CONFIG_NETWORK["Mainnet"];
    console.log("Slot config:", JSON.stringify(slotCfg));
    
    const supplier = buildSupplierWalletKey();
    const ESCROW_TX_HASH = "f".repeat(64);
    
    // Create a minimal Claimed datum with small timestamps
    const datum: EscrowDatum = {
      buyer_pkh: BUYER_PKH,
      supplier_pkh: SUPPLIER_PKH,
      advert_ref: { txHash: "b".repeat(64), index: 0 },
      capability_id: "llm.text.generate.v1",
      request_spec_hash: "c".repeat(64),
      prompt_hash: "d".repeat(64),
      payment_lovelace: 2_000_000n,
      buyer_bond_lovelace: 1_000_000n,
      supplier_bond_lovelace: 1_000_000n,
      deliver_by: SMALL_DELIVER_BY,
      posted_at: SMALL_TIP_MS,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Claimed",
    };
    const claimedDatumHex = encodeEscrowDatum(datum);
    
    mockFetch.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(SMALL_TIP_MS);
    
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const method: string = body.method ?? "";
      if (method === "queryLedgerState/protocolParameters") return protocolParamsResponse();
      if (method === "queryLedgerState/utxo") {
        if ((body.params ?? {}).outputReferences) {
          return rpcOk([makeOgmiosUtxo(ESCROW_TX_HASH, 1, "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6", 4_000_000, claimedDatumHex)]);
        }
        return rpcOk([makeOgmiosUtxo("c".repeat(64), 0, supplier.address, 100_000_000)]);
      }
      if (method === "queryNetwork/tip") {
        const tipSlot = Math.floor((SMALL_DELIVER_BY - 30_000) / 1000);
        return rpcOk({ slot: tipSlot, id: "a".repeat(64) });
      }
      if (method === "submitTransaction") return rpcOk({ transaction: { id: "d".repeat(64) } });
      return rpcOk({});
    });
    
    try {
      const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: mockFetch });
      const result = await buildSubmitTx({ chain, supplierKey: supplier, escrowRef: { txHash: ESCROW_TX_HASH, index: 1 }, receiptHash: "a".repeat(64) });
      console.log("SUCCESS: txCborHex length=", result.txCborHex.length, "first bytes=", result.txCborHex.slice(0,4));
    } catch (err) {
      console.error("FAILED:", err instanceof Error ? err.message : String(err));
    } finally {
      vi.useRealTimers();
    }
  });
});
