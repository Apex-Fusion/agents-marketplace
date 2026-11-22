/**
 * withdraw-insufficient.test.ts — POST /account/withdraw for an amount that the wallet cannot cover.
 *
 * Money path: a withdrawal moves AP3X out of a custodial wallet, and the builder keeps DEFAULT_FEE_RESERVE in the wallet. So the most
 * that a withdrawal sends is the balance minus the reserve. A larger amount, or a wallet with nothing to spare, must send nothing.
 * The accepted control sends exactly that most. The real builder runs through the route; only Ogmios is fake.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import { DEFAULT_FEE_RESERVE, inspectSignedTransaction, inspectSignedTransactionFinancials } from "@marketplace/shared/tx/server";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import { seal } from "../src/crypto/seal.js";
import { hashApiKey } from "../src/middleware/apiKeyAuth.js";
import { deriveWalletKey, genPrivKeyHex } from "../src/wallet.js";
import type { GatewayDeps } from "../src/deps.js";
import { AP3X, FakeOgmios, outputOf } from "../../tests/fixtures/identity-builders/world.js";

const MASTER = "ab".repeat(32);
/** The builder reads the wallet at its mainnet address, so the gateway of this test runs on mainnet too. */
const NETWORK_ID = 1;
/** An address of the main network (the enterprise address of the RFC 8032 test key 2). */
const RECIPIENT = "addr1vxtha7e44d3p6wwmade8fmrhjk35wz8lf5j6qxsa7pxp7fcau533v";

const FUNDING = [100n * AP3X, 50n * AP3X];
const BALANCE = 150n * AP3X;
const SPENDABLE = BALANCE - DEFAULT_FEE_RESERVE;

/** The fake Ogmios, with one change: it confirms the transaction that it receives, so that the route finds the transaction on chain. */
function confirming(fake: FakeOgmios): typeof globalThis.fetch {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: { method: string; params?: { transaction?: { cbor?: string } } } = JSON.parse(String(init?.body));
    const cbor = call.params?.transaction?.cbor;
    if (call.method !== "submitTransaction" || cbor === undefined) return fake.fetch(url, init);
    const { txHash } = inspectSignedTransaction(cbor);
    fake.submitted.push(cbor);
    inspectSignedTransactionFinancials(cbor).outputs.forEach((_output, index) => fake.add(outputOf(cbor, txHash, index)));
    return new Response(JSON.stringify({ jsonrpc: "2.0", result: { transaction: { id: txHash } } }), {
      headers: { "content-type": "application/json" },
    });
  };
}

interface World {
  fake: FakeOgmios;
  /** POST /account/withdraw to RECIPIENT with the key of a custodial wallet that holds the UTxOs `funding`. */
  withdraw: (body: Record<string, unknown>) => Promise<request.Response>;
}

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function makeWorld(funding: bigint[]): World {
  const fake = new FakeOgmios();
  const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios.invalid", fetch: confirming(fake) });
  const dbDir = join(tmpdir(), `gw-withdraw-insufficient-${randomUUID()}`);
  const store = new GatewayStore(dbDir);
  const config = {
    ...loadConfig({
      GATEWAY_MASTER_KEY: MASTER,
      INDEXER_URL: "http://indexer.invalid",
      OGMIOS_URL: "http://ogmios.invalid",
      LIVE_CHAIN: "1",
      NETWORK_ID: String(NETWORK_ID),
    }),
    dbDir,
  };
  const registry = new SdkRegistry({
    chain, store, indexerUrl: config.indexerUrl, networkId: config.networkId, masterKeyHex: config.masterKeyHex, max: config.sdkRegistryMax,
  });
  const fetchFn: typeof globalThis.fetch = async () => new Response("[]", { status: 200 });
  const deps: GatewayDeps = { config, store, chain, registry, fetchFn };
  const app = createApp(deps);

  // A custodial wallet with its API key, as POST /signup makes them.
  const apiKey = `vk_live_${randomUUID().replaceAll("-", "")}`;
  const privateKey = genPrivKeyHex();
  const wallet = deriveWalletKey(privateKey, NETWORK_ID);
  const sealed = seal(privateKey, MASTER);
  store.insertKey({
    id: randomUUID(),
    key_hash: hashApiKey(apiKey),
    key_prefix: apiKey.slice(0, 12),
    label: "withdraw insufficient test",
    wallet_pkh: wallet.pubKeyHash,
    deposit_address: wallet.address,
    enc_priv_nonce: sealed.nonce,
    enc_priv_ct: sealed.ct,
    enc_priv_tag: sealed.tag,
    master_key_version: 1,
    created_at: Date.now(),
  });
  fake.fund(wallet, ...funding);

  closers.push(() => {
    store["db"].close();
    rmSync(dbDir, { recursive: true, force: true });
  });
  return {
    fake,
    withdraw: (body) => request(app).post("/account/withdraw").set("authorization", `Bearer ${apiKey}`).send({ to_address: RECIPIENT, ...body }),
  };
}

describe("POST /account/withdraw", () => {
  it("builds, submits and answers 200 for the most that the wallet can spare (the accepted control)", async () => {
    const world = makeWorld(FUNDING);
    const response = await world.withdraw({ amount_lovelace: SPENDABLE.toString() });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "submitted",
      tx_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      amount_lovelace: SPENDABLE.toString(),
      to_address: RECIPIENT,
    });
    expect(world.fake.submitted).toHaveLength(1);
    expect(inspectSignedTransactionFinancials(world.fake.submitted[0]!).outputs).toContainEqual({ address: RECIPIENT, lovelace: SPENDABLE });
  });

  // Today's answer: 502 escrow_failed. It looks wrong: an amount that the wallet cannot cover is a client error, and a withdrawal has no escrow.
  const REFUSED: Array<[string, bigint[], Record<string, unknown>, string]> = [
    ["one lovelace above the most that the wallet can spare", FUNDING, { amount_lovelace: (SPENDABLE + 1n).toString() }, "withdraw_insufficient"],
    ["an amount above the whole balance", FUNDING, { amount_lovelace: (BALANCE + AP3X).toString() }, "withdraw_insufficient"],
    ["no amount, a wallet with no output", [], {}, "withdraw_amount_invalid"],
    ["no amount, a wallet below the fee reserve", [AP3X], {}, "withdraw_amount_invalid"],
    ["no amount, a wallet with exactly the fee reserve", [DEFAULT_FEE_RESERVE], {}, "withdraw_amount_invalid"],
  ];

  it.each(REFUSED)("%s: answers 502 escrow_failed and submits nothing", async (_name, funding, body, reason) => {
    const world = makeWorld(funding);
    const response = await world.withdraw(body);
    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: { message: `escrow build failed: ${reason}`, type: "server_error", code: "escrow_failed", param: null },
    });
    expect(world.fake.submitted).toHaveLength(0);
  });
});
