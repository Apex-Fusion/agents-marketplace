/**
 * Ledger building blocks for offline Plutus V3 evaluation: hashes, keys,
 * addresses (CIP-19), values, outputs and Conway transactions.
 *
 * buildTx() writes a complete transaction, signed with throwaway keys. It
 * also checks the phase-1 rules that decide whether a script runs at all:
 * value balance, key witnesses, the min-UTxO of each output and one
 * redeemer for each script purpose. So a test cannot pass or fail for a
 * reason that the ledger rejects before any script runs. The harness does
 * not check fees, the script data hash, collateral amounts or the
 * transaction size.
 */
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import * as cbor from "./cbor.js";
import { encodeData, type Data } from "./data.js";

export const blake2b224 = (input: Uint8Array): Uint8Array => blake2b(input, { dkLen: 28 });
export const blake2b256 = (input: Uint8Array): Uint8Array => blake2b(input, { dkLen: 32 });

export function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error(`Not a hex string: ${value}`);
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export const toHex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

// ─── Time ────────────────────────────────────────────────────────────────

/** Vector mainnet (Part 1 §4): system start 2025-08-29T16:40:00Z, one slot per second. */
export const VECTOR_MAINNET_TIME = {
  zeroTimeMs: 1_756_485_600_000n,
  zeroSlot: 0n,
  slotLengthMs: 1_000n,
} as const;

/** The POSIX time (ms) that a script sees for a validity bound at `slot`. */
export function slotToPosixMs(slot: bigint): bigint {
  const { zeroTimeMs, zeroSlot, slotLengthMs } = VECTOR_MAINNET_TIME;
  return zeroTimeMs + (slot - zeroSlot) * slotLengthMs;
}

/** The slot that contains the POSIX time `ms`. */
export function posixMsToSlot(ms: bigint): bigint {
  const { zeroTimeMs, zeroSlot, slotLengthMs } = VECTOR_MAINNET_TIME;
  if (ms < zeroTimeMs) throw new RangeError(`Time before the system start: ${ms}`);
  return zeroSlot + (ms - zeroTimeMs) / slotLengthMs;
}

// ─── Keys, credentials and addresses ─────────────────────────────────────

/** CIP-19 network id of Vector mainnet (addresses start with `addr1`). */
export const MAINNET = 1;

export type Credential = { readonly key: Uint8Array } | { readonly script: Uint8Array };

const credentialHash = (credential: Credential): Uint8Array =>
  "key" in credential ? credential.key : credential.script;

/** A base address (with `stake`) or an enterprise address (without). */
export function address(payment: Credential, stake?: Credential, network = MAINNET): Uint8Array {
  const paymentType = "script" in payment ? 0b0001 : 0;
  const type = stake === undefined
    ? 0b0110 | paymentType
    : paymentType | ("script" in stake ? 0b0010 : 0);
  const parts = [Uint8Array.of((type << 4) | network), credentialHash(payment)];
  if (stake !== undefined) parts.push(credentialHash(stake));
  return cbor.concat(parts);
}

export function rewardAddress(stake: Credential, network = MAINNET): Uint8Array {
  const type = "script" in stake ? 0b1111 : 0b1110;
  return cbor.concat([Uint8Array.of((type << 4) | network), credentialHash(stake)]);
}

/** The payment credential of a base, pointer or enterprise address. */
export function paymentCredential(addr: Uint8Array): Credential {
  const type = addr[0]! >> 4;
  if (type > 0b0111) throw new Error(`Address type ${type} has no payment credential`);
  const hash = addr.subarray(1, 29);
  return (type & 1) === 1 ? { script: hash } : { key: hash };
}

export function bech32Address(addr: Uint8Array): string {
  const reward = addr[0]! >> 4 >= 0b1110;
  const mainnet = (addr[0]! & 0x0f) === MAINNET;
  const prefix = reward ? (mainnet ? "stake" : "stake_test") : mainnet ? "addr" : "addr_test";
  return bech32.encode(prefix, bech32.toWords(addr), 1023);
}

