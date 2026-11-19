/**
 * address-text-check.test.ts — the check of an address text before it reaches Lucid.
 *
 * Two shared functions guard the places where an address text from outside reaches an address function of Lucid:
 *   - checkedAddressText refuses the empty text and a text longer than any address (1,024 characters), and gives back every other
 *     text as it is;
 *   - checkedShelleyAddress also reads the text with the bech32 codec of the shared package and refuses a text that is no Shelley
 *     payment address.
 * The places are: the destination of a withdrawal (a request field), the address of the wallet (a value from the environment),
 * and the address of each output that a script spend plans (the refund address of a datum).
 */

import { performance } from "node:perf_hooks";
import { bech32 } from "bech32";
import { describe, expect, it, vi, type Mock } from "vitest";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { plutusAddressToBech32, type PlutusAddress, type PlutusCredential } from "../../packages/shared/src/cbor/address.js";
import {
  MAX_ADDRESS_TEXT_LENGTH,
  checkedAddressText,
  checkedShelleyAddress,
  isAddressRefusal,
} from "../../packages/shared/src/tx/internal/addressText.js";
import { TxConstructionError } from "../../packages/shared/src/tx/types.js";
import { buildWithdrawTx } from "../../packages/shared/src/tx/wallet/withdrawWallet.js";
import {
  buildLiveTxForAdvert, buildLiveTxForEscrow, type LivePostAdvertParams, type LivePostEscrowParams,
} from "../../packages/shared/src/tx/internal/liveCbor.js";
import { buildConsolidateWalletTx } from "../../packages/shared/src/tx/wallet/consolidateWallet.js";
import { buildLiveScriptSpend, type LiveScriptSpendParams } from "../../packages/shared/src/tx/internal/liveIdentityCbor.js";
import { AP3X, FakeOgmios, testWallet } from "../fixtures/identity-builders/world.js";

const HASH_A = "11".repeat(28);
const HASH_B = "22".repeat(28);
const key = (hash: string): PlutusCredential => ({ type: "VerificationKey", hash });
const script = (hash: string): PlutusCredential => ({ type: "Script", hash });
const inline = (credential: PlutusCredential): NonNullable<PlutusAddress["stakeCredential"]> => ({ type: "Inline", credential });
const pointer = (slotNumber: bigint, transactionIndex: bigint, certificateIndex: bigint): NonNullable<PlutusAddress["stakeCredential"]> => ({
  type: "Pointer", slotNumber, transactionIndex, certificateIndex,
});

/** One address of each kind of CIP-19 (base, pointer, enterprise; key and script credentials) for a network. */
function addressesOfEachKind(networkId: 0 | 1): Array<[string, string]> {
  const addresses: Array<[string, PlutusAddress]> = [
    ["base, key and key", { paymentCredential: key(HASH_A), stakeCredential: inline(key(HASH_B)) }],
    ["base, script and key", { paymentCredential: script(HASH_A), stakeCredential: inline(key(HASH_B)) }],
    ["base, key and script", { paymentCredential: key(HASH_A), stakeCredential: inline(script(HASH_B)) }],
    ["base, script and script", { paymentCredential: script(HASH_A), stakeCredential: inline(script(HASH_B)) }],
    ["pointer, key", { paymentCredential: key(HASH_A), stakeCredential: pointer(2_498_243n, 27n, 3n) }],
    ["pointer, script", { paymentCredential: script(HASH_A), stakeCredential: pointer(1n, 0n, 0n) }],
    ["pointer, large numbers", { paymentCredential: key(HASH_A), stakeCredential: pointer(2n ** 40n, 2n ** 20n, 2n ** 30n) }],
    ["enterprise, key", { paymentCredential: key(HASH_A), stakeCredential: null }],
    ["enterprise, script", { paymentCredential: script(HASH_A), stakeCredential: null }],
  ];
  return addresses.map(([name, address]) => [name, plutusAddressToBech32(address, networkId)]);
}

/** A bech32 text with a right checksum over `bytes`. */
const bech32Text = (prefix: string, bytes: Uint8Array | number[]): string => bech32.encode(prefix, bech32.toWords(bytes), 1023);

/** The best time of a few runs, in ms: a slow machine slows one run, not all of them. */
function bestTime(run: () => void): number {
  let best = Infinity;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

function refusal(run: () => unknown): TxConstructionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TxConstructionError);
    return error as TxConstructionError;
  }
  throw new Error("the call did not refuse");
}

