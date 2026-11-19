/**
 * withdraw-route.test.ts — POST /account/withdraw reads `to_address` and `amount_lovelace` from the request.
 *
 * The route checks `to_address` before it reads the wallet and before it takes the mutex of the key: first a pattern with a length
 * bound, then the shared codec check with the network of the gateway. Four kinds of text:
 *   - a text that the pattern refuses (also a text of 1 MB): 400 `invalid_address` at once, and the builder does not run;
 *   - a text that passes the pattern and is no address (a wrong checksum, a right checksum and the wrong bytes): the same 400, and
 *     the builder does not run;
 *   - a valid address of the other network (`addr_test` for a gateway on the main network, `addr` for one on the test network): the
 *     same 400 with its own message, before the wallet is read;
 *   - a valid address of each kind on the network of the gateway: the transaction builds, goes to the fake Ogmios, and the route
 *     answers 200.
 * A text of 1 MB is answered in under 1,000 ms, and the process serves another request in that time.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { bech32 } from "bech32";
import { CML } from "@lucid-evolution/lucid";
import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import { plutusAddressToBech32, type PlutusAddress, type PlutusCredential } from "@marketplace/shared/cbor";
import {
  buildWithdrawTx,
  DEFAULT_FEE_RESERVE,
  inspectSignedTransaction,
  inspectSignedTransactionFinancials,
} from "@marketplace/shared/tx/server";
import type * as TxServer from "@marketplace/shared/tx/server";
import { createApp } from "../src/server.js";
import { GatewayStore } from "../src/db/store.js";
import { SdkRegistry } from "../src/sdk/registry.js";
import { seal } from "../src/crypto/seal.js";
import { hashApiKey } from "../src/middleware/apiKeyAuth.js";
import { deriveWalletKey, genPrivKeyHex } from "../src/wallet.js";
import type { GatewayConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";
import { AP3X, FakeOgmios, outputOf, testWallet } from "../../tests/fixtures/identity-builders/world.js";

// The real builder runs in every test. The spy only records what the route gives it.
vi.mock("@marketplace/shared/tx/server", async (importOriginal) => {
  const actual = await importOriginal<typeof TxServer>();
  return { ...actual, buildWithdrawTx: vi.fn(actual.buildWithdrawTx) };
});

const MASTER = "ab".repeat(32);
/** The builder reads the wallet at its mainnet address, so the gateway of these tests runs on mainnet too. */
const NETWORK_ID = 1;
const RECIPIENT = testWallet("withdrawal recipient");

/** The library still decodes a known value (Plutus data, constructor 0 with no fields). */
function libraryDecodes(): boolean {
  try {
    CML.PlutusData.from_cbor_hex("d87980").free();
    return true;
  } catch {
    return false;
  }
}

/** The stack pointer of the library. A call into the library that fails can leave it lower. */
function stackPointer(): number {
  const instance: unknown = Reflect.get(CML, "__wasm");
  if (typeof instance !== "object" || instance === null) throw new Error("the library has no instance");
  const move: unknown = Reflect.get(instance, "__wbindgen_add_to_stack_pointer");
  if (typeof move !== "function") throw new Error("the library has no stack pointer");
  const pointer: unknown = Reflect.apply(move, instance, [0]);
  if (typeof pointer !== "number") throw new Error("the stack pointer is not a number");
  return pointer;
}

/** The time in ms that a promise needs, counted from `started`. */
async function elapsedAfter(started: number, promise: Promise<unknown>): Promise<number> {
  await promise;
  return performance.now() - started;
}

/**
 * The fake Ogmios with one change: it confirms the transaction that it receives. It answers a submit with the hash of the
 * transaction, and it then holds the outputs of the transaction, so that the gateway finds the transaction on chain.
 */
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
  app: Express;
  fake: FakeOgmios;
  /** Each request that the chain client of the gateway makes to the fake Ogmios. */
  ogmios: Mock<typeof globalThis.fetch>;
  /** POST /account/withdraw with the key of a custodial wallet that holds 150 AP3X. */
  withdraw: (body: Record<string, unknown>) => Promise<request.Response>;
  close: () => void;
}