export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: Uint8Array;
  readonly keyHash: Uint8Array;
}

/** PKCS #8 DER prefix of an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * A throwaway Ed25519 key, derived from a public label so that each run
 * builds the same transactions. It controls nothing on any network.
 */
export function testKeyPair(label: string): KeyPair {
  const seed = blake2b256(new TextEncoder().encode(`legacy-registry test key: ${label}`));
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const raw = Uint8Array.from(spki.subarray(spki.length - 32));
  return { privateKey, publicKey: raw, keyHash: blake2b224(raw) };
}

// ─── Scripts, values and outputs ────────────────────────────────────────

/** A Plutus V3 script as a blueprint gives it: one CBOR byte string around the flat program. */
export interface PlutusV3Script {
  readonly compiledCode: Uint8Array;
}

/** Script hash = policy ID = blake2b_224(0x03 || compiledCode). */
export const scriptHash = (script: PlutusV3Script): Uint8Array =>
  blake2b224(cbor.concat([Uint8Array.of(0x03), script.compiledCode]));

export interface Asset {
  readonly policy: Uint8Array;
  readonly name: Uint8Array;
  readonly quantity: bigint;
}

/** `coin` is in base units of AP3X (1 AP3X = 1,000,000). */
export interface Value {
  readonly coin: bigint;
  readonly assets?: readonly Asset[];
}

/** Merges equal assets, drops zero quantities and sorts by policy, then by name. */
export function normaliseAssets(assets: readonly Asset[]): Asset[] {
  const merged = new Map<string, Asset>();
  for (const asset of assets) {
    const key = `${toHex(asset.policy)}.${toHex(asset.name)}`;
    const quantity = (merged.get(key)?.quantity ?? 0n) + asset.quantity;
    merged.set(key, { policy: asset.policy, name: asset.name, quantity });
  }
  return [...merged.values()]
    .filter((asset) => asset.quantity !== 0n)
    .sort((a, b) => compareBytes(a.policy, b.policy) || compareBytes(a.name, b.name));
}

/** The ledger multi-asset map (also the mint field): policy → name → quantity. */
function encodeMultiasset(assets: readonly Asset[]): Uint8Array {
  const groups: Array<{ policy: Uint8Array; entries: Array<readonly [Uint8Array, Uint8Array]> }> = [];
  for (const asset of normaliseAssets(assets)) {
    const entry = [cbor.bytes(asset.name), cbor.int(asset.quantity)] as const;
    const last = groups.at(-1);
    if (last !== undefined && equalBytes(last.policy, asset.policy)) last.entries.push(entry);
    else groups.push({ policy: asset.policy, entries: [entry] });
  }
  return cbor.map(groups.map(({ policy, entries }) => [cbor.bytes(policy), cbor.map(entries)] as const));
}

export function encodeValue(value: Value): Uint8Array {
  const assets = normaliseAssets(value.assets ?? []);
  if (assets.some((asset) => asset.quantity < 0n)) throw new Error("A value cannot hold a negative quantity");
  if (assets.length === 0) return cbor.uint(value.coin);
  return cbor.array([cbor.uint(value.coin), encodeMultiasset(assets)]);
}

export function quantityOf(value: Value, policy: Uint8Array, name?: Uint8Array): bigint {
  let total = 0n;
  for (const asset of value.assets ?? []) {
    if (equalBytes(asset.policy, policy) && (name === undefined || equalBytes(asset.name, name))) {
      total += asset.quantity;
    }
  }
  return total;
}

export type DatumOption = { readonly inline: Data } | { readonly hash: Uint8Array };

export interface TxOut {
  readonly address: Uint8Array;
  readonly value: Value;
  readonly datum?: DatumOption;
  readonly referenceScript?: PlutusV3Script;
}

