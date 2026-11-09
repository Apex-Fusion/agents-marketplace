/**
 * tests/unit/indexer-documents.test.ts — documents on chain (Module-1/jury/SPEC.md §10).
 *
 * Covers the Ogmios v6 metadata converter (`json` and `cbor` forms), the
 * label 22084 document parser (chunk join, the 0x rule, the 64-byte rule),
 * the vector-tx URI, the capture of the document of every transaction (also
 * one that touches no watched address), the rollback, and the /documents
 * routes.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";

import { metadataFromOgmios, metadatumFromCbor, metadatumFromJson, metadatumFromOgmios } from "../../indexer/src/follower/metadata.js";
import { fromOgmiosBlock } from "../../indexer/src/follower/ogmiosBlock.js";
import { processBlock } from "../../indexer/src/follower/blockProcessor.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import type { IndexerBlock, IndexerTx, Metadatum } from "../../indexer/src/follower/types.js";
import { SqliteCache } from "../../indexer/src/db/cache.js";
import { parseDocument, txIdFromVectorTxUri, vectorTxUri } from "../../indexer/src/documents/document.js";
import { createApp } from "../../indexer/src/server.js";
import { MockChainSyncSource } from "./__helpers__/MockChainSyncSource.js";
import { ADVERT_SCRIPT_ADDRESS, ESCROW_SCRIPT_ADDRESS } from "../fixtures/indexer-side/sample-blocks.js";
import { chunks, documentMetadatum, textHash } from "../fixtures/indexer-side/jury-blocks.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── A minimal CBOR writer for metadata (RFC 8949) ────────────────────────────

function head(major: number, n: number): string {
  const type = major << 5;
  if (n < 24) return (type | n).toString(16).padStart(2, "0");
  if (n < 0x100) return (type | 24).toString(16) + n.toString(16).padStart(2, "0");
  return (type | 25).toString(16) + n.toString(16).padStart(4, "0");
}

/** CBOR hex of a metadatum; `indefinite` writes lists and texts with indefinite lengths. */
function cbor(m: Metadatum, indefinite = false): string {
  switch (m.kind) {
    case "int":
      return m.value >= 0n ? head(0, Number(m.value)) : head(1, Number(-1n - m.value));
    case "bytes":
      return head(2, m.hex.length / 2) + m.hex;
    case "text": {
      const hex = Buffer.from(m.value, "utf8").toString("hex");
      if (!indefinite || hex.length < 4) return head(3, hex.length / 2) + hex;
      // Two definite chunks inside an indefinite text (split at a byte that starts a character).
      const bytes = Buffer.from(m.value, "utf8");
      let cut = 1;
      while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
      const a = bytes.subarray(0, cut).toString("hex");
      const b = bytes.subarray(cut).toString("hex");
      return `7f${head(3, a.length / 2)}${a}${head(3, b.length / 2)}${b}ff`;
    }
    case "list":
      return indefinite
        ? `9f${m.items.map((i) => cbor(i, indefinite)).join("")}ff`
        : head(4, m.items.length) + m.items.map((i) => cbor(i, indefinite)).join("");
    case "map":
      return head(5, m.entries.length) + m.entries.map(([k, v]) => cbor(k, indefinite) + cbor(v, indefinite)).join("");
  }
}

const text = (value: string): Metadatum => ({ kind: "text", value });
const docMap = (entries: Array<[string, Metadatum]>): Metadatum => ({
  kind: "map",
  entries: entries.map(([k, v]) => [text(k), v]),
});
const one: Metadatum = { kind: "int", value: 1n };
const chunkList = (items: string[]): Metadatum => ({ kind: "list", items: items.map(text) });

const SAMPLE = '{"type":"vector-jury-record/1","reason":"Die Prüfung schlägt fehl — 証拠が不足 🙂","vote":"AuditorWins"}';

// ─── Ogmios metadata converter ────────────────────────────────────────────────

