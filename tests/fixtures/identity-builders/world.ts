/**
 * Test world for the identity-layout builders: throwaway keys, agent records
 * at the identity address, adverts at the new advert address, and a fake
 * Ogmios endpoint for the live (lucid) path.
 *
 * Every key is derived from a public label. It controls nothing on any
 * network.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { LiveOgmiosProvider } from "../../../packages/shared/src/chain/LiveOgmiosProvider.js";
import type { OutputReference, Utxo } from "../../../packages/shared/src/chain/ChainProvider.js";
import { encodeIdentityDatum, type IdentityDatum, type Party, type Status } from "../../../packages/shared/src/cbor/IdentityDatum.js";
import { encodeIdentityAdvertDatum, type IdentityAdvertDatum } from "../../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { inspectSignedTransactionFinancials } from "../../../packages/shared/src/tx/internal/signedTransaction.js";
import { pkhToEnterpriseAddress } from "../../../packages/shared/src/tx/internal/pkhAddress.js";
import type { IdentityBlueprint } from "../../../packages/shared/src/tx/blueprint.js";
import type { WalletKey } from "../../../packages/shared/src/tx/types.js";
import { utf8ToHex, vectorIdFromSeed } from "../../../packages/shared/src/identity/id.js";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A throwaway Ed25519 wallet key (32-byte seed as the private key, as lucid's fromPrivateKey reads it). */
export function testWallet(label: string, networkId: 0 | 1 = 1): WalletKey {
  const seed = blake2b(new TextEncoder().encode(`identity-builders test key: ${label}`), { dkLen: 32 });
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = spki.subarray(spki.length - 32);
  const pkh = hex(blake2b(publicKey, { dkLen: 28 }));
  return { pubKeyHash: pkh, pubKeyHex: hex(publicKey), privateKeyHex: hex(seed), address: pkhToEnterpriseAddress(pkh, networkId) };
}

export const AP3X = 1_000_000n;
export const CAPABILITY = "llm.text.generate.v1";
export const AGENT_ID = vectorIdFromSeed("a1".repeat(32), 0);

/** Vector mainnet (Part 1 §4): system start 2025-08-29T16:40:00Z, one slot per second. */
export const VECTOR_MAINNET_ZERO_TIME_MS = 1_756_485_600_000;

/** The Accountable Party of the agent: the controller, from `notBefore`, without end. */
export function accountableParty(notBefore = 0, notAfter: number | null = null): Party {
  return {
    role: "Accountable",
    signer: { type: "ControllerSet" },
    organisation: null,
    notBefore,
    notAfter,
    rights: 3,
    removalAfter: null,
  };
}

/** A record without a parent that lists the supplier key (authentication + transaction) and CAPABILITY. */
export function agentRecord(controller: WalletKey, supplier: WalletKey, changes: Partial<IdentityDatum> = {}): IdentityDatum {
  return {
    controller: controller.pubKeyHex,
    keys: [{ keyType: "Ed25519", key: supplier.pubKeyHex, purposes: 9, pop: null }],
    parties: [accountableParty()],
    guardianThreshold: 0,
    pendingRecovery: null,
    lineage: { type: "Root" },
    subagentEpoch: 0,
    name: utf8ToHex("builder test agent"),
    description: "",
    framework: "",
    endpoint: utf8ToHex("https://agent.example/v1"),
    capabilities: [utf8ToHex(CAPABILITY)],
    createdAt: 1_760_000_000_000,
    status: { type: "Active" },
    ...changes,
  };
}

/** The tombstone of a record (Part 2 §3.7) with `status`. */
export function tombstone(record: IdentityDatum, status: Status): IdentityDatum {
  return {
    ...record,
    keys: [],
    parties: [],
    guardianThreshold: 0,
    pendingRecovery: null,
    description: "",
    framework: "",
    endpoint: "",
    capabilities: [],
    status,
  };
}

/** The authentic record output of `agentId`: identity address, 10 AP3X and the token, inline datum. */
export function recordUtxo(
  blueprint: IdentityBlueprint,
  datum: IdentityDatum,
  ref: OutputReference = { txHash: "7e".repeat(32), index: 0 },
  agentId = AGENT_ID,
): Utxo {
  return {
    ref,
    address: blueprint.identityScriptAddress(1),
    lovelace: 10n * AP3X,
    assets: { [`${blueprint.identityHash}${agentId}`]: 1n },
    datumHex: encodeIdentityDatum(datum),
    scriptRef: null,
  };
}

/** A new advert of `supplier` for AGENT_ID. */
export function identityAdvert(supplier: WalletKey, changes: Partial<IdentityAdvertDatum> = {}): IdentityAdvertDatum {
  return {
    supplier_pkh: supplier.pubKeyHash,
    capability_id: CAPABILITY,
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: 2n * AP3X,
    supplier_bond_lovelace: 1n * AP3X,
    buyer_bond_lovelace: 1n * AP3X,
    endpoint_url: "https://agent.example/v1",
    detail_uri: "ipfs://detail",
    detail_hash: "ab".repeat(32),
    advertised_at: 1_760_000_000_000,
    status: "Active",
    agent_id: AGENT_ID,
    ...changes,
  };
}

export function advertUtxo(
  blueprint: IdentityBlueprint,
  datum: IdentityAdvertDatum,
  ref: OutputReference = { txHash: "ad".repeat(32), index: 0 },
  networkId: 0 | 1 = 1,
): Utxo {
  return {
    ref,
    address: blueprint.advertScriptAddress(networkId),
    lovelace: 2n * AP3X,
    assets: {},
    datumHex: encodeIdentityAdvertDatum(datum),
    scriptRef: null,
  };
}

