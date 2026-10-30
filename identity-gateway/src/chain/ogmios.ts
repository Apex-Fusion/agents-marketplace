// Reads one block through Ogmios v6 chain synchronisation (JSON-RPC over WebSocket). Koios on
// Vector does not keep transaction bytes (tx_cbor answers `cbor: null`) and exposes no witnesses,
// so the vkey witnesses come from the block itself. Each call opens its own connection: the
// chain-sync protocol is stateful, so a shared connection could not serve concurrent requests.

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

/** The block that directly follows `point` on the node's selected chain. */
export function fetchBlockAfter(url: string, point: OgmiosPoint, timeoutMs = 20_000): Promise<OgmiosBlock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (error: Error | null, block?: OgmiosBlock) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      if (error) reject(error);
      else resolve(block!);
    };
    const timer = setTimeout(() => finish(new Error(`Ogmios: no block after ${timeoutMs} ms`)), timeoutMs);
    const send = (method: string, params?: unknown) =>
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), id: method }));

    ws.on("open", () => send("findIntersection", { points: [point] }));
    ws.on("message", (data) => {
      let msg: RpcMessage;
      try {
        msg = JSON.parse(String(data)) as RpcMessage;
      } catch {
        return finish(new Error("Ogmios: answer is not JSON"));
      }
      if (msg.error) return finish(new Error(`Ogmios ${String(msg.id)}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      if (msg.id === "findIntersection") {
        const at = msg.result?.intersection;
        if (typeof at !== "object" || at.id !== point.id) return finish(new Error(`Ogmios: no intersection at ${point.slot}.${point.id}`));
        return send("nextBlock");
      }
      if (msg.id === "nextBlock") {
        if (msg.result?.direction === "backward") return send("nextBlock");
        if (msg.result?.direction === "forward" && msg.result.block) return finish(null, msg.result.block);
        return finish(new Error("Ogmios: unexpected nextBlock answer"));
      }
    });
    ws.on("error", (e) => finish(e));
    ws.on("close", () => finish(new Error("Ogmios: connection closed before the block arrived")));
  });
}
