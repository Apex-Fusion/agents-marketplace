/**
 * Identity-registry additions to the legacy-script harness: the applied
 * identity-marketplace scripts with test parameters, conversions between the
 * shared builder types and the harness types, and the offline evaluation of
 * an unsigned builder transaction with `aiken tx simulate`.
 *
 * The test deployment follows Part 2 §3.8: `config_holder`, then
 * `config_seal(seed, holder)`, then `identity(legacy_hash, legacy_root,
 * config_policy, config_holder)` with the deployed legacy hash, then the
 * attestation, delegation, escrow and vault scripts with the identity hash.
 * Module-1 is a stand-in script that accepts every purpose: the identity side
 * needs only its hash and its withdrawal; Module-1's own rules are tested in
 * vector-agent-modules. Nothing goes to a network.
 */
import { appendFileSync } from "node:fs";
import { sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import { decodePlutusDataHex, type PlutusData } from "../../../packages/shared/src/cbor/plutus-data.js";
import { readCbor } from "../../../packages/shared/src/identity/tx/cbor.js";
import {
  addressBytes, buildConfigSeal, buildRegister, validityWindow, VECTOR_MAINNET_SLOT_CONFIG, type AdoptionScripts,
  type AttestationScripts, type CreatedRecordTx, type DelegationScripts, type IdentityScripts, type Profile,
  type ProtocolParameters, type ScriptSource, type TxContext, type UnsignedTx, type ValidityWindow, type VaultScripts,
} from "../../../packages/shared/src/identity/tx/index.js";
import type { Key, Party } from "../../../packages/shared/src/cbor/IdentityDatum.js";
import { allowlistRoot } from "../../../packages/shared/src/identity/allowlist.js";
import { blueprintScript } from "./blueprint.js";
import * as cbor from "./cbor.js";
import { encodeData, type Data } from "./data.js";
import {
  address, bech32Address, blake2b256, chainUtxo, fromHex, minUtxo, scriptHash, testKeyPair, toHex,
  type BuiltTx, type KeyPair, type PlutusV3Script, type TxOut, type Utxo as HarnessUtxo,
} from "./ledger.js";
import { identifierOf, LEGACY_HASH, LEGACY_SCRIPT, outRefData } from "./legacy.js";
import { simulate, type Simulation } from "./simulate.js";

export const IDENTITY_BLUEPRINT_PATH = fileURLToPath(new URL("../../../contracts/identity-marketplace/plutus.json", import.meta.url));

/** A Plutus V3 script that accepts every purpose: `(program 1.1.0 (lam ctx (con unit ())))`. The test Module-1. */
export const MODULE1_STAND_IN: PlutusV3Script = { compiledCode: fromHex("450101002499") };

export const AP3X = 1_000_000n;

/** Protocol parameters of the tests (Vector mainnet values; the cost model only feeds the script data hash). */
export const TEST_PROTOCOL: ProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155_381,
  priceMem: 0.0577,
  priceStep: 0.0000721,
  coinsPerUtxoByte: 4310n,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  maxTxSize: 16_384,
  maxTxExMem: 16_000_000n,
  maxTxExSteps: 10_000_000_000n,
  minFeeRefScriptCostPerByte: 15,
  costModels: { PlutusV3: Array.from({ length: 297 }, (_, i) => 1000 + i) },
};

/** A test time: 2025-11-01T12:26:40Z, a slot start on the Vector clock. */
export const TEST_NOW = 1_762_000_000_000;

export const testWindow = (nowMs = TEST_NOW): ValidityWindow => validityWindow(nowMs, VECTOR_MAINNET_SLOT_CONFIG);

// ─── Conversions ─────────────────────────────────────────────────────

export function harnessData(d: PlutusData): Data {
  switch (d.kind) {
    case "int":
      return d.value;
    case "bytes":
      return fromHex(d.hex);
    case "list":
      return d.items.map(harnessData);
    case "map":
      return { map: d.entries.map(([k, v]) => [harnessData(k), harnessData(v)] as const) };
    case "constr":
      return { constr: Number(d.index), fields: d.fields.map(harnessData) };
  }
}