const worlds: World[] = [];

function makeWorld(networkId: 0 | 1 = NETWORK_ID): World {
  const fake = new FakeOgmios();
  const ogmios = vi.fn(confirming(fake));
  const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios.invalid", fetch: ogmios });
  const dbDir = join(tmpdir(), `gw-withdraw-${randomUUID()}`);
  const store = new GatewayStore(dbDir);
  const config: GatewayConfig = {
    masterKeyHex: MASTER, indexerUrl: "http://indexer.invalid", ogmiosUrl: "http://ogmios.invalid", networkId,
    liveChain: true, port: 0, dbDir, signupRate: { max: 1000, windowMs: 60_000 },
    keyRate: { max: 1000, windowMs: 60_000 }, demoIpRate: { max: 1000, windowMs: 60_000 },
    sweeperIntervalMs: 60_000, demoSessionIdleMs: 180_000, chatSettleMode: "full",
    walletHealthIntervalMs: 600_000, sdkRegistryMax: 100,
    oneShotConcurrency: 4, oneShotMaxOutstanding: 64, oneShotQueueTimeoutMs: 60_000,
    mcpIpRate: { max: 1000, windowMs: 60_000 }, mcpCallIpRate: { max: 1000, windowMs: 60_000 },
    mcpCallIpConcurrency: 1, mcpCallConcurrency: 2, mcpCallQueueTimeoutMs: 60_000, mcpCatalogTtlMs: 30_000,
    ocrCapabilityId: "ocr.page.extract.chandra-ocr-2.v1", corsOrigins: [], identityPolicyId: null, switchSlot: null,
  };
  const registry = new SdkRegistry({
    chain, store, indexerUrl: config.indexerUrl, networkId: config.networkId, masterKeyHex: config.masterKeyHex, max: config.sdkRegistryMax,
  });
  const fetchFn: typeof globalThis.fetch = async () => new Response("[]", { status: 200 });
  const deps: GatewayDeps = { config, store, chain, registry, fetchFn };
  const app = createApp(deps);

  // A custodial wallet with its API key, as POST /signup makes it. The wallet holds 150 AP3X on the fake Ogmios.
  const apiKey = `vk_live_${randomUUID().replaceAll("-", "")}`;
  const privateKey = genPrivKeyHex();
  const wallet = deriveWalletKey(privateKey, networkId);
  const sealed = seal(privateKey, MASTER);
  store.insertKey({
    id: randomUUID(),
    key_hash: hashApiKey(apiKey),
    key_prefix: apiKey.slice(0, 12),
    label: "withdraw route test",
    wallet_pkh: wallet.pubKeyHash,
    deposit_address: wallet.address,
    enc_priv_nonce: sealed.nonce,
    enc_priv_ct: sealed.ct,
    enc_priv_tag: sealed.tag,
    master_key_version: 1,
    created_at: Date.now(),
    demo: 0,
  });
  fake.fund(wallet, 100n * AP3X, 50n * AP3X);

  const world: World = {
    app,
    fake,
    ogmios,
    withdraw: (body) => request(app).post("/account/withdraw").set("authorization", `Bearer ${apiKey}`).send(body),
    close: () => {
      store["db"].close();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
  worlds.push(world);
  return world;
}

beforeEach(() => {
  vi.mocked(buildWithdrawTx).mockClear();
});

afterEach(() => {
  for (const world of worlds.splice(0)) world.close();
});

/** A bech32 text with the prefix `addr` whose checksum is right and whose bytes are too few for an address. */
const TWO_BYTES = bech32.encode("addr", bech32.toWords(Buffer.from("6100", "hex")), 1023);
/** The address of the recipient with another last letter: the checksum is wrong. */
const WRONG_CHECKSUM = RECIPIENT.address.slice(0, -1) + (RECIPIENT.address.endsWith("q") ? "p" : "q");
/** Well-formed reward addresses of the key of the recipient: the header byte, then the 28 bytes of the key hash. */
const STAKE = bech32.encode("stake", bech32.toWords(Buffer.from(`e1${RECIPIENT.pubKeyHash}`, "hex")), 1023);
const STAKE_TEST = bech32.encode("stake_test", bech32.toWords(Buffer.from(`e0${RECIPIENT.pubKeyHash}`, "hex")), 1023);
/** A text with a right checksum over `header`, the key hash of the recipient, and `extra` more bytes. */
const withBytes = (prefix: string, header: number, extra: number): string =>
  bech32.encode(prefix, bech32.toWords(Buffer.from([header, ...Buffer.from(RECIPIENT.pubKeyHash, "hex"), ...new Array<number>(extra).fill(0x11)])), 1023);

const hashOf = (byte: string): string => byte.repeat(28);
const keyOf = (hex: string): PlutusCredential => ({ type: "VerificationKey", hash: hex });
const scriptOf = (hex: string): PlutusCredential => ({ type: "Script", hash: hex });
const KIND_ADDRESSES: Array<[string, PlutusAddress]> = [
  ["enterprise, key", { paymentCredential: keyOf(hashOf("11")), stakeCredential: null }],
  ["enterprise, script", { paymentCredential: scriptOf(hashOf("11")), stakeCredential: null }],
  ["base, key and key", { paymentCredential: keyOf(hashOf("11")), stakeCredential: { type: "Inline", credential: keyOf(hashOf("22")) } }],
  ["base, script and script", { paymentCredential: scriptOf(hashOf("11")), stakeCredential: { type: "Inline", credential: scriptOf(hashOf("22")) } }],
  ["pointer, key", { paymentCredential: keyOf(hashOf("11")), stakeCredential: { type: "Pointer", slotNumber: 2_498_243n, transactionIndex: 27n, certificateIndex: 3n } }],
];
/** An address of each kind that the route accepts, on the main network. */
const KINDS: Array<[string, string]> = KIND_ADDRESSES.map(([name, address]) => [name, plutusAddressToBech32(address, 1)]);

/** After a refusal by the route: no builder, no request to Ogmios, the library untouched, and the library still decodes. */
function expectNothingReached(world: World, pointerBefore: number): void {
  expect(buildWithdrawTx).not.toHaveBeenCalled();
  expect(world.ogmios).not.toHaveBeenCalled();
  expect(world.fake.submitted).toHaveLength(0);
  expect(stackPointer()).toBe(pointerBefore);
  expect(libraryDecodes()).toBe(true);
}

describe("a to_address that the pattern refuses", () => {
  const REFUSED: Array<[string, unknown]> = [
    ["a missing field", undefined],
    ["null", null],
    ["a number", 42],
    ["a list of texts", [RECIPIENT.address]],
    ["an object", { address: RECIPIENT.address }],
    ["the empty text", ""],
    ["the prefix `addr1` alone", "addr1"],
    ["the prefix `addr_test1` alone", "addr_test1"],
    ["upper case letters", RECIPIENT.address.toUpperCase()],
    ["one capital letter", `${RECIPIENT.address.slice(0, 5)}Q${RECIPIENT.address.slice(6)}`],
    ["a space inside", `${RECIPIENT.address.slice(0, 10)} ${RECIPIENT.address.slice(10)}`],
    ["a space before", ` ${RECIPIENT.address}`],
    ["a line break after", `${RECIPIENT.address}\n`],
    ["a stake address", STAKE],
    ["a test stake address", STAKE_TEST],
    ["a prefix that is not `addr`", RECIPIENT.address.replace(/^addr/, "cosmos")],
    ["a short text", "addr1qqqqqqqq"],
    ["a short test text", "addr_test1qqqqqqqq"],
    ["one letter after the prefix", "addr1q"],
    ["a text with a right checksum and no data", "addr1mykd6t"],
    ["a text with a right checksum and two bytes", TWO_BYTES],
    ["19 characters after the prefix", `addr1${"q".repeat(19)}`],
    ["201 characters after the prefix", `addr1${"q".repeat(201)}`],
    ["a text of 1,000 characters", `addr1${"q".repeat(995)}`],
    ["a text of 100,000 characters", `addr1${"q".repeat(100_000)}`],
  ];

  it.each(REFUSED)("answers 400 invalid_address for %s, and nothing reaches the builder or the library", async (_name, text) => {
    const world = makeWorld();
    const pointerBefore = stackPointer();
    const response = await world.withdraw({ to_address: text, amount_lovelace: "10000000" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ type: "invalid_request_error", code: "invalid_address" });
    expect(response.body.error.message).toBe("`to_address` must be a bech32 Cardano address"); // the pattern refuses it, not the codec
    expectNothingReached(world, pointerBefore);
  });

  it("answers a text of 1 MB in under 1 s, and serves another request in that time", async () => {
    const world = makeWorld();
    const pointerBefore = stackPointer();
    const text = `addr1${"q".repeat(1_000_000)}`;
    const times: Array<{ refusal: number; other: number }> = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      const refusal = world.withdraw({ to_address: text });
      const other = request(world.app).get("/healthz");
      const [refusalTime, otherTime] = await Promise.all([elapsedAfter(started, refusal), elapsedAfter(started, other)]);
      expect((await refusal).status).toBe(400);
      expect((await other).status).toBe(200);
      times.push({ refusal: refusalTime, other: otherTime });
    }
    // A slow machine slows one attempt, not all of them, and the limit has room for a busy test machine.
    expect(Math.min(...times.map((time) => time.refusal))).toBeLessThan(1_000);
    expect(Math.min(...times.map((time) => time.other))).toBeLessThan(1_000);
    expectNothingReached(world, pointerBefore);
  });
});

describe("a to_address that passes the pattern and is no address", () => {
  const NOT_ADDRESSES: Array<[string, string]> = [
    ["20 letters after the prefix", `addr1${"q".repeat(20)}`],
    ["200 letters after the prefix", `addr1${"q".repeat(200)}`],
    ["letters that bech32 does not use", `addr1${"bio".repeat(20)}`],
    ["a valid address with a wrong checksum", WRONG_CHECKSUM],
    ["a right checksum and an enterprise header with one byte too many", withBytes("addr", 0x61, 1)],
    ["a right checksum and a base header with the bytes of an enterprise address", withBytes("addr", 0x01, 0)],
    ["a right checksum and a pointer header with the numbers missing", withBytes("addr", 0x41, 0)],
    ["a right checksum and a reward header under the prefix addr", withBytes("addr", 0xe1, 0)],
    ["a right checksum and a header of the test network under the prefix addr", withBytes("addr", 0x60, 0)],
    ["a right checksum and a header of the main network under the prefix addr_test", withBytes("addr_test", 0x61, 0)],
    ["a right checksum and a network that is neither", withBytes("addr", 0x62, 0)],
  ];

  it.each(NOT_ADDRESSES)("%s: answers 400 invalid_address, and nothing reaches the builder or the library", async (_name, text) => {
    expect(text).toMatch(/^addr(_test)?1[0-9a-z]{20,200}$/); // the pattern lets it pass
    const world = makeWorld();
    const pointerBefore = stackPointer();
    const response = await world.withdraw({ to_address: text, amount_lovelace: "10000000" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ type: "invalid_request_error", code: "invalid_address" });
    expect(response.body.error.message).toBe("`to_address` must be a valid Cardano payment address");
    expectNothingReached(world, pointerBefore);

    // The next withdrawal of the same wallet, to a valid address, builds as before.
    const next = await world.withdraw({ to_address: RECIPIENT.address, amount_lovelace: "10000000" });
    expect(next.status).toBe(200);
    expect(world.fake.submitted).toHaveLength(1);
  });
});

describe("an amount_lovelace that is too long", () => {
  it("answers a text of 1 MB with 400 invalid_amount in under 1 s, before the wallet is read", async () => {
    const world = makeWorld();
    const times: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      const response = await world.withdraw({ to_address: RECIPIENT.address, amount_lovelace: "9".repeat(1_000_000) });
      times.push(performance.now() - started);
      expect(response.status).toBe(400);
      expect(response.body.error).toMatchObject({ code: "invalid_amount" });
    }
    expect(Math.min(...times)).toBeLessThan(1_000);
    expect(buildWithdrawTx).not.toHaveBeenCalled();
    expect(world.ogmios).not.toHaveBeenCalled();
  });

  it("answers a text of 65 characters with 400 invalid_amount, and still reads a text of 20 digits as a number", async () => {
    const world = makeWorld();
    const tooLong = await world.withdraw({ to_address: RECIPIENT.address, amount_lovelace: "1".repeat(65) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatchObject({ code: "invalid_amount" });
    expect(buildWithdrawTx).not.toHaveBeenCalled();
    await world.withdraw({ to_address: RECIPIENT.address, amount_lovelace: "9".repeat(20) });
    expect(buildWithdrawTx).toHaveBeenCalledWith(expect.objectContaining({ amountLovelace: 99_999_999_999_999_999_999n }));
    await world.withdraw({ to_address: RECIPIENT.address, amount_lovelace: "1".padEnd(64, "0") }); // 64 characters: the longest text
    expect(buildWithdrawTx).toHaveBeenCalledWith(expect.objectContaining({ amountLovelace: 10n ** 63n }));
  });
});

describe("a valid to_address", () => {
  it.each(KINDS)("%s: builds the transaction, submits it, and answers 200", async (_name, address) => {
    const world = makeWorld();
    const response = await world.withdraw({ to_address: address, amount_lovelace: 10_000_000 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "submitted",
      tx_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      amount_lovelace: "10000000",
      to_address: address,
    });

    expect(world.fake.submitted).toHaveLength(1);
    const [cbor] = world.fake.submitted;
    expect(inspectSignedTransaction(cbor!).txHash).toBe(response.body.tx_hash);
    expect(inspectSignedTransactionFinancials(cbor!).outputs).toContainEqual({ address, lovelace: 10n * AP3X });
    expect(libraryDecodes()).toBe(true);
  });

  it("withdraws what the wallet can spare when amount_lovelace is missing", async () => {
    const world = makeWorld();
    const response = await world.withdraw({ to_address: RECIPIENT.address });
    expect(response.status).toBe(200);
    expect(response.body.amount_lovelace).toBe((150n * AP3X - DEFAULT_FEE_RESERVE).toString());
    expect(world.fake.submitted).toHaveLength(1);
    expect(libraryDecodes()).toBe(true);
  });

  it("refuses an address of the test network with 400 invalid_address before the wallet is read, when the gateway is on the main network", async () => {
    const world = makeWorld();
    const pointerBefore = stackPointer();
    const address = plutusAddressToBech32({ paymentCredential: keyOf(hashOf("11")), stakeCredential: null }, 0);
    expect(address).toMatch(/^addr_test1/);
    const response = await world.withdraw({ to_address: address, amount_lovelace: "10000000" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ type: "invalid_request_error", code: "invalid_address", message: "`to_address` must be an address of the main network" });
    expectNothingReached(world, pointerBefore);
  });
});

describe("a gateway on the test network", () => {
  it("refuses an address of the main network with 400 invalid_address, and gives an address of the test network to the builder", async () => {
    const world = makeWorld(0);
    const pointerBefore = stackPointer();
    const mainAddress = KINDS[0]![1];
    const refused = await world.withdraw({ to_address: mainAddress, amount_lovelace: "10000000" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "invalid_address", message: "`to_address` must be an address of the test network" });
    expectNothingReached(world, pointerBefore);

    const testAddress = plutusAddressToBech32({ paymentCredential: keyOf(hashOf("11")), stakeCredential: null }, 0);
    const response = await world.withdraw({ to_address: testAddress, amount_lovelace: "10000000" });
    expect(buildWithdrawTx).toHaveBeenCalledWith(expect.objectContaining({ toAddress: testAddress }));
    expect(response.status).not.toBe(400); // the route passes it; the builder is fixed to the main network
  });
});
