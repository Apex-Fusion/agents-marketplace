/**
 * tests/unit/indexer-ogmios-json.test.ts — integers of the transaction metadata beyond 2^53
 * (indexer/src/follower/ogmiosJson.ts, follower/metadata.ts, documents/document.ts).
 *
 * Ogmios writes a metadata integer in full digits (from -2^64 to 2^64 - 1). JSON.parse turns it into a
 * double and the digits are lost. parseOgmiosMessage keeps such an integer of `metadata.labels` exact, so
 * a label with one is still a label: the document rules of Module-1/jury/SPEC.md §10.1 decide whether it
 * is a document ("Readers ignore other keys of the map"), as in the Python reader.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { once } from "node:events";
import { createRequire } from "node:module";
import fc from "fast-check";

import { SqliteCache } from "../../indexer/src/db/cache.js";
import { parseDocument } from "../../indexer/src/documents/document.js";
import { metadataFromOgmios } from "../../indexer/src/follower/metadata.js";
import { parseOgmiosMessage } from "../../indexer/src/follower/ogmiosJson.js";
import { OgmiosSource } from "../../indexer/src/follower/ogmiosSource.js";
import { ChainSyncWorker } from "../../indexer/src/follower/worker.js";
import { textHash } from "../fixtures/indexer-side/jury-blocks.js";

const { WebSocketServer } = createRequire(new URL("../../indexer/package.json", import.meta.url))("ws");

afterEach(() => {
  vi.restoreAllMocks();
});

const TX = "c".repeat(64);
const U64_MAX = 18446744073709551615n;

interface TxMetadata {
  hash: string;
  labels: Record<string, { json: unknown }>;
}

/** The text of a nextBlock answer whose transaction has this JSON text as the `json` of label 22084. */
function nextBlock(json: string): string {
  const metadata = `{"hash":"${"ab".repeat(32)}","labels":{"22084":{"json":${json}}}}`;
  const transaction = `{"id":"${TX}","spends":"inputs","inputs":[],"outputs":[],"metadata":${metadata}}`;
  const block = `{"type":"praos","era":"conway","id":"${"b".repeat(64)}","ancestor":"${"a".repeat(64)}","height":10,"slot":500,"transactions":[${transaction}]}`;
  return `{"jsonrpc":"2.0","method":"nextBlock","result":{"direction":"forward","block":${block},"tip":{"slot":600,"id":"${"c".repeat(64)}","height":12}},"id":null}`;
}

/** The metadata of the transaction in a parsed nextBlock answer (the shape that nextBlock() builds). */
function metadataOf(message: unknown): TxMetadata {
  const answer = message as { result: { block: { transactions: Array<{ metadata: TxMetadata }> } } };
  return answer.result.block.transactions[0]!.metadata;
}

/** The same value with each bigint as a number: what JSON.parse gives for the same text. */
function lossy(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(lossy);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lossy(v)]));
  return value;
}

