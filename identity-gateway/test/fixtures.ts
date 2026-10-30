// An in-memory ChainSource and a builder for generation-1 record histories.

import { blake2b } from "@noble/hashes/blake2b";
import type { ChainSource, ChainTip, LedgerTx, TxPointer, TxWitnesses, UnspentOutput } from "../src/chain/types.js";
import { GENERATION_1 } from "../src/resolve/registry.js";

export const POLICY = GENERATION_1.policyId;
export const REGISTRY = GENERATION_1.scriptAddress;
export const WALLET = "addr1q8pyltzvw2vvp29g95ndr6tukpzyc7qtaxq8f400c2kuq83t63ar50qelzpf59teke4kuythtxzgx6mxtv75l79xryvqhagm80";

// Mainnet facts: record 4c2047... was minted in tx e6992139... (block 4821638), whose only vkey
// witness is OWNER_KEY; the record's owner hash is blake2b-224(OWNER_KEY). OWNER_MULTIKEY was
// computed with @scure/base, independently of src/resolve/multikey.ts.
export const ASSET = "4c2047697c7aa8b3399c5fecf20f2bd19ff276aaffbd0496acfd7b3e1a52545e";
export const MINT_TX = "e6992139dfb2922a175d3d614899067e6989e79e791f7b9e452af007bbec1611";
export const MINT_BLOCK = { hash: "adfc6ebfb06396231fa21deb352a2ce158af2ed67bbdcf06eadb4f5d4eacbff0", height: 4821638, slot: 19801342, time: 1776286942 };
export const OWNER_KEY = "edca77f5418b21bb7bf540bd056a238e38575fc26c4aa677a36df6bf305d9e9c";
export const OWNER_HASH = "c24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01e";
export const OWNER_MULTIKEY = "z6MkvTVjXjyHobwwQTTFzv36vkXTTTKdPu8uc8X8giZ82cdq";
export const REAL_DATUM =
  "d8799fd8799f581cc24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01eff52476f7665726e616e636550726f706f7365725f5840416e616c797a6573206f6e2d636861696e206d65747269637320616e64207375626d69747320676f7665726e616e63652070726f706f73616c7320746f20696d583070726f766520566563746f722070726f746f636f6c20706172616d657465727320616e64206f7065726174696f6e732eff9f4a676f7665726e616e636549616e616c79746963735070726f706f73616c2d77726974696e67ff4b636c617564652d636f6465401b0000019d92f3c0afff";

export const LEGACY_DID = `did:vector:agent:${POLICY}:${ASSET}`;
export const CANONICAL_DID = `did:vector:${ASSET}`;

export const keyHashOf = (keyHex: string) => Buffer.from(blake2b(Buffer.from(keyHex, "hex"), { dkLen: 28 })).toString("hex");

/** The real datum with another owner; `script` makes the owner a script credential (Constr 1). */
export function datumFor(ownerHash: string, script = false): string {
  const body = REAL_DATUM.replace(OWNER_HASH, ownerHash);
  return script ? body.replace(/^d8799fd8799f/, "d8799fd87a9f") : body;
}

const hex64 = (n: number) => n.toString(16).padStart(64, "0");
const token = (quantity = 1n) => ({ policyId: POLICY, assetName: ASSET, quantity });

export interface RecordStep {
  kind: "mint" | "update" | "burn";
  height: number;
  /** Owner hash written by a mint or update. */
  owner?: string;
  /** Ed25519 keys (hex) that witnessed the transaction. */
  witnesses: string[];
  txHash?: string;
  blockIndex?: number;
  time?: number;
}

export interface OtherTx {
  height: number;
  witnesses: string[];
  /** Payment credentials whose index lists this transaction. */
  credentials: string[];
  txHash?: string;
}

export class FakeChain implements ChainSource {
  tipInfo: ChainTip = { blockHeight: 5_000_000, blockHash: "ab".repeat(32), slot: 30_000_000 };
  txs: LedgerTx[] = [];
  utxos: UnspentOutput[] = [];
  credentialIndex = new Map<string, TxPointer[]>();
  witnesses = new Map<number, TxWitnesses[]>();
  /** Heights passed to blockWitnesses, in call order. */
  witnessCalls: number[] = [];

