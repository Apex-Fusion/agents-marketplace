/**
 * The deployed legacy agent registry (`legacy_hash` of Part 2 §2).
 *
 * The blueprint in ../fixtures is a byte copy of
 * Apex-Fusion/vector-ai-agents@f6ae4bb:agent-registry/deploy/agent-registry/plutus.json
 * (git blob 4c79883e). Its code is the multi-validator `registry` (mint,
 * spend, else). The datum and redeemer layouts below follow the source that
 * compiles to these exact bytes (see ../README.md, "Source of the deployed
 * bytes").
 */
import { fileURLToPath } from "node:url";
import { blueprintScript, readBlueprint, type Blueprint } from "./blueprint.js";
import { constr, encodeData, utf8, type Data } from "./data.js";
import {
  address,
  blake2b256,
  scriptHash,
  type Asset,
  type Credential,
  type OutRef,
  type PlutusV3Script,
  type TxOut,
} from "./ledger.js";

export const LEGACY_BLUEPRINT_PATH = fileURLToPath(new URL("../fixtures/agent-registry.plutus.json", import.meta.url));

export const LEGACY_BLUEPRINT: Blueprint = readBlueprint(LEGACY_BLUEPRINT_PATH);

/** The mint, spend and else entries carry the same code (blueprint.test.ts). */
export const LEGACY_SCRIPT: PlutusV3Script = blueprintScript(LEGACY_BLUEPRINT_PATH, "registry.registry.mint");

/** Script hash = policy ID: be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01. */
export const LEGACY_HASH = scriptHash(LEGACY_SCRIPT);

/** The legacy address: the script as payment credential and no stake credential. */
export const LEGACY_ADDRESS = address({ script: LEGACY_HASH });

/** `min_deposit_lovelace` of the deployed script: 10 AP3X. */
export const LEGACY_MIN_DEPOSIT = 10_000_000n;

/** `AgentDatum` of the deployed script = `LegacyDatum` of Part 1 §5. */
export interface AgentDatum {
  readonly owner: Credential;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly framework: string;
  readonly endpoint: string;
  readonly registeredAt: bigint;
}

/** Aiken `Credential`: `VerificationKey` is constructor 0, `Script` is constructor 1. */
export const credentialData = (credential: Credential): Data =>
  "key" in credential ? constr(0, credential.key) : constr(1, credential.script);

/** Constructor 0 with 7 fields, in the order of Part 1 §5. */
export function agentDatum(datum: AgentDatum): Data {
  return constr(
    0,
    credentialData(datum.owner),
    utf8(datum.name),
    utf8(datum.description),
    datum.capabilities.map(utf8),
    utf8(datum.framework),
    utf8(datum.endpoint),
    datum.registeredAt,
  );
}

/** Plutus V3 `OutputReference`: constructor 0 with the transaction ID and the output index. */
export const outRefData = (ref: OutRef): Data => constr(0, ref.txId, BigInt(ref.index));

/** Part 1 §3.1: `vector-id = blake2b_256(serialise(seed))`. Also the legacy asset name. */
export const identifierOf = (seed: OutRef): Uint8Array => blake2b256(encodeData(outRefData(seed)));

/** Mint redeemer `MintAction.Register { seed }`. */
export const registerRedeemer = (seed: OutRef): Data => constr(0, outRefData(seed));

/** Mint redeemer `MintAction.Burn`. */
export const BURN: Data = constr(1);

/** Spend redeemer `SpendAction.Update`. */
export const UPDATE: Data = constr(0);

/** Spend redeemer `SpendAction.Deregister`. */
export const DEREGISTER: Data = constr(1);

export const legacyToken = (id: Uint8Array, quantity = 1n): Asset => ({ policy: LEGACY_HASH, name: id, quantity });

/** A legacy record output: the token, the inline datum and the AP3X deposit. */
export function recordOutput(args: {
  readonly ids: readonly Uint8Array[];
  readonly datum: AgentDatum;
  readonly coin?: bigint;
  readonly address?: Uint8Array;
}): TxOut {
  return {
    address: args.address ?? LEGACY_ADDRESS,
    value: { coin: args.coin ?? LEGACY_MIN_DEPOSIT, assets: args.ids.map((id) => legacyToken(id)) },
    datum: { inline: agentDatum(args.datum) },
  };
}
