/**
 * Identity builders (Part 2 §3.4–§3.8): each action is built with the shared
 * builders and evaluated offline against the applied identity script with
 * `aiken tx simulate` (tests/legacy-registry harness, test parameters).
 * Refusals happen in the builder, before any transaction exists.
 *
 * The tests run in order: one record (R1) goes through Register, Update
 * (P-256 key with its pop, a removal notice, a Module-1 consent), holds,
 * recovery, a controller change, an epoch bump, four subagent levels, a
 * revocation with a successor and a reclaim.
 */
import { describe, expect, it } from "vitest";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import type { IdentityDatum, Party, Signer } from "../../packages/shared/src/cbor/IdentityDatum.js";
import type { Actor } from "../../packages/shared/src/cbor/IdentityRedeemer.js";
import {
  buildBumpEpoch, buildChangeController, buildReclaim, buildRecoverCancel, buildRecoverFinalize, buildRecoverInit,
  buildRegister, buildRetire, buildRevoke, buildSetSuccessor, buildSuspend, buildUnsuspend, buildUpdate, createP256Pop,
  ed25519Key, p256Key, readRecord, TxConstructionError, verifyP256Pop, type UnsignedTx, type ValidityWindow,
} from "../../packages/shared/src/identity/tx/index.js";
import { DAYS_7_MS, DAY_MS, MAX_RANGE_MS } from "../../packages/shared/src/identity/constants.js";
import { utf8FromHex } from "../../packages/shared/src/identity/id.js";
import { p256PopValid } from "../../identity-gateway/src/codec/keys.js";
import { describeSimulation, type Simulation } from "../legacy-registry/harness/simulate.js";
import {
  AP3X, identityWorld, reportEvaluation, simulateUnsigned, TEST_NOW, testContext, testWallet, testWindow, walletFunds,
  type TestWallet,
} from "../legacy-registry/harness/identity.js";

const world = identityWorld();
const scripts = world.identityScripts;
const window = testWindow();

/** Every UTxO the tests create, so each evaluation can resolve its inputs. */
const known: Utxo[] = [...world.utxos];
let fundsCounter = 0;

const wallets = {
  controller: testWallet("identity: controller"),
  supplier: testWallet("identity: supplier key"),
  second: testWallet("identity: second key"),
  accountable: testWallet("identity: accountable party"),
  provider: testWallet("identity: provider party"),
  guardian1: testWallet("identity: guardian 1"),
  guardian2: testWallet("identity: guardian 2"),
  recovered: testWallet("identity: recovered controller"),
  changed: testWallet("identity: changed controller"),
  successor: testWallet("identity: successor controller"),
  stranger: testWallet("identity: stranger"),
};

/** A funding UTxO of `payer` and the builder context that spends it. */
function context(payer: TestWallet) {
  const funds = walletFunds(`identity funds ${fundsCounter++}`, payer, 200n * AP3X);
  known.push(funds);
  return { ctx: testContext(payer, [funds]), funds };
}

function evaluate(tx: UnsignedTx, keys: TestWallet[]): Simulation {
  const result = simulateUnsigned(tx, known, keys.map((k) => k.key));
  reportEvaluation(expect.getState().currentTestName ?? "", tx, result);
  known.push(...tx.outputs);
  return result;
}

function expectPass(tx: UnsignedTx, keys: TestWallet[], labels: string[]): Simulation {
  const result = evaluate(tx, keys);
  expect(result.passed, `${describeSimulation(result)}\n${result.error ?? ""}`).toBe(true);
  expect(result.verdicts.map((v) => v.label).sort()).toEqual([...labels].sort());
  return result;
}

const party = (role: Party["role"], signer: Signer, rights: number, extra: Partial<Party> = {}): Party => ({
  role,
  signer,
  organisation: null,
  notBefore: window.lo - 1000,
  notAfter: null,
  rights,
  removalAfter: null,
  ...extra,
});