describe("metadata converter — Ogmios v6 json and cbor forms", () => {
  it("converts the plain JSON form: integers, texts, lists and text-keyed maps", () => {
    expect(metadatumFromJson({ v: 1, t: "claim", d: ["ab", "cd"] })).toEqual(
      docMap([["v", one], ["t", text("claim")], ["d", chunkList(["ab", "cd"])]]),
    );
    expect(metadatumFromJson(-5)).toEqual({ kind: "int", value: -5n });
  });

  it("refuses JSON values that are not metadata or lost precision", () => {
    expect(metadatumFromJson(null)).toBeNull();
    expect(metadatumFromJson({ a: true })).toBeNull();
    expect(metadatumFromJson([1.5])).toBeNull();
    expect(metadatumFromJson(2 ** 60)).toBeNull();
  });

  it("converts an integer outside the safe range that arrives as a bigint with its exact value", () => {
    const big = (value: bigint): Metadatum => ({ kind: "int", value });
    expect(metadatumFromJson({ v: 1, high: 2n ** 64n - 1n, low: -(2n ** 64n), list: [2n ** 53n] })).toEqual(
      docMap([["v", one], ["high", big(2n ** 64n - 1n)], ["low", big(-(2n ** 64n))], ["list", { kind: "list", items: [big(2n ** 53n)] }]]),
    );
  });

  it("converts the CBOR form, with definite and indefinite lengths, byte strings and big integers", () => {
    const value = docMap([["v", one], ["t", text("claim")], ["d", chunkList(["hé", "llo"])]]);
    expect(metadatumFromCbor(cbor(value))).toEqual(value);
    expect(metadatumFromCbor(cbor(value, true))).toEqual(value);
    expect(metadatumFromCbor("43010203")).toEqual({ kind: "bytes", hex: "010203" });
    // Tag 2 (positive big number) of 9 bytes: 2^64.
    expect(metadatumFromCbor("c249010000000000000000")).toEqual({ kind: "int", value: 1n << 64n });
    expect(metadatumFromCbor("c349010000000000000000")).toEqual({ kind: "int", value: -1n - (1n << 64n) });
  });

  it("refuses CBOR that is not exactly one metadatum", () => {
    expect(metadatumFromCbor("f5")).toBeNull(); // true
    expect(metadatumFromCbor("0101")).toBeNull(); // trailing bytes
    expect(metadatumFromCbor("xyz")).toBeNull();
    expect(metadatumFromCbor("d8798080")).toBeNull(); // tag 121 and trailing bytes
  });

  it("prefers cbor (the exact value) and falls back to json", () => {
    const fromCbor = docMap([["t", text("claim")]]);
    expect(metadatumFromOgmios({ json: { t: "other" }, cbor: cbor(fromCbor) })).toEqual(fromCbor);
    expect(metadatumFromOgmios({ json: { t: "other" }, cbor: "zz" })).toEqual(docMap([["t", text("other")]]));
    expect(metadatumFromOgmios({})).toBeNull();
  });

  it("reads every label of `metadata.labels` and leaves out a label that does not convert", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = metadataFromOgmios(
      { hash: "ab".repeat(32), labels: { "674": { json: { msg: ["hi"] } }, "22084": { cbor: "43010203" }, "7": { json: null } } },
      "c".repeat(64),
    );
    expect(out).toEqual({
      "674": docMap([["msg", chunkList(["hi"])]]),
      "22084": { kind: "bytes", hex: "010203" },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("metadata label 7"));
    expect(metadataFromOgmios(undefined, "c".repeat(64))).toBeUndefined();
  });
});

// ─── Document parser ──────────────────────────────────────────────────────────

