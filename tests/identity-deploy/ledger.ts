/**
 * An in-memory Vector ledger and chain index for the tests of the identity
 * deployment tool (contracts/identity-marketplace/deploy).
 *
 * - `submit` decodes the transaction, requires that every input exists and
 *   that every spent key-locked input has a valid key witness, then applies
 *   the transaction.
 * - `evaluate` runs `aiken tx simulate` (evaluateBuiltTx of the legacy-registry
 *   harness) on a transaction with redeemers. Like Ogmios, it returns no
 *   units for a transaction without scripts.
 * - `FakeIndex` stands in for Koios: the asset list, the asset cache (which
 *   can lack recent assets) and the first-mint lookup.
 */

import { addressFromBytes, paymentCredential, transactionId, type ExUnits, type OutputReference, type ProtocolParameters } from "@marketplace/shared";
import { readCbor, type CborItem } from "../../packages/shared/src/identity/tx/cbor.js";
import { describeSimulation } from "../legacy-registry/harness/index.js";
import { evaluateBuiltTx, TEST_PROTOCOL } from "../legacy-registry/harness/identity.js";
import type { Chain, ChainUtxo, LegacyIndex } from "../../contracts/identity-marketplace/deploy/chain.js";
import type { Io } from "../../contracts/identity-marketplace/deploy/context.js";
import { MAINNET_SYSTEM_START, type Network } from "../../contracts/identity-marketplace/deploy/network.js";
import { witnessedKeyHashes } from "../../contracts/identity-marketplace/deploy/txfiles.js";

/** The tip of the fake chain: 2025-11-01T12:26:40Z, the time of the harness tests. */
export const TIP_SLOT = 5_514_400;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const refKey = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

function field(map: CborItem, key: number): CborItem | undefined {
  if (map.kind !== "map") throw new Error("not a CBOR map");
  return map.entries.find(([k]) => k.kind === "uint" && k.value === BigInt(key))?.[1];
}

function refs(item: CborItem | undefined): OutputReference[] {
  if (item === undefined) return [];
  const list = item.kind === "tag" ? item.item : item;
  if (list.kind !== "array") throw new Error("not a list of output references");
  return list.items.map((entry) => {
    if (entry.kind !== "array" || entry.items[0]?.kind !== "bytes" || entry.items[1]?.kind !== "uint") throw new Error("bad output reference");
    return { txHash: hex(entry.items[0].value), index: Number(entry.items[1].value) };
  });
}

function decodeOutput(item: CborItem, ref: OutputReference): ChainUtxo {
  const address = field(item, 0);
  const value = field(item, 1);
  if (address?.kind !== "bytes" || value === undefined) throw new Error("bad output");
  let lovelace: bigint;
  const assets: Record<string, bigint> = {};
  if (value.kind === "uint") lovelace = value.value;
  else if (value.kind === "array" && value.items[0]?.kind === "uint" && value.items[1]?.kind === "map") {
    lovelace = value.items[0].value;
    for (const [policy, names] of value.items[1].entries) {
      if (policy.kind !== "bytes" || names.kind !== "map") throw new Error("bad multi-asset");
      for (const [name, quantity] of names.entries) {
        if (name.kind !== "bytes" || quantity.kind !== "uint") throw new Error("bad asset");
        assets[`${hex(policy.value)}${hex(name.value)}`] = quantity.value;
      }
    }
  } else throw new Error("bad value");
  const datum = field(item, 2);
  let datumHex: string | null = null;
  if (datum?.kind === "array" && datum.items[0]?.kind === "uint" && datum.items[0].value === 1n) {
    const inline = datum.items[1];
    if (inline?.kind !== "tag" || inline.item.kind !== "bytes") throw new Error("bad inline datum");
    datumHex = hex(inline.item.value);
  }
  const script = field(item, 3);
  let scriptRef: string | null = null;
  if (script !== undefined) {
    if (script.kind !== "tag" || script.item.kind !== "bytes") throw new Error("bad script reference");
    const inner = readCbor(script.item.value);
    if (inner.kind !== "array" || inner.items[0]?.kind !== "uint" || inner.items[0].value !== 3n || inner.items[1]?.kind !== "bytes") {
      throw new Error("the script reference is not a Plutus V3 script");
    }
    scriptRef = hex(inner.items[1].value);
  }
  return {
    ref,
    address: addressFromBytes(address.value),
    lovelace,
    assets,
    datumHex,
    scriptRef,
    ...(scriptRef === null ? {} : { scriptLanguage: "plutus:v3" }),
  };
}

export interface DecodedTx {
  id: string;
  inputs: OutputReference[];
  collateral: OutputReference[];
  outputs: ChainUtxo[];
  redeemers: number;
}