const keyParty = (role: Party["role"], wallet: TestWallet, rights: number, extra: Partial<Party> = {}): Party =>
  party(role, { type: "KeyHash", hash: wallet.keyHash }, rights, extra);

const datumOf = (utxo: Utxo): IdentityDatum => readRecord(utxo, world.identity.hash).datum;

const refusal = (run: () => unknown): TxConstructionError => {
  try {
    run();
  } catch (error) {
    if (error instanceof TxConstructionError) return error;
    throw error;
  }
  throw new Error("the builder did not refuse");
};

/** The live state of the main record R1 and its keys. */
const state: { r1?: Utxo; id?: string; p256?: { key: string; pop: string }; subagents: Utxo[]; successor?: Utxo } = { subagents: [] };

describe("Register (§3.4)", () => {
  it("registers R1: listed key, key-hash parties, guardians, controller as Accountable Party", () => {
    const { ctx, funds } = context(wallets.controller);
    const tx = buildRegister(ctx, scripts, {
      seed: funds,
      window,
      controller: wallets.controller.publicKey,
      keys: [ed25519Key(wallets.supplier.publicKey, 9)],
      parties: [
        party("Accountable", { type: "ControllerSet" }, 3),
        keyParty("Accountable", wallets.accountable, 3),
        keyParty("Provider", wallets.provider, 1),
        keyParty("Guardian", wallets.guardian1, 4),
        keyParty("Guardian", wallets.guardian2, 4),
      ],
      guardianThreshold: 2,
      profile: { name: "R1 agent", description: "Builder test record", framework: "vector-agent", endpoint: "https://r1.example/a2a", capabilities: ["ocr.page.extract.v1"] },
    });
    const signers = [wallets.controller, wallets.supplier, wallets.accountable, wallets.provider, wallets.guardian1, wallets.guardian2];
    expect(tx.requiredSigners).toEqual(signers.map((w) => w.keyHash).sort());
    expect(tx.window.hi - tx.window.lo).toBeLessThanOrEqual(3_600_000);
    expectPass(tx, signers, ["identity Register"]);
    state.r1 = tx.outputs[tx.recordOutput];
    state.id = tx.id;
    const d = datumOf(state.r1!);
    expect(d.createdAt).toBe(window.hi);
    expect(d.status).toEqual({ type: "Active" });
    expect(state.r1!.lovelace).toBeGreaterThanOrEqual(10n * AP3X);
  });

  it("lists each key-hash party in the required signers", () => {
    const { ctx, funds } = context(wallets.controller);
    const tx = buildRegister(ctx, scripts, {
      seed: funds,
      window,
      controller: wallets.controller.publicKey,
      parties: [party("Accountable", { type: "ControllerSet" }, 3), keyParty("Provider", wallets.provider, 1)],
      profile: { name: "Missing signature" },
    });
    expect(tx.requiredSigners).toContain(wallets.provider.keyHash);
  });

  it("refuses inputs that the contract rejects", () => {
    const { ctx, funds } = context(wallets.controller);
    const base = {
      seed: funds,
      window,
      controller: wallets.controller.publicKey,
      parties: [party("Accountable", { type: "ControllerSet" }, 3)],
      profile: { name: "Refused" },
    };
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, parties: [] })).reason).toBe("not_accountable");
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, parties: [party("Accountable", { type: "ControllerSet" }, 3, { notBefore: window.lo + 1 })] })).reason)
      .toBe("not_accountable");
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, guardianThreshold: 1 })).reason).toBe("guardian_bound");
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, profile: { name: "x".repeat(65) } })).reason).toBe("datum_invalid");
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, keys: [ed25519Key(wallets.supplier.publicKey, 4)] })).reason).toBe("datum_invalid");
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, parties: [...base.parties, keyParty("Guardian", wallets.guardian1, 1)] })).reason)
      .toBe("datum_invalid");
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, window: { lo: window.lo, hi: window.lo + 3_601_000 } })).reason).toBe("window_too_long");
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, window: { lo: window.lo + 1, hi: window.hi } })).reason).toBe("window_not_slot_aligned");
    expect(refusal(() => buildRegister(ctx, scripts, { ...base, deposit: 9_999_999n })).reason).toBe("deposit_too_low");
    const tiny = walletFunds("identity: tiny seed", wallets.stranger, 2n * AP3X);
    expect(refusal(() => buildRegister(testContext(wallets.stranger, [tiny]), scripts, { ...base, seed: tiny })).reason).toBe("insufficient_funds");
    expect(refusal(() => buildRegister(testContext(wallets.stranger, []), scripts, base)).reason).toBe("collateral_missing");
  });
});

