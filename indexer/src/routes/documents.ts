/**
 * indexer/src/routes/documents.ts — documents on chain (Module-1/jury/SPEC.md §10).
 *
 * GET /documents/:tx           — the document in the metadata (label 22084) of a
 *                                transaction. `:tx` is the transaction id (64 hex) or
 *                                its `vector-tx:` URI.
 * GET /documents/by-hash/:hash — the first document on chain with this blake2b-256
 *                                (64 hex); `txs` lists every transaction that carries it.
 *
 * Body: { tx, uri, slot, block_height, time, label, type, media_type, hash, size,
 * bytes_hex, text }. `bytes_hex` holds the exact document bytes and `text` the same
 * bytes as UTF-8. A reader checks the hash itself: blake2b-256 of the bytes must
 * equal the hash on chain that names the document. 404: the indexer holds no such
 * document (the transaction has none, or the indexer has not read it).
 */

import { Router, type Request, type Response } from "express";
import { VECTOR_MAINNET, VECTOR_TESTNET, slotToPosixMs, type NetworkId } from "@marketplace/shared";
import type { DocumentRow, SqliteCache } from "../db/cache.js";
import { DOCUMENT_LABEL, txIdFromVectorTxUri, vectorTxUri } from "../documents/document.js";

export interface DocumentsDeps {
  cache: SqliteCache;
  networkId: NetworkId;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

export function documentsRouter(deps: DocumentsDeps): Router {
  const router = Router();
  const network = deps.networkId === 1 ? VECTOR_MAINNET : VECTOR_TESTNET;

  const body = (doc: DocumentRow): Record<string, unknown> => ({
    tx: doc.tx_hash,
    uri: vectorTxUri(doc.tx_hash),
    slot: doc.slot,
    block_height: doc.block_height,
    time: new Date(slotToPosixMs(doc.slot, network)).toISOString(),
    label: Number(DOCUMENT_LABEL),
    type: doc.type,
    media_type: doc.media_type,
    hash: doc.hash,
    size: doc.bytes.length,
    bytes_hex: doc.bytes.toString("hex"),
    text: UTF8.decode(doc.bytes),
  });

  router.get("/documents/by-hash/:hash", (req: Request, res: Response) => {
    const hash = String(req.params.hash).toLowerCase();
    if (!HEX64_RE.test(hash)) {
      res.status(400).json({ error: "hash must be 64 hexadecimal characters" });
      return;
    }
    const docs = deps.cache.listDocumentsByHash(hash);
    if (docs.length === 0) {
      res.status(404).json({ error: "no document on chain has this blake2b-256 hash" });
      return;
    }
    res.status(200).json({ ...body(docs[0]!), txs: docs.map((d) => d.tx_hash) });
  });

  router.get("/documents/:tx", (req: Request, res: Response) => {
    const param = String(req.params.tx);
    const tx = HEX64_RE.test(param.toLowerCase()) ? param.toLowerCase() : txIdFromVectorTxUri(param);
    if (tx === null) {
      res.status(400).json({ error: "tx must be a transaction id (64 hexadecimal characters) or a vector-tx: URI" });
      return;
    }
    const doc = deps.cache.getDocument(tx);
    if (!doc) {
      res.status(404).json({ error: "the indexer holds no document of this transaction" });
      return;
    }
    res.status(200).json(body(doc));
  });

  return router;
}
