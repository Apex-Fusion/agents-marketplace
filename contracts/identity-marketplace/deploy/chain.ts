/**
 * Chain access of the deployment tool. Ogmios (JSON-RPC over HTTP, v6) gives
 * the tip, the system start, the protocol parameters, UTxOs and the script
 * evaluation; the cardano-submit-api endpoint takes the signed transaction;
 * Koios lists the mints of the legacy registry policy. Only `submit` changes
 * the chain, and only the `--submit` flag reaches it.
 *
 * The interfaces are the seams of the tests, which use an in-memory ledger.
 */

import type { ExUnits, OutputReference, ProtocolParameters, Utxo } from "@marketplace/shared";
import { ogmiosProtocolParameters } from "../../../supplier/src/identity/registrar.js";
import { DeployError } from "./network.js";

/** A chain UTxO with the language of its reference script (Ogmios names it; the shared type keeps only the code). */
export type ChainUtxo = Utxo & { scriptLanguage?: string };

export interface Chain {
  /** The endpoint, for messages. */
  readonly label: string;
  tipSlot(): Promise<number>;
  /** The system start in POSIX milliseconds. */
  systemStartMs(): Promise<number>;
  /** The protocol parameters with the Plutus V3 cost model; an error, never a default, when a value is missing. */
  protocolParameters(): Promise<ProtocolParameters>;
  utxosAt(address: string): Promise<ChainUtxo[]>;
  utxo(ref: OutputReference): Promise<ChainUtxo | null>;
  /**
   * The execution units of each redeemer, keyed `<tag>:<index>` as the
   * builders take them (`TxContext.exUnits`). `additional` resolves inputs
   * that are not on chain yet (outputs of earlier transactions of the same
   * run). Throws when a script fails.
   */
  evaluate(txCborHex: string, additional: readonly Utxo[]): Promise<Record<string, ExUnits>>;
  /** Sends a signed transaction; returns its ID. */
  submit(txCborHex: string): Promise<string>;
}

interface OgmiosUtxo {
  transaction: { id: string };
  index: number;
  address: string;
  value: Record<string, Record<string, number | bigint>>;
  datumHash?: string;
  datum?: string;
  script?: { language?: string; cbor?: string };
}

interface OgmiosEvaluation {
  validator?: { purpose?: string; index?: number };
  budget?: { memory?: number; cpu?: number };
}

const PURPOSE_TAGS: Readonly<Record<string, string>> = { spend: "spend", mint: "mint", withdraw: "withdraw" };

function fromOgmios(o: OgmiosUtxo): ChainUtxo {
  const assets: Record<string, bigint> = {};
  let lovelace = 0n;
  for (const [policy, entries] of Object.entries(o.value)) {
    for (const [name, quantity] of Object.entries(entries)) {
      if (policy === "ada" && name === "lovelace") lovelace = BigInt(quantity);
      else assets[`${policy}${name}`] = BigInt(quantity);
    }
  }
  return {
    ref: { txHash: o.transaction.id, index: o.index },
    address: o.address,
    lovelace,
    assets,
    datumHex: typeof o.datum === "string" && o.datum.length > 0 ? o.datum : null,
    scriptRef: typeof o.script?.cbor === "string" ? o.script.cbor : null,
    ...(typeof o.script?.language === "string" ? { scriptLanguage: o.script.language } : {}),
  };
}

/** A UTxO in the form of Ogmios `additionalUtxo`. */
function toOgmios(u: ChainUtxo): OgmiosUtxo {
  const value: Record<string, Record<string, number>> = { ada: { lovelace: Number(u.lovelace) } };
  for (const [unit, quantity] of Object.entries(u.assets)) {
    const flat = unit.replace(".", "");
    const policy = flat.slice(0, 56);
    value[policy] = { ...(value[policy] ?? {}), [flat.slice(56)]: Number(quantity) };
  }
  return {
    transaction: { id: u.ref.txHash },
    index: u.ref.index,
    address: u.address,
    value,
    ...(u.datumHex === null ? {} : { datum: u.datumHex }),
    ...(u.scriptRef === null ? {} : { script: { language: u.scriptLanguage ?? "plutus:v3", cbor: u.scriptRef } }),
  };
}