/** The error that `run` throws; null when it does not throw. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return null;
}

describe("parseOgmiosMessage — integers of metadata.labels", () => {
  it("an integer outside the safe range is a bigint with every digit; every other number stays a number", () => {
    const text = nextBlock(
      '{"u64":18446744073709551615,"low":-18446744073709551616,"first":9007199254740993,"safe":9007199254740991,' +
        '"list":[[18446744073709551615]],"half":1.5,"exp":1e30,"zero":-0}',
    );
    expect(metadataOf(parseOgmiosMessage(text)).labels["22084"]!.json).toStrictEqual({
      u64: U64_MAX,
      low: -(U64_MAX + 1n),
      first: 9007199254740993n,
      safe: 9007199254740991,
      list: [[U64_MAX]],
      half: 1.5,
      exp: 1e30,
      zero: -0,
    });
    // JSON.parse cannot tell 2^53 + 1 from 2^53: the digits are lost there.
    expect(metadataOf(JSON.parse(text)).labels["22084"]!.json).toMatchObject({ first: 9007199254740992 });
  });

  it("a number outside metadata.labels stays a number, as in JSON.parse", () => {
    const text =
      '{"result":{"value":{"ada":{"lovelace":12345678901234567890}},"labels":{"x":12345678901234567890},' +
      '"metadata":{"other":{"y":12345678901234567890},"labels":{"z":12345678901234567890}}}}';
    const parsed = parseOgmiosMessage(text) as {
      result: { value: { ada: { lovelace: unknown } }; labels: { x: unknown }; metadata: { other: { y: unknown }; labels: { z: unknown } } };
    };
    expect(parsed.result.value.ada.lovelace).toBe(12345678901234567890);
    expect(parsed.result.labels.x).toBe(12345678901234567890);
    expect(parsed.result.metadata.other.y).toBe(12345678901234567890);
    // Only metadata.labels is exact.
    expect(parsed.result.metadata.labels.z).toBe(12345678901234567890n);
  });

  it("gives the value of JSON.parse for any JSON text, with indentation, escapes and a key that occurs twice", () => {
    // `big` is an integer in metadata.labels: the reader runs, and it must change nothing else.
    fc.assert(
      fc.property(fc.jsonValue(), fc.constantFrom(undefined, 0, 2, "\t"), (value, indent) => {
        const labels = { "22084": { json: { big: "@@big@@", value } } };
        const answer = { result: { block: { transactions: [{ metadata: { labels } }] } }, value };
        const text = JSON.stringify(answer, null, indent).replace('"@@big@@"', U64_MAX.toString());
        const parsed = parseOgmiosMessage(text);
        expect(metadataOf(parsed).labels["22084"]!.json).toMatchObject({ big: U64_MAX });
        expect(lossy(parsed)).toStrictEqual(JSON.parse(text));
      }),
      { numRuns: 300 },
    );
    const edge =
      '{"labels":[],"pad":12345678901234567890,"s":"a\\"b\\\\c\\n\\u00e9\\ud83d\\ude42 \u2028 0x","e":{},"a":[],"w": [ 1 , { "k" : null } , true , false ],' +
      '"d":1,"d":2,"10":"ten","9":"nine","metadata":{"labels":{"1":{"json":{"x":1,"x":2,"y":[{"y":0},{"y":1}]}}}}}';
    const parsed = parseOgmiosMessage(edge) as { metadata: { labels: { "1": { json: unknown } } } };
    expect(lossy(parsed)).toStrictEqual(JSON.parse(edge));
    expect(Object.keys(parsed)).toEqual(Object.keys(JSON.parse(edge)));
    expect(parsed.metadata.labels["1"].json).toMatchObject({ x: 2 });
  });

  it("makes a key __proto__ an own property and leaves the prototype alone, as JSON.parse does", () => {
    const text = '{"labels":1,"pad":12345678901234567890,"__proto__":{"polluted":true},"o":{"__proto__":[1]}}';
    const parsed = parseOgmiosMessage(text) as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed)).toEqual(["labels", "pad", "__proto__", "o"]);
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toEqual({ polluted: true });
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(parsed).toStrictEqual(JSON.parse(text));
  });

  it("throws the error of JSON.parse for text that is not JSON", () => {
    const bad = '{"labels":{"a":18446744073709551615,}}';
    const expected = thrown(() => JSON.parse(bad));
    expect(expected).toBeInstanceOf(SyntaxError);
    expect(thrown(() => parseOgmiosMessage(bad))).toEqual(expected);
  });

  it("a value that is nested too deep for the reader is the value of JSON.parse, and a warning says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = nextBlock(`${"[".repeat(1_200)}18446744073709551615${"]".repeat(1_200)}`);
    expect(JSON.stringify(parseOgmiosMessage(text))).toBe(JSON.stringify(JSON.parse(text)));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[ogmiosJson]"));
  });
});

describe("a label with an integer beyond 2^53 — the document rules decide (SPEC §10.1)", () => {
  const fields = { v: '"v":1', t: '"t":"juror-record"', m: '"m":"application/json"', d: '"d":["{}"]' };
  /** The JSON text of a label value: the fields of a document, some replaced, and one more member. */
  const label = (replace: Partial<typeof fields> = {}, extra = ""): string =>
    `{${[...Object.values({ ...fields, ...replace }), ...(extra ? [extra] : [])].join(",")}}`;

  /** The label 22084 as the follower converts it, read as a document; null: the label is left out. */
  function read(json: string) {
    const value = metadataFromOgmios(metadataOf(parseOgmiosMessage(nextBlock(json))), TX)?.["22084"];
    return value ? parseDocument(value) : null;
  }

  it("accepts a document whose other keys hold such integers", () => {
    const accepted = { ok: true, document: { type: "juror-record", mediaType: "application/json", hash: textHash("{}") } };
    expect(read(label({}, '"note":18446744073709551615'))).toMatchObject(accepted);
    expect(read(label({}, '"extra":[[18446744073709551615],{"n":-9223372036854775809}]'))).toMatchObject(accepted);
    expect(read(`{"first":9007199254740993,${label().slice(1)}`)).toMatchObject(accepted);
  });

  it("refuses a document whose field is such an integer; the label is not left out", () => {
    expect(read(label({ v: '"v":18446744073709551615' }))).toEqual({ ok: false, reason: "v is not 1" });
    expect(read(label({ t: '"t":18446744073709551615' }))).toEqual({ ok: false, reason: 't is not a text or starts with "0x"' });
    expect(read(label({ m: '"m":-9223372036854775809' }))).toEqual({ ok: false, reason: 'm is not a text or starts with "0x"' });
    expect(read(label({ d: '"d":["{}",18446744073709551615]' }))).toEqual({ ok: false, reason: "chunk 1 is not a text" });
    expect(read(label({ d: '"d":18446744073709551615' }))).toEqual({ ok: false, reason: "d is not a list" });
  });
});

