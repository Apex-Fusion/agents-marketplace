/**
 * The set-up of the live builder tests of the legacy layout (tests/unit/tx-*-live.test.ts, and the cases of other files that run a
 * builder on a LiveOgmiosProvider): the fake Ogmios of tests/fixtures/identity-builders, a pinned clock, and the variables that
 * choose a reference script. The fake answers only the four methods that the live builders send. A builder that sends another
 * method (for example the protocol parameters, which lucid reads only without a preset) fails its test.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { blake2b } from "@noble/hashes/blake2b";
import type { OutputReference, Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import { encodeAdvertDatum } from "../../../packages/shared/src/cbor/AdvertDatum.js";
import type { AdvertDatum } from "../../../packages/shared/src/cbor/types.js";
import { pkhToEnterpriseAddress } from "../../../packages/shared/src/tx/internal/pkhAddress.js";
import type { WalletKey } from "../../../packages/shared/src/tx/types.js";
import { FakeOgmios, hex, VECTOR_MAINNET_ZERO_TIME_MS } from "../identity-builders/world.js";
import { ADVERT_SCRIPT_ADDRESS } from "./legacy-advert.js";

export interface LegacyLive {
  /** The fake Ogmios of the current test: a new one before each test. */
  readonly ogmios: FakeOgmios;
}

/**
 * Registers the hooks of a file or of a describe block. Before each test: full fake timers with the clock at `nowMs` (the legacy
 * live tests always used them), the zero time of the Vector mainnet clock, inlined scripts (no reference-script variable), and a
 * new FakeOgmios.
 */
export function legacyLive(nowMs: number): LegacyLive {
  const live = { ogmios: new FakeOgmios() };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    vi.stubEnv("VECTOR_ZERO_TIME_MS", String(VECTOR_MAINNET_ZERO_TIME_MS));
    vi.stubEnv("ESCROW_REF_UTXO", "");
    vi.stubEnv("ADVERT_REF_UTXO", "");
    live.ogmios = new FakeOgmios();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  return live;
}

/**
 * `key` with the key hash of its public key. Lucid takes the wallet address from the private key, and FakeOgmios funds the
 * address of `pubKeyHash`. The supplier fixture's `pubKeyHash` is a pattern, not the hash of its key, so the tests fund this copy.
 */
export function lucidWallet(key: WalletKey): WalletKey {
  const pubKeyHash = hex(blake2b(Buffer.from(key.pubKeyHex, "hex"), { dkLen: 28 }));
  return { ...key, pubKeyHash, address: pkhToEnterpriseAddress(pubKeyHash, 1) };
}

/** The advert UTxO of the legacy layout for the fake Ogmios (`seedAdvertUtxo` of legacy-advert.ts is its mock-chain twin). */
export function legacyAdvertUtxo(
  datum: AdvertDatum,
  ref: OutputReference = { txHash: "b".repeat(64), index: 0 },
  lovelace = 2_000_000n,
): Utxo {
  return { ref, address: ADVERT_SCRIPT_ADDRESS, lovelace, assets: {}, datumHex: encodeAdvertDatum(datum), scriptRef: null };
}
