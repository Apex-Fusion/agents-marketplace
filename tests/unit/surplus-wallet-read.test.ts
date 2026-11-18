/**
 * surplus-wallet-read.test.ts — the surplus seller reads the outputs of its proof wallet.
 *
 * Any wallet can send an output with an inline datum to the proof wallet of the seller. The Ogmios client withholds a datum that
 * fails the check: the output stays in the list with no datum. The seller counts the lovelace of such an output in its balance,
 * and it builds the anchor transaction from a wallet that holds such outputs. The library still decodes a known value afterwards.
 *
 * The test starts the seller over a fake Ogmios, and it calls the two functions that the seller gives its proof publisher: the
 * balance and the anchor. The controller and the publisher are stand-ins, so no request leaves the test.
 */

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { decoderWorks } from "../../packages/shared/src/tx/internal/decoderHealth.js";
import { inspectSignedTransaction, inspectSignedTransactionFinancials } from "../../packages/shared/src/tx/internal/signedTransaction.js";
import { SURPLUS_SALE_PROOF_PROTOCOL, type SurplusSaleProofAnchorMetadata } from "../../packages/shared/src/tx/wallet/anchorMetadata.js";
import { runSurplusSeller } from "../../supplier/src/cli/surplus-seller.js";
import type { SurplusVectorProofPublisherOptions } from "../../supplier/src/surplus/vectorPublisher.js";
import { AP3X, FakeOgmios, testWallet } from "../fixtures/identity-builders/world.js";

// The seller builds its proof publisher from two functions: the balance of the wallet and the anchor transaction. The stand-in
// keeps what the seller gives it, and it starts no timer.
const published = vi.hoisted(() => ({ options: undefined as SurplusVectorProofPublisherOptions | undefined }));

vi.mock("../../supplier/src/surplus/vectorPublisher.js", () => ({
  SurplusVectorProofPublisher: class {
    constructor(options: SurplusVectorProofPublisherOptions) {
      published.options = options;
    }
    start(): void {}
    async stop(): Promise<void> {}
  },
}));

vi.mock("../../supplier/src/surplus/controller.js", () => ({
  SurplusSellerController: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

/** The wallet of the seller: a key from a public label. */
const wallet = testWallet("surplus proof wallet", 1);
const refString = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

/** An output at the wallet of the seller that carries the datum `datumHex`. */
function output(index: number, lovelace: bigint, datumHex: string): Utxo {
  return { ref: { txHash: "c1".repeat(32), index }, address: wallet.address, lovelace, assets: {}, datumHex, scriptRef: null };
}

/** Outputs whose datums the Ogmios client withholds: a datum nested 70 levels, text that is not hex, and CBOR that ends inside an item. */
const WITHHELD: Utxo[] = [
  output(0, 7n * AP3X, `${"81".repeat(70)}00`),
  output(1, 3n * AP3X, "zz"),
  output(2, 2n * AP3X, "d879"),
];

function validMetadata(): SurplusSaleProofAnchorMetadata {
  return { p: SURPLUS_SALE_PROOF_PROTOCOL, root: "a".repeat(64), count: 1_000, first: "sale-000001", last: "sale-001000" };
}

/** A port that no process listens on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  probe.close();
  await once(probe, "close");
  return port;
}

let directory: string;
let server: Server | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "surplus-wallet-read-"));
  published.options = undefined;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // The Ogmios client writes one log line for each output that it withholds.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  if (server !== undefined) {
    const closing = server;
    closing.closeAllConnections();
    closing.close();
    await once(closing, "close");
    server = undefined;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

/** Starts the seller with the proof publisher on, over `fake`, and gives back what the seller gave its publisher. */
async function startSeller(fake: FakeOgmios): Promise<SurplusVectorProofPublisherOptions> {
  // The seller makes its chain client with no fetch of its own, so the client uses the global fetch.
  vi.stubGlobal("fetch", fake.fetch);
  const started = await runSurplusSeller({
    SURPLUS_SELLER_API_KEY: "si_seller_test",
    SURPLUS_OPENROUTER_API_KEY: "provider-test-key",
    SURPLUS_SELLER_WALLET: `0x${"ab".repeat(20)}`,
    SURPLUS_STATE_PATH: join(directory, "state.json"),
    PORT: String(await freePort()),
    SURPLUS_PROOF_ENABLED: "1",
    OGMIOS_URL: "http://ogmios.invalid",
    SURPLUS_PROOF_WALLET_PRIV_KEY_HEX: wallet.privateKeyHex,
    SURPLUS_PROOF_LEDGER_PATH: join(directory, "proofs.json"),
  });
  server = started.server;
  if (published.options === undefined) throw new Error("the seller did not build a proof publisher");
  return published.options;
}

describe("surplus seller: the proof wallet holds outputs whose datums are withheld", () => {
  it("counts the lovelace of every output in the balance, and builds the anchor transaction", async () => {
    const fake = new FakeOgmios();
    fake.fund(wallet, 20n * AP3X);
    fake.add(...WITHHELD);
    // The client lists each output of the wallet, and it gives none of them a datum.
    const listed = await fake.chain().queryUtxosByAddress(wallet.address);
    expect(listed.map((utxo) => utxo.datumHex)).toEqual([null, null, null, null]);
    const publisher = await startSeller(fake);

    // 20 AP3X in a plain output, and 7 + 3 + 2 AP3X in the outputs whose datums are withheld.
    expect(await publisher.balanceLovelace()).toBe(32n * AP3X);

    const built = await publisher.anchor(validMetadata());

    expect(fake.submitted).toHaveLength(1);
    expect(built.expectedTxHash).toBe(inspectSignedTransaction(fake.submitted[0]!).txHash);
    expect(decoderWorks()).toBe(true);
  });

  it("builds the anchor transaction from a wallet that holds only such outputs", async () => {
    const fake = new FakeOgmios();
    fake.add(...WITHHELD);
    const listed = await fake.chain().queryUtxosByAddress(wallet.address);
    expect(listed.map((utxo) => utxo.datumHex)).toEqual([null, null, null]);
    const publisher = await startSeller(fake);

    expect(await publisher.balanceLovelace()).toBe(12n * AP3X);

    const built = await publisher.anchor(validMetadata());

    expect(fake.submitted).toHaveLength(1);
    expect(built.expectedTxHash).toBe(inspectSignedTransaction(fake.submitted[0]!).txHash);
    // The wallet has no other output, so the transaction spends outputs whose datums are withheld.
    const { inputs } = inspectSignedTransactionFinancials(fake.submitted[0]!);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(WITHHELD.map((utxo) => refString(utxo.ref))).toContain(refString(input));
    expect(decoderWorks()).toBe(true);
  });
});