/** A harness UTxO as a chain UTxO of the shared builders. */
export function sharedUtxo(u: HarnessUtxo): Utxo {
  const assets: Record<string, bigint> = {};
  for (const a of u.output.value.assets ?? []) {
    const unit = `${toHex(a.policy)}${toHex(a.name)}`;
    assets[unit] = (assets[unit] ?? 0n) + a.quantity;
  }
  const datum = u.output.datum;
  return {
    ref: { txHash: toHex(u.ref.txId), index: u.ref.index },
    address: bech32Address(u.output.address),
    lovelace: u.output.value.coin,
    assets,
    datumHex: datum !== undefined && "inline" in datum ? toHex(encodeData(datum.inline)) : null,
    scriptRef: u.output.referenceScript === undefined ? null : toHex(u.output.referenceScript.compiledCode),
  };
}

/** A chain UTxO of the shared builders as a harness UTxO. */
export function harnessUtxo(u: Utxo): HarnessUtxo {
  const output: TxOut = {
    address: addressBytes(u.address),
    value: {
      coin: u.lovelace,
      assets: Object.entries(u.assets).map(([unit, quantity]) => ({ policy: fromHex(unit.slice(0, 56)), name: fromHex(unit.slice(56)), quantity })),
    },
    ...(u.datumHex === null ? {} : { datum: { inline: harnessData(decodePlutusDataHex(u.datumHex)) } }),
    ...(u.scriptRef === null ? {} : { referenceScript: { compiledCode: fromHex(u.scriptRef) } }),
  };
  return { ref: { txId: fromHex(u.ref.txHash), index: u.ref.index }, output };
}

// ─── Evaluation of builder transactions ──────────────────────────────

const refKey = (ref: { txHash: string; index: number }): string => `${ref.txHash}#${ref.index}`;

/**
 * The harness view of an unsigned builder transaction: the body bytes stay
 * as built, `keys` add the key witnesses, and `encode(order)` writes the
 * redeemers in another order (the transaction ID does not change), so
 * simulate() gives each redeemer its own verdict. `utxos` resolves the
 * spent, reference and collateral inputs.
 */
