/**
 * flood-before-record.test.ts — outputs that a third party adds at an address do not hide a record or an escrow.
 *
 * Any wallet can send an output with an inline datum to any address. A reader that lists an address gets those outputs in the same
 * answer as the record, the escrow or the advert that it looks for. Each reader must find its output and read the same datum as
 * before, however many added outputs the node lists in front of it.
 *
 * The fake node is an injected `fetch`. For an address with wanted outputs it answers `count` added outputs (each has a valid inline
 * datum and no token), then the wanted outputs. The answer is built once for each count and each datum, and every reader shares it.
 * The pull request gate runs 25,000 added outputs with a datum of 3 bytes: the record is then text 25,001, the smallest answer that
 * the old limit of 25,000 texts for one answer would hide. The night (TEST_DEPTH=nightly) adds 100,000 added outputs, and the datum
 * of 200 bytes (40 million characters at 100,000 outputs, more than the old limit of 32 MiB). The two scans of the supplier
 * (release-escrows and the advert scan) run with the small datum only, because they skip each added datum with an error.
 *
 * Readers that this file calls:
 *   - supplier record lookup (supplier/src/identity/agent.ts), with readAgentRecord
 *   - buyer SDK record lookup (buyer/src/sdk/identity.ts), with readAgentRecord
 *   - gateway record lookup and refundRevokedApplies (gateway/src/onchain/records.ts)
 *   - indexer start-up load (indexer/src/identity/backfill.ts)
 *   - supplier record scan by key (recordsListingKey) and advert scan (advertCapabilities), supplier/src/identity/register.ts
 *   - release-escrows, in dry-run mode, over the legacy and the new escrow address (supplier/src/cli/release-escrows.ts)
 *   - wallet outputs: the read-only client, the Lucid client and GET /account (gateway/src/account/routes.ts)
 * Reader that this file does not call: the advert scan in `findOrPostAdvert` (supplier/src/cli/setup-reseller.ts). The function is
 * not exported. Its only caller builds its own Ogmios client, calls an external service and writes a state file. The client-level
 * case below lists the same advert addresses through the same client.
 *
 * The file imports only code that exists on origin/main, so the same file runs on a tree without the datum check of the clients.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { ChainProvider, OutputReference, Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import { OgmiosLucidProvider } from "../../packages/shared/src/chain/OgmiosLucidProvider.js";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import {
  encodeAdvertDatum,
  encodeEscrowDatum,
  encodeIdentityAdvertDatum,
  encodeIdentityEscrowDatum,
  encodePlutusDataHex,
  type AdvertDatum,
  type EscrowDatum,
  type IdentityAdvertDatum,
  type IdentityDatum,
  type IdentityEscrowDatum,
  type PlutusData,
  type Status,
} from "../../packages/shared/src/cbor/index.js";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import { readAgentRecord } from "../../packages/shared/src/tx/identityRecord.js";
import { ACCEPT_WINDOW_MS } from "../../packages/shared/src/tx/index.js";
import { chainRecordLookup as buyerRecordLookup } from "../../buyer/src/sdk/identity.js";
import { makeAccountHandler } from "../../gateway/src/account/routes.js";
import { chainRecordLookup as gatewayRecordLookup, refundRevokedApplies } from "../../gateway/src/onchain/records.js";
import { loadIdentityOutputs } from "../../indexer/src/identity/backfill.js";
import { runReleaseEscrows } from "../../supplier/src/cli/release-escrows.js";
import { chainRecordLookup as supplierRecordLookup } from "../../supplier/src/identity/agent.js";
import { advertCapabilities, recordsListingKey } from "../../supplier/src/identity/register.js";
import { buildSampleAdvertDatum } from "../fixtures/buyer-side/advert-datum-builders.js";
import { buildSampleEscrowDatum } from "../fixtures/buyer-side/escrow-datum-builders.js";
import { newAdvert, newEscrow } from "../fixtures/buyer-side/identity-world.js";
import { TEST_IDENTITY_HASH, testIdentityBlueprint } from "../fixtures/identity-builders/blueprint.js";
import { AGENT_ID, AP3X, agentRecord, recordUtxo, testWallet, tombstone } from "../fixtures/identity-builders/world.js";
import { nightly } from "../depth.js";

const OGMIOS_URL = "http://ogmios.test";
const NETWORK_ID = 1;

// ─── The datums that the added outputs carry ─────────────────────────────

/** Plutus data: constructor 0 with no field. */
const DATUM_3_BYTES = "d87980";
/** Plutus data: constructor 0 with three byte strings of 64, 64 and 62 bytes. */
const DATUM_200_BYTES = encodePlutusDataHex({
  kind: "constr",
  index: 0n,
  fields: ["11".repeat(64), "22".repeat(64), "33".repeat(62)].map((hex): PlutusData => ({ kind: "bytes", hex })),
});

