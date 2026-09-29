import { expect, it } from "vitest";
import { once } from "node:events";
import { createRequire } from "node:module";
import { SqliteCache } from "../../indexer/src/db/cache.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import { OgmiosSource } from "../../indexer/src/follower/ogmiosSource.js";

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
    source, cache, addresses: { advertAddress: "advert-script", escrowAddress: "escrow-script" },
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