describe("parseDocument — label 22084 (SPEC §10.1)", () => {
  const exact = new TextEncoder().encode(SAMPLE);

  it("joins the chunks into the exact document bytes and hashes them with blake2b-256", () => {
    const parsed = parseDocument(documentMetadatum("juror-record", SAMPLE));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(chunks(SAMPLE).length).toBeGreaterThan(1);
    expect(Buffer.from(parsed.document.bytes).equals(Buffer.from(exact))).toBe(true);
    expect(parsed.document).toMatchObject({ type: "juror-record", mediaType: "application/json", hash: textHash(SAMPLE) });
  });

  it("gives the same bytes and hash from the JSON form and the CBOR form", () => {
    const value = documentMetadatum("claim", SAMPLE);
    const viaJson = metadatumFromOgmios({ json: JSON.parse(JSON.stringify({ v: 1, t: "claim", m: "application/json", d: chunks(SAMPLE) })) });
    const viaCbor = metadatumFromOgmios({ cbor: cbor(value) });
    const viaIndefinite = metadatumFromOgmios({ cbor: cbor(value, true) });
    const hashes = [viaJson, viaCbor, viaIndefinite].map((m) => {
      const parsed = parseDocument(m!);
      return parsed.ok ? parsed.document.hash : parsed.reason;
    });
    expect(hashes).toEqual([textHash(SAMPLE), textHash(SAMPLE), textHash(SAMPLE)]);
  });

  it("keeps a byte order mark at the start of a chunk (exact bytes)", () => {
    const withBom = "\ufeff{\"a\":1}";
    const parsed = parseDocument(metadatumFromOgmios({ cbor: cbor(documentMetadatum("claim", withBom)) })!);
    expect(parsed.ok && Buffer.from(parsed.document.bytes).toString("hex")).toBe(Buffer.from(withBom, "utf8").toString("hex"));
  });

  it("the 0x rule: a chunk that starts with 0x makes the value no document", () => {
    const value = docMap([["v", one], ["t", text("claim")], ["m", text("text/plain")], ["d", chunkList(["abc", "0xdead"])]]);
    expect(parseDocument(value)).toEqual({ ok: false, reason: 'chunk 1 starts with "0x"' });
    const inside = docMap([["v", one], ["t", text("claim")], ["m", text("text/plain")], ["d", chunkList(["a0x", "x0x"])]]);
    expect(parseDocument(inside).ok).toBe(true);
  });

  it("refuses a chunk of more than 64 bytes and a chunk that is not a text", () => {
    const long = docMap([["v", one], ["t", text("claim")], ["m", text("text/plain")], ["d", chunkList(["é".repeat(33)])]]);
    expect(parseDocument(long)).toEqual({ ok: false, reason: "chunk 0 is longer than 64 bytes" });
    const bytes = docMap([["v", one], ["t", text("claim")], ["m", text("text/plain")], ["d", { kind: "list", items: [{ kind: "bytes", hex: "00" }] }]]);
    expect(parseDocument(bytes)).toEqual({ ok: false, reason: "chunk 0 is not a text" });
  });

  it("refuses other versions and missing fields; ignores other keys", () => {
    const base: Array<[string, Metadatum]> = [["v", one], ["t", text("claim")], ["m", text("text/plain")], ["d", chunkList(["x"])]];
    expect(parseDocument(docMap([["v", { kind: "int", value: 2n }], ...base.slice(1)])).ok).toBe(false);
    expect(parseDocument(docMap(base.filter(([k]) => k !== "t"))).ok).toBe(false);
    expect(parseDocument(docMap(base.filter(([k]) => k !== "m"))).ok).toBe(false);
    expect(parseDocument(docMap([...base.slice(0, 3), ["d", text("x")]])).ok).toBe(false);
    expect(parseDocument(docMap([...base, ["note", text("ignored")]])).ok).toBe(true);
    expect(parseDocument(chunkList(["x"])).ok).toBe(false);
  });

  it("a key that occurs twice: the last value counts, as the Python reader reads the map into a dictionary", () => {
    const base: Array<[string, Metadatum]> = [["v", one], ["t", text("claim")], ["m", text("text/plain")], ["d", chunkList(["old"])]];
    const bytesOf = (value: Metadatum): [string, string] | string => {
      const parsed = parseDocument(value);
      return parsed.ok ? [parsed.document.type, Buffer.from(parsed.document.bytes).toString("utf8")] : parsed.reason;
    };

    // Accepted: the last t and the last d count, in the Metadatum, in the CBOR form and in the JSON form (JSON.parse keeps the last key).
    const twice = docMap([...base, ["t", text("evidence")], ["d", chunkList(["ne", "w"])]]);
    const viaCbor = metadatumFromOgmios({ cbor: cbor(twice) });
    const viaJson = metadatumFromOgmios({ json: JSON.parse('{"v":1,"t":"claim","m":"text/plain","d":["old"],"t":"evidence","d":["ne","w"]}') });
    expect(viaCbor).toEqual(twice);
    for (const value of [twice, viaCbor!, viaJson!]) expect(bytesOf(value)).toEqual(["evidence", "new"]);
    // An earlier value that is not valid does not matter when the last value is valid.
    expect(bytesOf(docMap([["v", { kind: "int", value: 2n }], ...base]))).toEqual(["claim", "old"]);
    expect(bytesOf(docMap([["d", { kind: "list", items: [{ kind: "bytes", hex: "00" }] }], ...base]))).toEqual(["claim", "old"]);

    // Refused: the last value is not valid, whatever an earlier value was.
    expect(bytesOf(docMap([...base, ["v", { kind: "int", value: 2n }]]))).toBe("v is not 1");
    expect(bytesOf(docMap([...base, ["m", { kind: "bytes", hex: "00" }]]))).toBe('m is not a text or starts with "0x"');
    expect(bytesOf(docMap([...base, ["d", chunkList(["0xab"])]]))).toBe('chunk 0 starts with "0x"');
  });

  it("an empty chunk list is an empty document", () => {
    const parsed = parseDocument(docMap([["v", one], ["t", text("claim")], ["m", text("text/plain")], ["d", chunkList([])]]));
    expect(parsed.ok && parsed.document.bytes.length).toBe(0);
  });
});

