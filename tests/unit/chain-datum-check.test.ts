/**
 * chain-datum-check.test.ts — the check at the boundary of the Ogmios clients.
 *
 * A datum that is nested deeper than 64 levels, or that is not CBOR that the decoders read, is withheld: the output stays in the
 * list with no datum. A native script that fails the check leaves the output out of the answer. One log line for each output
 * reference, one time, names the reference (never the bytes). A Plutus script is opaque bytes and is mapped as before.
 *
 * Covered: OgmiosLucidProvider (getUtxos, getUtxosByOutRef), ReadOnlyOgmiosProvider (queryUtxo, queryUtxosByAddress) and
 * LiveOgmiosProvider, which reads through the read-only one.
 */

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { OgmiosLucidProvider } from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { MAX_CBOR_DEPTH } from "../../packages/shared/src/cbor-depth.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { encodeIdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { encodeIdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { encodeIdentityDatum } from "../../packages/shared/src/cbor/IdentityDatum.js";
import { plutusAddressFromBech32 } from "../../packages/shared/src/cbor/address.js";
import { buildSampleEscrowDatum } from "../fixtures/buyer-side/escrow-datum-builders.js";
import { buildSampleAdvertDatum } from "../fixtures/buyer-side/advert-datum-builders.js";
import { activeRecord, buyer, newAdvert, newEscrow } from "../fixtures/buyer-side/identity-world.js";

const URL = "http://ogmios.test";
const ADDRESS = "addr1vyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkdl5mw";
// A new transaction hash for each test: the clients remember the references that they reported.
let TX = "ab".repeat(32);

const rep = (piece: string, times: number): string => piece.repeat(times);
/** `levels` arrays inside each other; the leaf is the integer 0. */
const arrays = (levels: number): string => `${rep("81", levels)}00`;
/** `levels` maps inside each other. */
const maps = (levels: number): string => `${rep("a100", levels)}00`;
/** A native script that nests `scripts` "all" scripts (2 levels of CBOR for each) around a signature script. */
const nativeScript = (scripts: number): string => `${rep("820181", scripts)}8200581c${rep("11", 28)}`;

interface OgmiosOutput {
  transaction: { id: string };
  index: number;
  address: string;
  value: { ada: { lovelace: number } };
  datum?: string | null;
  datumHash?: string | null;
  script?: unknown;
}

function output(index: number, extra: Partial<OgmiosOutput> = {}): OgmiosOutput {
  return {
    transaction: { id: TX },
    index,
    address: ADDRESS,
    value: { ada: { lovelace: 2_000_000 + index } },
    datum: null,
    datumHash: null,
    script: null,
    ...extra,
  };
}

interface OutputReferences {
  params?: { outputReferences?: Array<{ transaction: { id: string }; index: number }> };
}

/** A fetch that answers every query with `result`, except a query by reference: that answer holds only the outputs that were asked for. */
function fetchOf(result: unknown): typeof globalThis.fetch {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const query: OutputReferences = JSON.parse(String(init?.body));
    const references = query.params?.outputReferences;
    const answer = references === undefined || !Array.isArray(result)
      ? result
      : result.filter((o: OgmiosOutput) => references.some((r) => r.transaction.id === o.transaction.id && r.index === o.index));
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ jsonrpc: "2.0", result: answer }) };
  }) as unknown as typeof globalThis.fetch;
}

const lucid = (result: unknown) => new OgmiosLucidProvider({ ogmiosUrl: URL, fetch: fetchOf(result) });
const readOnly = (result: unknown) => new ReadOnlyOgmiosProvider({ ogmiosUrl: URL, fetch: fetchOf(result) });
const live = (result: unknown) => new LiveOgmiosProvider({ ogmiosUrl: URL, fetch: fetchOf(result) });

