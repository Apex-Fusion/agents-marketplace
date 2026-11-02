/**
 * Offline evaluation of a signed transaction from the shared builders with
 * `aiken tx simulate`, through the harness of tests/legacy-registry: the
 * harness writes the transaction and its resolved inputs and gives one
 * verdict per redeemer. Nothing goes to a network.
 *
 * The builders write their transactions with lucid-evolution, so this module
 * adapts that CBOR to the harness: the redeemers come from the escrow (or
 * advert) input's position in the sorted inputs, and the resolved inputs from
 * the UTxOs of the test world.
 */
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import {
  fromHex, simulate, type BuiltTx, type Data, type Simulation, type TxOut, type TxSpec, type Utxo as HarnessUtxo,
} from "../legacy-registry/harness/index.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { decodePlutusDataHex, type PlutusData } from "../../packages/shared/src/cbor/plutus-data.js";
import { plutusAddressFromBech32 } from "../../packages/shared/src/cbor/address.js";
import { inspectSignedTransactionFinancials } from "../../packages/shared/src/tx/internal/signedTransaction.js";

const refKey = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

function harnessData(data: PlutusData): Data {
  switch (data.kind) {
    case "int": return data.value;
    case "bytes": return fromHex(data.hex);
    case "list": return data.items.map(harnessData);
    case "map": return { map: data.entries.map(([key, value]) => [harnessData(key), harnessData(value)] as const) };
    case "constr": return { constr: Number(data.index), fields: data.fields.map(harnessData) };
  }
}

function harnessUtxo(utxo: Utxo): HarnessUtxo {
  const output: TxOut = {
    address: Uint8Array.from(bech32.fromWords(bech32.decode(utxo.address, 1023).words)),
    value: {
      coin: utxo.lovelace,
      assets: Object.entries(utxo.assets).map(([unit, quantity]) => {
        const flat = unit.replace(".", "");
        return { policy: fromHex(flat.slice(0, 56)), name: fromHex(flat.slice(56)), quantity };
      }),
    },
    ...(utxo.datumHex === null ? {} : { datum: { inline: harnessData(decodePlutusDataHex(utxo.datumHex)) } }),
    ...(utxo.scriptRef === null ? {} : { referenceScript: { compiledCode: fromHex(utxo.scriptRef) } }),
  };
  return { ref: { txId: fromHex(utxo.ref.txHash), index: utxo.ref.index }, output };
}

/** The inputs in ledger order: a script input's position is its spend redeemer index. */
function sortedInputs(txCborHex: string): OutputReference[] {
  return [...inspectSignedTransactionFinancials(txCborHex).inputs]
    .sort((a, b) => (a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1));
}

/**
 * Runs the scripts of `txCborHex` with `aiken tx simulate`. `utxos` resolves
 * the spent and reference inputs (a superset is fine). `label` names the
 * single script input in the verdicts.
 */
export function evaluateBuiltTx(txCborHex: string, utxos: Iterable<Utxo>, label: string): Simulation {
  const known = new Map<string, Utxo>();
  for (const utxo of utxos) known.set(refKey(utxo.ref), utxo);
  const inputs = sortedInputs(txCborHex);
  const scriptIndexes = inputs
    .map((ref, index) => ({ utxo: known.get(refKey(ref)), index }))
    .filter(({ utxo }) => utxo !== undefined && plutusAddressFromBech32(utxo.address).paymentCredential.type === "Script");
  if (scriptIndexes.length !== 1) throw new Error(`expected one script input, found ${scriptIndexes.length}`);
  const bytes = fromHex(txCborHex);
  const built: BuiltTx = {
    spec: { inputs: [], outputs: [], fee: 0n } satisfies TxSpec,
    // The harness names its working files after the ID only.
    id: blake2b(bytes, { dkLen: 32 }),
    body: bytes,
    redeemers: [{ tag: "spend", index: scriptIndexes[0]!.index, data: 0n, label }],
    resolved: [...known.values()].map(harnessUtxo),
    encode: () => bytes,
    utxo: () => {
      throw new Error("not a harness transaction");
    },
  };
  return simulate(built);
}