/** The added datums, each with its name for the report. The gate runs the small datum only. */
const DATUMS: ReadonlyArray<[name: string, hex: string]> = [
  ["a datum of 3 bytes", DATUM_3_BYTES],
  ...(nightly ? [["a datum of 200 bytes", DATUM_200_BYTES] as [string, string]] : []),
];
/** The numbers of added outputs, each with its label for the report. The gate runs the smallest number that fails the old limit. */
const COUNTS: ReadonlyArray<[label: string, count: number]> = [
  ["25,000", 25_000],
  ...(nightly ? [["100,000", 100_000] as [string, number]] : []),
];

// ─── The outputs that the readers look for ───────────────────────────────

const legacyBlueprint = loadBlueprint();
const blueprint = testIdentityBlueprint();

const supplier = testWallet("added-outputs supplier");
const controller = testWallet("added-outputs controller");
const wallet = testWallet("added-outputs wallet");

const ACTIVE_AGENT = AGENT_ID;
const REVOKED_AGENT = "b2".repeat(32);
const SUBMITTED_AT = 1_780_000_050_000;
const RECEIPT_HASH = "e".repeat(64);
const LEGACY_CAPABILITY = "llm.legacy.advert.v1";
const IDENTITY_CAPABILITY = "llm.identity.advert.v1";

const IDENTITY_ADDRESS = blueprint.identityScriptAddress(NETWORK_ID);
const LEGACY_ESCROW_ADDRESS = legacyBlueprint.escrowScriptAddress(NETWORK_ID);
const NEW_ESCROW_ADDRESS = blueprint.escrowScriptAddress(NETWORK_ID);
const LEGACY_ADVERT_ADDRESS = legacyBlueprint.advertScriptAddress(NETWORK_ID);
const NEW_ADVERT_ADDRESS = blueprint.advertScriptAddress(NETWORK_ID);

const refText = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

function outputAt(address: string, txChar: string, datumHex: string, lovelace = 2n * AP3X): Utxo {
  return { ref: { txHash: txChar.repeat(32), index: 0 }, address, lovelace, assets: {}, datumHex, scriptRef: null };
}

// Two records at the identity address: an active one for most readers, and a revoked one for the refund check of the gateway.
const ACTIVE_DATUM: IdentityDatum = agentRecord(controller, supplier);
const REVOKED_STATUS: Status = {
  type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: 1_770_000_000_000, invalidFrom: null, successor: null,
};
const REVOKED_DATUM: IdentityDatum = tombstone(agentRecord(controller, supplier), REVOKED_STATUS);
const ACTIVE_RECORD = recordUtxo(blueprint, ACTIVE_DATUM, { txHash: "7e".repeat(32), index: 0 }, ACTIVE_AGENT);
const REVOKED_RECORD = recordUtxo(blueprint, REVOKED_DATUM, { txHash: "7f".repeat(32), index: 0 }, REVOKED_AGENT);

const LEGACY_ESCROW_DATUM: EscrowDatum = {
  ...buildSampleEscrowDatum(),
  supplier_pkh: supplier.pubKeyHash,
  state: "Submitted",
  submitted_at: SUBMITTED_AT,
  result_receipt_hash: RECEIPT_HASH,
};
const NEW_ESCROW_DATUM: IdentityEscrowDatum = newEscrow({
  supplier_pkh: supplier.pubKeyHash,
  payment_lovelace: 3_000_000n, // The payout is 5 AP3X, so the two dry-run lines of release-escrows differ.
  state: "Submitted",
  submitted_at: SUBMITTED_AT,
  result_receipt_hash: RECEIPT_HASH,
});
const LEGACY_ESCROW = outputAt(LEGACY_ESCROW_ADDRESS, "c1", encodeEscrowDatum(LEGACY_ESCROW_DATUM), 4n * AP3X);
const NEW_ESCROW = outputAt(NEW_ESCROW_ADDRESS, "c2", encodeIdentityEscrowDatum(NEW_ESCROW_DATUM), 5n * AP3X);

