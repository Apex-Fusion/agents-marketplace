// Builds record histories in a FakeChain: registrations, updates, value-only changes, adoptions,
// legacy registrations, updates and deregistrations, and moves of a token out of and back into an
// authentic output. Block h has slot 10·h; every transaction states its block height.

import { blake2b } from "@noble/hashes/blake2b";
import { createHash } from "node:crypto";
import type { Asset, LedgerTx, TxInput, TxOutput } from "../../src/chain/types.js";
import { encodeIdentityDatum, type IdentityDatum, type Party, type Signer } from "../../src/codec/identity-datum.js";
import { bech32Encode } from "../../src/codec/address.js";
import { keyHash } from "../../src/codec/keys.js";
import { encodeLegacyDatum, type LegacyDatum } from "../../src/codec/legacy-datum.js";
import { LEGACY_REGISTRY, VECTOR_MAINNET, registryOf, type ResolverSettings } from "../../src/resolve/settings.js";
import { FakeChain } from "./chain.js";
import { ed25519Key } from "./keys.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A stand-in identity registry: its policy ID is blake2b-224 of a label, not a deployed script. */
export const IDENTITY = registryOf(Buffer.from(blake2b(Buffer.from("did:vector test identity registry"), { dkLen: 28 })).toString("hex"));
export const LEGACY = LEGACY_REGISTRY;
export const WALLET = "addr1q8pyltzvw2vvp29g95ndr6tukpzyc7qtaxq8f400c2kuq83t63ar50qelzpf59teke4kuythtxzgx6mxtv75l79xryvqhagm80";

export const SLOTS_PER_BLOCK = 10;
export const CUTOFF_HEIGHT = 500;
export const slotAt = (height: number): number => height * SLOTS_PER_BLOCK;
/** Block time of a height, POSIX milliseconds. */
export const timeAt = (height: number): number => (VECTOR_MAINNET.systemStart + slotAt(height)) * 1000;
export const blockHashAt = (height: number): string => sha256(`block:${height}`);

export const SETTINGS: ResolverSettings = {
  network: VECTOR_MAINNET,
  registries: { identity: IDENTITY, legacy: LEGACY, cutoffSlot: slotAt(CUTOFF_HEIGHT) },
};

/** A 64-hex identifier for a label. */
export const idOf = (label: string): string => sha256(`id:${label}`);
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const CONTROLLER = ed25519Key(1);
export const CONTROLLER_2 = ed25519Key(2);
export const KEY_A = ed25519Key(3);
export const KEY_B = ed25519Key(4);
export const PARTY_KEY = ed25519Key(5);
export const PARTY_KEY_2 = ed25519Key(6);
export const GUARDIAN_KEY = ed25519Key(7);
export const LEGACY_OWNER = ed25519Key(8);
export const LEGACY_OWNER_2 = ed25519Key(9);

/** The legacy script with a stake credential (header 0x11): the same script, but not the exact registry address. */
export const LEGACY_WITH_STAKE = bech32Encode("addr", Uint8Array.from([0x11, ...Buffer.from(LEGACY.policyId, "hex"), ...Buffer.from(keyHash(PARTY_KEY), "hex")]));

export const keySigner = (key: string): Signer => ({ type: "KeyHash", hash: keyHash(key) });

export function party(overrides: Partial<Party> = {}): Party {
  return {
    role: "Accountable",
    signer: keySigner(PARTY_KEY),
    organisation: null,
    notBefore: 0,
    notAfter: null,
    rights: 3,
    removalAfter: null,
    ...overrides,
  };
}

export function identityDatum(overrides: Partial<IdentityDatum> = {}): IdentityDatum {
  return {
    controller: CONTROLLER,
    keys: [{ keyType: "Ed25519", key: KEY_A, purposes: 1 | 2 | 8, pop: null }],
    parties: [party()],
    guardianThreshold: 0,
    pendingRecovery: null,
    lineage: { type: "Root" },
    subagentEpoch: 0,
    name: utf8("test-agent"),
    description: utf8("An agent for resolver tests."),
    framework: utf8("vector-agent-template"),
    endpoint: utf8("https://agent.example.org/a2a"),
    capabilities: [utf8("ocr.extract.v1"), utf8("llm.text.generate.v1")],
    createdAt: timeAt(100),
    status: { type: "Active" },
    ...overrides,
  };
}

