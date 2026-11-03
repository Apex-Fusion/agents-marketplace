import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { KoiosOgmiosChainSource } from "../src/chain/koios-ogmios-source.js";
import { KOIOS_PAGE, KoiosClient } from "../src/chain/koios.js";
import { LEGACY_REGISTRY } from "../src/resolve/settings.js";

// Mainnet facts: legacy record 4c2047… was minted in tx e6992139… (block 4821638); its only vkey
// witness is OWNER_KEY. The record output is #0 at the legacy address with an inline datum.
const POLICY = LEGACY_REGISTRY.policyId;
const ASSET = "4c2047697c7aa8b3399c5fecf20f2bd19ff276aaffbd0496acfd7b3e1a52545e";
const MINT_TX = "e6992139dfb2922a175d3d614899067e6989e79e791f7b9e452af007bbec1611";
const MINT_BLOCK = { hash: "adfc6ebfb06396231fa21deb352a2ce158af2ed67bbdcf06eadb4f5d4eacbff0", height: 4821638, slot: 19801342 };
const PREVIOUS_BLOCK = { hash: "3a419d645f96d16afe73a4882fd9eac999a49c7f4567ce980fbdd42ddc8fdda4", height: 4821637, slot: 19801338 };
const OWNER_KEY = "edca77f5418b21bb7bf540bd056a238e38575fc26c4aa677a36df6bf305d9e9c";
const DATUM_HASH = "3c579fc003959cd94a3debdd25e67d51f4528acbcb1b20a1e75832ef7134d64d";

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A fetch stub answering from a route function of the path (query included). */
function stubFetch(routes: (path: string, body: unknown) => unknown, calls: Call[] = [], status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const path = url.replace("https://koios.test/api/v1/", "");
    return new Response(JSON.stringify(routes(path, body)), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const koiosWith = (routes: (path: string, body: unknown) => unknown, calls: Call[] = []) =>
  new KoiosClient({ baseUrl: "https://koios.test/api/v1/", fetch: stubFetch(routes, calls) });

let wss: WebSocketServer | null = null;
afterEach(async () => {
  await new Promise<void>((done) => (wss ? wss.close(() => done()) : done()));
  wss = null;
});

interface FakeBlock {
  readonly id: string;
  readonly slot: number;
  readonly height: number;
  readonly transactions: readonly unknown[];
}

/**
 * A local stand-in for Ogmios chain sync over consecutive blocks: findIntersection at a block, then
 * nextBlock (first the roll back to the intersection, then the following blocks). `sessions` gets the
 * methods of each connection. `rollBackOnceBefore`: the node switches chains once, just before it
 * would serve the block at that height without a new intersection.
 */
async function fakeOgmios(blocks: readonly FakeBlock[], sessions: string[][] = [], rollBackOnceBefore?: number): Promise<string> {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const pointOf = (b: FakeBlock) => ({ slot: b.slot, id: b.id });
  const tip = pointOf(blocks[blocks.length - 1]!);
  let switched = false;
  wss.on("connection", (socket) => {
    const methods: string[] = [];
    sessions.push(methods);
    let cursor = -1;
    let rollBack = false;
    socket.on("message", (data) => {
      const req = JSON.parse(String(data)) as { method: string; params?: { points: Array<{ slot: number; id: string }> }; id: unknown };
      methods.push(req.method);
      const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", method: req.method, result, id: req.id }));
      if (req.method === "findIntersection") {
        const p = req.params!.points[0]!;
        const at = blocks.findIndex((b) => b.id === p.id && b.slot === p.slot);
        if (at < 0) return socket.send(JSON.stringify({ jsonrpc: "2.0", method: req.method, error: { code: 1000, message: "no intersection" }, id: req.id }));
        cursor = at;
        rollBack = true;
        return reply({ intersection: p, tip });
      }
      if (rollBack) {
        rollBack = false;
        return reply({ direction: "backward", point: pointOf(blocks[cursor]!), tip });
      }
      if (!switched && blocks[cursor + 1]?.height === rollBackOnceBefore) {
        switched = true;
        cursor = Math.max(0, cursor - 2);
        return reply({ direction: "backward", point: pointOf(blocks[cursor]!), tip });
      }
      cursor++;
      return reply({ direction: "forward", block: blocks[cursor], tip });
    });
  });
  await new Promise<void>((done) => wss!.on("listening", done));
  const address = wss.address();
  if (address === null || typeof address === "string") throw new Error("the fake Ogmios has no TCP address");
  return `ws://127.0.0.1:${address.port}`;
}

describe("KoiosClient", () => {
  test("postAll pages with order, offset and limit until a short page; the token is a bearer header", async () => {
    const calls: Call[] = [];
    const client = new KoiosClient({
      baseUrl: "https://koios.test/api/v1/",
      token: "test-token",
      fetch: stubFetch((path) => (path.includes("offset=0&") ? Array.from({ length: KOIOS_PAGE }, (_, i) => ({ i })) : [{ i: "last" }]), calls),
    });
    const rows = await client.postAll("asset_txs", { _asset_policy: "x" }, "tx_hash.asc");
    expect(rows).toHaveLength(KOIOS_PAGE + 1);
    expect(calls.map((c) => c.url)).toEqual([
      `https://koios.test/api/v1/asset_txs?order=tx_hash.asc&offset=0&limit=${KOIOS_PAGE}`,
      `https://koios.test/api/v1/asset_txs?order=tx_hash.asc&offset=${KOIOS_PAGE}&limit=${KOIOS_PAGE}`,
    ]);
    expect(calls[0]!.headers.authorization).toBe("Bearer test-token");
  });

  test("an HTTP error or a body that is not an array throws, naming the endpoint only", async () => {
    const failing = new KoiosClient({ baseUrl: "https://koios.test/api/v1", fetch: stubFetch(() => ({}), [], 503) });
    await expect(failing.post("asset_txs?x=1", { _asset_name: "secret" })).rejects.toThrow("Koios POST asset_txs answered HTTP 503");
    const odd = new KoiosClient({ baseUrl: "https://koios.test/api/v1", fetch: stubFetch(() => ({ not: "an array" })) });
    await expect(odd.get("tip")).rejects.toThrow(/JSON array/);
  });
});

describe("KoiosOgmiosChainSource", () => {
  test("tip and genesis", async () => {
    const source = new KoiosOgmiosChainSource({
      koios: koiosWith((path) =>
        path.startsWith("tip")
          ? [{ hash: "aa".repeat(32), abs_slot: 37146463, block_height: 9162036 }]
          : [{ networkmagic: "764824073", systemstart: 1756485600, slotlength: "1", securityparam: "2160", networkid: "Mainnet" }],
      ),
      ogmiosUrl: "ws://unused",
    });
    expect(await source.tip()).toEqual({ blockHeight: 9162036, blockHash: "aa".repeat(32), slot: 37146463 });
    expect(await source.genesis()).toEqual({ networkMagic: 764824073, systemStart: 1756485600, slotLength: 1, securityParam: 2160 });
  });

  test("tx_info rows map to ledger transactions with values, inline datum bytes, datum hashes and reference scripts", async () => {
    const calls: Call[] = [];
    const source = new KoiosOgmiosChainSource({
      koios: koiosWith(
        () => [
          {
            tx_hash: MINT_TX,
            block_hash: MINT_BLOCK.hash,
            block_height: MINT_BLOCK.height,
            absolute_slot: MINT_BLOCK.slot,
            tx_timestamp: 1776286942,
            tx_block_index: 3,
            inputs: [{ tx_hash: "ee".repeat(32), tx_index: 0, payment_addr: { bech32: "addr1wallet" }, asset_list: [], value: "50000000" }],
            outputs: [
              {
                tx_index: 1,
                payment_addr: { bech32: "addr1wallet" },
                value: "39674537",
                asset_list: [],
                datum_hash: null,
                inline_datum: null,
                reference_script: null,
              },
              {
                tx_index: 0,
                payment_addr: { bech32: LEGACY_REGISTRY.address },
                value: "10000000",
                asset_list: [{ policy_id: POLICY, asset_name: ASSET, quantity: "1" }],
                datum_hash: DATUM_HASH.toUpperCase(),
                inline_datum: { bytes: "D87980", value: { constructor: 0, fields: [] } },
                reference_script: { hash: "cc".repeat(28) },
              },
            ],
            assets_minted: [{ policy_id: POLICY, asset_name: ASSET, quantity: "1" }],
          },
        ],
        calls,
      ),
      ogmiosUrl: "ws://unused",
    });
    expect(await source.transactions([MINT_TX])).toEqual([
      {
        txHash: MINT_TX,
        blockHash: MINT_BLOCK.hash,
        blockHeight: MINT_BLOCK.height,
        txIndex: 3,
        slot: MINT_BLOCK.slot,
        inputs: [{ txHash: "ee".repeat(32), outputIndex: 0, address: "addr1wallet", assets: [] }],
        outputs: [
          { outputIndex: 1, address: "addr1wallet", lovelace: 39674537n, assets: [], inlineDatum: null, datumHash: null, hasReferenceScript: false },
          {
            outputIndex: 0,
            address: LEGACY_REGISTRY.address,
            lovelace: 10000000n,
            assets: [{ policyId: POLICY, assetName: ASSET, quantity: 1n }],
            inlineDatum: "d87980",
            datumHash: DATUM_HASH,
            hasReferenceScript: true,
          },
        ],
        mint: [{ policyId: POLICY, assetName: ASSET, quantity: 1n }],
      },
    ]);
    expect(calls[0]!.body).toEqual({ _tx_hashes: [MINT_TX], _inputs: true, _assets: true, _scripts: true, _bytecode: true });
  });

  test("an inline datum without its bytes is a failed read", async () => {
    const source = new KoiosOgmiosChainSource({
      koios: koiosWith(() => [
        {
          tx_hash: MINT_TX,
          block_hash: MINT_BLOCK.hash,
          block_height: 1,
          absolute_slot: 1,
          tx_block_index: 0,
          inputs: [],
          outputs: [{ tx_index: 0, payment_addr: { bech32: "a" }, value: "1", asset_list: [], datum_hash: "ab", inline_datum: { bytes: null }, reference_script: null }],
          assets_minted: null,
        },
      ]),
      ogmiosUrl: "ws://unused",
    });
    await expect(source.transactions([MINT_TX])).rejects.toThrow(/without its bytes/);
  });

  test("asset_txs, datum_info and policy_asset_mints", async () => {
    const calls: Call[] = [];
    const source = new KoiosOgmiosChainSource({
      koios: koiosWith((path) => {
        if (path.startsWith("asset_txs")) return [{ tx_hash: "b1" }, { tx_hash: "a1" }, { tx_hash: "b1" }];
        if (path.startsWith("datum_info")) return [{ datum_hash: DATUM_HASH, bytes: "D87980" }, { datum_hash: "ff".repeat(32), bytes: null }];
        if (path.startsWith("policy_asset_mints")) return [{ asset_name: ASSET, minting_tx_hash: MINT_TX, mint_cnt: 1, creation_time: 1776286942 }];
        return [];
      }, calls),
      ogmiosUrl: "ws://unused",
    });
    expect(await source.assetTxHashes(POLICY, ASSET)).toEqual(["b1", "a1"]);
    expect(calls[0]!.body).toEqual({ _asset_policy: POLICY, _asset_name: ASSET, _history: true });
    expect(await source.datums([DATUM_HASH, "ff".repeat(32)])).toEqual(new Map([[DATUM_HASH, "d87980"]]));
    expect(await source.policyAssets(POLICY)).toEqual([{ assetName: ASSET, mintCount: 1, lastMintTx: MINT_TX, createdAt: 1776286942 }]);
    expect(calls[2]!.url).toBe(
      `https://koios.test/api/v1/policy_asset_mints?_asset_policy=${POLICY}&select=asset_name,minting_tx_hash,mint_cnt,creation_time&order=asset_name.asc&offset=0&limit=${KOIOS_PAGE}`,
    );
  });

  test("assetHolders asks asset_utxos for many assets at once and keys each holder by asset", async () => {
    const calls: Call[] = [];
    const other = "ab".repeat(32);
    const source = new KoiosOgmiosChainSource({
      koios: koiosWith(
        () => [
          {
            tx_hash: MINT_TX,
            tx_index: 0,
            block_height: MINT_BLOCK.height,
            asset_list: [
              { policy_id: POLICY, asset_name: ASSET, quantity: "1" },
              { policy_id: "cd".repeat(28), asset_name: "x", quantity: "5" },
            ],
          },
        ],
        calls,
      ),
      ogmiosUrl: "ws://unused",
    });
    const held = await source.assetHolders([
      { policyId: POLICY, assetName: ASSET },
      { policyId: POLICY, assetName: other },
    ]);
    expect([...held]).toEqual([[`${POLICY}.${ASSET}`, [`${MINT_TX}#0@${MINT_BLOCK.height}`]]]);
    expect(calls.map((c) => c.url)).toEqual([
      `https://koios.test/api/v1/asset_utxos?select=tx_hash,tx_index,block_height,asset_list&order=tx_hash.asc,tx_index.asc&offset=0&limit=${KOIOS_PAGE}`,
    ]);
    expect(calls[0]!.body).toEqual({ _asset_list: [[POLICY, ASSET], [POLICY, other]], _extended: true });
  });

  test("assetHolders sends at most 1,000 assets in one request", async () => {
    const calls: Call[] = [];
    const source = new KoiosOgmiosChainSource({ koios: koiosWith(() => [], calls), ogmiosUrl: "ws://unused" });
    const assets = Array.from({ length: 1_500 }, (_, i) => ({ policyId: POLICY, assetName: i.toString(16).padStart(64, "0") }));
    expect(await source.assetHolders(assets)).toEqual(new Map());
    const listed = assets.map((a) => [a.policyId, a.assetName]);
    expect(calls.map((c) => c.body)).toEqual([
      { _asset_list: listed.slice(0, 1_000), _extended: true },
      { _asset_list: listed.slice(1_000), _extended: true },
    ]);
  });

  test("blockWitnesses reads the block after the previous one through Ogmios, with its hash, without bootstrap witnesses", async () => {
    const ogmiosUrl = await fakeOgmios([
      { id: PREVIOUS_BLOCK.hash, height: PREVIOUS_BLOCK.height, slot: PREVIOUS_BLOCK.slot, transactions: [] },
      {
        id: MINT_BLOCK.hash,
        height: MINT_BLOCK.height,
        slot: MINT_BLOCK.slot,
        transactions: [
          { id: MINT_TX, signatories: [{ key: OWNER_KEY.toUpperCase(), signature: "00" }] },
          { id: "dd".repeat(32), signatories: [{ key: "11".repeat(32), signature: "00", chainCode: "22".repeat(32), addressAttributes: "a0" }] },
        ],
      },
    ]);
    const blocks = [
      { hash: PREVIOUS_BLOCK.hash, abs_slot: PREVIOUS_BLOCK.slot, block_height: PREVIOUS_BLOCK.height },
      { hash: MINT_BLOCK.hash, abs_slot: MINT_BLOCK.slot, block_height: MINT_BLOCK.height },
    ];
    const calls: Call[] = [];
    const source = new KoiosOgmiosChainSource({ koios: koiosWith(() => blocks, calls), ogmiosUrl, ogmiosTimeoutMs: 5000 });
    expect(await source.blockWitnesses([MINT_BLOCK.height])).toEqual([
      {
        blockHash: MINT_BLOCK.hash,
        transactions: [
          { txHash: MINT_TX, vkeys: [OWNER_KEY] },
          { txHash: "dd".repeat(32), vkeys: [] },
        ],
      },
    ]);
    expect(calls[0]!.url).toContain(`blocks?block_height=in.(${PREVIOUS_BLOCK.height},${MINT_BLOCK.height})`);
    expect(await source.blockWitnesses([])).toEqual([]);

    const forked = new KoiosOgmiosChainSource({ koios: koiosWith(() => [blocks[0], { ...blocks[1], hash: "ff".repeat(32) }]), ogmiosUrl, ogmiosTimeoutMs: 5000 });
    await expect(forked.blockWitnesses([MINT_BLOCK.height])).rejects.toThrow(/Ogmios returned another block/);
  });

  describe("a window of blocks: one Koios read and one Ogmios session", () => {
    const hex64 = (n: number): string => n.toString(16).padStart(4, "0").repeat(16);
    const chainBlocks: FakeBlock[] = Array.from({ length: 8 }, (_, i) => ({
      id: hex64(100 + i),
      height: 100 + i,
      slot: 1000 + 7 * i,
      transactions: [{ id: hex64(200 + i), signatories: [{ key: OWNER_KEY, signature: "00" }] }],
    }));
    const rows = chainBlocks.map((b) => ({ hash: b.id, abs_slot: b.slot, block_height: b.height }));

    test("the block after each point; a block that follows the last one read needs no new intersection", async () => {
      const sessions: string[][] = [];
      const ogmiosUrl = await fakeOgmios(chainBlocks, sessions);
      const calls: Call[] = [];
      const source = new KoiosOgmiosChainSource({ koios: koiosWith(() => rows, calls), ogmiosUrl, ogmiosTimeoutMs: 5000 });
      const read = await source.blockWitnesses([101, 102, 104]);
      expect(read.map((b) => b.blockHash)).toEqual([chainBlocks[1]!.id, chainBlocks[2]!.id, chainBlocks[4]!.id]);
      expect(read[2]!.transactions).toEqual([{ txHash: hex64(204), vkeys: [OWNER_KEY] }]);
      expect(calls.map((c) => c.url)).toEqual(["https://koios.test/api/v1/blocks?block_height=in.(100,101,102,103,104)&select=hash,abs_slot,block_height"]);
      expect(sessions).toEqual([["findIntersection", "nextBlock", "nextBlock", "nextBlock", "findIntersection", "nextBlock", "nextBlock"]]);
    });

    test("a roll back in the middle of the session: the read starts again from the point", async () => {
      const sessions: string[][] = [];
      const ogmiosUrl = await fakeOgmios(chainBlocks, sessions, 103);
      const source = new KoiosOgmiosChainSource({ koios: koiosWith(() => rows), ogmiosUrl, ogmiosTimeoutMs: 5000 });
      const read = await source.blockWitnesses([101, 102, 103]);
      expect(read.map((b) => b.blockHash)).toEqual([chainBlocks[1]!.id, chainBlocks[2]!.id, chainBlocks[3]!.id]);
      expect(sessions).toEqual([["findIntersection", "nextBlock", "nextBlock", "nextBlock", "nextBlock", "findIntersection", "nextBlock", "nextBlock"]]);
    });

    test("a height that Koios does not list is a failed read", async () => {
      const source = new KoiosOgmiosChainSource({ koios: koiosWith(() => rows), ogmiosUrl: "ws://unused", ogmiosTimeoutMs: 5000 });
      await expect(source.blockWitnesses([101, 120])).rejects.toThrow(/a requested block height is missing/);
    });
  });
});