const LEGACY_ADVERT_DATUM: AdvertDatum = {
  ...buildSampleAdvertDatum(),
  supplier_pkh: supplier.pubKeyHash,
  capability_id: LEGACY_CAPABILITY,
};
const NEW_ADVERT_DATUM: IdentityAdvertDatum = newAdvert({
  supplier_pkh: supplier.pubKeyHash,
  capability_id: IDENTITY_CAPABILITY,
  agent_id: ACTIVE_AGENT,
});
const LEGACY_ADVERT = outputAt(LEGACY_ADVERT_ADDRESS, "d1", encodeAdvertDatum(LEGACY_ADVERT_DATUM));
const NEW_ADVERT = outputAt(NEW_ADVERT_ADDRESS, "d2", encodeIdentityAdvertDatum(NEW_ADVERT_DATUM));

/** The output that a wallet needs: pure AP3X, enough for collateral, and it carries a datum as the added outputs do. */
const WALLET_OUTPUT = outputAt(wallet.address, "5e", DATUM_3_BYTES, 20n * AP3X);

/** Every wanted output. The fake node lists added outputs in front of the wanted outputs of each of their addresses. */
const WANTED: readonly Utxo[] = [
  ACTIVE_RECORD, REVOKED_RECORD, LEGACY_ESCROW, NEW_ESCROW, LEGACY_ADVERT, NEW_ADVERT, WALLET_OUTPUT,
];

// ─── The fake node ───────────────────────────────────────────────────────

/** One output as Ogmios v6 lists it. */
interface OgmiosOutput {
  transaction: { id: string };
  index: number;
  address: string;
  value: { ada: { lovelace: number }; [policy: string]: unknown };
  datum: string | null;
  datumHash: null;
  script: null;
}

interface OgmiosQuery {
  method: string;
  params?: { addresses?: string[]; outputReferences?: Array<{ transaction: { id: string }; index: number }> };
}

const refOf = (output: OgmiosOutput): string => `${output.transaction.id}#${output.index}`;

/** `utxo` as Ogmios lists it: the ada, and one entry for each policy with its asset names. */
function ogmiosOutput(utxo: Utxo): OgmiosOutput {
  const value: OgmiosOutput["value"] = { ada: { lovelace: Number(utxo.lovelace) } };
  for (const [unit, quantity] of Object.entries(utxo.assets)) {
    const policy = unit.slice(0, 56);
    const assetName = unit.slice(56).replace(".", "");
    value[policy] = { ...(value[policy] as Record<string, number> | undefined), [assetName]: Number(quantity) };
  }
  return {
    transaction: { id: utxo.ref.txHash }, index: utxo.ref.index, address: utxo.address, value, datum: utxo.datumHex,
    datumHash: null, script: null,
  };
}

/** `count` outputs at `address`. Each has the inline datum `datum`, no token, its own reference and its own amount of ada. */
function addedOutputs(address: string, count: number, datum: string): OgmiosOutput[] {
  const outputs: OgmiosOutput[] = [];
  for (let i = 0; i < count; i += 1) {
    outputs.push({
      transaction: { id: `${i.toString(16).padStart(8, "0")}${"d0".repeat(28)}` },
      index: 0,
      address,
      value: { ada: { lovelace: 1_000_000 + i } },
      datum,
      datumHash: null,
      script: null,
    });
  }
  return outputs;
}

/**
 * An Ogmios node over an injected fetch. A query by address gets `count` added outputs and then the wanted outputs of that address
 * (nothing for an address without a wanted output). The answer for an address is built when it is first asked for, and every
 * later query gets the same array. A query by reference gets the wanted outputs only: no reader asks for an added output.
 */
class FakeNode {
  private readonly wanted = new Map<string, OgmiosOutput[]>();
  private readonly byReference = new Map<string, OgmiosOutput>();
  private readonly answers = new Map<string, OgmiosOutput[]>();