describe("Update (§3.6)", () => {
  it("adds a P-256 key with its pop and a signing Ed25519 key, removes a key, gives notice, appoints Module-1, edits the profile", async () => {
    const pair = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    state.p256 = await createP256Pop(state.id!, pair);
    expect(await verifyP256Pop(state.id!, state.p256.key, state.p256.pop)).toBe(true);
    expect(p256PopValid(state.id!, state.p256.key, state.p256.pop)).toBe(true);
    expect(await verifyP256Pop("00".repeat(32), state.p256.key, state.p256.pop)).toBe(false);

    const d = datumOf(state.r1!);
    const parties = [
      d.parties[0]!,
      d.parties[1]!,
      { ...d.parties[2]!, removalAfter: window.hi + DAYS_7_MS },
      d.parties[3]!,
      d.parties[4]!,
      party("Responsible", { type: "Script", hash: world.module1.hash }, 1),
    ];
    const { ctx } = context(wallets.controller);
    const tx = buildUpdate(ctx, scripts, {
      record: state.r1!,
      window,
      keys: [p256Key(state.p256.key, 3, state.p256.pop), ed25519Key(wallets.second.publicKey, 27)],
      parties,
      profile: { description: "Updated description", capabilities: ["ocr.page.extract.v1", "llm.chat.v1"] },
    });
    expect(tx.requiredSigners).toEqual([wallets.controller.keyHash, wallets.second.keyHash].sort());
    expect(tx.referenceInputs.map((r) => `${r.txHash}#${r.index}`)).toContain(`${world.configRecord.ref.txHash}#${world.configRecord.ref.index}`);
    expectPass(tx, [wallets.controller, wallets.second], ["identity Update", "Module-1 Consent"]);
    state.r1 = tx.outputs[0];
    const next = datumOf(state.r1!);
    expect(next.keys.map((k) => k.keyType)).toEqual(["P256", "Ed25519"]);
    expect(next.parties[5]!.signer).toEqual({ type: "Script", hash: world.module1.hash });
    expect(utf8FromHex(next.description)).toBe("Updated description");
  });

  it("keeps the Module-1 party unchanged and needs only the configuration reference input", () => {
    const { ctx } = context(wallets.controller);
    const tx = buildUpdate(ctx, scripts, { record: state.r1!, window, profile: { framework: "vector-agent 2" } });
    expect(tx.redeemers.map((r) => r.label)).toEqual(["identity Update"]);
    expect(tx.referenceInputs.some((r) => r.txHash === world.configRecord.ref.txHash)).toBe(true);
    expectPass(tx, [wallets.controller], ["identity Update"]);
    state.r1 = tx.outputs[0];
  });

  it("refuses Update inputs that the contract or Module-1 rejects", () => {
    const { ctx } = context(wallets.controller);
    const d = datumOf(state.r1!);
    const base = { record: state.r1!, window };
    expect(refusal(() => buildUpdate(ctx, scripts, { ...base, keys: [p256Key(state.p256!.key, 1, state.p256!.pop)] })).reason).toBe("kept_key_changed");
    expect(refusal(() => buildUpdate(ctx, scripts, { ...base, keys: [{ keyType: "P256", key: "02" + "11".repeat(32), purposes: 1, pop: null }] })).reason)
      .toBe("p256_pop_missing");
    expect(refusal(() => buildUpdate(ctx, scripts, { ...base, parties: [d.parties[1]!, d.parties[0]!, ...d.parties.slice(2)] })).reason).toBe("party_order");
    expect(refusal(() => buildUpdate(ctx, scripts, { ...base, parties: d.parties.slice(0, 5) })).reason).toBe("module1_early_removal");
    expect(refusal(() => buildUpdate(ctx, scripts, { ...base, guardianThreshold: 3 })).reason).toBe("guardian_bound");
    expect(refusal(() => buildUpdate(ctx, scripts, {
      ...base,
      parties: [...d.parties, party("Accountable", { type: "Script", hash: world.module1.hash }, 1)],
    })).reason).toBe("module1_rights");
  });
});

