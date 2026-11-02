/**
 * tx-identity-advert.test.ts — the advert builders on the identity layout
 * (new advert, Part 2 §6.2), mock backend: Post, Update (keeps agent_id) and
 * Retire, the listing rule of the builders, and the layout boundaries.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { decodeIdentityAdvertDatum, type IdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { decodeAdvertDatum, encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import type { IdentityDatum } from "../../packages/shared/src/cbor/IdentityDatum.js";
import { loadBlueprint, type IdentityBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { MAX_RANGE_MS } from "../../packages/shared/src/identity/constants.js";
import {
  buildPostAdvertTx, buildRetireAdvertTx, buildUpdateAdvertTx, TxConstructionError, type RecordLookup,
  type UpdateAdvertParams,
} from "../../packages/shared/src/tx/index.js";
import { pkhToEnterpriseAddress } from "../../packages/shared/src/tx/internal/pkhAddress.js";
import { utf8ToHex } from "../../packages/shared/src/identity/id.js";
import { testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";
import { advertUtxo, AGENT_ID, agentRecord, AP3X, identityAdvert, recordUtxo, testWallet } from "../fixtures/identity-builders/world.js";

const NOW_MS = 1_780_000_000_000;
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
const supplier = testWallet("supplier", 0);
const controller = testWallet("controller");
const stranger = testWallet("stranger", 0);
let blueprint: IdentityBlueprint;

beforeAll(() => {
  blueprint = testIdentityBlueprint();
});

interface MockBody {
  inputs: OutputReference[];
  outputs: Array<{ address: string; lovelace: bigint; datumHex: string | null }>;
  requiredSigners: string[];
  validityRange?: { lowerBoundMs: number; upperBoundMs: number };
  redeemer?: string;
  meta?: { script_hash?: string };
}

function mockBody(txCborHex: string): MockBody {
  const length = parseInt(txCborHex.slice(0, 8), 16);
  const json = Buffer.from(txCborHex.slice(8, 8 + 2 * length), "hex").toString("utf8");
  return JSON.parse(json, (_key, value) => (typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value));
}

function chainAt(ms: number): MockChainProvider {
  const chain = new MockChainProvider();
  chain.advanceSlot(Math.floor(ms / 1000));
  return chain;
}

const lookupOf = (record: IdentityDatum): RecordLookup => async (agentId) =>
  (agentId === AGENT_ID ? recordUtxo(blueprint, record) : null);

const activeRecord = (): IdentityDatum => agentRecord(controller, supplier);

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TxConstructionError);
    return (err as TxConstructionError).reason;
  }
  throw new Error("expected a TxConstructionError");
}

describe("PostAdvert of a new advert", () => {
  const advert = (changes: Partial<IdentityAdvertDatum> = {}) => identityAdvert(supplier, { advertised_at: NOW_MS, ...changes });

  it("pays the new advert script with the 14-field datum", async () => {
    const chain = chainAt(NOW_MS);
    const built = await buildPostAdvertTx({
      chain, walletKey: supplier, advertDatum: advert(), deposit_lovelace: 2n * AP3X,
      lookupRecord: lookupOf(activeRecord()), identityBlueprint: blueprint,
    });
    const body = mockBody(built.txCborHex);
    expect(body.outputs[0]!.address).toBe(blueprint.advertScriptAddress(0));
    expect(decodeIdentityAdvertDatum(body.outputs[0]!.datumHex!)).toEqual(advert());
    expect(body.requiredSigners).toEqual([supplier.pubKeyHash]);
    expect(body.meta?.script_hash).toBe(blueprint.advertScriptHash);
    expect((await chain.queryUtxo(built.advertOutputRef))?.address).toBe(blueprint.advertScriptAddress(0));
  });

  it("refuses an advert that the listing rule would not list", async () => {
    const post = (record: IdentityDatum | null, datum = advert()) => buildPostAdvertTx({
      chain: chainAt(NOW_MS), walletKey: supplier, advertDatum: datum, deposit_lovelace: 2n * AP3X,
      lookupRecord: record === null ? undefined : lookupOf(record), identityBlueprint: blueprint,
    });
    expect(await reason(post(null))).toBe("agent record lookup required");
    expect(await reason(post(activeRecord(), advert({ capability_id: "other.v1" })))).toBe("capability not listed");
    expect(await reason(post({ ...activeRecord(), keys: [] }))).toBe("supplier key not listed");
    expect(await reason(post({ ...activeRecord(), parties: [] }))).toBe("agent not active");
    expect(await reason(post(activeRecord(), advert({ agent_id: "00".repeat(32) })))).toBe("agent record not found");
  });

  it("still posts a legacy advert to the legacy script", async () => {
    const { agent_id: _id, ...legacy } = advert();
    const built = await buildPostAdvertTx({ chain: chainAt(NOW_MS), walletKey: supplier, advertDatum: legacy, deposit_lovelace: 2n * AP3X });
    const output = mockBody(built.txCborHex).outputs[0]!;
    expect(output.address).toBe(loadBlueprint().advertScriptAddress(0));
    expect(decodeAdvertDatum(output.datumHex!)).toEqual(legacy);
  });
});

describe("UpdateAdvert of a new advert", () => {
  const old = identityAdvert(supplier, { advertised_at: NOW_MS - 10_000 });
  const seeded = (datum: IdentityAdvertDatum = old, address?: string) => {
    const chain = chainAt(NOW_MS);
    const utxo = advertUtxo(blueprint, datum, ADVERT_REF, 0);
    chain.seed(address === undefined ? utxo : { ...utxo, address });
    return chain;
  };
  const update = (chain: MockChainProvider, newAdvertDatum: UpdateAdvertParams["newAdvertDatum"], record = activeRecord()) =>
    buildUpdateAdvertTx({
      chain, walletKey: supplier, advertRef: ADVERT_REF, newAdvertDatum, deposit_lovelace: 3n * AP3X,
      lookupRecord: lookupOf(record), identityBlueprint: blueprint,
    });

  it("spends the advert with UpdateAdvert and writes the new datum at the new advert script", async () => {
    const next = { ...old, price_lovelace: 3n * AP3X, advertised_at: NOW_MS };
    const body = mockBody((await update(seeded(), next)).txCborHex);
    expect(body.inputs).toEqual([ADVERT_REF]);
    expect(body.redeemer).toBe("UpdateAdvert");
    expect(body.requiredSigners).toEqual([supplier.pubKeyHash]);
    expect(body.outputs).toHaveLength(1);
    expect(body.outputs[0]!.address).toBe(blueprint.advertScriptAddress(0));
    expect(body.outputs[0]!.lovelace).toBe(3n * AP3X);
    expect(decodeIdentityAdvertDatum(body.outputs[0]!.datumHex!)).toEqual(next);
    expect(body.validityRange!.upperBoundMs - body.validityRange!.lowerBoundMs).toBeLessThanOrEqual(MAX_RANGE_MS);
  });

  it("keeps agent_id, supplier_pkh and a non-decreasing advertised_at", async () => {
    expect(await reason(update(seeded(), { ...old, agent_id: "11".repeat(32) }))).toBe("agent_id changed");
    expect(await reason(update(seeded(), { ...old, supplier_pkh: stranger.pubKeyHash }))).toBe("supplier pkh changed");
    expect(await reason(update(seeded(), { ...old, advertised_at: old.advertised_at - 1 }))).toBe("advertised_at regress");
    expect(await reason(buildUpdateAdvertTx({
      chain: seeded(), walletKey: stranger, advertRef: ADVERT_REF, newAdvertDatum: old, deposit_lovelace: 2n * AP3X,
      lookupRecord: lookupOf(activeRecord()), identityBlueprint: blueprint,
    }))).toBe("supplier signature mismatch");
  });

  it("applies the listing rule to the new datum", async () => {
    const record = { ...activeRecord(), capabilities: [utf8ToHex(old.capability_id)] };
    expect(await reason(update(seeded(), { ...old, capability_id: "other.v1" }, record))).toBe("capability not listed");
  });

  it("refuses a layout change in either direction", async () => {
    const { agent_id: _id, ...legacyNext } = old;
    expect(await reason(update(seeded(), legacyNext))).toBe("advert layout mismatch");
    const legacyChain = chainAt(NOW_MS);
    legacyChain.seed({ ...advertUtxo(blueprint, old, ADVERT_REF, 0), address: loadBlueprint().advertScriptAddress(0), datumHex: encodeAdvertDatum(legacyNext) });
    expect(await reason(update(legacyChain, old))).toBe("advert layout mismatch");
    expect(await reason(update(seeded(old, loadBlueprint().advertScriptAddress(0)), old))).toBe("advert layout mismatch");
  });
});

describe("RetireAdvert of a new advert", () => {
  it("spends the advert with RetireAdvert and returns the deposit to the supplier key", async () => {
    const chain = chainAt(NOW_MS);
    chain.seed(advertUtxo(blueprint, identityAdvert(supplier), ADVERT_REF, 0));
    const body = mockBody((await buildRetireAdvertTx({ chain, walletKey: supplier, advertRef: ADVERT_REF, identityBlueprint: blueprint })).txCborHex);
    expect(body.redeemer).toBe("RetireAdvert");
    expect(body.requiredSigners).toEqual([supplier.pubKeyHash]);
    expect(body.outputs.map((o) => [o.address, o.lovelace])).toEqual([[pkhToEnterpriseAddress(supplier.pubKeyHash, 0), 2n * AP3X]]);
    expect(await chain.queryUtxo(ADVERT_REF)).toBeNull();
  });

  it("refuses another key", async () => {
    const chain = chainAt(NOW_MS);
    chain.seed(advertUtxo(blueprint, identityAdvert(supplier), ADVERT_REF, 0));
    expect(await reason(buildRetireAdvertTx({ chain, walletKey: stranger, advertRef: ADVERT_REF, identityBlueprint: blueprint })))
      .toBe("supplier signature mismatch");
  });
});