export function decodeTx(txCborHex: string): DecodedTx {
  const tx = readCbor(Buffer.from(txCborHex, "hex"));
  if (tx.kind !== "array" || tx.items.length !== 4) throw new Error("not a Conway transaction");
  const body = tx.items[0]!;
  const id = transactionId(txCborHex);
  const outputs = field(body, 1);
  if (outputs?.kind !== "array") throw new Error("no outputs");
  const redeemers = field(tx.items[1]!, 5);
  return {
    id,
    inputs: refs(field(body, 0)),
    collateral: refs(field(body, 13)),
    outputs: outputs.items.map((item, index) => decodeOutput(item, { txHash: id, index })),
    redeemers: redeemers === undefined ? 0 : redeemers.kind === "map" ? redeemers.entries.length : redeemers.kind === "array" ? redeemers.items.length : 0,
  };
}

export class FakeLedger implements Chain {
  readonly label = "fake ledger";
  readonly utxos = new Map<string, ChainUtxo>();
  readonly submitted: string[] = [];
  readonly evaluations: string[] = [];
  tip = TIP_SLOT;
  protocol: ProtocolParameters = TEST_PROTOCOL;

  add(...utxos: ChainUtxo[]): void {
    for (const u of utxos) this.utxos.set(refKey(u.ref), u);
  }

  async tipSlot(): Promise<number> {
    return this.tip;
  }

  async systemStartMs(): Promise<number> {
    return MAINNET_SYSTEM_START * 1000;
  }

  async protocolParameters(): Promise<ProtocolParameters> {
    return this.protocol;
  }

  async utxosAt(address: string): Promise<ChainUtxo[]> {
    return [...this.utxos.values()].filter((u) => u.address === address);
  }

  async utxo(ref: OutputReference): Promise<ChainUtxo | null> {
    return this.utxos.get(refKey(ref)) ?? null;
  }

  async evaluate(txCborHex: string, additional: readonly ChainUtxo[]): Promise<Record<string, ExUnits>> {
    this.evaluations.push(transactionId(txCborHex));
    if (decodeTx(txCborHex).redeemers === 0) return {};
    const simulation = evaluateBuiltTx(txCborHex, [...this.utxos.values(), ...additional], "evaluate");
    if (!simulation.passed) throw new Error(`evaluation failed: ${describeSimulation(simulation)} ${simulation.error ?? ""}`);
    const units: Record<string, ExUnits> = {};
    for (const verdict of simulation.verdicts) {
      const [, purpose, index] = /^(\w+)\[(\d+)\]$/.exec(verdict.purpose)!;
      units[`${purpose!.toLowerCase()}:${index}`] = { mem: BigInt(verdict.mem!), steps: BigInt(verdict.cpu!) };
    }
    return units;
  }

  async submit(txCborHex: string): Promise<string> {
    const tx = decodeTx(txCborHex);
    const witnessed = new Set(witnessedKeyHashes(txCborHex));
    for (const ref of [...tx.inputs, ...tx.collateral]) {
      const spent = this.utxos.get(refKey(ref));
      if (spent === undefined) throw new Error(`BadInputs: ${refKey(ref)} is not in the ledger`);
      const credential = paymentCredential(spent.address);
      if (credential?.type === "VerificationKey" && !witnessed.has(credential.hash)) throw new Error(`MissingVKeyWitnesses: ${credential.hash}`);
    }
    for (const ref of tx.inputs) this.utxos.delete(refKey(ref));
    this.add(...tx.outputs);
    this.submitted.push(tx.id);
    return tx.id;
  }
}

export interface FakeAsset {
  name: string;
  slot: number;
  /** Default 1; 0 for a burned identifier. */
  supply?: bigint;
  /** False when the asset cache of the index lacks the asset. */
  cached?: boolean;
}

export class FakeIndex implements LegacyIndex {
  readonly label = "fake index";
  readonly lookups: string[] = [];

  constructor(public tip: number, public assets: FakeAsset[], public systemStart = MAINNET_SYSTEM_START) {}

  async tipSlot(): Promise<number> {
    return this.tip;
  }

  async genesis(): Promise<{ systemStart: number; slotLength: number }> {
    return { systemStart: this.systemStart, slotLength: 1 };
  }

  async policyAssetNames(): Promise<string[]> {
    return this.assets.map((a) => a.name).sort();
  }

  async policyAssets(): Promise<Array<{ name: string; firstMintTime: number; supply: bigint }>> {
    return this.assets.filter((a) => a.cached !== false).map((a) => ({ name: a.name, firstMintTime: this.systemStart + a.slot, supply: a.supply ?? 1n }));
  }

  async firstMintTime(_policy: string, name: string): Promise<number> {
    this.lookups.push(name);
    const asset = this.assets.find((a) => a.name === name);
    if (asset === undefined) throw new Error(`no asset ${name}`);
    return this.systemStart + asset.slot;
  }
}

export interface TestIo extends Io {
  lines: string[];
}

/** An Io over the fake ledger and index; output lines are collected. */
export function testIo(ledger: FakeLedger, index?: FakeIndex): TestIo {
  const lines: string[] = [];
  return {
    lines,
    out: (line) => lines.push(line),
    chain: (_network: Network) => ledger,
    index: (_network: Network) => {
      if (index === undefined) throw new Error("no index in this test");
      return index;
    },
    sleep: async () => undefined,
    now: () => new Date("2026-11-03T12:00:00.000Z"),
  };
}