  async tip() {
    return this.tipInfo;
  }
  async utxosWithAsset(policyId: string, assetName: string) {
    return this.utxos.filter((u) => u.assets.some((a) => a.policyId === policyId && a.assetName === assetName));
  }
  async assetTxHashes(policyId: string, assetName: string) {
    const touches = (assets: LedgerTx["mint"]) => assets.some((a) => a.policyId === policyId && a.assetName === assetName);
    return this.txs.filter((t) => touches(t.mint) || t.inputs.some((i) => touches(i.assets)) || t.outputs.some((o) => touches(o.assets))).map((t) => t.txHash);
  }
  async transactions(txHashes: string[]) {
    return this.txs.filter((t) => txHashes.includes(t.txHash));
  }
  async paymentCredentialTxs(keyHash: string) {
    return this.credentialIndex.get(keyHash) ?? [];
  }
  async blockWitnesses(blockHeight: number) {
    this.witnessCalls.push(blockHeight);
    return this.witnesses.get(blockHeight) ?? [];
  }

  private addWitnesses(height: number, txHash: string, vkeys: string[]) {
    this.witnesses.set(height, [...(this.witnesses.get(height) ?? []), { txHash, vkeys }]);
  }

  /** Lays down a record history; the record output of the last mint or update stays unspent unless burned. */
  static history(steps: RecordStep[], others: OtherTx[] = []): FakeChain {
    const chain = new FakeChain();
    let previous: string | null = null; // tx holding the record output
    let owner = OWNER_HASH;
    for (const [i, s] of steps.entries()) {
      const txHash = s.txHash ?? (i === 0 ? MINT_TX : hex64(0x1000 + i));
      const realMintBlock = txHash === MINT_TX && s.height === MINT_BLOCK.height;
      const tx: LedgerTx = {
        txHash,
        blockHash: realMintBlock ? MINT_BLOCK.hash : hex64(0xb0000 + s.height),
        blockHeight: s.height,
        blockIndex: s.blockIndex ?? 0,
        slot: realMintBlock ? MINT_BLOCK.slot : s.height * 4,
        blockTime: s.time ?? 1_776_000_000 + s.height,
        inputs: previous
          ? [{ txHash: previous, outputIndex: 0, address: REGISTRY, assets: [token()] }]
          : [{ txHash: hex64(0xf000 + i), outputIndex: 0, address: WALLET, assets: [] }],
        outputs: s.kind === "burn" ? [{ outputIndex: 0, address: WALLET, assets: [] }] : [{ outputIndex: 0, address: REGISTRY, assets: [token()] }],
        mint: s.kind === "mint" ? [token(1n)] : s.kind === "burn" ? [token(-1n)] : [],
      };
      chain.txs.push(tx);
      chain.addWitnesses(s.height, txHash, s.witnesses);
      owner = s.owner ?? owner;
      previous = s.kind === "burn" ? null : txHash;
    }
    if (previous) {
      chain.utxos.push({ txHash: previous, outputIndex: 0, address: REGISTRY, assets: [token()], datumHex: datumFor(owner) });
    }
    for (const [i, o] of others.entries()) {
      const txHash = o.txHash ?? hex64(0x2000 + i);
      chain.addWitnesses(o.height, txHash, o.witnesses);
      for (const c of o.credentials) chain.credentialIndex.set(c, [...(chain.credentialIndex.get(c) ?? []), { txHash, blockHeight: o.height }]);
    }
    return chain;
  }
}

/** The mainnet registration of ASSET: minted at block 4821638, witnessed by OWNER_KEY. */
export function realMint(): RecordStep {
  return { kind: "mint", height: MINT_BLOCK.height, owner: OWNER_HASH, witnesses: [OWNER_KEY], time: MINT_BLOCK.time };
}