describe("Suspend and Unsuspend (§3.5)", () => {
  it("suspends by a key-hash party with the suspend right", () => {
    const { ctx } = context(wallets.controller);
    const tx = buildSuspend(ctx, scripts, { record: state.r1!, window, actor: { type: "ByParty", index: 1 }, reason: 6, until: window.hi + DAY_MS });
    expect(tx.requiredSigners).toContain(wallets.accountable.keyHash);
    expectPass(tx, [wallets.controller, wallets.accountable], ["identity Suspend"]);
    state.r1 = tx.outputs[0];
    expect(datumOf(state.r1!).status).toMatchObject({ type: "Suspended", holds: [{ by: { type: "KeyHash", hash: wallets.accountable.keyHash }, reason: 6, since: window.lo }] });
  });

  it("adds the controller's own hold and keeps the party's hold", () => {
    const { ctx } = context(wallets.controller);
    const tx = buildSuspend(ctx, scripts, { record: state.r1!, window, actor: { type: "ByController" }, reason: 0, until: window.lo + 30 * DAY_MS });
    expectPass(tx, [wallets.controller], ["identity Suspend"]);
    state.r1 = tx.outputs[0];
    const status = datumOf(state.r1!).status;
    expect(status.type === "Suspended" ? status.holds.map((h) => h.by.type) : []).toEqual(["KeyHash", "ControllerSet"]);
  });

  it("refuses holds that the contract rejects", () => {
    const { ctx } = context(wallets.controller);
    const base = { record: state.r1!, window, actor: { type: "ByController" } as const };
    expect(refusal(() => buildSuspend(ctx, scripts, { ...base, reason: 64, until: window.hi + 1 })).reason).toBe("reason_module1_only");
    expect(refusal(() => buildSuspend(ctx, scripts, { ...base, reason: 1, until: window.hi + 1 })).reason).toBe("reason_not_allowed");
    expect(refusal(() => buildSuspend(ctx, scripts, { ...base, reason: 6, until: window.hi })).reason).toBe("hold_until");
    expect(refusal(() => buildSuspend(ctx, scripts, { ...base, reason: 6, until: window.lo + 30 * DAY_MS + 1 })).reason).toBe("hold_until");
    expect(refusal(() => buildSuspend(ctx, scripts, { ...base, actor: { type: "ByParty", index: 3 }, reason: 6, until: window.hi + 1 })).reason)
      .toBe("party_without_right");
    expect(refusal(() => buildSuspend(ctx, scripts, { ...base, actor: { type: "ByParty", index: 5 }, reason: 64, until: window.hi + 1 })).reason)
      .toBe("module1_not_approving");
    expect(refusal(() => buildUnsuspend(ctx, scripts, { record: state.r1!, window, author: { type: "Script", hash: world.module1.hash } })).reason)
      .toBe("hold_missing");
  });

  it("unsuspends by the party, then by the controller", () => {
    let { ctx } = context(wallets.controller);
    let tx = buildUnsuspend(ctx, scripts, { record: state.r1!, window, author: { type: "KeyHash", hash: wallets.accountable.keyHash } });
    expectPass(tx, [wallets.controller, wallets.accountable], ["identity Unsuspend"]);
    state.r1 = tx.outputs[0];
    expect(datumOf(state.r1!).status.type).toBe("Suspended");
    ({ ctx } = context(wallets.controller));
    tx = buildUnsuspend(ctx, scripts, { record: state.r1!, window, author: { type: "ControllerSet" } });
    expectPass(tx, [wallets.controller], ["identity Unsuspend"]);
    state.r1 = tx.outputs[0];
    expect(datumOf(state.r1!).status).toEqual({ type: "Active" });
  });
});

