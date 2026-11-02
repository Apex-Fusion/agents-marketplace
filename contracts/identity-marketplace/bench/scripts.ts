/**
 * The applied scripts of the benchmarks (Part 2 §12.4) and the outputs that
 * every benchmark transaction reads: reference scripts, the configuration
 * record and the wallets. The scripts come from the committed blueprint
 * (../plutus.json) with test parameters, applied by `aiken blueprint apply`.
 *
 * Parameters, in the order of Part 2 §2:
 * - `config_holder`: none. `config_seal`: a test seed and the holder hash.
 * - `identity`: the deployed legacy registry hash (`be1a0a29…`), the root of a
 *   test allowlist of 8,192 identifiers (13-node proofs), the `config_seal`
 *   and `config_holder` hashes.
 * - `attestation`, `delegation`, `escrow`: the identity hash. `vault`: the
 *   identity, delegation and escrow hashes. `advert`: none.
 *
 * Module-1 (`identity_party`, repository vector-agent-modules) is not in this
 * project. A stand-in that accepts every purpose takes its place, and the
 * configuration record names the stand-in's hash as M1. The Module-1 cost of
 * the transactions that use `ok(Script { M1 })` is therefore not included.
 */
import { fileURLToPath } from "node:url";
import { buildAllowlistTree } from "@marketplace/shared/identity";
import {
  address,
  blake2b256,
  blueprintScript,
  chainUtxo,
  fromHex,
  LEGACY_HASH,
  minUtxo,
  outRefData,
  scriptHash,
  testKeyPair,
  toHex,
  utf8,
  type KeyPair,
  type PlutusV3Script,
  type TxOut,
  type Utxo,
} from "../../../tests/legacy-registry/harness/index.js";

export const BLUEPRINT_PATH = fileURLToPath(new URL("../plutus.json", import.meta.url));

export const AP3X = 1_000_000n;

/** The key hash of 28 zero bytes: its enterprise address holds the reference scripts (Part 2 §2). */
export const REFERENCE_SCRIPT_ADDRESS = address({ key: new Uint8Array(28) });

/**
 * A Plutus V3 script that accepts every purpose: `(program 1.1.0 (lam ctx (con unit ())))`,
 * from `aiken uplc encode --cbor --hex`. It stands in for Module-1's `identity_party`.
 */
export const MODULE1_STAND_IN: PlutusV3Script = { compiledCode: fromHex("450101002499") };
export const M1 = scriptHash(MODULE1_STAND_IN);

/** A wallet of a throwaway test key, with its enterprise address. */
export interface Wallet {
  readonly key: KeyPair;
  readonly address: Uint8Array;
}

export function wallet(label: string): Wallet {
  const key = testKeyPair(`identity bench: ${label}`);
  return { key, address: address({ key: key.keyHash }) };
}

/** An output of an earlier transaction, named `label`, with the least AP3X for its size when `coin` is 0. */
export function existing(label: string, output: TxOut, index = 0): Utxo {
  // The coin field takes at most 9 bytes; the min-UTxO of the largest coin covers every amount.
  const coin = output.value.coin === 0n ? minUtxo({ ...output, value: { ...output.value, coin: 1n << 62n } }) : output.value.coin;
  return chainUtxo(`identity bench: ${label}`, { ...output, value: { ...output.value, coin } }, index);
}

/** The seed of `config_seal`. */
export const CONFIG_SEED = existing("config seal seed", { address: wallet("deployer").address, value: { coin: 50n * AP3X } });

/** The identifiers of the test allowlist: 8,192 (13-node proofs). The adopted record is the first. */
export const ALLOWLIST_IDS: readonly string[] = Array.from({ length: 8_192 }, (_, i) =>
  toHex(blake2b256(utf8(`identity bench: legacy record ${i}`))),
);

export const ALLOWLIST = buildAllowlistTree(ALLOWLIST_IDS);

export interface Scripts {
  readonly identity: PlutusV3Script;
  readonly configHolder: PlutusV3Script;
  readonly configSeal: PlutusV3Script;
  readonly attestation: PlutusV3Script;
  readonly delegation: PlutusV3Script;
  readonly vault: PlutusV3Script;
  readonly escrow: PlutusV3Script;
  readonly advert: PlutusV3Script;
}

function loadScripts(): Scripts {
  const configHolder = blueprintScript(BLUEPRINT_PATH, "config.config_holder.spend");
  const configSeal = blueprintScript(BLUEPRINT_PATH, "config.config_seal.mint", [outRefData(CONFIG_SEED.ref), scriptHash(configHolder)]);
  const identity = blueprintScript(BLUEPRINT_PATH, "identity.identity.mint", [
    LEGACY_HASH,
    fromHex(ALLOWLIST.root),
    scriptHash(configSeal),
    scriptHash(configHolder),
  ]);
  const identityHash = scriptHash(identity);
  const delegation = blueprintScript(BLUEPRINT_PATH, "delegation.delegation.mint", [identityHash]);
  const escrow = blueprintScript(BLUEPRINT_PATH, "escrow.escrow.spend", [identityHash]);
  return {
    identity,
    configHolder,
    configSeal,
    attestation: blueprintScript(BLUEPRINT_PATH, "attestation.attestation.mint", [identityHash]),
    delegation,
    vault: blueprintScript(BLUEPRINT_PATH, "vault.vault.spend", [identityHash, scriptHash(delegation), scriptHash(escrow)]),
    escrow,
    advert: blueprintScript(BLUEPRINT_PATH, "advert.advert.spend"),
  };
}

export const SCRIPTS = loadScripts();

/** Script hashes (= policy IDs). */
export const IDENTITY_HASH = scriptHash(SCRIPTS.identity);
export const CONFIG_HOLDER_HASH = scriptHash(SCRIPTS.configHolder);
export const CONFIG_POLICY = scriptHash(SCRIPTS.configSeal);
export const DELEGATION_HASH = scriptHash(SCRIPTS.delegation);
export const VAULT_HASH = scriptHash(SCRIPTS.vault);
export const ESCROW_HASH = scriptHash(SCRIPTS.escrow);

/** Exact enterprise script addresses (Part 2 §2). */
export const IDENTITY_ADDRESS = address({ script: IDENTITY_HASH });
export const DELEGATION_ADDRESS = address({ script: DELEGATION_HASH });
export const VAULT_ADDRESS = address({ script: VAULT_HASH });
export const ESCROW_ADDRESS = address({ script: ESCROW_HASH });

/** The reference-script output of `script`, published at the zero key hash address. */
export const referenceScript = (label: string, script: PlutusV3Script): Utxo =>
  existing(`reference script ${label}`, { address: REFERENCE_SCRIPT_ADDRESS, value: { coin: 0n }, referenceScript: script });

export const REFERENCE = {
  identity: referenceScript("identity", SCRIPTS.identity),
  delegation: referenceScript("delegation", SCRIPTS.delegation),
  vault: referenceScript("vault", SCRIPTS.vault),
  escrow: referenceScript("escrow", SCRIPTS.escrow),
  module1: referenceScript("Module-1 stand-in", MODULE1_STAND_IN),
};

/** The configuration record (§3.8): the `identity-config` token at the holder address, with M1 as inline datum. */
export const CONFIG_RECORD = existing("configuration record", {
  address: address({ script: CONFIG_HOLDER_HASH }),
  value: { coin: 0n, assets: [{ policy: CONFIG_POLICY, name: utf8("identity-config"), quantity: 1n }] },
  datum: { inline: M1 },
});