describe("checkedAddressText", () => {
  it("refuses the empty text with a TxConstructionError that names the address", () => {
    const error = refusal(() => checkedAddressText("", "the destination address"));
    expect(error.reason).toBe("address_empty");
    expect(error.message).toBe("the destination address is empty");
  });

  it("refuses a text longer than 1,024 characters, names its length and not the text, and passes 1,024 characters", () => {
    expect(MAX_ADDRESS_TEXT_LENGTH).toBe(1024);
    const longest = `addr1${"q".repeat(MAX_ADDRESS_TEXT_LENGTH - 5)}`;
    expect(checkedAddressText(longest, "an address")).toBe(longest);

    const text = `addr1${"q".repeat(MAX_ADDRESS_TEXT_LENGTH - 4)}`;
    const error = refusal(() => checkedAddressText(text, "the destination address"));
    expect(error.reason).toBe("address_too_long");
    expect(error.message).toBe("the destination address is 1025 characters long; the longest address text is 1024 characters");
    expect(error.message).not.toContain("qqqq");
  });

  it("refuses a text of 1 MB in under 50 ms, and says its length", () => {
    const text = `addr1${"q".repeat(1_000_000)}`;
    expect(bestTime(() => refusal(() => checkedAddressText(text, "an address")))).toBeLessThan(50);
    expect(refusal(() => checkedAddressText(text, "an address")).message).toContain("1000005 characters long");
  });

  it.each([
    ["a bech32 address", "addr1vyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkdl5mw"],
    ["a test address", "addr_test1vz2fs4y3q9ekzs7zrr5xkjhq5dzl2wkxqh5hqz6v3l9kqaqklyp2"],
    ["hex of an address", "61" + "11".repeat(28)],
    ["a text that is not an address", "not an address"],
    ["one space", " "],
    ["a text with a line break", "addr1\n"],
  ])("gives back %s as it is", (_name, text) => {
    expect(checkedAddressText(text, "an address")).toBe(text);
  });
});