  constructor(private readonly count: number, private readonly datum: string, wanted: readonly Utxo[]) {
    for (const utxo of wanted) {
      const output = ogmiosOutput(utxo);
      this.wanted.set(utxo.address, [...(this.wanted.get(utxo.address) ?? []), output]);
      this.byReference.set(refOf(output), output);
    }
  }

  /** The answer for `address`. */
  answerAt(address: string): OgmiosOutput[] {
    const known = this.answers.get(address);
    if (known !== undefined) return known;
    const wanted = this.wanted.get(address);
    if (wanted === undefined) return [];
    const answer = addedOutputs(address, this.count, this.datum);
    answer.push(...wanted);
    this.answers.set(address, answer);
    return answer;
  }

  readonly fetch = (async (_url: unknown, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body)) as OgmiosQuery;
    if (query.method !== "queryLedgerState/utxo") throw new Error(`the fake node does not answer ${query.method}`);
    const { addresses, outputReferences } = query.params ?? {};
    let result: OgmiosOutput[];
    if (outputReferences !== undefined) {
      result = outputReferences.flatMap(({ transaction, index }) => this.byReference.get(`${transaction.id}#${index}`) ?? []);
    } else if (addresses?.length === 1) {
      result = this.answerAt(addresses[0]!);
    } else {
      throw new Error("the fake node answers one address at a time");
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ jsonrpc: "2.0", result }) };
  }) as unknown as typeof globalThis.fetch;
}

const readOnly = (node: FakeNode) => new ReadOnlyOgmiosProvider({ ogmiosUrl: OGMIOS_URL, fetch: node.fetch });
const live = (node: FakeNode) => new LiveOgmiosProvider({ ogmiosUrl: OGMIOS_URL, fetch: node.fetch });

// ─── Helpers of the checks ───────────────────────────────────────────────

/** What a client lists for one output, whatever the client. */
interface Listed {
  ref: string;
  lovelace: bigint;
  datum: string | null;
}

interface ListingClient {
  name: string;
  list(node: FakeNode, address: string): Promise<Listed[]>;
}

const READ_ONLY_CLIENT: ListingClient = {
  name: "the read-only client",
  list: async (node, address) => (await readOnly(node).queryUtxosByAddress(address))
    .map((utxo) => ({ ref: refText(utxo.ref), lovelace: utxo.lovelace, datum: utxo.datumHex })),
};

const LUCID_CLIENT: ListingClient = {
  name: "the Lucid client",
  list: async (node, address) => (await new OgmiosLucidProvider({ ogmiosUrl: OGMIOS_URL, fetch: node.fetch }).getUtxos(address))
    .map((utxo) => ({ ref: `${utxo.txHash}#${utxo.outputIndex}`, lovelace: utxo.assets["lovelace"] ?? 0n, datum: utxo.datum ?? null })),
};

const lovelaceOf = (output: OgmiosOutput): bigint => BigInt(output.value.ada.lovelace);

/** The first difference between what a client listed and what the node answered, or null. */
function firstDifference(listed: readonly Listed[], answer: readonly OgmiosOutput[]): string | null {
  if (listed.length !== answer.length) return `${listed.length} outputs listed, ${answer.length} in the answer`;
  for (let i = 0; i < answer.length; i += 1) {
    const expected = answer[i]!;
    const got = listed[i]!;
    if (got.ref !== refOf(expected)) return `output ${i} has the reference ${got.ref}, not ${refOf(expected)}`;
    if (got.lovelace !== lovelaceOf(expected)) return `output ${i} has ${got.lovelace} lovelace, not ${lovelaceOf(expected)}`;
    if (got.datum !== expected.datum) return `output ${i} has ${got.datum === null ? "no datum" : "another datum"}`;
  }
  return null;
}

/** The record `record` of `agentId`, found as `found`: the same output, the same datum, and the datum decodes to `datum`. */
function expectRecord(found: Utxo | null, record: Utxo, datum: IdentityDatum, agentId: string): void {
  expect(found?.ref).toEqual(record.ref);
  expect(found?.datumHex).toBe(record.datumHex);
  expect(readAgentRecord(found, blueprint.identityHash, agentId)).toEqual(datum);
}

/** Collects what the code writes to the standard output, until vi.restoreAllMocks(). */
function captureStdout(): () => string {
  let text = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  });
  return () => text;
}

