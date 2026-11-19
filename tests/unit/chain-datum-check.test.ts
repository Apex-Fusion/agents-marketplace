/**
 * chain-datum-check.test.ts — the check at the boundary of the Ogmios clients.
 *
 * A datum that is nested deeper than 64 levels, or that is not CBOR that the decoders read, is withheld: the output stays in the
 * list with no datum. At the Lucid client, a native script that fails the check leaves the output out of the answer; the read-only
 * client maps no native script and never leaves an output out. One log line for each output reference, one time, names the
 * reference (never the bytes). A Plutus script is opaque bytes and is mapped as before.
 *
 * Covered: OgmiosLucidProvider (getUtxos, getUtxosByOutRef), ReadOnlyOgmiosProvider (queryUtxo, queryUtxosByAddress) and
 * LiveOgmiosProvider, which reads through the read-only one.
 */

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { OgmiosLucidProvider, OutputLeftOutError } from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import {
  MAX_CBOR_TEXT_LENGTH, OutputFieldError, SCAN_BUDGET_CHARS, SCAN_BUDGET_TEXTS, SILENT_ADDRESSES_MAX, SILENT_MS, resetGuardLogForTests,
} from "../../packages/shared/src/chain/datumGuard.js";
import { createLucidContext } from "../../packages/shared/src/tx/internal/lucidContext.js";
import { resolveSpendCtx } from "../../packages/shared/src/tx/internal/liveCbor.js";
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
import { testWallet } from "../fixtures/identity-builders/world.js";

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
  value: { ada: { lovelace: number }; [policyId: string]: unknown };
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
  resetGuardLogForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
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
  /** `count` bad outputs with new references, at `address`. */
  let next = 0;
  const bad = (count: number, address = ADDRESS): OgmiosOutput[] => Array.from({ length: count }, () => output(next++, { datum: long, address }));
  beforeEach(() => {
    next = 0;
  });

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

  it("remembers the last 1,000 references, and forgets the oldest when the 1,001st comes", async () => {
    // An answer keeps 20 new references for its lines, so 50 answers of 20 references fill the memory.
    const first = output(next++, { datum: long });
    await readOnly([first, ...bad(19)]).queryUtxosByAddress(ADDRESS);
    for (let answer = 1; answer < 50; answer += 1) await readOnly(bad(20)).queryUtxosByAddress(ADDRESS);
    expect(next).toBe(1000);
    warn.mockClear();
    await readOnly([first]).queryUtxosByAddress(ADDRESS); // 1,000 references: the first is still remembered
    expect(warn).not.toHaveBeenCalled();

    await readOnly(bad(1)).queryUtxosByAddress(ADDRESS); // the 1,001st reference: the first goes
    warn.mockClear();
    await readOnly([first]).queryUtxosByAddress(ADDRESS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(linesOf()[0]).toContain(`${TX}#0`);
  });

  it("writes 20 lines and no summary line for 20 bad outputs, and 20 lines and a summary line for 21", async () => {
    await lucid(bad(20)).getUtxos(ADDRESS);
    expect(linesOf()).toHaveLength(20);
    expect(linesOf().some((line) => line.includes("more outputs"))).toBe(false);

    resetGuardLogForTests();
    warn.mockClear();
    await lucid(bad(21)).getUtxos(ADDRESS);
    const lines = linesOf();
    expect(lines).toHaveLength(21);
    expect(lines[20]).toContain(`1 more outputs at ${ADDRESS}`);
  });

  it("writes 20 lines and one summary line for an answer with 45 bad outputs", async () => {
    await lucid(bad(45)).getUtxos(ADDRESS);
    const lines = linesOf();
    expect(lines).toHaveLength(21);
    expect(lines[20]).toContain(`25 more outputs at ${ADDRESS}`);
  });

  it("writes one line when an answer lists the same output twice, and counts the copy of a kept reference as no new output", async () => {
    const same = output(0, { datum: long });
    await readOnly([same, { ...same }]).queryUtxosByAddress(ADDRESS);
    expect(warn).toHaveBeenCalledTimes(1);

    resetGuardLogForTests();
    warn.mockClear();
    const twenty = bad(20);
    await readOnly([...twenty, { ...twenty[0]! }]).queryUtxosByAddress(ADDRESS);
    expect(linesOf()).toHaveLength(20); // no summary line for the copy
  });

  it("counts the outputs of the addresses after the 20th address in one line for other addresses", async () => {
    const others = Array.from({ length: 22 }, (_unused, i) => output(100 + i, { datum: long, address: `addr1other${i}` }));
    await lucid([...bad(20), ...others]).getUtxos(ADDRESS);
    const lines = linesOf();
    expect(lines).toHaveLength(41); // 20 lines, 20 summary lines, and one line for the others
    expect(lines.filter((line) => /1 more outputs at addr1other\d+ /.test(line))).toHaveLength(20);
    expect(lines[40]).toContain("2 more outputs at other addresses");
  });

  it("writes no line for other addresses when the 20 addresses of the summary lines are the only ones, and one line for the 21st", async () => {
    const others = (count: number) => Array.from({ length: count }, (_unused, i) => output(100 + i, { datum: long, address: `addr1other${i}` }));
    await lucid([...bad(20), ...others(20)]).getUtxos(ADDRESS);
    expect(linesOf()).toHaveLength(40);
    expect(linesOf().some((line) => line.includes("other addresses"))).toBe(false);

    resetGuardLogForTests();
    warn.mockClear();
    await lucid([...bad(20), ...others(21).map((o) => ({ ...o, transaction: { id: o.transaction.id }, index: o.index + 500 }))]).getUtxos(ADDRESS);
    expect(linesOf()).toHaveLength(41);
    expect(linesOf()[40]).toContain("1 more outputs at other addresses");
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

  describe("an address that holds more bad outputs than one answer writes", () => {
    const START = Date.parse("2026-11-19T10:00:00Z");
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
    });

    it("writes nothing more for that address after the summary line, until one hour has passed", async () => {
      expect(SILENT_MS).toBe(3_600_000);
      await lucid(bad(45)).getUtxos(ADDRESS);
      expect(linesOf()).toHaveLength(21);
      warn.mockClear();

      await lucid(bad(45)).getUtxos(ADDRESS); // new references at the same address
      vi.setSystemTime(START + SILENT_MS - 1);
      await lucid(bad(45)).getUtxos(ADDRESS);
      expect(warn).not.toHaveBeenCalled();

      vi.setSystemTime(START + SILENT_MS); // the hour is over
      await lucid(bad(45)).getUtxos(ADDRESS);
      expect(linesOf()).toHaveLength(21);
      expect(linesOf()[20]).toContain("25 more outputs");
    });

    it("keeps the silence of one address apart from another address", async () => {
      await lucid(bad(45)).getUtxos(ADDRESS);
      warn.mockClear();
      const other = "addr1vxqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe6y8r2";
      await lucid(bad(3, other)).getUtxos(other);
      expect(warn).toHaveBeenCalledTimes(3);
      await lucid(bad(3)).getUtxos(ADDRESS);
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it("writes no line for an address with 20 bad outputs, so the next new reference at it is still written", async () => {
      await lucid(bad(20)).getUtxos(ADDRESS);
      warn.mockClear();
      await lucid(bad(2)).getUtxos(ADDRESS);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("remembers at most 100 silent addresses, and forgets the oldest address first", async () => {
      expect(SILENT_ADDRESSES_MAX).toBe(100);
      const addressOf = (index: number): string => `addr1silent${index.toString().padStart(4, "0")}`;
      for (let index = 0; index < SILENT_ADDRESSES_MAX; index += 1) await lucid(bad(21, addressOf(index))).getUtxos(addressOf(index));
      warn.mockClear();
      await lucid(bad(1, addressOf(0))).getUtxos(addressOf(0)); // 100 addresses: the first is still silent
      expect(warn).not.toHaveBeenCalled();

      await lucid(bad(21, addressOf(SILENT_ADDRESSES_MAX))).getUtxos(addressOf(SILENT_ADDRESSES_MAX)); // the 101st address: the first goes
      warn.mockClear();
      await lucid(bad(1, addressOf(1))).getUtxos(addressOf(1));
      expect(warn).not.toHaveBeenCalled();
      await lucid(bad(1, addressOf(0))).getUtxos(addressOf(0));
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it("bounds the work for one answer: 100,000 bad outputs keep 100,000 outputs, write 21 lines, and remember 20 references", async () => {
    const flood = bad(100_000);
    const started = performance.now();
    const utxos = await lucid(flood).getUtxos(ADDRESS);
    const elapsed = performance.now() - started;
    expect(utxos).toHaveLength(100_000);
    expect(utxos.every((utxo) => utxo.datum === null)).toBe(true);
    expect(linesOf()).toHaveLength(21);
    expect(linesOf()[20]).toContain("99980 more outputs");
    // The work is bounded by the scan budgets, whatever the machine: seconds at most, not minutes.
    expect(elapsed).toBeLessThan(5000);

    // The memory holds 20 references of the answer, not 100,000: they are not said again at another address, the 21st is.
    warn.mockClear();
    const elsewhere = (outputs: OgmiosOutput[]): OgmiosOutput[] => outputs.map((o) => ({ ...o, address: "addr1elsewhere" }));
    await lucid(elsewhere(flood.slice(0, 20))).getUtxos("addr1elsewhere");
    expect(warn).not.toHaveBeenCalled();
    await lucid(elsewhere(flood.slice(20, 21))).getUtxos("addr1elsewhere");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the scan budgets of one answer", () => {
  const small = "d87980";
  /** A valid datum of 120,000 hex characters: a byte string of 59,995 zero bytes. */
  const big = `5a0000ea5b${"00".repeat(59_995)}`;

  it("scans at most 25,000 texts: the 25,001st valid datum of an answer is withheld without a scan, and its output stays", async () => {
    expect(SCAN_BUDGET_TEXTS).toBe(25_000);
    const answer = Array.from({ length: SCAN_BUDGET_TEXTS + 1 }, (_unused, i) => output(i, { datum: small }));
    const utxos = await lucid(answer).getUtxos(ADDRESS);
    expect(utxos).toHaveLength(SCAN_BUDGET_TEXTS + 1);
    expect(utxos.filter((utxo) => utxo.datum !== null)).toHaveLength(SCAN_BUDGET_TEXTS);
    expect(utxos[SCAN_BUDGET_TEXTS]?.datum).toBeNull();
    const plain = await readOnly(answer).queryUtxosByAddress(ADDRESS);
    expect(plain.filter((utxo) => utxo.datumHex !== null)).toHaveLength(SCAN_BUDGET_TEXTS);
  });

  it("reads at most 32 MiB of text: the 280th datum of 120,000 characters is withheld", async () => {
    expect(SCAN_BUDGET_CHARS).toBe(33_554_432);
    expect(big).toHaveLength(120_000);
    const answer = Array.from({ length: 300 }, (_unused, i) => output(i, { datum: big }));
    const utxos = await readOnly(answer).queryUtxosByAddress(ADDRESS);
    expect(utxos.filter((utxo) => utxo.datumHex !== null)).toHaveLength(279);
    expect(utxos[278]?.datumHex).toBe(big);
    expect(utxos[279]?.datumHex).toBeNull();
  });

  it("reads exactly 32 MiB: 256 datums of 131,072 characters pass, and the 257th is withheld", async () => {
    const exact = `5a0000ffdb${"00".repeat(65_531)}`;
    expect(exact).toHaveLength(131_072);
    const answer = Array.from({ length: 257 }, (_unused, i) => output(i, { datum: exact }));
    const utxos = await readOnly(answer).queryUtxosByAddress(ADDRESS);
    expect(utxos.filter((utxo) => utxo.datumHex !== null)).toHaveLength(256);
    expect(utxos[255]?.datumHex).toBe(exact);
    expect(utxos[256]?.datumHex).toBeNull();
  });

  it("withholds a datum text longer than 131,072 characters without a scan, and passes one of that length", async () => {
    expect(MAX_CBOR_TEXT_LENGTH).toBe(131_072);
    const exact = `5a0000ffdb${"00".repeat(65_531)}`; // 131,072 characters: a byte string of 65,531 zero bytes
    const over = `5a0000ffdc${"00".repeat(65_532)}`; // 131,074 characters
    expect(exact).toHaveLength(131_072);
    expect(over).toHaveLength(131_074);
    const utxos = await readOnly([output(0, { datum: exact }), output(1, { datum: over })]).queryUtxosByAddress(ADDRESS);
    expect(utxos.map((utxo) => utxo.datumHex)).toEqual([exact, null]);
  });

  it("takes a new budget for each answer", async () => {
    const answer = Array.from({ length: 300 }, (_unused, i) => output(i, { datum: big }));
    await readOnly(answer).queryUtxosByAddress(ADDRESS);
    const again = await readOnly(answer).queryUtxosByAddress(ADDRESS);
    expect(again.filter((utxo) => utxo.datumHex !== null)).toHaveLength(279);
  });
});

describe("the check of a reference script", () => {
  // The read-only client maps no native script, so it never leaves an output out: an output is absent from its answer only when
  // the node does not list it, and the callers read "absent" as "spent". The Lucid client hands a native script to Lucid, and Lucid
  // asks a fee for the reference script of each output that it spends. A transaction that does not count the script gets a fee that
  // is too low. So the Lucid client leaves out an output whose native script fails the check. An output with a withheld datum stays
  // in the list, because a datum costs no fee.
  const shallow = nativeScript(31); // 63 levels
  const deep = nativeScript(32); // 65 levels
  const veryDeep = nativeScript(1500); // 3,001 levels
  const linesOf = (): string[] => warn.mock.calls.map((call) => String(call.join(" ")));

  describe("at the Lucid client", () => {
    it("leaves out a wallet output and an escrow output with such a script, keeps the others, and keeps a valid script mapped", async () => {
      const answer = [
        output(0, { script: { language: "native", cbor: shallow } }),
        output(1, { script: { language: "native", cbor: deep } }), // a wallet output
        output(2, { datum: "d87980" }),
        output(3, { datum: "d87980", script: { language: "native", cbor: veryDeep } }), // an escrow output
        output(4),
      ];
      const utxos = await lucid(answer).getUtxos(ADDRESS);
      expect(utxos.map((u) => u.outputIndex)).toEqual([0, 2, 4]);
      expect(utxos[0]?.scriptRef).toEqual({ type: "Native", script: shallow });
      expect(utxos[1]?.datum).toBe("d87980");
      const lines = linesOf();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(`${TX}#1`);
      expect(lines[0]).toContain("left out");
      expect(lines[0]).not.toContain(deep.slice(0, 30));
      expect(lines[1]).toContain(`${TX}#3`);
    });

    it("says when it left out an output that was asked for: getUtxosByOutRef throws OutputLeftOutError, and an output that the node does not list gives an empty answer", async () => {
      const answer = [output(2, { datum: "d87980" }), output(3, { datum: "d87980", script: { language: "native", cbor: veryDeep } })];
      const asked = (...indexes: number[]) => indexes.map((outputIndex) => ({ txHash: TX, outputIndex }));

      expect((await lucid(answer).getUtxosByOutRef(asked(2))).map((u) => u.outputIndex)).toEqual([2]);
      expect(await lucid(answer).getUtxosByOutRef(asked(9))).toEqual([]); // the node does not list it

      const error = await lucid(answer).getUtxosByOutRef(asked(3)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OutputLeftOutError);
      expect((error as OutputLeftOutError).refs).toEqual([`${TX}#3`]);
      expect((error as OutputLeftOutError).message).toContain(`${TX}#3`);
      expect((error as OutputLeftOutError).message).not.toContain(veryDeep.slice(0, 30));
      // One output among several: the call refuses as a whole.
      await expect(lucid(answer).getUtxosByOutRef(asked(2, 3))).rejects.toBeInstanceOf(OutputLeftOutError);
    });

    it("tells the reader of a reference script UTxO (resolveSpendCtx) that the output was left out, and not that it is not on chain", async () => {
      const answer = [output(3, { script: { language: "native", cbor: veryDeep } })];
      const { lucid: context } = await createLucidContext(lucid(answer), testWallet("reference script reader", 1), { networkId: 1, systemStartUnix: 0, slotLengthMs: 1000 }, { usePresetProtocolParameters: true });
      vi.stubEnv("ESCROW_REF_UTXO", `${TX}#3`);
      try {
        const error = await resolveSpendCtx(context, "ESCROW_REF_UTXO", { type: "PlutusV3", script: "5901ab0101002229800aba2aba1" }).catch((e: unknown) => e);
        expect(String(error)).toContain("OutputLeftOutError");
        expect(String(error)).not.toContain("not found on chain");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("leaves out an output whose native script is not CBOR that the decoders read", async () => {
      const answer = [
        output(0, { datum: "d87980", script: { language: "native", cbor: "zz" } }),
        output(1, { script: { language: "native", cbor: "" } }),
        output(2, { script: { language: "native", cbor: "5a80000000" } }),
        output(3),
      ];
      expect((await lucid(answer).getUtxos(ADDRESS)).map((u) => u.outputIndex)).toEqual([3]);
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

  describe("at the read-only client and the live client", () => {
    const scripts: Array<[string, string]> = [["65 levels", deep], ["3,001 levels", veryDeep], ["not CBOR", "zz"], ["a declared length past the end", "5a80000000"]];

    it.each(scripts)("returns an escrow output with a native script of %s: queryUtxo gives it, and the lists keep it", async (_name, cbor) => {
      const datum = encodeEscrowDatum(buildSampleEscrowDatum());
      const answer = [output(0, { datum, script: { language: "native", cbor } }), output(1), output(2, { datum: "d87980" })];
      for (const client of [readOnly(answer), live(answer)]) {
        const found = await client.queryUtxo({ txHash: TX, index: 0 });
        expect(found).not.toBeNull();
        expect(found).toMatchObject({ ref: { txHash: TX, index: 0 }, address: ADDRESS, datumHex: datum, scriptRef: null });
        const listed = await client.queryUtxosByAddress(ADDRESS);
        expect(listed.map((u) => u.ref.index)).toEqual([0, 1, 2]);
        expect(listed[2]?.datumHex).toBe("d87980");
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it("returns a wallet output with a native script of 65 levels, and it still counts in a balance", async () => {
      const answer = [output(0, { script: { language: "native", cbor: deep } }), output(1)];
      const listed = await readOnly(answer).queryUtxosByAddress(ADDRESS);
      expect(listed.reduce((sum, u) => sum + u.lovelace, 0n)).toBe(4_000_001n);
    });

    it("still answers null for an output that the node does not list: that is the only way to get null", async () => {
      expect(await readOnly([output(0)]).queryUtxo({ txHash: TX, index: 7 })).toBeNull();
      expect(await live([]).queryUtxo({ txHash: TX, index: 0 })).toBeNull();
    });
  });
});

describe("the bounds of the fields of an output", () => {
  // A wallet or a script address cannot hold an output with a field longer than the ledger allows, so a node that sends one is broken.
  // The library reads the address when Lucid spends the output (with a quadratic cost for a long text), so both clients refuse the
  // whole answer before they build an object from it. A caller sees a failed call, and never an absent output.
  const word = (length: number): string => "a".repeat(length);
  const lovelace = { ada: { lovelace: 2_000_000 } };
  const CASES: Array<[string, number, (length: number) => OgmiosOutput]> = [
    ["transaction id", 64, (n) => output(0, { transaction: { id: word(n) } })],
    ["address", 1024, (n) => output(0, { address: `addr1${word(n - 5)}` })],
    ["policy id", 56, (n) => output(0, { value: { ...lovelace, [word(n)]: { "": 1 } } })],
    ["asset name", 64, (n) => output(0, { value: { ...lovelace, [word(56)]: { [word(n)]: 1 } } })],
  ];
  const CLIENTS: Array<[string, (answer: OgmiosOutput[]) => Promise<unknown[]>]> = [
    ["the Lucid client", (answer) => lucid(answer).getUtxos(ADDRESS)],
    ["the read-only client", (answer) => readOnly(answer).queryUtxosByAddress(ADDRESS)],
    ["the live client", (answer) => live(answer).queryUtxosByAddress(ADDRESS)],
  ];

  describe.each(CASES)("the %s (at most %i characters)", (field, max, make) => {
    it.each(CLIENTS)("%s: passes the longest value, and refuses one more character", async (_name, call) => {
      expect(await call([make(max)])).toHaveLength(1);
      const error = await call([make(max + 1)]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OutputFieldError);
      expect((error as Error).message).toBe(`Ogmios sent an output whose ${field} is ${max + 1} characters long; the longest ${field} is ${max} characters`);
    });

    it("refuses a text of one million characters at once, and the message holds no part of it", async () => {
      const started = performance.now();
      const error = await readOnly([make(1_000_000)]).queryUtxosByAddress(ADDRESS).catch((e: unknown) => e);
      expect(performance.now() - started).toBeLessThan(500);
      expect(error).toBeInstanceOf(OutputFieldError);
      expect((error as Error).message.length).toBeLessThan(120);
    });
  });

  it("fails the whole call when one output among 100 has a field that is too long, and keeps the order of the others when none has", async () => {
    const good = Array.from({ length: 100 }, (_unused, i) => output(i));
    const withBad = good.map((o, i) => (i === 57 ? output(57, { address: word(1025) }) : o));
    await expect(lucid(withBad).getUtxos(ADDRESS)).rejects.toBeInstanceOf(OutputFieldError);
    await expect(readOnly(withBad).queryUtxosByAddress(ADDRESS)).rejects.toBeInstanceOf(OutputFieldError);
    expect((await readOnly(good).queryUtxosByAddress(ADDRESS)).map((u) => u.ref.index)).toEqual(good.map((o) => o.index));
  });

  it("fails a query for one output by its reference, and does not answer null as for an output that the node does not list", async () => {
    const bad = output(3, { address: word(1025) });
    await expect(readOnly([bad]).queryUtxo({ txHash: TX, index: 3 })).rejects.toBeInstanceOf(OutputFieldError);
    await expect(live([bad]).queryUtxo({ txHash: TX, index: 3 })).rejects.toBeInstanceOf(OutputFieldError);
    await expect(lucid([bad]).getUtxosByOutRef([{ txHash: TX, outputIndex: 3 }])).rejects.toBeInstanceOf(OutputFieldError);
    expect(await readOnly([bad]).queryUtxo({ txHash: TX, index: 4 })).toBeNull();
  });

  it("passes an output with several policies and several asset names within the bounds, and keeps its value", async () => {
    const value = { ...lovelace, [word(56)]: { [word(64)]: 5, "": 7 }, [word(55)]: { "ab": 1 } };
    const [utxo] = await readOnly([output(0, { value })]).queryUtxosByAddress(ADDRESS);
    expect(utxo?.assets).toEqual({ [`${word(56)}.${word(64)}`]: 5n, [`${word(56)}.`]: 7n, [`${word(55)}.ab`]: 1n });
  });

  it("skips a policy whose assets are not an object, as before", async () => {
    const value = { ...lovelace, [word(56)]: null, [word(55)]: 7, [word(54)]: { "": 1 } };
    const [utxo] = await readOnly([output(0, { value })]).queryUtxosByAddress(ADDRESS);
    expect(utxo?.assets).toEqual({ [`${word(54)}.`]: 1n });
    expect(await lucid([output(0, { value })]).getUtxos(ADDRESS)).toHaveLength(1);
  });

  it("leaves a field that is not a text to the mapper, as before", async () => {
    const odd = { ...output(0), address: undefined, transaction: { id: undefined } } as unknown as OgmiosOutput;
    expect(await readOnly([odd]).queryUtxosByAddress(ADDRESS)).toHaveLength(1);
    expect(await lucid([odd]).getUtxos(ADDRESS)).toHaveLength(1);
  });
});