describe("checkedShelleyAddress", () => {
  describe.each([
    [1 as const, "main network"],
    [0 as const, "test network"],
  ])("an address of the %s", (networkId) => {
    it.each(addressesOfEachKind(networkId))("passes %s, and gives it back as it is", (_name, address) => {
      expect(checkedShelleyAddress(address, "an address")).toBe(address);
    });
  });

  it("refuses the empty text and a long text with the reasons of checkedAddressText", () => {
    expect(refusal(() => checkedShelleyAddress("", "an address")).reason).toBe("address_empty");
    expect(refusal(() => checkedShelleyAddress(`addr1${"q".repeat(2000)}`, "an address")).reason).toBe("address_too_long");
    expect(bestTime(() => refusal(() => checkedShelleyAddress(`addr1${"q".repeat(1_000_000)}`, "an address")))).toBeLessThan(50);
  });

  it.each([
    ["a short text", "addr1qqqqqqqq"],
    ["a text with a wrong checksum", `${addressesOfEachKind(1)[7]![1].slice(0, -1)}q`],
    ["a text with the letters that bech32 does not use", `addr1${"bio".repeat(20)}`],
    ["a text with upper and lower case letters", `${addressesOfEachKind(1)[7]![1].slice(0, 20).toUpperCase()}${addressesOfEachKind(1)[7]![1].slice(20)}`],
    ["a text of 1,024 characters", `addr1${"q".repeat(1019)}`],
    ["hex of an address", "61" + "11".repeat(28)],
    ["a prefix that is not addr", bech32Text("cosmos", [0x61, ...Buffer.from(HASH_A, "hex")])],
    ["a reward address", bech32Text("stake", [0xe1, ...Buffer.from(HASH_A, "hex")])],
    ["a test reward address", bech32Text("stake_test", [0xe0, ...Buffer.from(HASH_A, "hex")])],
  ])("refuses %s with the reason address_invalid, and does not name the text", (_name, text) => {
    const error = refusal(() => checkedShelleyAddress(text, "an address"));
    expect(error.reason).toBe("address_invalid");
    expect(error.message).toBe("an address is not a Cardano payment address");
  });

  it("refuses a text with a right checksum and no data", () => {
    const error = refusal(() => checkedShelleyAddress("addr1mykd6t", "an address"));
    expect(error.reason).toBe("address_invalid");
    expect(bech32.decode("addr1mykd6t").words).toEqual([]);
  });

  it("refuses a text with a right checksum when its header and size are not those of an address, and passes the others", () => {
    // The sizes of CIP-19: base 57 bytes (types 0 to 3), pointer 29 bytes and three numbers of one byte each here (types 4 and 5,
    // 32 bytes), enterprise 29 bytes (types 6 and 7). The types 8 to 15 are not Shelley payment addresses.
    const valid = (type: number, size: number): boolean =>
      (type <= 3 && size === 57) || ((type === 4 || type === 5) && size === 32) || ((type === 6 || type === 7) && size === 29);
    const passed: string[] = [];
    for (const [networkId, prefix] of [[1, "addr"], [0, "addr_test"]] as const) {
      for (let type = 0; type < 16; type += 1) {
        for (let size = 1; size <= 70; size += 1) {
          const bytes = new Uint8Array(size).fill(0x11);
          bytes[0] = (type << 4) | networkId;
          const text = bech32Text(prefix, bytes);
          let accepted = true;
          try {
            checkedShelleyAddress(text, "an address");
          } catch {
            accepted = false;
          }
          if (accepted !== valid(type, size)) passed.push(`${prefix} type ${type} size ${size}: accepted ${accepted}`);
        }
      }
    }
    expect(passed).toEqual([]);
  });

  it("refuses a prefix that does not match the network of the header, and a header of another network", () => {
    const bytes = (header: number): number[] => [header, ...Buffer.from(HASH_A, "hex")];
    expect(refusal(() => checkedShelleyAddress(bech32Text("addr", bytes(0x60)), "an address")).reason).toBe("address_invalid");
    expect(refusal(() => checkedShelleyAddress(bech32Text("addr_test", bytes(0x61)), "an address")).reason).toBe("address_invalid");
    for (const nibble of [2, 7, 15]) {
      expect(refusal(() => checkedShelleyAddress(bech32Text("addr", bytes(0x60 | nibble)), "an address")).reason).toBe("address_invalid");
    }
  });

  it("refuses a pointer address that ends inside a number or has bytes after the third number", () => {
    const base = [0x41, ...Buffer.from(HASH_A, "hex")];
    expect(refusal(() => checkedShelleyAddress(bech32Text("addr", [...base, 0x81, 0x01, 0x01, 0x81]), "an address")).reason).toBe("address_invalid");
    expect(refusal(() => checkedShelleyAddress(bech32Text("addr", [...base, 0x01, 0x01, 0x01, 0x01]), "an address")).reason).toBe("address_invalid");
    expect(checkedShelleyAddress(bech32Text("addr", [...base, 0x81, 0x01, 0x01, 0x01]), "an address")).toMatch(/^addr1/);
  });

  it("refuses 2,000 texts of random bytes with a right checksum, and passes none of them", () => {
    let seed = 20_261_118;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    let passed = 0;
    for (let i = 0; i < 2000; i += 1) {
      const size = 1 + (next() % 80);
      const bytes = Uint8Array.from({ length: size }, () => next() % 256);
      bytes[0] = (bytes[0]! & 0xf1) | 0x80; // a type from 8 to 15, whatever the network
      try {
        checkedShelleyAddress(bech32Text("addr", bytes), "an address");
        passed += 1;
      } catch {
        // refused
      }
    }
    expect(passed).toBe(0);
  });

  it("refuses every text with a right checksum whose data part is not a whole number of bytes", () => {
    // The data part of a bech32 text is a list of 5-bit words. It holds an address only when the words fill whole bytes and the
    // padding bits are zero. Any other list has no bytes, and Lucid must never read the text.
    const wholeBytes = (words: number[]): boolean => {
      let value = 0;
      let bits = 0;
      for (const word of words) {
        value = (value << 5) | word;
        bits += 5;
        while (bits >= 8) {
          bits -= 8;
          value &= (1 << bits) - 1;
        }
      }
      return bits < 5 && value === 0;
    };
    let seed = 0x5eed;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed >>> 8;
    };
    let unaligned = 0;
    for (const prefix of ["addr", "addr_test"]) {
      for (let length = 0; length <= 80; length += 1) {
        for (let sample = 0; sample < 25; sample += 1) {
          const words = Array.from({ length }, () => next() % 32);
          if (wholeBytes(words)) continue;
          unaligned += 1;
          expect(refusal(() => checkedShelleyAddress(bech32.encode(prefix, words, 1023), "an address")).reason).toBe("address_invalid");
        }
      }
    }
    expect(unaligned).toBeGreaterThan(2000);
  });
});