describe("vector-tx URI (SPEC §10.2)", () => {
  const TX = `72ef1290${"00".repeat(28)}`;

  it("is vector-tx: and the unpadded base64url of the 32 bytes (53 characters)", () => {
    const uri = vectorTxUri(TX);
    expect(uri.startsWith("vector-tx:cu8Sk")).toBe(true);
    expect(uri).toHaveLength(53);
    expect(txIdFromVectorTxUri(uri)).toBe(TX);
  });

  it("refuses other texts, other lengths and a non-canonical last character", () => {
    const uri = vectorTxUri(TX);
    expect(txIdFromVectorTxUri("https://example.org/x")).toBeNull();
    expect(txIdFromVectorTxUri(uri.slice(0, -1))).toBeNull();
    expect(txIdFromVectorTxUri(`${uri.slice(0, -1)}B`)).toBeNull(); // unused bits not zero
    expect(txIdFromVectorTxUri(`${uri.slice(0, -1)}+`)).toBeNull();
  });
});

// ─── Ogmios block conversion ──────────────────────────────────────────────────

describe("fromOgmiosBlock — metadata and block height", () => {
  it("keeps the block height and the metadata of each transaction", () => {
    const block = fromOgmiosBlock({
      type: "praos",
      era: "conway",
      id: "b".repeat(64),
      ancestor: "a".repeat(64),
      height: 4321,
      slot: 100,
      transactions: [{
        id: "C".repeat(64),
        spends: "inputs",
        inputs: [],
        outputs: [],
        metadata: { hash: "ab".repeat(32), labels: { "22084": { json: { v: 1, t: "claim", m: "text/plain", d: ["hi"] } } } },
      }],
    });
    expect(block.height).toBe(4321);
    const tx = block.transactions![0]!;
    expect(tx.metadata?.["22084"]).toEqual(docMap([["v", one], ["t", text("claim")], ["m", text("text/plain")], ["d", chunkList(["hi"])]]));
  });
});

// ─── Capture ──────────────────────────────────────────────────────────────────

const DOC_TX = "d0".repeat(32);
const ADDRESSES = { advertAddress: ADVERT_SCRIPT_ADDRESS, escrowAddress: ESCROW_SCRIPT_ADDRESS };

function documentTx(id: string, type: string, body: string): IndexerTx {
  return { id, inputs: [{ transaction: { id: "9".repeat(64) }, index: 0 }], outputs: [], metadata: { "22084": documentMetadatum(type, body) } };
}

function block(slot: number, transactions: IndexerTx[], height = slot / 10): IndexerBlock {
  return { slot, id: slot.toString(16).padStart(64, "0"), height, transactions };
}