describe("Recovery (§3.5)", () => {
  it("starts and cancels a recovery with both guardians", () => {
    let { ctx } = context(wallets.controller);
    let tx = buildRecoverInit(ctx, scripts, { record: state.r1!, window, guardians: [3, 4], newController: wallets.recovered.publicKey });
    expect(tx.requiredSigners).toEqual(expect.arrayContaining([wallets.guardian1.keyHash, wallets.guardian2.keyHash, wallets.recovered.keyHash]));
    expectPass(tx, [wallets.controller, wallets.guardian1, wallets.guardian2, wallets.recovered], ["identity RecoverInit"]);
    state.r1 = tx.outputs[0];
    expect(datumOf(state.r1!).pendingRecovery).toEqual({ newController: wallets.recovered.publicKey, effectiveAfter: window.hi + DAYS_7_MS });
    ({ ctx } = context(wallets.controller));
    tx = buildRecoverCancel(ctx, scripts, { record: state.r1!, window, guardians: [4, 3] });
    expectPass(tx, [wallets.controller, wallets.guardian1, wallets.guardian2], ["identity RecoverCancel"]);
    state.r1 = tx.outputs[0];
    expect(datumOf(state.r1!).pendingRecovery).toBeNull();
  });

  it("refuses guardians that the contract rejects", () => {
    const { ctx } = context(wallets.controller);
    const base = { record: state.r1!, window, newController: wallets.recovered.publicKey };
    expect(refusal(() => buildRecoverInit(ctx, scripts, { ...base, guardians: [3] })).reason).toBe("guardians_too_few");
    expect(refusal(() => buildRecoverInit(ctx, scripts, { ...base, guardians: [3, 3] })).reason).toBe("guardians_not_distinct");
    expect(refusal(() => buildRecoverInit(ctx, scripts, { ...base, guardians: [1, 3] })).reason).toBe("guardian_not_eligible");
    expect(refusal(() => buildRecoverCancel(ctx, scripts, { record: state.r1!, window, guardians: [3, 4] })).reason).toBe("recovery_not_pending");
  });

  it("completes a recovery after 7 days (anybody submits)", () => {
    let { ctx } = context(wallets.controller);
    const init = buildRecoverInit(ctx, scripts, { record: state.r1!, window, guardians: [3, 4], newController: wallets.recovered.publicKey });
    expectPass(init, [wallets.controller, wallets.guardian1, wallets.guardian2, wallets.recovered], ["identity RecoverInit"]);
    state.r1 = init.outputs[0];
    const early = testWindow(TEST_NOW + DAYS_7_MS);
    ({ ctx } = context(wallets.stranger));
    expect(refusal(() => buildRecoverFinalize(ctx, scripts, { record: state.r1!, window: early })).reason).toBe("recovery_too_early");
    const later = testWindow(TEST_NOW + DAYS_7_MS + 11 * 60_000);
    const tx = buildRecoverFinalize(ctx, scripts, { record: state.r1!, window: later });
    expect(tx.extraSignatories).toEqual([]);
    expectPass(tx, [wallets.stranger], ["identity RecoverFinalize"]);
    state.r1 = tx.outputs[0];
    const d = datumOf(state.r1!);
    expect(d.controller).toBe(wallets.recovered.publicKey);
    expect(d.subagentEpoch).toBe(1);
  });

  it("removes a party whose notice has passed, removes a guardian with its signature and lowers the threshold", () => {
    // Each evaluation sees only its own validity window, so the later tests may use the first window again.
    const later = testWindow(TEST_NOW + DAYS_7_MS + 11 * 60_000);
    const d = datumOf(state.r1!);
    expect(d.parties[2]!.removalAfter).toBeLessThanOrEqual(later.lo);
    const { ctx } = context(wallets.recovered);
    const parties = [d.parties[0]!, d.parties[1]!, d.parties[3]!, d.parties[5]!];
    expect(refusal(() => buildUpdate(ctx, scripts, { record: state.r1!, window: later, parties })).reason).toBe("guardian_bound");
    const tx = buildUpdate(ctx, scripts, { record: state.r1!, window: later, parties, guardianThreshold: 1 });
    expect(tx.requiredSigners).toEqual([wallets.recovered.keyHash, wallets.guardian2.keyHash].sort());
    expectPass(tx, [wallets.recovered, wallets.guardian2], ["identity Update"]);
    state.r1 = tx.outputs[0];
    const next = datumOf(state.r1!);
    expect(next.parties.map((p) => p.role)).toEqual(["Accountable", "Accountable", "Guardian", "Responsible"]);
    expect(next.guardianThreshold).toBe(1);
  });
});