export function legacyDatum(owner: string = LEGACY_OWNER, overrides: Partial<LegacyDatum> = {}): LegacyDatum {
  return {
    owner: { kind: "key", hash: keyHash(owner) },
    name: utf8("Legacy Agent"),
    description: utf8("A record of the legacy registry."),
    capabilities: [utf8("document-extraction")],
    framework: utf8("custom"),
    endpoint: utf8("https://legacy.example.org/agent"),
    registeredAt: 1_756_000_000_000n,
    ...overrides,
  };
}

export interface At {
  readonly height: number;
  readonly txIndex?: number;
  /** Ed25519 keys that witness the transaction. */
  readonly vkeys?: readonly string[];
}

interface Holding {
  readonly txHash: string;
  readonly output: TxOutput;
}

export class LedgerBuilder {
  readonly chain = new FakeChain();
  private count = 0;
  private readonly holdings = new Map<string, Holding>();

  constructor(readonly settings: ResolverSettings = SETTINGS) {
    this.tip(1000);
  }

  tip(height: number): this {
    this.chain.tipInfo = { blockHeight: height, blockHash: blockHashAt(height), slot: slotAt(height) };
    return this;
  }

  private add(at: At, inputs: TxInput[], outputs: TxOutput[], mint: Asset[]): LedgerTx {
    const txHash = sha256(`tx:${this.count++}`);
    const tx: LedgerTx = { txHash, blockHash: blockHashAt(at.height), blockHeight: at.height, txIndex: at.txIndex ?? 0, slot: slotAt(at.height), inputs, outputs, mint };
    this.chain.txs.push(tx);
    if (at.vkeys?.length) this.chain.witnesses.set(txHash, [...at.vkeys]);
    return tx;
  }

  private fee(): TxInput {
    return { txHash: sha256(`funds:${this.count}`), outputIndex: 0, address: WALLET, assets: [] };
  }

  private change(outputIndex: number): TxOutput {
    return { outputIndex, address: WALLET, lovelace: 5_000_000n, assets: [], inlineDatum: null, datumHash: null, hasReferenceScript: false };
  }

  private spend(id: string): TxInput {
    const held = this.holdings.get(id);
    if (!held) throw new Error(`no output holds ${id}`);
    return { txHash: held.txHash, outputIndex: held.output.outputIndex, address: held.output.address, assets: held.output.assets };
  }

  private hold(id: string, tx: LedgerTx, output: TxOutput | null): LedgerTx {
    if (output) this.holdings.set(id, { txHash: tx.txHash, output });
    else this.holdings.delete(id);
    return tx;
  }

  /** The output that holds the token now. */
  current(id: string): TxOutput {
    const held = this.holdings.get(id);
    if (!held) throw new Error(`no output holds ${id}`);
    return held.output;
  }

  static datumOutput(address: string, assets: Asset[], cbor: string, lovelace: bigint, inline = true): TxOutput {
    const datumHash = Buffer.from(blake2b(Buffer.from(cbor, "hex"), { dkLen: 32 })).toString("hex");
    return { outputIndex: 0, address, lovelace, assets, inlineDatum: inline ? cbor : null, datumHash, hasReferenceScript: false };
  }

  private identityOutput(id: string, datum: IdentityDatum, lovelace = 10_000_000n): TxOutput {
    return LedgerBuilder.datumOutput(IDENTITY.address, [{ policyId: IDENTITY.policyId, assetName: id, quantity: 1n }], hex(encodeIdentityDatum(datum)), lovelace);
  }

  private legacyOutput(id: string, datum: LegacyDatum, inline = true): TxOutput {
    return LedgerBuilder.datumOutput(LEGACY.address, [{ policyId: LEGACY.policyId, assetName: id, quantity: 1n }], hex(encodeLegacyDatum(datum)), 2_000_000n, inline);
  }

  // ── identity registry ──

  register(id: string, datum: IdentityDatum, at: At): LedgerTx {
    const out = this.identityOutput(id, datum);
    return this.hold(id, this.add(at, [this.fee()], [out, this.change(1)], [{ policyId: IDENTITY.policyId, assetName: id, quantity: 1n }]), out);
  }