/**
 * Runs `read` with no stack trace for the errors that it makes. The two scans of the supplier skip each added datum with an error.
 * Nobody reads the stack trace of such an error, and making it takes more time than the decode. The limit is back before the checks
 * of the test run.
 */
async function withoutStackTraces<T>(read: () => Promise<T>): Promise<T> {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    return await read();
  } finally {
    Error.stackTraceLimit = limit;
  }
}

interface AccountBody {
  balance: { available_lovelace: string };
  collateral_ok: boolean;
}

/**
 * GET /account for a key whose deposit address is `address`, with the wallet read through `chain`. The handler answers through
 * `res.json`, so the promise settles there. A handler that never answers ends at the timeout of the test. The executor form is
 * on purpose: `Promise.withResolvers` needs Node 22, and the tests run on Node 20.
 */
function getAccount(chain: ChainProvider, address: string): Promise<AccountBody> {
  const deps = {
    config: { indexerUrl: "http://indexer.test", networkId: NETWORK_ID, masterKeyHex: "00" },
    store: { sumCostLovelace: () => 0n, countUsage: () => 0, listUsage: () => [] },
    chain,
    registry: {},
    fetchFn: async () => ({ ok: true, json: async () => [] }),
  } as never;
  const key = {
    id: "key-1", key_hash: "h", key_prefix: "vk_live_abc", label: null, wallet_pkh: wallet.pubKeyHash, deposit_address: address,
    enc_priv_nonce: "", enc_priv_ct: "", enc_priv_tag: "", master_key_version: 1, created_at: 0, disabled: 0, demo: 0,
  };
  return new Promise((resolve, reject) => {
    const res = {
      status: () => res,
      json: (body: AccountBody & { error?: unknown }) => {
        if (body.error !== undefined) reject(new Error(`the handler answered an error: ${JSON.stringify(body)}`));
        else resolve(body);
        return res;
      },
    } as unknown as Response;
    makeAccountHandler(deps)({ gatewayKey: key } as unknown as Request, res);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ─── The checks ──────────────────────────────────────────────────────────

describe("outputs that a third party adds at an address do not hide a record or an escrow", () => {
  describe.each(COUNTS)("%s added outputs in front", (_label, count) => {
    describe.each(DATUMS)("with %s", (_name, hex) => {
      let built: FakeNode | undefined;
      beforeAll(() => {
        built = new FakeNode(count, hex, WANTED);
      });
      afterAll(() => {
        built = undefined;
      });

      const timeout = count >= 100_000 ? 60_000 : 30_000;
      /** One check against the fake node of the enclosing describe block. */
      const check = (name: string, run: (node: FakeNode) => Promise<void>): void => {
        it(name, async () => {
          if (built === undefined) throw new Error("the fake node is not built yet");
          await run(built);
        }, timeout);
      };

      check("lists the added outputs in front of each wanted output", async (node) => {
        for (const address of new Set(WANTED.map((utxo) => utxo.address))) {
          const wanted = WANTED.filter((utxo) => utxo.address === address);
          const answer = node.answerAt(address);
          expect(answer).toHaveLength(count + wanted.length);
          expect(answer.slice(count).map(refOf)).toEqual(wanted.map((utxo) => refText(utxo.ref)));
          expect(answer.slice(0, count).every((output) => output.datum === hex && output.address === address)).toBe(true);
        }
      });

      // Records at the identity address.

      check("the supplier record lookup finds the record", async (node) => {
        const lookup = supplierRecordLookup(readOnly(node), NETWORK_ID, () => blueprint);
        expectRecord(await lookup(ACTIVE_AGENT), ACTIVE_RECORD, ACTIVE_DATUM, ACTIVE_AGENT);
      });

      check("the buyer record lookup finds the record", async (node) => {
        const lookup = buyerRecordLookup(live(node), () => blueprint, NETWORK_ID);
        expectRecord(await lookup(ACTIVE_AGENT), ACTIVE_RECORD, ACTIVE_DATUM, ACTIVE_AGENT);
      });

      check("the gateway record lookup finds a revoked record, and the refund applies to its escrow", async (node) => {
        vi.stubEnv("IDENTITY_POLICY_ID", TEST_IDENTITY_HASH);
        const lookup = gatewayRecordLookup(live(node), NETWORK_ID);
        expectRecord(await lookup(REVOKED_AGENT), REVOKED_RECORD, REVOKED_DATUM, REVOKED_AGENT);
        expect(await refundRevokedApplies(newEscrow({ agent_id: REVOKED_AGENT }), lookup)).toBe(true);
        // The record of the other agent is active: the refund does not apply to its escrow.
        expect(await refundRevokedApplies(newEscrow({ agent_id: ACTIVE_AGENT }), lookup)).toBe(false);
      });

      check("the indexer start-up load stores each record with its datum and no added output", async (node) => {
        const rows: unknown[][] = [];
        const cache = {
          insertUtxoIfAbsent: (...row: [string, string, string, number, string, string | null]): boolean => {
            rows.push(row);
            return true;
          },
          transaction: <T>(run: () => T): T => run(),
        };
        const result = await loadIdentityOutputs({
          cache, chain: readOnly(node), identityAddress: IDENTITY_ADDRESS, policyId: blueprint.identityHash,
        });
        expect(result).toEqual({ outputs: 2, inserted: 2 });
        expect(rows).toEqual([
          [refText(ACTIVE_RECORD.ref), IDENTITY_ADDRESS, ACTIVE_RECORD.datumHex, 0, ACTIVE_RECORD.ref.txHash, ACTIVE_AGENT],
          [refText(REVOKED_RECORD.ref), IDENTITY_ADDRESS, REVOKED_RECORD.datumHex, 0, REVOKED_RECORD.ref.txHash, REVOKED_AGENT],
        ]);
      });

      check("the record scan of the supplier finds the agent that lists its key", async (node) => {
        const agents = await recordsListingKey(readOnly(node), blueprint, NETWORK_ID, supplier.pubKeyHash);
        expect(agents).toEqual([ACTIVE_AGENT]);
      });

      // Escrows and adverts.

      // The two scans skip each added datum with an error, so their work grows with the number of added outputs. They run with the
      // small datum only. The client-level checks after them run with both datums.
      if (hex === DATUM_3_BYTES) {
        check("release-escrows finds a submitted escrow at each escrow address", async (node) => {
          const output = captureStdout();
          const result = await withoutStackTraces(() => runReleaseEscrows(
            {
              escrowAddresses: [LEGACY_ESCROW_ADDRESS, NEW_ESCROW_ADDRESS], supplierKey: supplier, refs: [],
              limit: Number.POSITIVE_INFINITY, awaitTimeoutMs: 1_000, dryRun: true,
            },
            { chain: live(node), now: () => SUBMITTED_AT + ACCEPT_WINDOW_MS + 1 },
          ));
          expect(result).toEqual({ released: 0, skipped: 0, failed: 0, exitCode: 0 });
          expect(output()).toContain(`dry-run ${refText(LEGACY_ESCROW.ref)} payout=4000000\n`);
          expect(output()).toContain(`dry-run ${refText(NEW_ESCROW.ref)} payout=5000000\n`);
        });

        check("the advert scan of the supplier finds an advert at each advert address", async (node) => {
          const addresses = [LEGACY_ADVERT_ADDRESS, NEW_ADVERT_ADDRESS];
          const capabilities = await withoutStackTraces(() => advertCapabilities(live(node), addresses, supplier.pubKeyHash));
          expect(capabilities).toEqual([IDENTITY_CAPABILITY, LEGACY_CAPABILITY].sort());
        });
      }

      // Wallet outputs.

      for (const client of [READ_ONLY_CLIENT, LUCID_CLIENT]) {
        check(`${client.name} returns every output of a wallet`, async (node) => {
          const answer = node.answerAt(wallet.address);
          const expectedTotal = answer.reduce((sum, output) => sum + lovelaceOf(output), 0n);
          const listed = await client.list(node, wallet.address);
          expect(firstDifference(listed, answer)).toBeNull();
          expect(listed.reduce((sum, output) => sum + output.lovelace, 0n)).toBe(expectedTotal);
        });
      }

      check("GET /account counts every output of a wallet", async (node) => {
        const expectedTotal = node.answerAt(wallet.address).reduce((sum, output) => sum + lovelaceOf(output), 0n);
        const body = await getAccount(live(node), wallet.address);
        expect(body.balance.available_lovelace).toBe(expectedTotal.toString());
        expect(body.collateral_ok).toBe(true);
      });
    });
  });
});