describe("ChangeController and BumpEpoch (§3.5)", () => {
  it("changes the controller with both signatures", () => {
    const { ctx } = context(wallets.recovered);
    const tx = buildChangeController(ctx, scripts, { record: state.r1!, window, newController: wallets.changed.publicKey });
    expectPass(tx, [wallets.recovered, wallets.changed], ["identity ChangeController"]);
    state.r1 = tx.outputs[0];
    expect(datumOf(state.r1!)).toMatchObject({ controller: wallets.changed.publicKey, subagentEpoch: 2, pendingRecovery: null });
  });

  it("bumps the epoch", () => {
    const { ctx } = context(wallets.changed);
    const tx = buildBumpEpoch(ctx, scripts, { record: state.r1!, window });
    expectPass(tx, [wallets.changed], ["identity BumpEpoch"]);
    state.r1 = tx.outputs[0];
    expect(datumOf(state.r1!).subagentEpoch).toBe(3);
  });
});

describe("Subagents (§3.4 rule 9)", () => {
  it("registers four levels of subagents with every ancestor as a reference input", () => {
    let parent = state.r1!;
    const ancestors: Utxo[] = [];
    for (let depth = 1; depth <= 4; depth += 1) {
      const controller = testWallet(`identity: subagent ${depth}`);
      const parentController = depth === 1 ? wallets.changed : testWallet(`identity: subagent ${depth - 1}`);
      const { ctx, funds } = context(controller);
      const tx = buildRegister(ctx, scripts, {
        seed: funds,
        window,
        controller: controller.publicKey,
        parties: [party("Accountable", { type: "ControllerSet" }, 3)],
        profile: { name: `Subagent ${depth}` },
        parent: { record: parent, ancestors: [...ancestors] },
      });
      expect(tx.requiredSigners).toContain(parentController.keyHash);
      expect(tx.referenceInputs.length).toBe(1 + depth);
      expectPass(tx, [controller, parentController], ["identity Register"]);
      const record = tx.outputs[tx.recordOutput]!;
      expect(datumOf(record).lineage).toMatchObject({ type: "Subagent", depth, parentEpoch: depth === 1 ? 3 : 0 });
      ancestors.unshift(parent);
      parent = record;
      state.subagents.push(record);
    }
    const deepest = testWallet("identity: subagent 5");
    const { ctx, funds } = context(deepest);
    expect(refusal(() => buildRegister(ctx, scripts, {
      seed: funds,
      window,
      controller: deepest.publicKey,
      parties: [party("Accountable", { type: "ControllerSet" }, 3)],
      profile: { name: "Too deep" },
      parent: { record: parent, ancestors },
    })).reason).toBe("subagent_too_deep");
    expect(refusal(() => buildRegister(ctx, scripts, {
      seed: funds,
      window,
      controller: deepest.publicKey,
      parties: [party("Accountable", { type: "ControllerSet" }, 3)],
      profile: { name: "No ancestors" },
      parent: { record: state.subagents[1]! },
    })).reason).toBe("ancestor_missing");
  });
});

