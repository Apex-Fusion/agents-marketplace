import { afterEach, describe, expect, it, vi } from "vitest";
import { CML, SLOT_CONFIG_NETWORK } from "@lucid-evolution/lucid";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { buildReclaimTx } from "../../packages/shared/src/tx/escrow/reclaim.js";
import { inspectSignedTransactionFinancials } from "../../packages/shared/src/tx/internal/signedTransaction.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildOpenEscrowUtxo } from "../fixtures/buyer-side/sample-escrow-utxos.js";

const DEADLINE = Date.UTC(2026, 8, 15, 12, 0, 0, 500);
const ESCROW_HASH = "f".repeat(64);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("live Reclaim validity", () => {
  it.each([0, 120_000])("does not admit a slot before deliver_by at deadline + %i ms", async (elapsed) => {
    const now = DEADLINE + elapsed;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubEnv("ESCROW_REF_UTXO", "");
    const buyer = buildBuyerWalletKey();
    const original = buildOpenEscrowUtxo();
    const datum = {
      ...decodeEscrowDatum(original.datumHex!),
      posted_at: DEADLINE - 60_000,
      deliver_by: DEADLINE,
    };
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      let result: unknown;
      switch (request.method) {
        case "queryNetwork/tip":
          result = { slot: Math.floor(now / 1000), id: "a".repeat(64) };
          break;
        case "queryLedgerState/utxo":
          result = request.params?.outputReferences
            ? [{
              transaction: { id: ESCROW_HASH }, index: 0, address: original.address,
              value: { ada: { lovelace: Number(original.lovelace) } },
              datum: encodeEscrowDatum(datum), datumHash: null, script: null,
            }]
            : [{
              transaction: { id: "c".repeat(64) }, index: 0, address: buyer.address,
              value: { ada: { lovelace: 100_000_000 } }, datum: null, datumHash: null, script: null,
            }];
          break;
        case "evaluateTransaction": {
          const signed = inspectSignedTransactionFinancials(request.params.transaction.cbor);
          const index = signed.inputs.findIndex((input) => input.txHash === ESCROW_HASH);
          result = [{ validator: { purpose: "spend", index }, budget: { memory: 1_000_000, cpu: 500_000_000 } }];
          break;
        }
        case "submitTransaction":
          result = { transaction: { id: "d".repeat(64) } };
          break;
        default:
          throw new Error(`Unexpected RPC method: ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", result }), {
        headers: { "content-type": "application/json" },
      });
    });
    const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios.invalid", fetch: fetchFn });
    const built = await buildReclaimTx({ chain, buyerKey: buyer, escrowRef: { txHash: ESCROW_HASH, index: 0 } });
    const tx = CML.Transaction.from_cbor_hex(built.txCborHex);
    const body = tx.body();
    try {
      // Decode the signed interval against the actual Vector slot origin.
      // The half-slot deadline also catches a clamp which rounds down.
      const { zeroTime, zeroSlot, slotLength } = SLOT_CONFIG_NETWORK.Mainnet;
      const startMs = zeroTime + (Number(body.validity_interval_start()) - zeroSlot) * slotLength;
      const endMs = zeroTime + (Number(body.ttl()) - zeroSlot) * slotLength;
      expect(startMs).toBeGreaterThanOrEqual(DEADLINE);
      expect(startMs).toBeLessThanOrEqual(now + 1000);
      expect(endMs).toBeGreaterThan(startMs);
      expect(endMs).toBeGreaterThan(now);
    } finally {
      body.free();
      tx.free();
    }
  });
});