export class OgmiosChain implements Chain {
  readonly label: string;

  constructor(
    private readonly ogmiosUrl: string,
    private readonly submitUrl: string,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.label = ogmiosUrl;
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    const response = await this.fetchImpl(this.ogmiosUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), id: method }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new DeployError(`Ogmios ${this.ogmiosUrl} answered HTTP ${response.status} to ${method}`);
    const body = await response.json() as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
    if (body.error !== undefined) {
      const data = body.error.data === undefined ? "" : ` ${JSON.stringify(body.error.data)}`;
      throw new DeployError(`Ogmios ${method}: ${body.error.message ?? "error"} (code ${body.error.code ?? "?"})${data}`);
    }
    if (body.result === undefined) throw new DeployError(`Ogmios ${method}: no result`);
    return body.result;
  }

  async tipSlot(): Promise<number> {
    const tip = await this.rpc<{ slot?: number } | "origin">("queryNetwork/tip");
    if (tip === "origin" || typeof tip.slot !== "number") throw new DeployError("Ogmios queryNetwork/tip: no slot");
    return tip.slot;
  }

  async systemStartMs(): Promise<number> {
    const start = Date.parse(await this.rpc<string>("queryNetwork/startTime"));
    if (!Number.isFinite(start)) throw new DeployError("Ogmios queryNetwork/startTime: not a time");
    return start;
  }

  protocolParameters(): Promise<ProtocolParameters> {
    return ogmiosProtocolParameters(this.ogmiosUrl, this.fetchImpl);
  }

  async utxosAt(address: string): Promise<ChainUtxo[]> {
    return (await this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", { addresses: [address] })).map(fromOgmios);
  }

  async utxo(ref: OutputReference): Promise<ChainUtxo | null> {
    const found = await this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", {
      outputReferences: [{ transaction: { id: ref.txHash }, index: ref.index }],
    });
    return found.length === 0 ? null : fromOgmios(found[0]!);
  }

  async evaluate(txCborHex: string, additional: readonly Utxo[]): Promise<Record<string, ExUnits>> {
    const result = await this.rpc<OgmiosEvaluation[]>("evaluateTransaction", {
      transaction: { cbor: txCborHex },
      ...(additional.length === 0 ? {} : { additionalUtxo: additional.map(toOgmios) }),
    });
    const units: Record<string, ExUnits> = {};
    for (const entry of result) {
      const tag = PURPOSE_TAGS[entry.validator?.purpose ?? ""];
      if (tag === undefined || typeof entry.validator?.index !== "number" || entry.budget?.memory === undefined || entry.budget.cpu === undefined) {
        throw new DeployError(`Ogmios evaluateTransaction: unexpected entry ${JSON.stringify(entry)}`);
      }
      units[`${tag}:${entry.validator.index}`] = { mem: BigInt(entry.budget.memory), steps: BigInt(entry.budget.cpu) };
    }
    return units;
  }

  async submit(txCborHex: string): Promise<string> {
    const response = await this.fetchImpl(this.submitUrl, {
      method: "POST",
      headers: { "content-type": "application/cbor" },
      body: Buffer.from(txCborHex, "hex"),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new DeployError(`the submit API ${this.submitUrl} refused the transaction (HTTP ${response.status}): ${text.slice(0, 2000)}`);
    let id: unknown;
    try {
      id = JSON.parse(text);
    } catch {
      id = text.trim();
    }
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) throw new DeployError(`the submit API answered ${text.slice(0, 200)}, not a transaction ID`);
    return id;
  }
}