describe("Revoke, SetSuccessor, Retire and Reclaim (§3.5, §3.7)", () => {
  function register(label: string, extraParties: Party[] = []): { record: Utxo; controller: TestWallet } {
    const controller = testWallet(`identity: ${label}`);
    const { ctx, funds } = context(controller);
    const tx = buildRegister(ctx, scripts, {
      seed: funds,
      window,
      controller: controller.publicKey,
      parties: [party("Accountable", { type: "ControllerSet" }, 3), ...extraParties],
      profile: { name: label },
    });
    expectPass(tx, [controller, ...extraParties.map(() => wallets.accountable)], ["identity Register"]);
    return { record: tx.outputs[tx.recordOutput]!, controller };
  }

  it("registers the successor record R2", () => {
    const { ctx, funds } = context(wallets.successor);
    const tx = buildRegister(ctx, scripts, {
      seed: funds,
      window,
      controller: wallets.successor.publicKey,
      parties: [party("Accountable", { type: "ControllerSet" }, 3)],
      profile: { name: "R2 successor" },
    });
    expectPass(tx, [wallets.successor], ["identity Register"]);
    state.successor = tx.outputs[tx.recordOutput];
  });

  it("revokes R1 by the controller with a successor, then reclaims the deposit", () => {
    let { ctx } = context(wallets.changed);
    const revoke = buildRevoke(ctx, scripts, { record: state.r1!, window, actor: { type: "ByController" }, reason: 4, successor: state.successor });
    expect(revoke.requiredSigners).toContain(wallets.successor.keyHash);
    expectPass(revoke, [wallets.changed, wallets.successor], ["identity Revoke"]);
    const tombstone = revoke.outputs[0]!;
    const d = datumOf(tombstone);
    expect(d.status).toMatchObject({ type: "Revoked", by: { type: "ControllerSet" }, reason: 4, at: window.lo });
    expect(d.keys).toEqual([]);
    expect(d.parties).toEqual([]);
    expect(tombstone.lovelace).toBe(state.r1!.lovelace);

    ({ ctx } = context(wallets.changed));
    const reclaim = buildReclaim(ctx, scripts, { record: tombstone, window });
    expectPass(reclaim, [wallets.changed], ["identity Reclaim"]);
    expect(reclaim.outputs[0]!.lovelace).toBeLessThan(2n * AP3X);
    expect(reclaim.outputs[0]!.datumHex).toBe(tombstone.datumHex);
    state.r1 = reclaim.outputs[0];
  });

  it("revokes by an Accountable key-hash party with invalid_from, then the controller sets a successor", () => {
    const { record, controller } = register("R3 party revoke", [keyParty("Accountable", wallets.accountable, 3)]);
    let { ctx } = context(controller);
    const createdAt = datumOf(record).createdAt;
    expect(refusal(() => buildRevoke(ctx, scripts, { record, window, actor: { type: "ByParty", index: 1 }, reason: 1 })).reason).toBe("invalid_from_missing");
    expect(refusal(() => buildRevoke(ctx, scripts, { record, window, actor: { type: "ByParty", index: 1 }, reason: 9, successor: state.successor })).reason)
      .toBe("successor_by_party");
    // A party revocation happens in a later window than the registration.
    const later: ValidityWindow = testWindow(TEST_NOW + 3_600_000);
    const revoke = buildRevoke(ctx, scripts, { record, window: later, actor: { type: "ByParty", index: 1 }, reason: 1, invalidFrom: createdAt });
    expectPass(revoke, [controller, wallets.accountable], ["identity Revoke"]);
    expect(datumOf(revoke.outputs[0]!).status).toMatchObject({ type: "Revoked", by: { type: "KeyHash", hash: wallets.accountable.keyHash }, invalidFrom: createdAt });
    ({ ctx } = context(controller));
    const set = buildSetSuccessor(ctx, scripts, { record: revoke.outputs[0]!, window: later, successor: state.successor! });
    expectPass(set, [controller, wallets.successor], ["identity SetSuccessor"]);
    expect(datumOf(set.outputs[0]!).status).toMatchObject({ type: "Revoked", successor: readRecord(state.successor!, world.identity.hash).id });
    ({ ctx } = context(controller));
    expect(refusal(() => buildSetSuccessor(ctx, scripts, { record: set.outputs[0]!, window: later, successor: state.successor! })).reason).toBe("successor_set");
  });

  it("revokes for keyCompromise in the window of the registration: invalid_from in [created_at − 1 h, lo]", () => {
    const { record, controller } = register("R5 key compromise", [keyParty("Accountable", wallets.accountable, 3)]);
    const createdAt = datumOf(record).createdAt;
    // created_at is the hi of the registration window, so lo < created_at here.
    expect(createdAt).toBe(window.hi);
    const revoke = (actor: Actor, invalidFrom: number) =>
      buildRevoke(context(controller).ctx, scripts, { record, window, actor, reason: 1, invalidFrom });
    const party: Actor = { type: "ByParty", index: 1 };
    expect(refusal(() => revoke(party, createdAt - MAX_RANGE_MS - 1)).reason).toBe("invalid_from_range");
    expect(refusal(() => revoke(party, window.lo + 1)).reason).toBe("invalid_from_range");
    const lowest = revoke(party, createdAt - MAX_RANGE_MS);
    expectPass(lowest, [controller, wallets.accountable], ["identity Revoke"]);
    expect(datumOf(lowest.outputs[0]!).status).toMatchObject({
      type: "Revoked", by: { type: "KeyHash", hash: wallets.accountable.keyHash }, reason: 1, at: window.lo, invalidFrom: createdAt - MAX_RANGE_MS,
    });
    const atLo = revoke({ type: "ByController" }, window.lo);
    expectPass(atLo, [controller], ["identity Revoke"]);
    expect(datumOf(atLo.outputs[0]!).status).toMatchObject({ type: "Revoked", by: { type: "ControllerSet" }, invalidFrom: window.lo });
  });

  it("retires a record with a successor and releases the deposit above the ledger minimum", () => {
    const { record, controller } = register("R4 retire");
    const { ctx } = context(controller);
    expect(refusal(() => buildRetire(ctx, scripts, { record, window, successor: record })).reason).toBe("successor_self");
    const tx = buildRetire(ctx, scripts, { record, window, successor: state.successor });
    expectPass(tx, [controller, wallets.successor], ["identity Retire"]);
    expect(datumOf(tx.outputs[0]!).status).toMatchObject({ type: "Retired", at: window.lo });
    expect(tx.outputs[0]!.lovelace).toBeLessThan(2n * AP3X);
    expect(refusal(() => buildUpdate(ctx, scripts, { record: tx.outputs[0]!, window })).reason).toBe("record_terminal");
    expect(refusal(() => buildReclaim(ctx, scripts, { record, window })).reason).toBe("record_live");
  });

  it("refuses an inactive parent for a subagent", () => {
    const parent = state.subagents[0]!;
    // The parent R1 is revoked now, so every subagent is effectively Revoked.
    const child = testWallet("identity: orphan");
    const { ctx, funds } = context(child);
    expect(refusal(() => buildRegister(ctx, scripts, {
      seed: funds,
      window,
      controller: child.publicKey,
      parties: [party("Accountable", { type: "ControllerSet" }, 3)],
      profile: { name: "Orphan" },
      parent: { record: parent, ancestors: [state.r1!] },
    })).reason).toBe("parent_not_active");
  });
});
