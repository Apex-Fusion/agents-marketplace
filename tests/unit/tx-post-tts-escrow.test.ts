/**
 * tx-post-tts-escrow.test.ts — coverage for precomputed prompt commitments in
 * the TTS escrow builder.
 */

import { describe, it, expect } from "vitest";

import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { decodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { buildPostTtsEscrowTx } from "../../packages/shared/src/tx/escrow/postTtsEscrow.js";
import type { TtsRequest } from "../../packages/shared/src/tx/escrow/postTtsEscrow.js";
import type { AdvertDatum } from "../../packages/shared/src/cbor/types.js";
import type { Utxo, OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const ADVERT_SCRIPT_ADDRESS = "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";
const ADVERT_REF: OutputReference = { txHash: "d".repeat(64), index: 0 };
const PRICE = 200_000n;

function validRequest(): TtsRequest {
  return { text: "Hello world.", voice: "nova", format: "mp3", speed: 1 };
}

function makeTtsAdvert(): AdvertDatum {
  return {
    supplier_pkh: buildSupplierWalletKey().pubKeyHash,
    capability_id: "audio.synthesize.piper.v1",
    model: "piper",
    max_output_tokens: 4096,
    max_processing_ms: 60_000,
    price_lovelace: PRICE,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example.com/v1",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "Active",
  };
}

function seedTtsAdvert(chain: MockChainProvider): void {
  const utxo: Utxo = {
    ref: ADVERT_REF,
    address: ADVERT_SCRIPT_ADDRESS,
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(makeTtsAdvert()),
    scriptRef: null,
  };
  chain.seed(utxo);
}

describe("buildPostTtsEscrowTx — precomputed prompt_hash", () => {
  it("stores a precomputed hash in lowercase without requiring request", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(1_745_500_000);
    seedTtsAdvert(chain);

    const result = await buildPostTtsEscrowTx({
      chain,
      buyerKey: buildBuyerWalletKey(),
      advertRef: ADVERT_REF,
      prompt_hash: "EF".repeat(32),
      payment_lovelace: PRICE,
    });
    const escrowUtxo = await chain.queryUtxo(result.escrowOutputRef);
    const datum = decodeEscrowDatum(escrowUtxo!.datumHex!);

    expect(datum.prompt_hash).toBe("ef".repeat(32));
  });

  it("rejects when neither request nor prompt_hash is provided", async () => {
    await expect(buildPostTtsEscrowTx({
      chain: new MockChainProvider(),
      buyerKey: buildBuyerWalletKey(),
      advertRef: ADVERT_REF,
      payment_lovelace: PRICE,
    })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "request required",
    });
  });

  it("rejects when both request and prompt_hash are provided", async () => {
    await expect(buildPostTtsEscrowTx({
      chain: new MockChainProvider(),
      buyerKey: buildBuyerWalletKey(),
      advertRef: ADVERT_REF,
      request: validRequest(),
      prompt_hash: "ef".repeat(32),
      payment_lovelace: PRICE,
    })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "ambiguous prompt commitment",
    });
  });

  it("rejects a malformed prompt_hash", async () => {
    await expect(buildPostTtsEscrowTx({
      chain: new MockChainProvider(),
      buyerKey: buildBuyerWalletKey(),
      advertRef: ADVERT_REF,
      prompt_hash: "not-32-byte-hex",
      payment_lovelace: PRICE,
    })).rejects.toMatchObject({
      name: "TxConstructionError",
      reason: "prompt_hash malformed",
    });
  });
});