/** The same answers through the clients of both kinds: the datum of output `index`, or null. */
async function datumsOf(result: OgmiosOutput[]): Promise<{ lucid: Array<string | null>; readOnly: Array<string | null>; live: Array<string | null> }> {
  const lucidUtxos = await lucid(result).getUtxos(ADDRESS);
  const readOnlyUtxos = await readOnly(result).queryUtxosByAddress(ADDRESS);
  const liveUtxos = await live(result).queryUtxosByAddress(ADDRESS);
  return {
    lucid: lucidUtxos.map((u) => u.datum ?? null),
    readOnly: readOnlyUtxos.map((u) => u.datumHex),
    live: liveUtxos.map((u) => u.datumHex),
  };
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  TX = randomBytes(32).toString("hex");
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("the check of an inline datum at the Ogmios clients", () => {
  it("passes a datum that nests 64 levels and withholds one that nests 65", async () => {
    const answers = await datumsOf([output(0, { datum: arrays(MAX_CBOR_DEPTH) }), output(1, { datum: arrays(MAX_CBOR_DEPTH + 1) })]);
    for (const datums of [answers.lucid, answers.readOnly, answers.live]) expect(datums).toEqual([arrays(MAX_CBOR_DEPTH), null]);
  });

  it.each([
    ["arrays inside each other", arrays(5000)],
    ["maps inside each other", maps(2500)],
    ["indefinite-length arrays inside each other", `${rep("9f", 70)}00${rep("ff", 70)}`],
    ["tags inside each other", `${rep("d87a", 70)}00`],
  ])("withholds a datum that nests too deep: %s", async (_name, datum) => {
    const answers = await datumsOf([output(0, { datum })]);
    expect(answers).toEqual({ lucid: [null], readOnly: [null], live: [null] });
  });

  it.each([
    ["text that is not hex", "zz"],
    ["hex of an odd length", "d8798"],
    ["CBOR that ends inside an item", "d879"],
    ["an array that has no break code", "9f01"],
    ["a break code with no array", "ff"],
    ["a reserved header", "de"],
    ["a float, which Plutus data does not hold", "fb3ff0000000000000"],
    ["whitespace", "  "],
  ])("withholds a datum that is not CBOR that the decoders read: %s", async (_name, datum) => {
    const answers = await datumsOf([output(0, { datum })]);
    expect(answers).toEqual({ lucid: [null], readOnly: [null], live: [null] });
  });

  it.each([
    ["a byte string with a declared length far past the input", "5a80000000"],
    ["a byte string with the largest declared length", "5bffffffffffffffff"],
    ["an array with the largest declared count", "9bffffffffffffffff"],
    ["a map with a declared count past the input", "bb0000000100000000"],
    ["an array with a declared count past the input", "9a000f424000"],
  ])("withholds a datum with a length or a count past the end, and allocates nothing for it: %s", async (_name, datum) => {
    const before = process.memoryUsage().arrayBuffers;
    const answers = await datumsOf([output(0, { datum })]);
    expect(answers).toEqual({ lucid: [null], readOnly: [null], live: [null] });
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(8 * 1024 * 1024);
  });

  it("keeps the output in the list with its address, value, hash datum and script", async () => {
    const withheld = output(1, { datum: arrays(5000), datumHash: "cd".repeat(32), value: { ada: { lovelace: 7_654_321 } } });
    const utxos = await lucid([output(0), withheld, output(2)]).getUtxos(ADDRESS);
    expect(utxos.map((u) => u.outputIndex)).toEqual([0, 1, 2]);
    expect(utxos[1]).toMatchObject({ txHash: TX, outputIndex: 1, address: ADDRESS, assets: { lovelace: 7_654_321n }, datumHash: "cd".repeat(32), datum: null, scriptRef: null });
    const plain = await readOnly([output(0), withheld, output(2)]).queryUtxosByAddress(ADDRESS);
    expect(plain.map((u) => u.ref.index)).toEqual([0, 1, 2]);
    expect(plain[1]).toMatchObject({ ref: { txHash: TX, index: 1 }, address: ADDRESS, lovelace: 7_654_321n, datumHex: null });
  });

  it("treats queryUtxo and getUtxosByOutRef the same way", async () => {
    const result = [output(3, { datum: arrays(65) })];
    const ref = { txHash: TX, index: 3 };
    expect((await readOnly(result).queryUtxo(ref))?.datumHex).toBeNull();
    expect((await live(result).queryUtxo(ref))?.datumHex).toBeNull();
    const [byRef] = await lucid(result).getUtxosByOutRef([{ txHash: TX, outputIndex: 3 }]);
    expect(byRef?.datum).toBeNull();
    expect(byRef?.outputIndex).toBe(3);
  });

  it("does not change an answer with no datum, a hash datum, an empty datum or a valid datum, and writes no line for it", async () => {
    const valid = "d8799f0102ff";
    const result = [output(0), output(1, { datumHash: "ef".repeat(32) }), output(2, { datum: valid })];
    const lucidUtxos = await lucid(result).getUtxos(ADDRESS);
    expect(lucidUtxos.map((u) => [u.datum, u.datumHash])).toEqual([[null, null], [null, "ef".repeat(32)], [valid, null]]);
    const readOnlyUtxos = await readOnly(result).queryUtxosByAddress(ADDRESS);
    expect(readOnlyUtxos.map((u) => u.datumHex)).toEqual([null, null, valid]);
    // An empty datum text is no datum: it is not counted as a withheld one.
    expect((await readOnly([output(0, { datum: "" })]).queryUtxosByAddress(ADDRESS))[0]?.datumHex).toBeNull();
    expect((await lucid([output(0, { datum: "" })]).getUtxos(ADDRESS))[0]?.datum).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes every datum that this repository writes", async () => {
    const identityEscrow = newEscrow();
    const datums = [
      encodeEscrowDatum(buildSampleEscrowDatum()),
      encodeAdvertDatum(buildSampleAdvertDatum()),
      encodeIdentityEscrowDatum(identityEscrow),
      encodeIdentityEscrowDatum({
        ...identityEscrow,
        refund: { address: plutusAddressFromBech32(buyer.address), datum: { kind: "list", items: [{ kind: "int", value: 5n }, { kind: "bytes", hex: "6162" }] } },
      }),
      encodeIdentityAdvertDatum(newAdvert()),
      encodeIdentityDatum(activeRecord()),
    ];
    const result = datums.map((datum, index) => output(index, { datum }));
    const answers = await datumsOf(result);
    expect(answers.lucid).toEqual(datums);
    expect(answers.readOnly).toEqual(datums);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the log lines of the check: one line for each output reference", () => {
  const long = arrays(5000);
  const linesOf = (): string[] => warn.mock.calls.map((call) => String(call.join(" ")));

  it("writes one line for each reference of an answer, with the reference and never the bytes", async () => {
    const result = [output(0), output(1, { datum: long }), output(2, { datum: "zz" }), output(3, { datum: "d87980" }), output(4, { datum: long })];
    await lucid(result).getUtxos(ADDRESS);
    const lines = linesOf();
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.match(/[0-9a-f]{64}#\d+/)?.[0])).toEqual([`${TX}#1`, `${TX}#2`, `${TX}#4`]);
    for (const line of lines) {
      expect(line).not.toContain(long.slice(0, 40));
      expect(line).not.toContain("zz");
      expect(line.length).toBeLessThan(300);
    }
  });

  it("says a reference one time: a second read of the same output writes nothing, also through another client", async () => {
    const result = [output(1, { datum: long })];
    await lucid(result).getUtxos(ADDRESS);
    expect(warn).toHaveBeenCalledTimes(1);
    await lucid(result).getUtxos(ADDRESS);
    await readOnly(result).queryUtxosByAddress(ADDRESS);
    await live(result).queryUtxo({ txHash: TX, index: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("remembers at most 1,000 references, and says the oldest again when it comes back", async () => {
    const first = output(0, { datum: long });
    await readOnly([first]).queryUtxosByAddress(ADDRESS);
    expect(warn).toHaveBeenCalledTimes(1);
    for (let batch = 0; batch < 11; batch += 1) {
      await readOnly(Array.from({ length: 100 }, (_unused, i) => output(1 + batch * 100 + i, { datum: long }))).queryUtxosByAddress(ADDRESS);
    }
    warn.mockClear();
    await readOnly([first]).queryUtxosByAddress(ADDRESS); // 1,100 newer references came after it: it is said again
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    await readOnly([output(1100, { datum: long })]).queryUtxosByAddress(ADDRESS); // the newest is still remembered
    expect(warn).not.toHaveBeenCalled();
  });

  it("writes at most 20 lines for one answer, and one line for the rest", async () => {
    await lucid(Array.from({ length: 45 }, (_unused, i) => output(i, { datum: long }))).getUtxos(ADDRESS);
    const lines = linesOf();
    expect(lines).toHaveLength(21);
    expect(lines[20]).toContain("25 more");
  });

  it("writes one line for a single output of queryUtxo, and none for an answer that holds no such output", async () => {
    await readOnly([output(0, { datum: long })]).queryUtxo({ txHash: TX, index: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(linesOf()[0]).toContain(`${TX}#0`);
    warn.mockClear();
    await readOnly([output(1, { datum: "d87980" })]).queryUtxo({ txHash: TX, index: 1 });
    await readOnly([]).queryUtxo({ txHash: TX, index: 2 });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the check of a reference script at the Ogmios clients", () => {
  // The rule: an output whose reference script fails the check is left OUT of the answer. When such an output is spent, the ledger
  // asks a fee for its script, and a transaction that does not count the script gets a fee that is too low. An output with a
  // withheld datum stays in the list, because a datum costs no fee.
  const shallow = nativeScript(31); // 63 levels
  const deep = nativeScript(32); // 65 levels
  const linesOf = (): string[] => warn.mock.calls.map((call) => String(call.join(" ")));

  it("Lucid client: leaves out a wallet output and an escrow output with such a script, keeps the others, and keeps a valid script mapped", async () => {
    const answer = [
      output(0, { script: { language: "native", cbor: shallow } }),
      output(1, { script: { language: "native", cbor: deep } }), // a wallet output
      output(2, { datum: "d87980" }),
      output(3, { datum: "d87980", script: { language: "native", cbor: nativeScript(2000) } }), // an escrow output
      output(4),
    ];
    const utxos = await lucid(answer).getUtxos(ADDRESS);
    expect(utxos.map((u) => u.outputIndex)).toEqual([0, 2, 4]);
    expect(utxos[0]?.scriptRef).toEqual({ type: "Native", script: shallow });
    expect(utxos[1]?.datum).toBe("d87980");
    expect(await lucid(answer).getUtxosByOutRef([{ txHash: TX, outputIndex: 3 }])).toEqual([]);
    const lines = linesOf();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`${TX}#1`);
    expect(lines[0]).toContain("left out");
    expect(lines[0]).not.toContain(deep.slice(0, 30));
    expect(lines[1]).toContain(`${TX}#3`);
  });

  it("read-only and live clients: leave out the same outputs, answer null for an escrow output with such a script, and keep a valid script as before", async () => {
    const answer = [
      output(0, { script: { language: "native", cbor: shallow } }),
      output(1, { script: { language: "native", cbor: deep } }),
      output(2, { datum: "d87980" }),
      output(3, { datum: "d87980", script: { language: "native", cbor: nativeScript(2000) } }),
    ];
    for (const client of [readOnly(answer), live(answer)]) {
      const utxos = await client.queryUtxosByAddress(ADDRESS);
      expect(utxos.map((u) => u.ref.index)).toEqual([0, 2]);
      expect(utxos[0]?.scriptRef).toBeNull(); // only a Plutus V3 script maps at these clients, as before
      expect(utxos[1]?.datumHex).toBe("d87980");
      expect(await client.queryUtxo({ txHash: TX, index: 3 })).toBeNull();
    }
    expect((await readOnly([answer[0]!]).queryUtxo({ txHash: TX, index: 0 }))?.ref.index).toBe(0);
  });

  it("leaves out an output whose native script is not CBOR that the decoders read", async () => {
    const answer = [
      output(0, { datum: "d87980", script: { language: "native", cbor: "zz" } }),
      output(1, { script: { language: "native", cbor: "" } }),
      output(2, { script: { language: "native", cbor: "5a80000000" } }),
      output(3),
    ];
    expect((await lucid(answer).getUtxos(ADDRESS)).map((u) => u.outputIndex)).toEqual([3]);
    expect((await readOnly(answer).queryUtxosByAddress(ADDRESS)).map((u) => u.ref.index)).toEqual([3]);
  });

  it("writes one line for an output whose datum and native script both fail, and it says that the output is left out", async () => {
    await lucid([output(5, { datum: arrays(100), script: { language: "native", cbor: nativeScript(100) } })]).getUtxos(ADDRESS);
    expect(linesOf()).toHaveLength(1);
    expect(linesOf()[0]).toContain("left out");
  });

  it("maps a Plutus script as before: its bytes are opaque and are not scanned", async () => {
    const script = "5901ab0101002229800aba2aba1";
    const odd = arrays(5000); // not a script that a ledger accepts; the client does not look inside
    const utxos = await lucid([
      output(0, { script: { language: "plutus:v1", cbor: script } }),
      output(1, { script: { language: "plutus:v2", cbor: script } }),
      output(2, { script: { language: "plutus:v3", cbor: script } }),
      output(3, { script: { language: "plutus:v3", cbor: odd } }),
      output(4, { script: { language: "plutus:v9", cbor: script } }),
      output(5, { script: { language: "native" } }),
    ]).getUtxos(ADDRESS);
    expect(utxos.map((u) => u.scriptRef)).toEqual([
      { type: "PlutusV1", script },
      { type: "PlutusV2", script },
      { type: "PlutusV3", script },
      { type: "PlutusV3", script: odd },
      null,
      null,
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});
