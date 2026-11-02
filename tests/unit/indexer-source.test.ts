import { expect, it } from "vitest";
import { once } from "node:events";
import { createRequire } from "node:module";
import { SqliteCache } from "../../indexer/src/db/cache.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import { OgmiosSource } from "../../indexer/src/follower/ogmiosSource.js";
import { buildEscrowDatumHex, escrowRedeemerHex } from "../fixtures/indexer-side/sample-blocks.js";
import { ogmiosRedeemer } from "../fixtures/indexer-side/identity-blocks.js";

const { WebSocketServer } = createRequire(new URL("../../indexer/package.json", import.meta.url))("ws");

it("preserves indexed funds and events when a node cannot resume the saved checkpoint", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket: {
    on(event: "message", listener: (data: Buffer) => void): void;
    send(data: string): void;
  }) => {
    socket.on("message", data => {
      const request = JSON.parse(data.toString());
      const reply = request.method === "findIntersection"
        ? request.params.points.includes("origin")
          ? { method: "findIntersection", result: { intersection: "origin" } }
          : { method: "findIntersection", error: { code: 1000, message: "Intersection not found" } }
        : { method: "nextBlock", result: { direction: "backward", point: "origin" } };
      socket.send(JSON.stringify(reply));
    });
  });
  const cache = new SqliteCache(":memory:");
  const ref = `${"a".repeat(64)}#0`;
  const checkpoint = { slot: 100, blockHash: "b".repeat(64) };
  cache.insertUtxo(ref, "escrow-script", "00", 90, "a".repeat(64));
  cache.appendEvent({
    type: "PostEscrow", slot: 90, tx_hash: "a".repeat(64), utxo_ref: ref,
    datum_hex: "00", metadata_json: "{}", rolled_back: 0,
  });
  cache.saveCursor(checkpoint.slot, checkpoint.blockHash);
  const source = new OgmiosSource(`ws://127.0.0.1:${server.address().port}`, { responseTimeoutMs: 0 });
  const worker = new ChainSyncWorker({
    source, cache, networkId: 0, addresses: { advertAddress: "advert-script", escrowAddress: "escrow-script" },
  });
  const response = new Promise<void>(resolve => {
    worker.once("error", () => resolve());
    source.once("rollback", () => resolve());
  });
  try {
    await worker.start();
    await response;
    expect(cache.getUnspentUtxos("escrow-script").map(row => row.ref)).toEqual([ref]);
    expect(cache.listEventsAfterSlot(0).map(row => row.utxo_ref)).toEqual([ref]);
    expect(cache.getCursor()).toEqual(checkpoint);
  } finally {
    worker.stop();
    cache.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("decodes the redeemers of an Ogmios v6 block: a Release spend is recorded as ReleaseEscrow", async () => {
  const escrowTx = "e".repeat(64);
  const escrowRef = `${escrowTx}#0`;
  const spendTx = "f".repeat(64);
  // Ogmios v6 Block<Praos> with one transaction (docs/static/cardano.json, v6.14.0).
  const block = {
    type: "praos", era: "conway", id: "b".repeat(64), ancestor: "a".repeat(64), height: 10, size: { bytes: 900 },
    slot: 500, protocol: { version: { major: 10, minor: 0, patch: 0 } }, issuer: {},
    transactions: [{
      id: spendTx,
      spends: "inputs",
      // Ledger order: 1…#3 (index 0), e…#0 (index 1).
      inputs: [{ transaction: { id: escrowTx }, index: 0 }, { transaction: { id: "1".repeat(64) }, index: 3 }],
      outputs: [{ address: "addr_test1vsupplier", value: { ada: { lovelace: 4_000_000 } } }],
      redeemers: [ogmiosRedeemer("spend", 1, escrowRedeemerHex("Release"))],
      signatories: [],
    }],
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let sent = false;
  server.on("connection", (socket: { on(event: "message", listener: (data: Buffer) => void): void; send(data: string): void }) => {
    socket.on("message", data => {
      const request = JSON.parse(data.toString());
      if (request.method === "findIntersection") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "findIntersection", result: { intersection: "origin" } }));
      } else if (request.method === "nextBlock" && !sent) {
        sent = true;
        socket.send(JSON.stringify({
          jsonrpc: "2.0", method: "nextBlock",
          result: { direction: "forward", block, tip: { slot: 600, id: "c".repeat(64), height: 12 } },
        }));
      }
    });
  });
  const cache = new SqliteCache(":memory:");
  cache.insertUtxo(escrowRef, "escrow-script", buildEscrowDatumHex({ state: "Submitted" }), 90, escrowTx);
  const source = new OgmiosSource(`ws://127.0.0.1:${server.address().port}`, { responseTimeoutMs: 0 });
  const worker = new ChainSyncWorker({
    source, cache, networkId: 0, addresses: { advertAddress: "advert-script", escrowAddress: "escrow-script" },
  });
  const event = new Promise<{ type: string; ref: string }>(resolve => worker.once("chain-event", resolve));
  try {
    await worker.start();
    expect(await event).toMatchObject({ type: "ReleaseEscrow", ref: escrowRef });
    expect(cache.listEventsAfterSlot(0).map(row => [row.type, row.tx_hash])).toEqual([["ReleaseEscrow", spendTx]]);
    expect(cache.getUnspentUtxos("escrow-script")).toEqual([]);
    expect(cache.getCursor()).toEqual({ slot: 500, blockHash: "b".repeat(64) });
  } finally {
    worker.stop();
    cache.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