export function builtFromUnsigned(tx: UnsignedTx, utxos: Iterable<Utxo>, keys: readonly KeyPair[]): BuiltTx {
  const bytes = fromHex(tx.txCborHex);
  const parsed = readCbor(bytes);
  if (parsed.kind !== "array" || parsed.items.length !== 4) throw new Error("not a Conway transaction");
  const body = parsed.items[0]!;
  const witnessSet = parsed.items[1]!;
  const slice = (item: { start: number; end: number }): Uint8Array => bytes.slice(item.start, item.end);
  const bodyBytes = slice(body);
  const id = blake2b256(bodyBytes);
  if (toHex(id) !== tx.txHash) throw new Error("txHash does not match the body");
  if (body.kind !== "map" || witnessSet.kind !== "map") throw new Error("body or witness set is not a map");

  const byHash = new Map(keys.map((k) => [toHex(k.keyHash), k]));
  const missing = tx.requiredSigners.filter((h) => !byHash.has(h));
  if (missing.length > 0) throw new Error(`no test key for required signer(s) ${missing.join(", ")}`);
  const vkeys = tx.requiredSigners.map((h) => {
    const key = byHash.get(h)!;
    return cbor.array([cbor.bytes(key.publicKey), cbor.bytes(Uint8Array.from(sign(null, id, key.privateKey)))]);
  });

  const known = new Map<string, Utxo>();
  for (const u of utxos) known.set(refKey(u.ref), u);
  const resolve = (ref: { txHash: string; index: number }): Utxo => {
    const u = known.get(refKey(ref));
    if (u === undefined) throw new Error(`unknown UTxO ${refKey(ref)}`);
    return u;
  };
  const collateral: Array<{ txHash: string; index: number }> = [];
  for (const [key, value] of body.entries) {
    if (key.kind === "uint" && key.value === 13n) {
      const list = value.kind === "tag" ? value.item : value;
      if (list.kind !== "array") throw new Error("collateral is not an array");
      for (const item of list.items) {
        if (item.kind !== "array" || item.items[0]?.kind !== "bytes" || item.items[1]?.kind !== "uint") throw new Error("bad collateral input");
        collateral.push({ txHash: toHex(item.items[0].value), index: Number(item.items[1].value) });
      }
    }
  }
  const seen = new Set<string>();
  const resolved: HarnessUtxo[] = [];
  for (const ref of [...tx.inputs, ...tx.referenceInputs, ...collateral]) {
    if (seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    resolved.push(harnessUtxo(resolve(ref)));
  }

  const entries = witnessSet.entries.filter(([key]) => !(key.kind === "uint" && key.value === 0n));
  const encode = (order: readonly number[] = tx.redeemers.map((_, i) => i)): Uint8Array => {
    const parts: Array<readonly [Uint8Array, Uint8Array]> = [];
    if (vkeys.length > 0) parts.push([cbor.uint(0), cbor.tag(258, cbor.array(vkeys))]);
    for (const [key, value] of entries) {
      if (key.kind === "uint" && key.value === 5n && value.kind === "map") {
        const reordered = order.map((position) => {
          const entry = value.entries[position];
          if (entry === undefined) throw new Error(`no redeemer ${position}`);
          return [slice(entry[0]), slice(entry[1])] as const;
        });
        parts.push([slice(key), cbor.map(reordered)]);
      } else {
        parts.push([slice(key), slice(value)]);
      }
    }
    return cbor.array([bodyBytes, cbor.map(parts), cbor.TRUE, cbor.NULL]);
  };

  return {
    spec: { inputs: [], outputs: [], fee: tx.fee },
    id,
    body: bodyBytes,
    redeemers: tx.redeemers.map((r) => ({ tag: r.tag, index: r.index, data: 0n, label: r.label })),
    resolved,
    encode,
    utxo: (index) => harnessUtxo(tx.outputs[index]!),
  };
}

/** Runs `aiken tx simulate` on an unsigned builder transaction, signed with `keys`. */
export function simulateUnsigned(tx: UnsignedTx, utxos: Iterable<Utxo>, keys: readonly KeyPair[]): Simulation {
  return simulate(builtFromUnsigned(tx, utxos, keys));
}

/**
 * With IDENTITY_TX_REPORT=<file>, appends one JSON line per evaluated builder
 * transaction: the test name, the verdicts with execution units, the fee and
 * the signed size. The results table of the report comes from this file.
 */
export function reportEvaluation(name: string, tx: UnsignedTx, result: Simulation): void {
  const file = process.env.IDENTITY_TX_REPORT;
  if (file === undefined) return;
  const line = { name, passed: result.passed, fee: tx.fee.toString(), signedSize: tx.signedSize, failedAt: result.failedAt, verdicts: result.verdicts };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

// ─── Test deployment ─────────────────────────────────────────────────

/** The enterprise address with 28 zero bytes as key hash: reference scripts live there (Part 2 §2). */
const REFERENCE_HOLDER = address({ key: new Uint8Array(28) });

/** A reference-script UTxO for `script`, created by an earlier transaction named `label`. */
export function referenceScriptUtxo(label: string, script: PlutusV3Script): Utxo {
  const shape: TxOut = { address: REFERENCE_HOLDER, value: { coin: 0n }, referenceScript: script };
  return sharedUtxo(chainUtxo(label, { ...shape, value: { coin: minUtxo({ ...shape, value: { coin: 100_000_000n } }) } }));
}

/** The identifier of the legacy record that `registeredRecord(owner, label)` of scenario.ts creates. */
export const legacyIdOf = (label: string): string =>
  toHex(identifierOf({ txId: blake2b256(new TextEncoder().encode(label)), index: 0 }));

/** Labels of the legacy records that the identity tests adopt; the test allowlist holds their identifiers. */
export const LEGACY_LABELS = [
  "adopt: plain",
  "adopt: long profile",
  "adopt: owner change",
  "adopt: module-1",
  "adopt: refusals",
  "adoption-identity: combined",
  "adoption-identity: short",
  "adoption-identity: builder",
] as const;

/** The test allowlist: the identifiers above and filler identifiers, so a proof has several nodes. */
export const TEST_ALLOWLIST: readonly string[] = [
  ...LEGACY_LABELS.map(legacyIdOf),
  ...Array.from({ length: 9 }, (_, i) => legacyIdOf(`allowlist filler ${i}`)),
];

/** A test wallet: a throwaway key, its enterprise address and a funding UTxO. */
export interface TestWallet {
  key: KeyPair;
  address: string;
  keyHash: string;
  publicKey: string;
}

export function testWallet(label: string): TestWallet {
  const key = testKeyPair(label);
  return { key, address: bech32Address(address({ key: key.keyHash })), keyHash: toHex(key.keyHash), publicKey: toHex(key.publicKey) };
}

/** AP3X at a wallet, created by an earlier transaction named `label`. */
export function walletFunds(label: string, wallet: TestWallet, coin: bigint, index = 0): Utxo {
  return sharedUtxo(chainUtxo(label, { address: addressBytes(wallet.address), value: { coin } }, index));
}

export interface IdentityWorld {
  holder: { script: PlutusV3Script; hash: string };
  seal: { script: PlutusV3Script; hash: string; seed: Utxo };
  identity: { script: PlutusV3Script; hash: string; reference: Utxo };
  attestation: { script: PlutusV3Script; hash: string; reference: Utxo };
  delegation: { script: PlutusV3Script; hash: string; reference: Utxo };
  escrow: { script: PlutusV3Script; hash: string };
  vault: { script: PlutusV3Script; hash: string; reference: Utxo };
  legacy: { hash: string; reference: Utxo };
  module1: { hash: string; reference: Utxo };
  legacyRoot: string;
  /** The seal transaction and the configuration record it creates. */
  sealTx: UnsignedTx;
  configRecord: Utxo;
  /** Every UTxO the world created, for evaluation. */
  utxos: Utxo[];
  deployer: TestWallet;
  identityScripts: IdentityScripts;
  adoptionScripts: AdoptionScripts;
  attestationScripts: AttestationScripts;
  delegationScripts: DelegationScripts;
  vaultScripts: VaultScripts;
}

const reference = (source: Utxo, hash: string): ScriptSource => ({ hash, referenceUtxo: source });

/** A builder context with the test protocol, the Vector slot clock and the given wallet UTxOs. */
export function testContext(wallet: TestWallet, utxos: Utxo[], extra: Partial<TxContext> = {}): TxContext {
  return {
    networkId: 1,
    slotConfig: VECTOR_MAINNET_SLOT_CONFIG,
    protocol: TEST_PROTOCOL,
    wallet: utxos,
    changeAddress: wallet.address,
    ...extra,
  };
}

let world: IdentityWorld | undefined;

/**
 * The test deployment. It applies the parameters with `aiken blueprint apply`,
 * builds the configuration seal with `buildConfigSeal` and requires that
 * `aiken tx simulate` accepts it.
 */
export function identityWorld(): IdentityWorld {
  if (world !== undefined) return world;
  const path = IDENTITY_BLUEPRINT_PATH;
  const deployer = testWallet("identity world deployer");
  const holder = blueprintScript(path, "config.config_holder.spend");
  const holderHash = scriptHash(holder);
  const seedUtxo = walletFunds("identity world: config seal seed", deployer, 50n * AP3X);
  const seal = blueprintScript(path, "config.config_seal.mint", [outRefData({ txId: fromHex(seedUtxo.ref.txHash), index: seedUtxo.ref.index }), holderHash]);
  const sealHash = scriptHash(seal);
  const legacyRoot = allowlistRoot(TEST_ALLOWLIST);
  const identity = blueprintScript(path, "identity.identity.mint", [LEGACY_HASH, fromHex(legacyRoot), sealHash, holderHash]);
  const identityHash = scriptHash(identity);
  const attestation = blueprintScript(path, "attestation.attestation.mint", [identityHash]);
  const delegation = blueprintScript(path, "delegation.delegation.mint", [identityHash]);
  const escrow = blueprintScript(path, "escrow.escrow.spend", [identityHash]);
  const delegationHash = scriptHash(delegation);
  const escrowHash = scriptHash(escrow);
  const vault = blueprintScript(path, "vault.vault.spend", [identityHash, delegationHash, escrowHash]);

  const refs = {
    identity: referenceScriptUtxo("identity world: identity reference script", identity),
    attestation: referenceScriptUtxo("identity world: attestation reference script", attestation),
    delegation: referenceScriptUtxo("identity world: delegation reference script", delegation),
    vault: referenceScriptUtxo("identity world: vault reference script", vault),
    legacy: referenceScriptUtxo("identity world: legacy reference script", LEGACY_SCRIPT),
    module1: referenceScriptUtxo("identity world: module-1 reference script", MODULE1_STAND_IN),
  };
  const module1Hash = toHex(scriptHash(MODULE1_STAND_IN));
  const deployerFunds = walletFunds("identity world: deployer funds", deployer, 200n * AP3X);
  const window = testWindow();
  const sealTx = buildConfigSeal(testContext(deployer, [deployerFunds]), {
    seed: seedUtxo,
    seal: { hash: toHex(sealHash), compiledCode: toHex(seal.compiledCode) },
    configHolder: toHex(holderHash),
    module1: module1Hash,
    window,
  });
  const result = simulateUnsigned(sealTx, [seedUtxo, deployerFunds], [deployer.key]);
  if (!result.passed) throw new Error(`the configuration seal fails: ${result.error ?? ""}`);
  const configRecord = sealTx.outputs[sealTx.configOutput]!;

  const identityScripts: IdentityScripts = {
    identity: reference(refs.identity, toHex(identityHash)),
    configPolicy: toHex(sealHash),
    configHolder: toHex(holderHash),
    configRecord,
    module1: reference(refs.module1, module1Hash),
  };
  world = {
    holder: { script: holder, hash: toHex(holderHash) },
    seal: { script: seal, hash: toHex(sealHash), seed: seedUtxo },
    identity: { script: identity, hash: toHex(identityHash), reference: refs.identity },
    attestation: { script: attestation, hash: toHex(scriptHash(attestation)), reference: refs.attestation },
    delegation: { script: delegation, hash: toHex(delegationHash), reference: refs.delegation },
    escrow: { script: escrow, hash: toHex(escrowHash) },
    vault: { script: vault, hash: toHex(scriptHash(vault)), reference: refs.vault },
    legacy: { hash: toHex(LEGACY_HASH), reference: refs.legacy },
    module1: { hash: module1Hash, reference: refs.module1 },
    legacyRoot,
    sealTx,
    configRecord,
    utxos: [...Object.values(refs), configRecord, seedUtxo, deployerFunds],
    deployer,
    identityScripts,
    adoptionScripts: { ...identityScripts, legacy: reference(refs.legacy, toHex(LEGACY_HASH)), legacyRoot },
    attestationScripts: { attestation: reference(refs.attestation, toHex(scriptHash(attestation))), identityHash: toHex(identityHash) },
    delegationScripts: { delegation: reference(refs.delegation, toHex(delegationHash)), identityHash: toHex(identityHash) },
    vaultScripts: {
      vault: reference(refs.vault, toHex(scriptHash(vault))),
      identityHash: toHex(identityHash),
      delegationHash: toHex(delegationHash),
      escrowHash: toHex(escrowHash),
    },
  };
  return world;
}

/** The Accountable Party `ControllerSet` with full rights from just before `window`. */
export const controllerAccountable = (window: ValidityWindow): Party => ({
  role: "Accountable",
  signer: { type: "ControllerSet" },
  organisation: null,
  notBefore: window.lo - 60_000,
  notAfter: null,
  rights: 3,
  removalAfter: null,
});

/**
 * Registers a test record with `buildRegister` and requires that `aiken tx
 * simulate` accepts it. `signers` are the keys besides the controller (listed
 * Ed25519 keys, key-hash parties, a parent controller). `known` resolves
 * parents and ancestors.
 */
export function registerTestRecord(args: {
  label: string;
  controller: TestWallet;
  keys?: Key[];
  parties?: Party[];
  signers?: TestWallet[];
  parent?: { record: Utxo; ancestors?: Utxo[] };
  profile?: Profile;
  window?: ValidityWindow;
  known?: readonly Utxo[];
}): { record: Utxo; id: string; tx: CreatedRecordTx } {
  const w = identityWorld();
  const window = args.window ?? testWindow();
  const funds = walletFunds(`${args.label} funds`, args.controller, 100n * AP3X);
  const tx = buildRegister(testContext(args.controller, [funds]), w.identityScripts, {
    seed: funds,
    window,
    controller: args.controller.publicKey,
    keys: args.keys ?? [],
    parties: args.parties ?? [controllerAccountable(window)],
    profile: args.profile ?? { name: args.label.slice(0, 64) },
    ...(args.parent === undefined ? {} : { parent: args.parent }),
  });
  const result = simulateUnsigned(tx, [...w.utxos, ...(args.known ?? []), funds], [args.controller, ...(args.signers ?? [])].map((s) => s.key));
  if (!result.passed) throw new Error(`the Register of ${args.label} fails: ${result.error ?? ""}`);
  return { record: tx.outputs[tx.recordOutput]!, id: tx.id, tx };
}
