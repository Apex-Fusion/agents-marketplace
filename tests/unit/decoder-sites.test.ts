/**
 * decoder-sites.test.ts — the places where the code calls the decoder library on data from outside are named.
 *
 * The test reads the sources of the services and of the shared package. A file that calls a decoder of the library (`Data.from`,
 * `CML.*.from_cbor_hex`, `from_cbor_bytes`, `getAddressDetails`, or a call of Lucid that decodes inside Lucid: `collectFrom`,
 * `readFrom`, `pay.ToAddress*`, `pay.ToContract`, `utxoToCore`, `toScriptRef`, `complete`) must be in the list below, with the
 * number of its calls and the reason why the call is safe: the check that runs before it. A new call in a file that is not in the
 * list, or one more call in a file that is, fails the test until the list names it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SOURCE_DIRS = [
  "packages/shared/src", "gateway/src", "buyer/src", "supplier/src", "paper2agent/src", "wallet-monitor/src", "indexer/src",
  "identity-gateway/src", "contracts/identity-marketplace/deploy",
];

/** A call of a decoder of the library, or of Lucid where Lucid decodes. */
const DECODER_CALL = new RegExp(
  [
    String.raw`\bData\.from\(`,
    String.raw`\.from_(?:cbor_hex|cbor_bytes|bech32|hex|raw_bytes|normal_bytes|base58)\(`,
    String.raw`\bgetAddressDetails\(`,
    String.raw`\.collectFrom\(`,
    String.raw`\.readFrom\(`,
    String.raw`\.pay\.To(?:Address|AddressWithData|Contract)\(`,
    String.raw`\butxoToCore\(`,
    String.raw`\btoScriptRef\(`,
    String.raw`\bvalidatorToScriptHash\(`,
    String.raw`\.fromTx\(`,
    String.raw`\b(?:txBuilder|tx)\.complete\(`,
  ].join("|"),
);

interface Site {
  /** The number of lines with a decoder call in the file. */
  calls: number;
  /** The check that runs before the calls. */
  reason: string;
}

const CHAIN_CHECK =
  "the datum and the native script of each output pass the check of the Ogmios client first (chain/datumGuard.ts), and a Plutus script is opaque bytes";
const ADDRESS_CHECK =
  "an address text from outside goes through checkedAddressText or checkedShelleyAddress first (tx/internal/addressText.ts)";

const SITES: Record<string, Site> = {
  "packages/shared/src/tx/internal/liveCbor.ts": {
    calls: 28,
    reason:
      `the builders of the escrow and advert transactions. Wallet and escrow outputs: ${CHAIN_CHECK}. Addresses: ${ADDRESS_CHECK}, ` +
      "and the others come from the encoder of this package. Redeemers and output datums are encoded by this package. The reference " +
      "script comes from an operator-set output reference, and its hash is compared (resolveSpendCtx).",
  },
  "packages/shared/src/tx/internal/liveIdentityCbor.ts": {
    calls: 8,
    reason:
      `the builder of the spends of the new escrow and advert. Outputs: ${CHAIN_CHECK}. Planned outputs are encoded by this package ` +
      `from a datum that passed that check, and their addresses: ${ADDRESS_CHECK}.`,
  },
  "packages/shared/src/tx/wallet/consolidateWallet.ts": {
    calls: 3,
    reason: `wallet outputs: ${CHAIN_CHECK}. The wallet address: ${ADDRESS_CHECK}.`,
  },
  "packages/shared/src/tx/wallet/withdrawWallet.ts": {
    calls: 2,
    reason: `wallet outputs: ${CHAIN_CHECK}. The destination of the request: ${ADDRESS_CHECK}.`,
  },
  "packages/shared/src/tx/wallet/anchorMetadata.ts": {
    calls: 1,
    reason: `a metadata transaction with no output datum; wallet outputs: ${CHAIN_CHECK}.`,
  },
  "packages/shared/src/tx/internal/lucidContext.ts": {
    calls: 1,
    reason: "the private key of the wallet: the text is checked to be 64 hex characters first (HEX64_RE).",
  },
  "packages/shared/src/tx/internal/signedTransaction.ts": {
    calls: 2,
    reason: "a transaction that this process built, or its own journal row: no bytes from outside.",
  },
  "packages/shared/src/tx/internal/decoderHealth.ts": {
    calls: 1,
    reason: "the self-check decodes one known value.",
  },
};

/** Files that must hold the check that the reasons above name. */
const CHECKS: Array<[file: string, needle: string]> = [
  ["packages/shared/src/chain/OgmiosLucidProvider.ts", "new WithheldOutputs()"],
  ["packages/shared/src/chain/ReadOnlyOgmiosProvider.ts", "new WithheldOutputs()"],
  ["packages/shared/src/tx/internal/liveCbor.ts", "checkedAddressText("],
  ["packages/shared/src/tx/internal/liveIdentityCbor.ts", "checkedAddressText("],
  ["packages/shared/src/tx/wallet/consolidateWallet.ts", "checkedShelleyAddress("],
  ["packages/shared/src/tx/wallet/withdrawWallet.ts", "checkedShelleyAddress("],
  ["packages/shared/src/tx/internal/lucidContext.ts", "HEX64_RE.test("],
];

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (name === "node_modules" || name === "ui" || name === "test" || name === "dist") continue;
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
  }
  return files;
}

/** The lines of the file with a decoder call, not counting lines of comments. */
function callsIn(path: string): number {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line) && DECODER_CALL.test(line)).length;
}

describe("the decoder sites", () => {
  const found = new Map<string, number>();
  for (const directory of SOURCE_DIRS) {
    for (const file of sourceFiles(join(ROOT, directory))) {
      const calls = callsIn(file);
      if (calls > 0) found.set(relative(ROOT, file), calls);
    }
  }

  it("finds no call of a decoder in a file that is not named", () => {
    const unnamed = [...found.keys()].filter((file) => SITES[file] === undefined);
    expect(unnamed).toEqual([]);
  });

  it("finds as many calls in each named file as the list says", () => {
    const counts = Object.fromEntries(Object.keys(SITES).map((file) => [file, found.get(file) ?? 0]));
    expect(counts).toEqual(Object.fromEntries(Object.entries(SITES).map(([file, site]) => [file, site.calls])));
  });

  it("gives a reason for each named file", () => {
    for (const [file, site] of Object.entries(SITES)) expect(site.reason.length, file).toBeGreaterThan(30);
  });

  it.each(CHECKS)("%s holds the check that runs before its calls: %s", (file, needle) => {
    expect(readFileSync(join(ROOT, file), "utf8")).toContain(needle);
  });

  it("sees a call that it should name (the patterns match what they are meant to)", () => {
    for (const line of [
      "const d = Data.from(hex);", "CML.PlutusData.from_cbor_hex(hex)", "CML.Transaction.from_cbor_bytes(b)", "getAddressDetails(a)",
      "tx.collectFrom([u], r)", "tx.readFrom([u])", ".pay.ToAddress(a, v)", ".pay.ToAddressWithData(a, d, v)", ".pay.ToContract(a, d, v)",
      "utxoToCore(u)", "toScriptRef(s)", "await txBuilder.complete({})",
    ]) expect(DECODER_CALL.test(line), line).toBe(true);
    for (const line of ["Array.from(x)", "Buffer.from(h, 'hex')", "jobs.complete(id, p)", "const from = 1;"]) expect(DECODER_CALL.test(line), line).toBe(false);
  });
});