/** Post-Alonzo output: a map with 0 address, 1 value, 2 datum option and 3 reference script. */
export function encodeOutput(output: TxOut): Uint8Array {
  const entries: Array<readonly [Uint8Array, Uint8Array]> = [
    [cbor.uint(0), cbor.bytes(output.address)],
    [cbor.uint(1), encodeValue(output.value)],
  ];
  if (output.datum !== undefined) {
    const datum = "inline" in output.datum
      ? cbor.array([cbor.uint(1), cbor.tag(24, cbor.bytes(encodeData(output.datum.inline)))])
      : cbor.array([cbor.uint(0), cbor.bytes(output.datum.hash)]);
    entries.push([cbor.uint(2), datum]);
  }
  if (output.referenceScript !== undefined) {
    const script = cbor.array([cbor.uint(3), cbor.bytes(output.referenceScript.compiledCode)]);
    entries.push([cbor.uint(3), cbor.tag(24, cbor.bytes(script))]);
  }
  return cbor.map(entries);
}

/** `coinsPerUTxOByte` on Vector mainnet (packages/shared/src/tx/internal/minAdaFloor.ts). */
export const COINS_PER_UTXO_BYTE = 4310n;

/** Ledger min-UTxO: (160 + size of the output) × coinsPerUTxOByte. */
export const minUtxo = (output: TxOut): bigint =>
  (160n + BigInt(encodeOutput(output).length)) * COINS_PER_UTXO_BYTE;

// ─── Transactions ───────────────────────────────────────────────────────

export interface OutRef {
  readonly txId: Uint8Array;
  readonly index: number;
}

export interface Utxo {
  readonly ref: OutRef;
  readonly output: TxOut;
}

export const compareOutRefs = (a: OutRef, b: OutRef): number => compareBytes(a.txId, b.txId) || a.index - b.index;

/** An output of an earlier transaction. The transaction ID is the hash of `label`. */
export const chainUtxo = (label: string, output: TxOut, index = 0): Utxo => ({
  ref: { txId: blake2b256(new TextEncoder().encode(label)), index },
  output,
});

export interface SpendInput {
  readonly utxo: Utxo;
  /** Required for an input at a script address; not allowed for a key address. */
  readonly redeemer?: Data;
  readonly label?: string;
}

export interface MintEntry {
  readonly policy: Uint8Array;
  readonly assets: ReadonlyArray<{ readonly name: Uint8Array; readonly quantity: bigint }>;
  readonly redeemer: Data;
  readonly label?: string;
}

export interface Withdrawal {
  readonly rewardAddress: Uint8Array;
  readonly amount: bigint;
  /** Required for a script stake credential. */
  readonly redeemer?: Data;
  readonly label?: string;
}

export interface TxSpec {
  readonly inputs: readonly SpendInput[];
  readonly referenceInputs?: readonly Utxo[];
  readonly collateral?: readonly Utxo[];
  readonly outputs: readonly TxOut[];
  readonly fee: bigint;
  readonly mint?: readonly MintEntry[];
  readonly withdrawals?: readonly Withdrawal[];
  readonly requiredSigners?: readonly Uint8Array[];
  /** Slots. A script sees the range [slotToPosixMs(invalidBefore), slotToPosixMs(invalidHereafter)). */
  readonly validity?: { readonly invalidBefore?: bigint; readonly invalidHereafter?: bigint };
  /** Scripts in the witness set. Reference scripts of spent and reference inputs also count. */
  readonly scripts?: readonly PlutusV3Script[];
  /** Datums in the witness set, for spent inputs with a datum hash. */
  readonly datums?: readonly Data[];
  /** Keys that sign the transaction body. */
  readonly signers?: readonly KeyPair[];
}

export type RedeemerTag = "spend" | "mint" | "withdraw";

export interface Redeemer {
  readonly tag: RedeemerTag;
  /** Spend: position in the sorted inputs. Mint: in the sorted policies. Withdraw: in the sorted accounts. */
  readonly index: number;
  readonly data: Data;
  readonly label: string;
}

