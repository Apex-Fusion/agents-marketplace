// Reads blocks through Ogmios v6 chain synchronisation (JSON-RPC over WebSocket,
// https://ogmios.dev/mini-protocols/local-chain-sync/). Koios on Vector does not keep transaction
// bytes (tx_cbor answers `cbor: null`) and exposes no witnesses, so the vkey witnesses come from the
// blocks themselves. One call is one connection, which reads the block after each given point in
// order: the cursor stays after the last block, so the block that follows it needs no new
// intersection. The chain-sync protocol is stateful, so a connection serves one call at a time.

import WebSocket from "ws";

export interface OgmiosPoint {
  slot: number;
  id: string;
}

export interface OgmiosSignatory {
  key: string;
  signature: string;
  /** Present on bootstrap (Byron) witnesses only. */
  chainCode?: string;
}

export interface OgmiosTransaction {
  id: string;
  signatories?: OgmiosSignatory[];
}

export interface OgmiosBlock {
  id: string;
  height?: number;
  slot?: number;
  transactions?: OgmiosTransaction[];
}

interface RpcMessage {
  id?: unknown;
  error?: { code?: number; message?: string };
  result?: {
    intersection?: { slot?: number; id?: string } | "origin";
    direction?: "forward" | "backward";
    block?: OgmiosBlock;
  };
}

type Method = "findIntersection" | "nextBlock";

/** Roll backs (other than the one to a new intersection) that a call accepts before it fails. */
const MAX_RESYNCS = 3;

/**
 * The block that directly follows each point on the node's selected chain, in the order of the
 * points, read through one connection. The connection and each answer must come within `timeoutMs`.
 */
export function fetchBlocksAfter(url: string, points: readonly OgmiosPoint[], timeoutMs = 20_000): Promise<OgmiosBlock[]> {
  if (points.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const blocks: OgmiosBlock[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let nextId = 0;
    let pending: { readonly id: number; readonly method: Method } | null = null;
    // After an intersection, the first nextBlock answer is the roll back to it.
    let rollBackExpected = false;
    let resyncs = 0;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      if (error) reject(error);
      else resolve(blocks);
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(`Ogmios: no answer within ${timeoutMs} ms`)), timeoutMs);
    };
    const send = (method: Method, params?: unknown): void => {
      pending = { id: ++nextId, method };
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), id: pending.id }));
    };
    const intersect = (): void => send("findIntersection", { points: [points[blocks.length]] });
    /** Asks for the block after the next point, or ends the call after the last one. */
    const advance = (): void => {
      if (blocks.length === points.length) return finish(null);
      const previous = blocks[blocks.length - 1];
      if (previous !== undefined && previous.id === points[blocks.length]!.id) send("nextBlock");
      else intersect();
    };

    arm();
    ws.on("open", advance);
    ws.on("message", (data) => {
      arm();
      let msg: RpcMessage;
      try {
        msg = JSON.parse(String(data)) as RpcMessage;
      } catch {
        return finish(new Error("Ogmios: answer is not JSON"));
      }
      const request = pending;
      if (request === null || msg.id !== request.id) return finish(new Error("Ogmios: an answer does not match the request"));
      if (msg.error) return finish(new Error(`Ogmios ${request.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      if (request.method === "findIntersection") {
        const at = msg.result?.intersection;
        if (typeof at !== "object" || at.id !== points[blocks.length]!.id) return finish(new Error("Ogmios: no intersection at the requested point"));
        rollBackExpected = true;
        return send("nextBlock");
      }
      const direction = msg.result?.direction;
      if (direction === "backward") {
        if (rollBackExpected) {
          rollBackExpected = false;
          return send("nextBlock");
        }
        // The node switched chains under the cursor: read again from the point.
        if (++resyncs > MAX_RESYNCS) return finish(new Error("Ogmios: the chain rolled back too often during the read"));
        return intersect();
      }
      if (direction === "forward" && msg.result?.block) {
        rollBackExpected = false;
        blocks.push(msg.result.block);
        return advance();
      }
      return finish(new Error("Ogmios: unexpected nextBlock answer"));
    });
    ws.on("error", (e) => finish(e));
    ws.on("close", () => finish(new Error("Ogmios: connection closed before the blocks arrived")));
  });
}