/** What the allowlist needs from the chain index: the mints of the legacy registry policy. */
export interface LegacyIndex {
  readonly label: string;
  tipSlot(): Promise<number>;
  /** System start (POSIX seconds) and slot length (seconds) of the indexed chain. */
  genesis(): Promise<{ systemStart: number; slotLength: number }>;
  /**
   * Every asset name that `policy` ever minted, burned ones included, up to
   * the indexer's tip (Koios `asset_list`, which reads the asset table).
   */
  policyAssetNames(policy: string): Promise<string[]>;
  /**
   * The asset information of `policy`: the POSIX time (seconds) of the block
   * of each first mint and the supply (Koios `policy_asset_info`). This list
   * comes from a cache that can lag behind the tip by minutes.
   */
  policyAssets(policy: string): Promise<Array<{ name: string; firstMintTime: number; supply: bigint }>>;
  /** The POSIX time (seconds) of the first block with an output that holds the asset (Koios `asset_txs`). */
  firstMintTime(policy: string, name: string): Promise<number>;
}

const KOIOS_PAGE = 1000;

export class KoiosIndex implements LegacyIndex {
  readonly label: string;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.label = baseUrl;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json", ...(this.token === null ? {} : { authorization: `Bearer ${this.token}` }) },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new DeployError(`Koios ${this.baseUrl}${path.split("?")[0]} answered HTTP ${response.status}`);
    return await response.json() as T;
  }

  async tipSlot(): Promise<number> {
    const [tip] = await this.get<Array<{ abs_slot?: number }>>("/tip");
    if (typeof tip?.abs_slot !== "number") throw new DeployError("Koios /tip: no abs_slot");
    return tip.abs_slot;
  }

  async genesis(): Promise<{ systemStart: number; slotLength: number }> {
    const [genesis] = await this.get<Array<{ systemstart?: number; slotlength?: string | number }>>("/genesis");
    const systemStart = genesis?.systemstart;
    const slotLength = Number(genesis?.slotlength);
    if (typeof systemStart !== "number" || !Number.isFinite(slotLength) || slotLength <= 0) throw new DeployError("Koios /genesis: no systemstart or slotlength");
    return { systemStart, slotLength };
  }

  /** Every row of a paged Koios list. `path` has a query and an `order`, so the pages do not overlap. */
  private async pages<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += KOIOS_PAGE) {
      const page = await this.get<T[]>(`${path}&offset=${offset}&limit=${KOIOS_PAGE}`);
      rows.push(...page);
      if (page.length < KOIOS_PAGE) return rows;
    }
  }

  async policyAssetNames(policy: string): Promise<string[]> {
    const rows = await this.pages<{ asset_name?: string | null }>(`/asset_list?policy_id=eq.${policy}&select=asset_name&order=asset_name.asc`);
    return rows.map((row) => row.asset_name ?? "");
  }

  async policyAssets(policy: string): Promise<Array<{ name: string; firstMintTime: number; supply: bigint }>> {
    const rows = await this.pages<{ asset_name?: string | null; creation_time?: number; total_supply?: string }>(
      `/policy_asset_info?_asset_policy=${policy}&select=asset_name,creation_time,total_supply&order=asset_name.asc`,
    );
    return rows.map((row) => {
      if (typeof row.creation_time !== "number" || typeof row.total_supply !== "string") {
        throw new DeployError(`Koios policy_asset_info: an asset of ${policy} has no creation_time or total_supply`);
      }
      return { name: row.asset_name ?? "", firstMintTime: row.creation_time, supply: BigInt(row.total_supply) };
    });
  }

  async firstMintTime(policy: string, name: string): Promise<number> {
    const rows = await this.get<Array<{ block_time?: number }>>(`/asset_txs?_asset_policy=${policy}&_asset_name=${name}&_history=true`);
    const times = rows.map((row) => row.block_time).filter((time): time is number => typeof time === "number");
    if (times.length === 0) throw new DeployError(`Koios asset_txs: no transaction holds ${policy}.${name}`);
    return Math.min(...times);
  }
}