const TAG_CODE: Record<RedeemerTag, number> = { spend: 0, mint: 1, withdraw: 3 };
const TAG_NAME: Record<RedeemerTag, string> = { spend: "Spend", mint: "Mint", withdraw: "Withdraw" };

/** The purpose as aiken prints it, for example `Spend[0]`. */
export const purposeOf = (redeemer: Redeemer): string => `${TAG_NAME[redeemer.tag]}[${redeemer.index}]`;

/** The budget of `aiken tx simulate` for a whole transaction (uplc ExBudget::default). */
export const EVALUATOR_BUDGET = { mem: 14_000_000n, steps: 10_000_000_000n } as const;

export interface BuiltTx {
  readonly spec: TxSpec;
  readonly id: Uint8Array;
  readonly body: Uint8Array;
  /** Ledger order: spends by sorted input, then mints by sorted policy, then withdrawals. */
  readonly redeemers: readonly Redeemer[];
  /** Spent, reference and collateral inputs with their outputs. */
  readonly resolved: readonly Utxo[];
  /**
   * The full transaction. `order` lists the redeemer positions in the order
   * to write them. The evaluator runs the redeemers in this order and stops
   * at the first failure. The order does not change the transaction ID.
   */
  encode(order?: readonly number[]): Uint8Array;
  /** The UTxO that output `index` of this transaction creates. */
  utxo(index: number): Utxo;
}

/** A set (Conway CDDL: tag 258 around a definite array). */
const set = (items: readonly Uint8Array[]): Uint8Array => cbor.tag(258, cbor.array(items));

const encodeOutRef = (ref: OutRef): Uint8Array => cbor.array([cbor.bytes(ref.txId), cbor.uint(ref.index)]);

function compareRewardAddresses(a: Uint8Array, b: Uint8Array): number {
  // aiken sort_reward_accounts: network, then script before key, then hash.
  const network = (a[0]! & 0x0f) - (b[0]! & 0x0f);
  if (network !== 0) return network;
  const scriptA = a[0]! >> 4 === 0b1111 ? 0 : 1;
  const scriptB = b[0]! >> 4 === 0b1111 ? 0 : 1;
  return scriptA - scriptB || compareBytes(a.subarray(1), b.subarray(1));
}

function addValue(totals: Map<string, bigint>, key: string, quantity: bigint): void {
  totals.set(key, (totals.get(key) ?? 0n) + quantity);
}

/** Phase-1 value balance: inputs + withdrawals + mint = outputs + fee, per asset. */
function checkBalance(spec: TxSpec): void {
  const delta = new Map<string, bigint>();
  for (const { utxo } of spec.inputs) {
    addValue(delta, "coin", utxo.output.value.coin);
    for (const a of utxo.output.value.assets ?? []) addValue(delta, `${toHex(a.policy)}.${toHex(a.name)}`, a.quantity);
  }
  for (const w of spec.withdrawals ?? []) addValue(delta, "coin", w.amount);
  for (const m of spec.mint ?? []) {
    for (const a of m.assets) addValue(delta, `${toHex(m.policy)}.${toHex(a.name)}`, a.quantity);
  }
  for (const output of spec.outputs) {
    addValue(delta, "coin", -output.value.coin);
    for (const a of output.value.assets ?? []) addValue(delta, `${toHex(a.policy)}.${toHex(a.name)}`, -a.quantity);
  }
  addValue(delta, "coin", -spec.fee);
  const unbalanced = [...delta].filter(([, quantity]) => quantity !== 0n);
  if (unbalanced.length > 0) {
    throw new Error(`Unbalanced transaction (consumed - produced): ${unbalanced.map(([k, q]) => `${k}=${q}`).join(", ")}`);
  }
}

/**
 * Adds one change output to `changeAddress` with the AP3X that balances the
 * transaction, and with `assets` (assets that the caller left unassigned).
 */