describe("isAddressRefusal", () => {
  it.each([
    ["the empty text", () => checkedAddressText("", "an address")],
    ["a long text", () => checkedAddressText("a".repeat(2000), "an address")],
    ["a text that is no payment address", () => checkedShelleyAddress("addr1qqqqqqqq", "an address")],
    ["an address of the other network", () => checkedShelleyAddress(addressesOfEachKind(0)[0]![1], "an address", 1)],
  ])("is true for the refusal of %s", (_name, run) => {
    expect(isAddressRefusal(refusal(run))).toBe(true);
  });

  it.each([
    ["a TxConstructionError of another reason", new TxConstructionError("insufficient_funds", "balance too low")],
    ["a TxConstructionError with a reason that only starts like an address reason", new TxConstructionError("address_empty_again", "another text")],
    ["an error that is not a TxConstructionError and has an address reason", Object.assign(new Error("address_empty"), { reason: "address_empty" })],
    ["an error of another kind", new Error("address_empty")],
    ["a text", "address_empty"],
    ["nothing", undefined],
  ])("is false for %s", (_name, value) => {
    expect(isAddressRefusal(value)).toBe(false);
  });
});

describe("checkedShelleyAddress with the network of the caller", () => {
  it.each([
    [1 as const, 0 as const, "main"],
    [0 as const, 1 as const, "test"],
  ])("network %i: passes each kind of address of its network, and refuses each kind of address of network %i", (own, other, ownName) => {
    for (const [name, address] of addressesOfEachKind(own)) expect(checkedShelleyAddress(address, "an address", own), name).toBe(address);
    for (const [name, address] of addressesOfEachKind(other)) {
      const error = refusal(() => checkedShelleyAddress(address, "the destination", own));
      expect(error.reason, name).toBe("address_wrong_network");
      expect(error.message).toBe(`the destination is not an address of the ${ownName} network`);
      expect(error.message).not.toContain(address);
    }
  });

  it.each([
    ["the empty text", "", "address_empty"],
    ["a text of 2,000 characters", `addr1${"q".repeat(1995)}`, "address_too_long"],
    ["a text that is no payment address", "addr1mykd6t", "address_invalid"],
    ["a text with a wrong checksum", `${addressesOfEachKind(1)[7]![1].slice(0, -1)}q`, "address_invalid"],
  ])("refuses %s with its own reason, whatever the network", (_name, text, reason) => {
    for (const networkId of [0 as const, 1 as const, undefined]) {
      expect(refusal(() => checkedShelleyAddress(text, "an address", networkId)).reason).toBe(reason);
    }
  });

  it("reads the network from the prefix, whatever the case of the letters", () => {
    const test = addressesOfEachKind(0)[7]![1];
    expect(checkedShelleyAddress(test.toUpperCase(), "an address", 0)).toBe(test.toUpperCase());
    expect(refusal(() => checkedShelleyAddress(test.toUpperCase(), "an address", 1)).reason).toBe("address_wrong_network");
  });

  it("checks no network when none is given", () => {
    for (const networkId of [0 as const, 1 as const]) {
      for (const [name, address] of addressesOfEachKind(networkId)) expect(checkedShelleyAddress(address, "an address"), name).toBe(address);
    }
  });
});

