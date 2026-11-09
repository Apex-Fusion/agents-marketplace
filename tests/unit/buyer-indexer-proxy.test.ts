/**
 * buyer-indexer-proxy.test.ts — the buyer's GET /v1/indexer/* passthrough
 * serves the indexer routes of the documents on chain and of the jury: it
 * forwards the path and the query, and returns the status and the body
 * unchanged (the page checks the document hash on these bytes).
 */

import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../buyer/src/server.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";

const INDEXER = "http://marketplace-indexer:8090";
const TX = "d1".repeat(32);

function proxy(respond: () => Response) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    return respond();
  });
  const app = createApp({ chain: new MockChainProvider(), walletKey: buildBuyerWalletKey(), indexerUrl: `${INDEXER}/`, fetchImpl });
  return { app, calls };
}

describe("buyer /v1/indexer passthrough — documents and jury", () => {
  it("forwards /documents/:tx and /jury/cases?challenge= and returns the body unchanged", async () => {
    const text = "\ufeff{\"statement\":\"Prüfung\"}";
    const document = { tx: TX, hash: "ab".repeat(32), bytes_hex: Buffer.from(text, "utf8").toString("hex"), text };
    const { app, calls } = proxy(() => Response.json(document));
    const res = await request(app).get(`/v1/indexer/documents/${TX}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual(document);
    await request(app).get(`/v1/indexer/jury/cases?challenge=${"ce".repeat(32)}`);
    expect(calls).toEqual([`${INDEXER}/documents/${TX}`, `${INDEXER}/jury/cases?challenge=${"ce".repeat(32)}`]);
  });

  it("passes the 404 of an unknown document through", async () => {
    const { app } = proxy(() => Response.json({ error: "the indexer holds no document of this transaction" }, { status: 404 }));
    const res = await request(app).get(`/v1/indexer/documents/${TX}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("no document");
  });
});
