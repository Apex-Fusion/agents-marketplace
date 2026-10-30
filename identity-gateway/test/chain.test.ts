import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { KoiosOgmiosChainSource } from "../src/chain/koios-ogmios-source.js";
import { KOIOS_PAGE, KoiosClient } from "../src/chain/koios.js";
import { ASSET, MINT_BLOCK, MINT_TX, OWNER_KEY, POLICY, REGISTRY } from "./fixtures.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A fetch stub answering from a route table keyed by the path (query included). */
function stubFetch(routes: (path: string, body: unknown) => unknown, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, headers: init?.headers as Record<string, string> });
    const path = url.replace("https://koios.test/api/v1/", "");
    return new Response(JSON.stringify(routes(path, body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

let wss: WebSocketServer | null = null;
afterEach(async () => {
  await new Promise<void>((done) => (wss ? wss.close(() => done()) : done()));
  wss = null;
});

/** A local stand-in for Ogmios chain sync that serves one block after one point. */
async function fakeOgmios(point: { slot: number; id: string }, block: unknown): Promise<string> {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket) => {
    let rolledBack = false;
    socket.on("message", (data) => {
      const req = JSON.parse(String(data)) as { method: string; params?: { points: Array<{ slot: number; id: string }> }; id: string };
      const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", method: req.method, result, id: req.id }));
      if (req.method === "findIntersection") {
        const p = req.params!.points[0]!;
        if (p.id !== point.id) return socket.send(JSON.stringify({ jsonrpc: "2.0", method: req.method, error: { code: 1000, message: "no intersection" }, id: req.id }));
        return reply({ intersection: point, tip: point });
      }
      if (!rolledBack) {
        rolledBack = true;
        return reply({ direction: "backward", point, tip: point });
      }
      return reply({ direction: "forward", block, tip: point });
    });
  });
  await new Promise<void>((done) => wss!.on("listening", done));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

describe("KoiosClient", () => {
  test("postAll pages with order, offset and limit until a short page; the token is a bearer header", async () => {
    const calls: Call[] = [];
    const client = new KoiosClient({
      baseUrl: "https://koios.test/api/v1/",
      token: "secret-token",
      fetch: stubFetch((path) => (path.includes("offset=0&") ? Array.from({ length: KOIOS_PAGE }, (_, i) => ({ i })) : [{ i: "last" }]), calls),
    });
    const rows = await client.postAll("credential_txs", { _payment_credentials: ["x"] }, "tx_hash.asc");
    expect(rows).toHaveLength(KOIOS_PAGE + 1);
    expect(calls.map((c) => c.url)).toEqual([
      `https://koios.test/api/v1/credential_txs?order=tx_hash.asc&offset=0&limit=${KOIOS_PAGE}`,
      `https://koios.test/api/v1/credential_txs?order=tx_hash.asc&offset=${KOIOS_PAGE}&limit=${KOIOS_PAGE}`,
    ]);
    expect(calls[0]!.headers.authorization).toBe("Bearer secret-token");
  });
});

describe("KoiosOgmiosChainSource", () => {
  test("maps Koios rows to ledger transactions and unspent outputs", async () => {
    const koios = new KoiosClient({
      baseUrl: "https://koios.test/api/v1",
      fetch: stubFetch((path) => {
        if (path.startsWith("tx_info")) {
          return [
            {
              tx_hash: MINT_TX,
              block_hash: MINT_BLOCK.hash,
              block_height: MINT_BLOCK.height,
              absolute_slot: MINT_BLOCK.slot,
              tx_timestamp: MINT_BLOCK.time,
              tx_block_index: 0,
              inputs: [{ tx_hash: "ee".repeat(32), tx_index: 0, payment_addr: { bech32: "addr1wallet" }, asset_list: [] }],
              outputs: [{ tx_index: 0, payment_addr: { bech32: REGISTRY }, asset_list: [{ policy_id: POLICY, asset_name: ASSET, quantity: "1" }] }],
              assets_minted: [{ policy_id: POLICY, asset_name: ASSET, quantity: "1" }],
            },
          ];
        }
        if (path.startsWith("asset_utxos")) {
          return [{ tx_hash: MINT_TX, tx_index: 0, address: REGISTRY, inline_datum: { bytes: "d87980" }, asset_list: [{ policy_id: POLICY, asset_name: ASSET, quantity: "1" }] }];
        }
        return [];
      }),
    });
    const source = new KoiosOgmiosChainSource({ koios, ogmiosUrl: "ws://unused" });
    expect(await source.transactions([MINT_TX])).toEqual([
      {
        txHash: MINT_TX,
        blockHash: MINT_BLOCK.hash,
        blockHeight: MINT_BLOCK.height,
        blockIndex: 0,
        slot: MINT_BLOCK.slot,
        blockTime: MINT_BLOCK.time,
        inputs: [{ txHash: "ee".repeat(32), outputIndex: 0, address: "addr1wallet", assets: [] }],
        outputs: [{ outputIndex: 0, address: REGISTRY, assets: [{ policyId: POLICY, assetName: ASSET, quantity: 1n }] }],
        mint: [{ policyId: POLICY, assetName: ASSET, quantity: 1n }],
      },
    ]);
    expect(await source.utxosWithAsset(POLICY, ASSET)).toEqual([
      { txHash: MINT_TX, outputIndex: 0, address: REGISTRY, assets: [{ policyId: POLICY, assetName: ASSET, quantity: 1n }], datumHex: "d87980" },
    ]);
  });

  test("blockWitnesses reads the block after the previous one through Ogmios and drops bootstrap witnesses", async () => {
    const previous = { slot: 19801338, id: "3a419d645f96d16afe73a4882fd9eac999a49c7f4567ce980fbdd42ddc8fdda4" };
    const ogmiosUrl = await fakeOgmios(previous, {
      id: MINT_BLOCK.hash,
      height: MINT_BLOCK.height,
      slot: MINT_BLOCK.slot,
      transactions: [
        { id: MINT_TX, signatories: [{ key: OWNER_KEY.toUpperCase(), signature: "00" }] },
        { id: "dd".repeat(32), signatories: [{ key: "11".repeat(32), signature: "00", chainCode: "22".repeat(32), addressAttributes: "a0" }] },
      ],
    });
    const blocks = [
      { hash: previous.id, abs_slot: previous.slot, block_height: MINT_BLOCK.height - 1 },
      { hash: MINT_BLOCK.hash, abs_slot: MINT_BLOCK.slot, block_height: MINT_BLOCK.height },
    ];
    const calls: Call[] = [];
    const koios = new KoiosClient({ baseUrl: "https://koios.test/api/v1", fetch: stubFetch(() => blocks, calls) });
    const source = new KoiosOgmiosChainSource({ koios, ogmiosUrl, ogmiosTimeoutMs: 5000 });

    expect(await source.blockWitnesses(MINT_BLOCK.height)).toEqual([
      { txHash: MINT_TX, vkeys: [OWNER_KEY] },
      { txHash: "dd".repeat(32), vkeys: [] },
    ]);
    expect(calls[0]!.url).toContain(`blocks?block_height=in.(${MINT_BLOCK.height - 1},${MINT_BLOCK.height})`);

    const forked = new KoiosClient({
      baseUrl: "https://koios.test/api/v1",
      fetch: stubFetch(() => [blocks[0], { ...blocks[1], hash: "ff".repeat(32) }]),
    });
    await expect(new KoiosOgmiosChainSource({ koios: forked, ogmiosUrl, ogmiosTimeoutMs: 5000 }).blockWitnesses(MINT_BLOCK.height)).rejects.toThrow(
      /Ogmios returned/,
    );
  });
});