describe("the places where an address text from outside reaches Lucid", () => {
  const wallet = testWallet("address text check", 1);

  /** A chain client over the fake Ogmios that counts the requests that it makes. */
  function countedChain(fake: FakeOgmios): { chain: LiveOgmiosProvider; requests: Mock } {
    const requests = vi.fn(fake.fetch);
    return { requests, chain: new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios.invalid", fetch: requests as unknown as typeof fetch }) };
  }

  it.each([
    ["the empty text", "", "address_empty"],
    ["a text with a right checksum and no data", "addr1mykd6t", "address_invalid"],
    ["a text that is not an address", "addr1qqqqqqqq", "address_invalid"],
    ["a text of 1 MB", `addr1${"0".repeat(1_000_000)}`, "address_too_long"],
  ])("withdrawal: refuses %s as the destination before any request", async (_name, text, reason) => {
    const fake = new FakeOgmios();
    fake.fund(wallet, 100n * AP3X);
    const { chain, requests } = countedChain(fake);
    const started = performance.now();
    await expect(buildWithdrawTx({ chain, walletKey: wallet, toAddress: text })).rejects.toMatchObject({ name: "TxConstructionError", reason });
    expect(performance.now() - started).toBeLessThan(500);
    expect(requests).not.toHaveBeenCalled();
  });

  it("withdrawal: builds for a valid destination of each kind of address", async () => {
    for (const [, address] of addressesOfEachKind(1)) {
      const fake = new FakeOgmios();
      fake.fund(wallet, 100n * AP3X);
      const { chain } = countedChain(fake);
      const built = await buildWithdrawTx({ chain, walletKey: wallet, toAddress: address, amountLovelace: 10n * AP3X });
      expect(built.txCborHex).toMatch(/^84/);
      expect(built.toAddress).toBe(address);
      expect(fake.submitted).toHaveLength(1);
    }
  });

  it.each([
    ["the empty text", "", "address_empty"],
    ["a text with a right checksum and no data", "addr1mykd6t", "address_invalid"],
    ["a text of 1 MB", `addr1${"0".repeat(1_000_000)}`, "address_too_long"],
  ])("consolidation: refuses a wallet whose address is %s, and builds for the same wallet with its address", async (_name, text, reason) => {
    const fake = new FakeOgmios();
    fake.fund(wallet, 2n * AP3X, 2n * AP3X, 2n * AP3X, 2n * AP3X, 2n * AP3X);
    const chain = fake.chain();
    await expect(buildConsolidateWalletTx({ chain, walletKey: { ...wallet, address: text } })).rejects.toMatchObject({ name: "TxConstructionError", reason });
    expect(fake.submitted).toHaveLength(0);

    const built = await buildConsolidateWalletTx({ chain, walletKey: wallet });
    expect(built.alreadyHealthy).toBe(false);
    expect(built.txCborHex).toMatch(/^84/);
  });

  it("consolidation: a wallet that needs no change is not refused, whatever its address text", async () => {
    const fake = new FakeOgmios();
    fake.fund(wallet, 5n * AP3X, 20n * AP3X);
    const built = await buildConsolidateWalletTx({ chain: fake.chain(), walletKey: { ...wallet, address: "" } });
    expect(built.alreadyHealthy).toBe(true);
  });

  it.each([
    ["an empty address", "", "address_empty"],
    ["an address of 1 MB", `addr1${"0".repeat(1_000_000)}`, "address_too_long"],
  ])("script spend: refuses a planned output with %s before it builds anything", async (_name, address, reason) => {
    const fake = new FakeOgmios();
    const { chain, requests } = countedChain(fake);
    const params = {
      chain,
      walletKey: wallet,
      outputs: [{ address, lovelace: 2_000_000n, assets: {}, datumHex: null, exactValue: false }],
    } as unknown as LiveScriptSpendParams;
    await expect(buildLiveScriptSpend(params)).rejects.toMatchObject({ name: "TxConstructionError", reason });
    expect(requests).not.toHaveBeenCalled();
    expect(fake.submitted).toHaveLength(0);
  });

  it.each([
    ["the empty text", "", "address_empty"],
    ["a text of 1 MB", `addr1${"0".repeat(1_000_000)}`, "address_too_long"],
  ])("post escrow and post advert: refuse a target address that is %s before any request", async (_name, address, reason) => {
    const fake = new FakeOgmios();
    fake.fund(wallet, 100n * AP3X);
    const { chain, requests } = countedChain(fake);
    const target = { address, datumHex: "d87980" };
    const escrow = { chain, buyerKey: wallet, escrowDatum: {}, totalLocked: 5_000_000n, deliverBy: Date.now() + 60_000, postedAt: Date.now(), target };
    await expect(buildLiveTxForEscrow(escrow as unknown as LivePostEscrowParams)).rejects.toMatchObject({ name: "TxConstructionError", reason });
    const advert = { chain, walletKey: wallet, advertDatum: {}, deposit_lovelace: 5_000_000n, target };
    await expect(buildLiveTxForAdvert(advert as unknown as LivePostAdvertParams)).rejects.toMatchObject({ name: "TxConstructionError", reason });
    expect(requests).not.toHaveBeenCalled();
    expect(fake.submitted).toHaveLength(0);
  });
});