  update(id: string, datum: IdentityDatum, at: At): LedgerTx {
    const out = this.identityOutput(id, datum, this.current(id).lovelace);
    return this.hold(id, this.add(at, [this.spend(id), this.fee()], [out, this.change(1)], []), out);
  }

  /** An update that writes the given datum CBOR (for example, another encoding of the same data). */
  updateRaw(id: string, cbor: string, at: At): LedgerTx {
    const out = LedgerBuilder.datumOutput(IDENTITY.address, [{ policyId: IDENTITY.policyId, assetName: id, quantity: 1n }], cbor, this.current(id).lovelace);
    return this.hold(id, this.add(at, [this.spend(id), this.fee()], [out, this.change(1)], []), out);
  }

  /** A value-only change (deposit added or taken back): same datum, other lovelace. */
  touch(id: string, lovelace: bigint, at: At): LedgerTx {
    const out = { ...this.current(id), lovelace };
    return this.hold(id, this.add(at, [this.spend(id), this.fee()], [out, this.change(1)], []), out);
  }

  /** Burns the legacy token and mints the identity token with the same name. */
  adopt(id: string, datum: IdentityDatum, at: At): LedgerTx {
    const out = this.identityOutput(id, datum);
    const mint = [
      { policyId: IDENTITY.policyId, assetName: id, quantity: 1n },
      { policyId: LEGACY.policyId, assetName: id, quantity: -1n },
    ];
    return this.hold(id, this.add(at, [this.spend(id), this.fee()], [out, this.change(1)], mint), out);
  }

  // ── legacy registry ──

  legacyRegister(id: string, datum: LegacyDatum, at: At, options: { inline?: boolean; datumKnown?: boolean } = {}): LedgerTx {
    const out = this.legacyOutput(id, datum, options.inline ?? true);
    if (options.inline === false && options.datumKnown) this.chain.datumStore.set(out.datumHash!, hex(encodeLegacyDatum(datum)));
    return this.hold(id, this.add(at, [this.fee()], [out, this.change(1)], [{ policyId: LEGACY.policyId, assetName: id, quantity: 1n }]), out);
  }

  /** A legacy registration whose output carries arbitrary datum CBOR (for unreadable datums). */
  legacyRegisterRaw(id: string, cbor: string, at: At): LedgerTx {
    const out = LedgerBuilder.datumOutput(LEGACY.address, [{ policyId: LEGACY.policyId, assetName: id, quantity: 1n }], cbor, 2_000_000n);
    return this.hold(id, this.add(at, [this.fee()], [out, this.change(1)], [{ policyId: LEGACY.policyId, assetName: id, quantity: 1n }]), out);
  }

  /** A transaction that touches no record (for example, another payment in the same block). */
  other(at: At): LedgerTx {
    return this.add(at, [this.fee()], [this.change(0)], []);
  }

  legacyUpdate(id: string, datum: LegacyDatum, at: At): LedgerTx {
    const out = this.legacyOutput(id, datum);
    return this.hold(id, this.add(at, [this.spend(id), this.fee()], [out, this.change(1)], []), out);
  }

  legacyDeregister(id: string, at: At): LedgerTx {
    return this.hold(id, this.add(at, [this.spend(id), this.fee()], [this.change(0)], [{ policyId: LEGACY.policyId, assetName: id, quantity: -1n }]), null);
  }

  /** Moves the token, with its datum, to an output that is not authentic. */
  moveOut(id: string, at: At, address = WALLET, extraAssets: readonly Asset[] = []): LedgerTx {
    const held = this.current(id);
    const out = { ...held, address, assets: [...held.assets, ...extraAssets] };
    return this.hold(id, this.add(at, [this.spend(id), this.fee()], [out, this.change(1)], []), out);
  }

  /** Moves the token back to the exact registry address, with the same datum. */
  moveBack(id: string, address: string, at: At): LedgerTx {
    const out = { ...this.current(id), address };
    return this.hold(id, this.add(at, [this.spend(id), this.fee()], [out, this.change(1)], []), out);
  }
}