describe("the follower — an integer beyond 2^53 in label 22084 of a block from Ogmios", () => {
  it("captures the document, and refuses a document whose version is such an integer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const OK_TX = "d1".repeat(32);
    const BAD_TX = "d2".repeat(32);
    const body = '{"type":"vector-jury-record/1","vote":"AuditorWins"}';
    // JSON.stringify cannot write 18446744073709551615: the placeholder becomes the digits in the text.
    const BIG = "@@big@@";
    const transaction = (id: string, json: object) => ({
      id, spends: "inputs", inputs: [], outputs: [], metadata: { hash: "ab".repeat(32), labels: { "22084": { json } } },
    });
    const block = {
      type: "praos", era: "conway", id: "b".repeat(64), ancestor: "a".repeat(64), height: 10, slot: 500,
      transactions: [
        transaction(OK_TX, { v: 1, t: "juror-record", m: "application/json", d: [body], note: BIG }),
        transaction(BAD_TX, { v: BIG, t: "juror-record", m: "application/json", d: [body] }),
      ],
    };
    const text = JSON.stringify({
      jsonrpc: "2.0", method: "nextBlock", result: { direction: "forward", block, tip: { slot: 600, id: "c".repeat(64), height: 12 } },
    }).replaceAll(`"${BIG}"`, U64_MAX.toString());
    expect(text).toContain(`"note":${U64_MAX}`);

    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    let sent = false;
    server.on("connection", (socket: { on(event: "message", listener: (data: Buffer) => void): void; send(data: string): void }) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString());
        if (request.method === "findIntersection") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "findIntersection", result: { intersection: "origin" } }));
        } else if (request.method === "nextBlock" && !sent) {
          sent = true;
          socket.send(text);
        }
      });
    });
    const cache = new SqliteCache(":memory:");
    const source = new OgmiosSource(`ws://127.0.0.1:${server.address().port}`, { responseTimeoutMs: 0 });
    const worker = new ChainSyncWorker({
      source, cache, networkId: 0, addresses: { advertAddress: "advert-script", escrowAddress: "escrow-script" },
    });
    try {
      await worker.start();
      await vi.waitFor(() => expect(cache.getCursor()).toEqual({ slot: 500, blockHash: "b".repeat(64) }));
      expect(cache.getDocument(OK_TX)).toMatchObject({ type: "juror-record", media_type: "application/json", hash: textHash(body) });
      expect(cache.getDocument(OK_TX)?.bytes.toString("utf8")).toBe(body);
      expect(cache.getDocument(BAD_TX)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`tx ${BAD_TX}: metadata label 22084 is not a document (v is not 1)`));
    } finally {
      worker.stop();
      cache.close();
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
});
