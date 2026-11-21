/**
 * The advert of the legacy-layout builder tests (tests/unit/tx-*-advert, tx-post-*escrow*): the Active advert datum
 * and the advert UTxO on a MockChainProvider. A test changes a field with `overrides`.
 */
import type { AdvertDatum } from "../../../packages/shared/src/cbor/types.js";
import { encodeAdvertDatum } from "../../../packages/shared/src/cbor/AdvertDatum.js";
import type { OutputReference, Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import type { MockChainProvider } from "../../../packages/shared/src/chain/MockChainProvider.js";
import { buildSupplierWalletKey } from "../supplier-side/wallet-keys.js";

/** The testnet address of the advert script. */
export const ADVERT_SCRIPT_ADDRESS = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";

/** `advertised_at` of the default advert (POSIX ms). The mock chain reads slot x 1000 as the time, so slot 1_745_500_000 is this time. */
export const ADVERT_NOW_MS = 1_745_500_000_000;

/** An Active advert of the test supplier: price 2 ADA, both bonds 1 ADA, 60 s of processing. */
export function activeAdvertDatum(overrides: Partial<AdvertDatum> = {}): AdvertDatum {
  return {
    supplier_pkh: buildSupplierWalletKey().pubKeyHash,
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com/v1",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: ADVERT_NOW_MS,
    status: "Active",
    ...overrides,
  };
}

/** Puts the advert UTxO (inline datum, `lovelace` locked) on the mock chain. */
export function seedAdvertUtxo(
  chain: MockChainProvider,
  datum: AdvertDatum,
  ref: OutputReference = { txHash: "a".repeat(64), index: 0 },
  lovelace = 2_000_000n,
): Utxo {
  const utxo: Utxo = { ref, address: ADVERT_SCRIPT_ADDRESS, lovelace, assets: {}, datumHex: encodeAdvertDatum(datum), scriptRef: null };
  chain.seed(utxo);
  return utxo;
}
