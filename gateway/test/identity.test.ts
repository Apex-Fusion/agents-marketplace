/**
 * identity.test.ts — the identity registry in the buyer-side gateway (Part 2
 * §6.1, §6.4, §6.5, §9.6): configuration, the escrow switch, the routing
 * rules (agent_id, F-29 value cap, new adverts after the switch), the 16-field
 * preflight floor and the agent-record reads of RefundRevoked.
 *
 * The sweeper and the one-shot recovery paths of the new escrow are in
 * sweeper.test.ts and job-recovery.test.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChainProvider, Utxo } from "@marketplace/shared/chain";
import {
  plutusAddressFromBech32,
  type EscrowDatum,
  type IdentityDatum,
  type IdentityEscrowDatum,
  type Status,
} from "@marketplace/shared/cbor";
import { MAX_ESCROW_LOVELACE } from "@marketplace/shared/identity";
import { escrowLockFloor, minAdaForEscrowDatum, type IdentityBlueprint } from "@marketplace/shared/tx";
import { loadConfig } from "../src/config.js";
import type { GatewayDeps } from "../src/deps.js";
import { newAdvertsOnly, paper2AgentClientOptions } from "../src/routing/escrowSwitch.js";
import { listModels, selectCandidates } from "../src/routing/selectSupplier.js";
import { COLLATERAL_MIN_LOVELACE, FEE_RESERVE_LOVELACE, preflight } from "../src/onchain/preflight.js";
import { chainRecordLookup, refundRevokedApplies } from "../src/onchain/records.js";
import { TEST_IDENTITY_HASH, testIdentityBlueprint } from "../../tests/fixtures/identity-builders/blueprint.js";
import { agentRecord, recordUtxo, testWallet, tombstone } from "../../tests/fixtures/identity-builders/world.js";

const BASE_ENV = {
  GATEWAY_MASTER_KEY: "c7".repeat(32),
  INDEXER_URL: "http://indexer.test",
  OGMIOS_URL: "http://ogmios.test",
  LIVE_CHAIN: "1",
};
const AGENT_A = "a1".repeat(32);
const AGENT_B = "b2".repeat(32);
const AP3X = 1_000_000n;

describe("config — identity registry values", () => {
  it("reads the identity policy ID and the switch slot", () => {
    const config = loadConfig({ ...BASE_ENV, IDENTITY_POLICY_ID: "ab".repeat(28), SWITCH_SLOT: "123456" });
    expect(config.identityPolicyId).toBe("ab".repeat(28));
    expect(config.switchSlot).toBe(123456);
  });

  it("leaves both unset before the identity deployment", () => {
    for (const env of [BASE_ENV, { ...BASE_ENV, IDENTITY_POLICY_ID: "", SWITCH_SLOT: "" }]) {
      const config = loadConfig(env);
      expect(config.identityPolicyId).toBeNull();
      expect(config.switchSlot).toBeNull();
    }
    expect(loadConfig({ ...BASE_ENV, SWITCH_SLOT: "0" }).switchSlot).toBe(0);
  });

  it("refuses a policy ID that the blueprint loader would refuse", () => {
    for (const value of ["AB".repeat(28), "ab".repeat(27), `${"ab".repeat(28)} `, "zz".repeat(28)]) {
      expect(() => loadConfig({ ...BASE_ENV, IDENTITY_POLICY_ID: value })).toThrow(/IDENTITY_POLICY_ID/);
    }
  });

  it("refuses a switch slot that is not a non-negative integer", () => {
    for (const value of ["-1", "1.5", "01", "abc", "9007199254740993"]) {
      expect(() => loadConfig({ ...BASE_ENV, SWITCH_SLOT: value })).toThrow(/SWITCH_SLOT/);
    }
  });
});

describe("escrow switch (Part 2 §9.6)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function switchDeps(switchSlot: number | null, tip: () => Promise<number>) {
    const chain = { tip: vi.fn(tip) };
    const deps = { config: { ...loadConfig(BASE_ENV), switchSlot }, chain } as unknown as Pick<GatewayDeps, "config" | "chain">;
    return { deps, tip: chain.tip };
  }

  it("is off without a switch slot and reads no tip", async () => {
    const { deps, tip } = switchDeps(null, async () => 10);
    expect(await newAdvertsOnly(deps)).toBe(false);
    expect(tip).not.toHaveBeenCalled();
  });

  it("turns on when the tip reaches the slot and then stays on without tip reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    let slot = 999;
    const { deps, tip } = switchDeps(1_000, async () => slot);
    expect(await newAdvertsOnly(deps)).toBe(false);
    // Within the recheck interval the last answer stands.
    slot = 1_000;
    expect(await newAdvertsOnly(deps)).toBe(false);
    expect(tip).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_800_000_015_000);
    expect(await newAdvertsOnly(deps)).toBe(true);
    expect(tip).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_800_000_100_000);
    slot = 0;
    expect(await newAdvertsOnly(deps)).toBe(true);
    expect(tip).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer when the tip read fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, tip } = switchDeps(1_000, async () => {
      throw new Error("ogmios down");
    });
    expect(await newAdvertsOnly(deps)).toBe(false);
    expect(tip).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("gives the buyer SDK the same switch slot and the network", () => {
    const config = { ...loadConfig({ ...BASE_ENV, NETWORK_ID: "1" }), switchSlot: 77 };
    expect(paper2AgentClientOptions(config)).toEqual({ switchSlot: 77, networkId: 1 });
  });
});

describe("routing — agent_id, value cap and switch", () => {
  function row(marker: string, overrides: Record<string, unknown> = {}) {
    return {
      utxo_ref: `${marker.repeat(64)}#0`,
      supplier_pkh: marker.repeat(56),
      capability_id: "llm.text.generate.v1",
      model: "m",
      max_output_tokens: 1,
      max_processing_ms: 60_000,
      price_lovelace: "2000000",
      supplier_bond_lovelace: "1000000",
      buyer_bond_lovelace: "1000000",
      endpoint_url: `http://${marker}`,
      advert_status: "Active",
      status: "free",
      ...overrides,
    };
  }

  function indexer(rows: unknown[]): typeof globalThis.fetch {
    return (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof globalThis.fetch;
  }

  const base = { indexerUrl: "http://ix", model: "m", capabilityId: "llm.text.generate.v1" };

  it("copies agent_id to the candidate and keeps legacy adverts before the switch", async () => {
    const got = await selectCandidates({
      ...base,
      fetchFn: indexer([row("1", { agent_id: AGENT_A }), row("2", { agent_id: null }), row("3")]),
    });
    expect(got.map((candidate) => [candidate.supplierPkh, candidate.agentId])).toEqual([
      ["1".repeat(56), AGENT_A],
      ["2".repeat(56), null],
      ["3".repeat(56), null],
    ]);
  });

  it("refuses adverts whose price and bonds exceed 10,000 AP3X (F-29)", async () => {
    const atCap = (MAX_ESCROW_LOVELACE - 2n * AP3X).toString();
    const overCap = (MAX_ESCROW_LOVELACE - 2n * AP3X + 1n).toString();
    const got = await selectCandidates({
      ...base,
      fetchFn: indexer([
        row("1", { price_lovelace: atCap }),
        row("2", { price_lovelace: overCap }),
        row("3", { supplier_bond_lovelace: MAX_ESCROW_LOVELACE.toString() }),
      ]),
    });
    expect(got.map((candidate) => candidate.supplierPkh)).toEqual(["1".repeat(56)]);
  });

  it("refuses negative or non-integer amounts and a malformed agent_id", async () => {
    const got = await selectCandidates({
      ...base,
      fetchFn: indexer([
        row("1", { price_lovelace: "-1" }),
        row("2", { buyer_bond_lovelace: "1.5" }),
        row("3", { agent_id: AGENT_A.toUpperCase() }),
        row("4", { agent_id: "ab" }),
        row("5", { agent_id: AGENT_B }),
      ]),
    });
    expect(got.map((candidate) => candidate.supplierPkh)).toEqual(["5".repeat(56)]);
  });

  it("routes only new adverts after the switch", async () => {
    const rows = [row("1", { agent_id: AGENT_A }), row("2", { agent_id: null }), row("3")];
    const got = await selectCandidates({ ...base, fetchFn: indexer(rows), newAdvertsOnly: true });
    expect(got.map((candidate) => candidate.agentId)).toEqual([AGENT_A]);
    // No new advert for the model: nothing is routable, as with no supplier.
    expect(await selectCandidates({ ...base, fetchFn: indexer(rows.slice(1)), newAdvertsOnly: true })).toEqual([]);
  });

  it("lists only models that can be routed", async () => {
    const rows = [
      row("1", { model: "legacy-only" }),
      row("2", { model: "new", agent_id: AGENT_A }),
      row("3", { model: "over-cap", agent_id: AGENT_B, price_lovelace: MAX_ESCROW_LOVELACE.toString() }),
    ];
    expect(await listModels({ indexerUrl: "http://ix", fetchFn: indexer(rows) })).toEqual(["legacy-only", "new"]);
    expect(await listModels({ indexerUrl: "http://ix", fetchFn: indexer(rows), newAdvertsOnly: true })).toEqual(["new"]);
  });
});

describe("preflight — 16-field escrow floor", () => {
  const BUYER_PKH = "3b".repeat(28);

  function legacyDatum(capabilityId: string, amounts: [bigint, bigint, bigint]): EscrowDatum {
    return {
      buyer_pkh: BUYER_PKH,
      supplier_pkh: "40".repeat(28),
      advert_ref: { txHash: "a6".repeat(32), index: 0 },
      capability_id: capabilityId,
      request_spec_hash: "1b".repeat(32),
      prompt_hash: "23".repeat(32),
      payment_lovelace: amounts[0],
      buyer_bond_lovelace: amounts[1],
      supplier_bond_lovelace: amounts[2],
      deliver_by: 1_786_105_955_257,
      posted_at: 1_786_105_625_257,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Open",
    };
  }

  it("locks at least the Submitted min-UTxO of the new escrow, with agent_id and an enterprise refund", async () => {
    const capabilityId = "ocr.page.extract.chandra-ocr-2.v1";
    const amounts: [bigint, bigint, bigint] = [200_000n, 1_000_000n, 1_000_000n];
    const total = amounts[0] + amounts[1] + amounts[2];
    const legacy = legacyDatum(capabilityId, amounts);
    const identity: IdentityEscrowDatum = {
      ...legacy,
      agent_id: "5e".repeat(32),
      refund: {
        address: { paymentCredential: { type: "VerificationKey", hash: BUYER_PKH }, stakeCredential: null },
        datum: null,
      },
    };
    const chain = {
      queryUtxosByAddress: async () => [{
        ref: { txHash: "x", index: 0 }, address: "a", lovelace: 50n * AP3X, assets: {}, datumHex: null, scriptRef: null,
      }],
    } as unknown as ChainProvider;

    const result = await preflight(chain, "a", {
      capabilityId, priceLovelace: amounts[0], buyerBondLovelace: amounts[1], supplierBondLovelace: amounts[2],
    });

    const floor = escrowLockFloor(identity, total);
    expect(floor).toBeGreaterThan(total);
    expect(floor).toBeGreaterThan(escrowLockFloor(legacy, total));
    expect(minAdaForEscrowDatum(identity, total)).toBeGreaterThan(minAdaForEscrowDatum(legacy, total));
    expect(result.requiredLovelace).toBe(floor + COLLATERAL_MIN_LOVELACE + FEE_RESERVE_LOVELACE);
    expect(result.ok).toBe(true);
  });
});

describe("records — RefundRevoked reads (Part 2 §6.1)", () => {
  let blueprint: IdentityBlueprint;
  const controller = testWallet("gateway records controller");
  const supplier = testWallet("gateway records supplier", 0);
  const buyer = testWallet("gateway records buyer", 0);

  beforeAll(() => {
    vi.stubEnv("IDENTITY_POLICY_ID", TEST_IDENTITY_HASH);
    blueprint = testIdentityBlueprint();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  /** A record output at the testnet identity address (the gateway reads NETWORK_ID 0 here). */
  function record(datum: IdentityDatum, agentId: string, index = 0): Utxo {
    return {
      ...recordUtxo(blueprint, datum, { txHash: "7e".repeat(32), index }, agentId),
      address: blueprint.identityScriptAddress(0),
    };
  }

  function chainWith(...records: Utxo[]) {
    const queryUtxosByAddress = vi.fn(async (address: string) => records.filter((utxo) => utxo.address === address));
    return { chain: { queryUtxosByAddress } as unknown as ChainProvider, queryUtxosByAddress };
  }

  function escrow(state: IdentityEscrowDatum["state"], submittedAt: number | null = null): IdentityEscrowDatum {
    return {
      buyer_pkh: buyer.pubKeyHash,
      supplier_pkh: supplier.pubKeyHash,
      advert_ref: { txHash: "ad".repeat(32), index: 0 },
      capability_id: "llm.text.generate.v1",
      request_spec_hash: "1b".repeat(32),
      prompt_hash: "c3".repeat(32),
      payment_lovelace: 2n * AP3X,
      buyer_bond_lovelace: AP3X,
      supplier_bond_lovelace: AP3X,
      deliver_by: 1_800_000_090_000,
      posted_at: 1_800_000_000_000,
      submitted_at: submittedAt,
      result_receipt_hash: submittedAt === null ? null : "e5".repeat(32),
      state,
      agent_id: AGENT_A,
      refund: { address: plutusAddressFromBech32(buyer.address), datum: null },
    };
  }

  const revoked = (invalidFrom: number | null): Status => ({
    type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: 1_800_000_000_000, invalidFrom, successor: null,
  });

  it("reads the identity address once for every lookup of one sweep", async () => {
    const active = agentRecord(controller, supplier);
    const first = record(active, AGENT_A, 0);
    const second = record(active, AGENT_B, 1);
    const { chain, queryUtxosByAddress } = chainWith(first, second);
    const lookup = chainRecordLookup(chain, 0);

    expect(await lookup(AGENT_A)).toBe(first);
    expect(await lookup(AGENT_B)).toBe(second);
    expect(await lookup("c3".repeat(32))).toBeNull();
    expect(queryUtxosByAddress).toHaveBeenCalledTimes(1);
    expect(queryUtxosByAddress).toHaveBeenCalledWith(blueprint.identityScriptAddress(0));
  });

  it("finds a record whose unit has the Ogmios dot form", async () => {
    const base = record(agentRecord(controller, supplier), AGENT_A);
    const dotted: Utxo = { ...base, assets: { [`${TEST_IDENTITY_HASH}.${AGENT_A}`]: 1n } };
    const { chain } = chainWith(dotted);
    expect(await chainRecordLookup(chain, 0)(AGENT_A)).toBe(dotted);
  });

  it("applies RefundRevoked only when the agent's own status allows it", async () => {
    const active = agentRecord(controller, supplier);
    const cases: Array<[IdentityEscrowDatum, Status, boolean]> = [
      [escrow("Open"), revoked(null), true],
      [escrow("Claimed"), { type: "Retired", at: 1_800_000_000_000, successor: null }, true],
      [escrow("Open"), { type: "Active" }, false],
      [escrow("Claimed"), { type: "Suspended", holds: [] }, false],
      [escrow("Submitted", 1_800_000_050_000), revoked(1_800_000_050_000), true],
      [escrow("Submitted", 1_800_000_050_000), revoked(1_800_000_050_001), false],
      [escrow("Submitted", 1_800_000_050_000), revoked(null), false],
      [escrow("Submitted", 1_800_000_050_000), { type: "Retired", at: 1_800_000_000_000, successor: null }, false],
    ];
    for (const [datum, status, expected] of cases) {
      const datumOfRecord = status.type === "Active" || status.type === "Suspended"
        ? { ...active, status }
        : tombstone(active, status);
      const { chain } = chainWith(record(datumOfRecord, AGENT_A));
      expect(await refundRevokedApplies(datum, chainRecordLookup(chain, 0)), `${datum.state} + ${status.type}`)
        .toBe(expected);
    }
  });

  it("does not apply without an authentic record", async () => {
    const tomb = tombstone(agentRecord(controller, supplier), revoked(null));
    const missing = chainWith();
    expect(await refundRevokedApplies(escrow("Open"), chainRecordLookup(missing.chain, 0))).toBe(false);
    // The token is at the identity address, but with a second identity token.
    const doubled: Utxo = {
      ...record(tomb, AGENT_A),
      assets: { [`${TEST_IDENTITY_HASH}${AGENT_A}`]: 1n, [`${TEST_IDENTITY_HASH}${AGENT_B}`]: 1n },
    };
    const twoTokens = chainWith(doubled);
    expect(await refundRevokedApplies(escrow("Open"), chainRecordLookup(twoTokens.chain, 0))).toBe(false);
  });

  it("passes a failed chain read to the caller", async () => {
    const chain = {
      queryUtxosByAddress: async () => {
        throw new Error("ogmios down");
      },
    } as unknown as ChainProvider;
    await expect(refundRevokedApplies(escrow("Open"), chainRecordLookup(chain, 0))).rejects.toThrow("ogmios down");
  });
});