/** The output `index` of a built transaction as a UTxO (live CBOR or the mock body). */
export function outputOf(txCborHex: string, txHash: string, index: number): Utxo {
  const output = inspectSignedTransactionFinancials(txCborHex).outputs[index];
  if (output === undefined) throw new Error(`no output ${index}`);
  return {
    ref: { txHash, index },
    address: output.address,
    lovelace: output.lovelace,
    assets: {},
    datumHex: output.datumHex ?? null,
    scriptRef: null,
  };
}

// ─── Fake Ogmios (JSON-RPC over the injected fetch) ─────────────────────

export interface EvalRedeemer {
  validator: { purpose: "spend"; index: number };
  budget: { memory: number; cpu: number };
}

interface OgmiosRequest {
  method: string;
  params?: {
    outputReferences?: Array<{ transaction: { id: string }; index: number }>;
    addresses?: string[];
    transaction?: { cbor: string };
  };
}

const refKey = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

/** Ogmios over the injected fetch. A UTxO's `scriptRef` is a Plutus V3 reference script (blueprint compiledCode). */
export class FakeOgmios {
  readonly utxos = new Map<string, Utxo>();
  readonly submitted: string[] = [];
  readonly evaluated: string[] = [];
  /** Default: one spend redeemer at the script input's ledger index, fixed budget. */
  evaluate: (txCborHex: string) => EvalRedeemer[] | { code: number; message: string } = (tx) => [
    { validator: { purpose: "spend", index: this.scriptInputIndex(tx) }, budget: { memory: 1_000_000, cpu: 500_000_000 } },
  ];

  add(...utxos: Utxo[]): void {
    for (const utxo of utxos) this.utxos.set(refKey(utxo.ref), utxo);
  }

  /** Wallet UTxOs: AP3X only, at the mainnet enterprise address that lucid derives from the key. */
  fund(wallet: WalletKey, ...amounts: bigint[]): void {
    amounts.forEach((lovelace, i) => this.add({
      ref: { txHash: hex(blake2b(new TextEncoder().encode(`${wallet.pubKeyHash} funds`), { dkLen: 32 })), index: i },
      address: pkhToEnterpriseAddress(wallet.pubKeyHash, 1),
      lovelace,
      assets: {},
      datumHex: null,
      scriptRef: null,
    }));
  }

  /** Ledger index (sorted inputs) of the first input that this fake holds at a script address. */
  scriptInputIndex(txCborHex: string): number {
    const inputs = [...inspectSignedTransactionFinancials(txCborHex).inputs]
      .sort((a, b) => (a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1));
    return inputs.findIndex((ref) => {
      const utxo = this.utxos.get(refKey(ref));
      return utxo !== undefined && /^addr(_test)?1w/.test(utxo.address);
    });
  }

  private ogmiosUtxo(utxo: Utxo): unknown {
    const tokens: Record<string, Record<string, number>> = {};
    for (const [unit, quantity] of Object.entries(utxo.assets)) {
      const policy = unit.slice(0, 56);
      tokens[policy] = { ...tokens[policy], [unit.slice(56).replace(".", "")]: Number(quantity) };
    }
    return {
      transaction: { id: utxo.ref.txHash },
      index: utxo.ref.index,
      address: utxo.address,
      value: { ada: { lovelace: Number(utxo.lovelace) }, ...tokens },
      datum: utxo.datumHex,
      datumHash: null,
      script: utxo.scriptRef === null ? null : { language: "plutus:v3", cbor: utxo.scriptRef },
    };
  }

  readonly fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // The requests come from our own Ogmios providers; this shape covers the methods below.
    const request: OgmiosRequest = JSON.parse(String(init?.body));
    let result: unknown;
    let error: unknown;
    switch (request.method) {
      case "queryNetwork/tip":
        result = { slot: Math.floor((Date.now() - VECTOR_MAINNET_ZERO_TIME_MS) / 1000), id: "a".repeat(64) };
        break;
      case "queryLedgerState/utxo": {
        const references = request.params?.outputReferences;
        if (references !== undefined) {
          result = references
            .map((ref) => this.utxos.get(`${ref.transaction.id}#${ref.index}`))
            .filter((utxo): utxo is Utxo => utxo !== undefined)
            .map((utxo) => this.ogmiosUtxo(utxo));
        } else {
          const addresses = request.params?.addresses ?? [];
          result = [...this.utxos.values()].filter((utxo) => addresses.includes(utxo.address)).map((utxo) => this.ogmiosUtxo(utxo));
        }
        break;
      }
      case "evaluateTransaction": {
        const tx = request.params?.transaction?.cbor ?? "";
        this.evaluated.push(tx);
        const outcome = this.evaluate(tx);
        if (Array.isArray(outcome)) result = outcome;
        else error = outcome;
        break;
      }
      case "submitTransaction":
        this.submitted.push(request.params?.transaction?.cbor ?? "");
        result = { transaction: { id: "d".repeat(64) } };
        break;
      default:
        throw new Error(`unexpected Ogmios method ${request.method}`);
    }
    const body = error === undefined ? { jsonrpc: "2.0", result } : { jsonrpc: "2.0", error };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };

  chain(): LiveOgmiosProvider {
    return new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios.invalid", fetch: this.fetch });
  }
}