describe("document capture — every transaction", () => {
  it("processBlock captures the document of a transaction that touches no watched address", () => {
    const { documents, created } = processBlock(block(100, [documentTx(DOC_TX, "claim", SAMPLE)]), new Map(), ADDRESSES);
    expect(created).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ txHash: DOC_TX, type: "claim", mediaType: "application/json", hash: textHash(SAMPLE) });
  });

  it("logs a label 22084 value that is not a document and captures nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx: IndexerTx = { id: DOC_TX, inputs: [], outputs: [], metadata: { "22084": chunkList(["0xab"]) } };
    expect(processBlock(block(100, [tx]), new Map(), ADDRESSES).documents).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is not a document"));
  });

  it("the worker stores the exact bytes with slot and height; a rollback removes them", async () => {
    const cache = new SqliteCache(":memory:");
    const source = new MockChainSyncSource([]);
    const worker = new ChainSyncWorker({ source, cache, networkId: 0, addresses: ADDRESSES });
    await worker.start();
    source.pushEvent({ kind: "block", block: block(100, [documentTx(DOC_TX, "claim", SAMPLE)], 77) });
    source.pushEvent({ kind: "block", block: block(200, [documentTx("d1".repeat(32), "evidence", "e")]) });
    const stored = cache.getDocument(DOC_TX)!;
    expect(stored).toMatchObject({ slot: 100, block_height: 77, type: "claim", hash: textHash(SAMPLE) });
    expect(stored.bytes.toString("utf8")).toBe(SAMPLE);
    expect(cache.getDocumentSummaries([DOC_TX]).get(DOC_TX)?.size).toBe(Buffer.byteLength(SAMPLE));

    source.pushEvent({ kind: "rollback", point: { slot: 100, id: (100).toString(16).padStart(64, "0") } });
    expect(cache.getDocument("d1".repeat(32))).toBeNull();
    expect(cache.getDocument(DOC_TX)).not.toBeNull();
    cache.close();
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

describe("GET /documents/:tx and /documents/by-hash/:hash", () => {
  async function app() {
    const cache = new SqliteCache(":memory:");
    const source = new MockChainSyncSource([]);
    const worker = new ChainSyncWorker({ source, cache, networkId: 0, addresses: ADDRESSES });
    await worker.start();
    source.pushEvent({ kind: "block", block: block(100, [documentTx(DOC_TX, "claim", SAMPLE)], 9) });
    source.pushEvent({ kind: "block", block: block(200, [documentTx("d2".repeat(32), "claim", SAMPLE)], 10) });
    return createApp({ cache, worker }, { networkId: 0 });
  }

  it("returns the exact bytes and the metadata by transaction id or vector-tx URI", async () => {
    const server = await app();
    const res = await request(server).get(`/documents/${DOC_TX}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tx: DOC_TX,
      uri: vectorTxUri(DOC_TX),
      slot: 100,
      block_height: 9,
      label: 22084,
      type: "claim",
      media_type: "application/json",
      hash: textHash(SAMPLE),
      size: Buffer.byteLength(SAMPLE),
      bytes_hex: Buffer.from(SAMPLE, "utf8").toString("hex"),
      text: SAMPLE,
    });
    const viaUri = await request(server).get(`/documents/${encodeURIComponent(vectorTxUri(DOC_TX))}`);
    expect(viaUri.body.tx).toBe(DOC_TX);
  });

  it("finds a document by its hash: the first one on chain, with every transaction that carries it", async () => {
    const server = await app();
    const res = await request(server).get(`/documents/by-hash/${textHash(SAMPLE).toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.tx).toBe(DOC_TX);
    expect(res.body.txs).toEqual([DOC_TX, "d2".repeat(32)]);
  });

  it("answers 404 for an unknown document and 400 for a malformed id or hash", async () => {
    const server = await app();
    expect((await request(server).get(`/documents/${"e".repeat(64)}`)).status).toBe(404);
    expect((await request(server).get(`/documents/by-hash/${"e".repeat(64)}`)).status).toBe(404);
    expect((await request(server).get("/documents/xyz")).status).toBe(400);
    expect((await request(server).get("/documents/by-hash/xyz")).status).toBe(400);
  });
});