export function withChange(spec: TxSpec, changeAddress: Uint8Array, assets: readonly Asset[] = []): TxSpec {
  let coin = -spec.fee;
  for (const { utxo } of spec.inputs) coin += utxo.output.value.coin;
  for (const w of spec.withdrawals ?? []) coin += w.amount;
  for (const output of spec.outputs) coin -= output.value.coin;
  const change: TxOut = { address: changeAddress, value: { coin, assets } };
  if (coin < minUtxo(change)) throw new Error(`Change ${coin} is below the min-UTxO ${minUtxo(change)}`);
  return { ...spec, outputs: [...spec.outputs, change] };
}

function dedupe(utxos: readonly Utxo[]): Utxo[] {
  const seen = new Set<string>();
  return utxos.filter((utxo) => {
    const key = `${toHex(utxo.ref.txId)}#${utxo.ref.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildTx(spec: TxSpec): BuiltTx {
  const inputs = [...spec.inputs].sort((a, b) => compareOutRefs(a.utxo.ref, b.utxo.ref));
  const mints = [...(spec.mint ?? [])].sort((a, b) => compareBytes(a.policy, b.policy));
  const withdrawals = [...(spec.withdrawals ?? [])].sort((a, b) => compareRewardAddresses(a.rewardAddress, b.rewardAddress));
  const signers = spec.signers ?? [];

  // Phase-1 checks.
  for (let i = 1; i < inputs.length; i += 1) {
    if (compareOutRefs(inputs[i - 1]!.utxo.ref, inputs[i]!.utxo.ref) === 0) throw new Error("Duplicate input");
  }
  for (let i = 1; i < mints.length; i += 1) {
    if (equalBytes(mints[i - 1]!.policy, mints[i]!.policy)) throw new Error("Duplicate mint policy");
  }
  for (const m of mints) {
    if (m.assets.length === 0 || m.assets.some((a) => a.quantity === 0n)) throw new Error("Empty mint or zero quantity");
  }
  checkBalance(spec);
  for (const output of spec.outputs) {
    if (output.value.coin < minUtxo(output)) {
      throw new Error(`Output coin ${output.value.coin} is below the min-UTxO ${minUtxo(output)}`);
    }
  }
  const needed: Uint8Array[] = [...(spec.requiredSigners ?? [])];
  for (const { utxo, redeemer } of inputs) {
    const credential = paymentCredential(utxo.output.address);
    if ("key" in credential) {
      if (redeemer !== undefined) throw new Error("A key-locked input takes no redeemer");
      needed.push(credential.key);
    } else if (redeemer === undefined) {
      throw new Error("A script-locked input needs a redeemer");
    }
  }
  for (const utxo of spec.collateral ?? []) {
    const credential = paymentCredential(utxo.output.address);
    if (!("key" in credential)) throw new Error("Collateral must be key-locked");
    needed.push(credential.key);
  }
  for (const w of withdrawals) {
    const script = w.rewardAddress[0]! >> 4 === 0b1111;
    if (script && w.redeemer === undefined) throw new Error("A script withdrawal needs a redeemer");
    if (!script) {
      if (w.redeemer !== undefined) throw new Error("A key withdrawal takes no redeemer");
      needed.push(w.rewardAddress.subarray(1));
    }
  }
  for (const hash of needed) {
    if (!signers.some((s) => equalBytes(s.keyHash, hash))) {
      throw new Error(`No key witness for key hash ${toHex(hash)}`);
    }
  }

  const redeemers: Redeemer[] = [];
  inputs.forEach(({ redeemer, label }, index) => {
    if (redeemer !== undefined) redeemers.push({ tag: "spend", index, data: redeemer, label: label ?? `spend ${index}` });
  });
  mints.forEach(({ redeemer, label }, index) => {
    redeemers.push({ tag: "mint", index, data: redeemer, label: label ?? `mint ${index}` });
  });
  withdrawals.forEach(({ redeemer, label }, index) => {
    if (redeemer !== undefined) redeemers.push({ tag: "withdraw", index, data: redeemer, label: label ?? `withdraw ${index}` });
  });

  const entries: Array<readonly [Uint8Array, Uint8Array]> = [
    [cbor.uint(0), set(inputs.map(({ utxo }) => encodeOutRef(utxo.ref)))],
    [cbor.uint(1), cbor.array(spec.outputs.map(encodeOutput))],
    [cbor.uint(2), cbor.uint(spec.fee)],
  ];
  if (spec.validity?.invalidHereafter !== undefined) entries.push([cbor.uint(3), cbor.uint(spec.validity.invalidHereafter)]);
  if (withdrawals.length > 0) {
    entries.push([cbor.uint(5), cbor.map(withdrawals.map((w) => [cbor.bytes(w.rewardAddress), cbor.uint(w.amount)] as const))]);
  }
  if (spec.validity?.invalidBefore !== undefined) entries.push([cbor.uint(8), cbor.uint(spec.validity.invalidBefore)]);
  if (mints.length > 0) {
    entries.push([cbor.uint(9), encodeMultiasset(mints.flatMap((m) => m.assets.map((a) => ({ policy: m.policy, ...a }))))]);
  }
  if ((spec.collateral ?? []).length > 0) {
    entries.push([cbor.uint(13), set([...spec.collateral!].sort((a, b) => compareOutRefs(a.ref, b.ref)).map((u) => encodeOutRef(u.ref)))]);
  }
  if ((spec.requiredSigners ?? []).length > 0) {
    entries.push([cbor.uint(14), set([...spec.requiredSigners!].sort(compareBytes).map(cbor.bytes))]);
  }
  if ((spec.referenceInputs ?? []).length > 0) {
    entries.push([cbor.uint(18), set([...spec.referenceInputs!].sort((a, b) => compareOutRefs(a.ref, b.ref)).map((u) => encodeOutRef(u.ref)))]);
  }
  const body = cbor.map(entries);
  const id = blake2b256(body);

  const vkeyWitnesses = signers.map((s) =>
    cbor.array([cbor.bytes(s.publicKey), cbor.bytes(Uint8Array.from(sign(null, id, s.privateKey)))]),
  );
  const share = BigInt(Math.max(redeemers.length, 1));
  const exUnits = cbor.array([cbor.uint(EVALUATOR_BUDGET.mem / share), cbor.uint(EVALUATOR_BUDGET.steps / share)]);

  const encode = (order: readonly number[] = redeemers.map((_, i) => i)): Uint8Array => {
    if (order.length !== redeemers.length || new Set(order).size !== order.length) throw new Error("Bad redeemer order");
    const witnesses: Array<readonly [Uint8Array, Uint8Array]> = [];
    if (vkeyWitnesses.length > 0) witnesses.push([cbor.uint(0), set(vkeyWitnesses)]);
    if ((spec.datums ?? []).length > 0) witnesses.push([cbor.uint(4), set(spec.datums!.map(encodeData))]);
    if (redeemers.length > 0) {
      witnesses.push([cbor.uint(5), cbor.map(order.map((position) => {
        const r = redeemers[position]!;
        return [cbor.array([cbor.uint(TAG_CODE[r.tag]), cbor.uint(r.index)]), cbor.array([encodeData(r.data), exUnits])] as const;
      }))]);
    }
    if ((spec.scripts ?? []).length > 0) witnesses.push([cbor.uint(7), set(spec.scripts!.map((s) => cbor.bytes(s.compiledCode)))]);
    return cbor.array([body, cbor.map(witnesses), cbor.TRUE, cbor.NULL]);
  };

  return {
    spec,
    id,
    body,
    redeemers,
    resolved: dedupe([...inputs.map(({ utxo }) => utxo), ...(spec.referenceInputs ?? []), ...(spec.collateral ?? [])]),
    encode,
    utxo: (index) => {
      const output = spec.outputs[index];
      if (output === undefined) throw new Error(`No output ${index}`);
      return { ref: { txId: id, index }, output };
    },
  };
}
