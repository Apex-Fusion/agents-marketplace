/**
 * Delegation and vault builders (Part 2 §5.2, §5.3): Delegate (principal
 * root, agent root, sub-delegation), Undelegate (own delegator, ancestor's
 * delegator), the vault funding output, Pay into new-layout escrows with the
 * vault refund, and Close of Live and Returned outputs. Each positive case is
 * evaluated offline against the applied scripts with `aiken tx simulate`.
 */
import { describe, expect, it } from "vitest";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { decodeVaultDatum, vaultDatumToData, type Delegator } from "../../packages/shared/src/cbor/Delegation.js";
import { decodeIdentityEscrowDatum, identityEscrowDatumToData } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { encodePlutusDataHex } from "../../packages/shared/src/cbor/plutus-data.js";
import {
  buildDelegate, buildUndelegate, buildVaultClose, buildVaultOpen, buildVaultPay, ed25519Key, enterpriseAddress,
  escrowResource, minUtxo, TxConstructionError, type UnsignedTx, type VaultEscrowJob,
} from "../../packages/shared/src/identity/tx/index.js";
import { DAYS_7_MS, DAY_MS } from "../../packages/shared/src/identity/constants.js";
import { describeSimulation } from "../legacy-registry/harness/simulate.js";
import {
  AP3X, identityWorld, registerTestRecord, reportEvaluation, simulateUnsigned, testContext, testWallet, testWindow,
  walletFunds, type TestWallet,
} from "../legacy-registry/harness/identity.js";

const world = identityWorld();
const scripts = world.delegationScripts;
const vaultScripts = world.vaultScripts;
const window = testWindow();
const known: Utxo[] = [...world.utxos];
let counter = 0;

const wallets = {
  principal: testWallet("delegation: principal key"),
  agentA: testWallet("delegation: agent A controller"),
  keyA: testWallet("delegation: agent A delegation key"),
  agentB: testWallet("delegation: agent B controller"),
  keyB1: testWallet("delegation: agent B key 1"),
  keyB2: testWallet("delegation: agent B key 2"),
  agentC: testWallet("delegation: agent C controller"),
  keyC: testWallet("delegation: agent C key"),
  stranger: testWallet("delegation: stranger"),
};

function context(payer: TestWallet) {
  const funds = walletFunds(`delegation funds ${counter++}`, payer, 300n * AP3X);
  known.push(funds);
  return testContext(payer, [funds]);
}

function seedOf(payer: TestWallet): Utxo {
  const seed = walletFunds(`delegation seed ${counter++}`, payer, 10n * AP3X);
  known.push(seed);
  return seed;
}

function expectPass(tx: UnsignedTx, keys: TestWallet[], labels: string[]): void {
  const result = simulateUnsigned(tx, known, keys.map((k) => k.key));
  reportEvaluation(expect.getState().currentTestName ?? "", tx, result);
  known.push(...tx.outputs);
  expect(result.passed, `${describeSimulation(result)}\n${result.error ?? ""}`).toBe(true);
  expect(result.verdicts.map((v) => v.label).sort()).toEqual([...labels].sort());
}

const refusal = (run: () => unknown): TxConstructionError => {
  try {
    run();
  } catch (error) {
    if (error instanceof TxConstructionError) return error;
    throw error;
  }
  throw new Error("the builder did not refuse");
};

const agentA = registerTestRecord({ label: "delegation: agent A", controller: wallets.agentA, keys: [ed25519Key(wallets.keyA.publicKey, 16)], signers: [wallets.keyA] });
const agentB = registerTestRecord({
  label: "delegation: agent B",
  controller: wallets.agentB,
  keys: [ed25519Key(wallets.keyB1.publicKey, 16), ed25519Key(wallets.keyB2.publicKey, 17)],
  signers: [wallets.keyB1, wallets.keyB2],
});
const agentC = registerTestRecord({ label: "delegation: agent C", controller: wallets.agentC, keys: [ed25519Key(wallets.keyC.publicKey, 16)], signers: [wallets.keyC] });
known.push(agentA.record, agentB.record, agentC.record);

const resource = escrowResource(world.escrow.hash);
const principal: Delegator = { type: "PrincipalKey", hash: wallets.principal.keyHash, organisation: null };
const state: { d1?: Utxo; d1Id?: string; d2?: Utxo; d2Id?: string; d3?: Utxo; v1?: Utxo; v2?: Utxo } = {};

const job = (payment: bigint, buyerBond = 0n, supplierBond = 0n, changes: Partial<VaultEscrowJob> = {}): VaultEscrowJob => ({
  supplierPkh: "a1".repeat(28),
  advertRef: { txHash: "a2".repeat(32), index: 0 },
  capabilityId: "ocr.page.extract.v1",
  requestSpecHash: "a3".repeat(32),
  promptHash: "a4".repeat(32),
  payment,
  buyerBond,
  supplierBond,
  deliverBy: window.hi + DAY_MS,
  agentId: agentC.id,
  ...changes,
});

describe("Delegate (§5.2)", () => {
  it("delegates from a principal key to agent B's listed key, with a value limit and one more hop", () => {
    const tx = buildDelegate(context(wallets.principal), scripts, {
      seed: seedOf(wallets.principal),
      window,
      delegator: principal,
      delegate: agentB.id,
      delegateKey: wallets.keyB1.keyHash,
      actions: ["marketplace.*"],
      resources: [resource],
      notBefore: window.lo - DAY_MS,
      notAfter: window.lo + 30 * DAY_MS,
      remaining: 1,
      value: { perTx: 50n * AP3X, total: 100n * AP3X, periodMs: DAY_MS },
      records: [agentB.record],
    });
    expect(tx.requiredSigners).toEqual(expect.arrayContaining([wallets.principal.keyHash, wallets.keyB1.keyHash]));
    expectPass(tx, [wallets.principal, wallets.keyB1], ["delegation Delegate"]);
    state.d1 = tx.outputs[tx.delegationOutput];
    state.d1Id = tx.delegationId;
  });

  it("sub-delegates from agent B to agent C: narrower actions, value limit and period; the parent's key signs", () => {
    const tx = buildDelegate(context(wallets.keyB1), scripts, {
      seed: seedOf(wallets.keyB1),
      window,
      parent: state.d1!,
      delegate: agentC.id,
      delegateKey: wallets.keyC.keyHash,
      actions: ["marketplace.hire.v1"],
      resources: [resource],
      notBefore: window.lo - DAY_MS,
      notAfter: window.lo + 20 * DAY_MS,
      remaining: 0,
      value: { perTx: 20n * AP3X, total: 50n * AP3X, periodMs: DAY_MS },
      records: [agentB.record, agentC.record],
    });
    expectPass(tx, [wallets.keyB1, wallets.keyC], ["delegation Delegate"]);
    state.d2 = tx.outputs[tx.delegationOutput];
    state.d2Id = tx.delegationId;
  });

  it("delegates from agent A, signed by A's listed delegation key", () => {
    const tx = buildDelegate(context(wallets.keyA), scripts, {
      seed: seedOf(wallets.keyA),
      window,
      delegator: { type: "Agent", id: agentA.id },
      agentSigner: wallets.keyA.keyHash,
      delegate: agentB.id,
      delegateKey: wallets.keyB2.keyHash,
      actions: ["*"],
      resources: ["*"],
      notBefore: window.lo - DAY_MS,
      notAfter: window.lo + DAY_MS,
      remaining: 0,
      inUseDelegateKeys: [wallets.keyB1.keyHash],
      records: [agentA.record, agentB.record],
    });
    expectPass(tx, [wallets.keyA, wallets.keyB2], ["delegation Delegate"]);
    state.d3 = tx.outputs[tx.delegationOutput];
  });

  it("refuses delegations that the contract or the fresh-key rule rejects", () => {
    const ctx = context(wallets.keyB1);
    const base = {
      seed: seedOf(wallets.keyB1),
      window,
      delegate: agentC.id,
      delegateKey: wallets.keyC.keyHash,
      actions: ["marketplace.hire.v1"],
      resources: [resource],
      notBefore: window.lo - DAY_MS,
      notAfter: window.lo + DAY_MS,
      remaining: 0,
      records: [agentB.record, agentC.record],
    };
    const sub = { ...base, parent: state.d1!, value: { perTx: 1n, total: 1n, periodMs: DAY_MS } };
    expect(refusal(() => buildDelegate(ctx, scripts, { ...sub, actions: ["*"] })).reason).toBe("not_narrower");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...sub, actions: ["oc.*"] })).reason).toBe("not_narrower");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...sub, value: null })).reason).toBe("not_narrower");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...sub, notAfter: window.lo + 31 * DAY_MS })).reason).toBe("not_narrower");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...sub, remaining: 1 })).reason).toBe("not_narrower");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...base, delegator: principal, delegateKey: wallets.keyB1.keyHash })).reason)
      .toBe("delegate_key_not_listed");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...base, delegator: principal, inUseDelegateKeys: [wallets.keyC.keyHash] })).reason)
      .toBe("delegate_key_in_use");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...base, delegator: principal, actions: ["Bad pattern"] })).reason).toBe("delegation_invalid");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...base, delegator: principal, remaining: 4 })).reason).toBe("delegation_invalid");
    expect(refusal(() => buildDelegate(ctx, scripts, { ...base, delegator: principal, records: [agentB.record] })).reason).toBe("record_missing");
  });
});

describe("Vault (§5.3)", () => {
  it("opens a vault for the principal's delegation (a plain payment, no script runs)", () => {
    expect(refusal(() => buildVaultOpen(context(wallets.principal), vaultScripts, {
      owner: { type: "Agent", id: agentA.id }, delegation: state.d1!, amount: 200n * AP3X, window,
    })).reason).toBe("vault_owner_mismatch");
    expect(refusal(() => buildVaultOpen(context(wallets.principal), vaultScripts, {
      owner: { type: "Agent", id: agentA.id }, delegation: state.d3!, amount: 200n * AP3X, window,
    })).reason).toBe("vault_no_limit");
    const tx = buildVaultOpen(context(wallets.principal), vaultScripts, { owner: principal, delegation: state.d1!, amount: 200n * AP3X, window });
    expect(tx.redeemers).toEqual([]);
    expectPass(tx, [wallets.principal], []);
    state.v1 = tx.outputs[tx.vaultOutput];
    expect(decodeVaultDatum(state.v1!.datumHex!)).toEqual({ type: "Live", owner: principal, delegation: state.d1Id, spent: 0n, periodStart: 0 });
  });

  it("pays two escrows from the vault: a new period starts at hi, the refunds return to the vault", () => {
    const tx = buildVaultPay(context(wallets.keyB1), vaultScripts, {
      vault: state.v1!,
      window,
      delegation: state.d1!,
      records: [agentB.record],
      escrows: [job(10n * AP3X, 1n * AP3X, 2n * AP3X), job(5n * AP3X)],
    });
    expect(tx.extraSignatories).toEqual([wallets.keyB1.keyHash]);
    expectPass(tx, [wallets.keyB1], ["vault Pay"]);
    const escrow = decodeIdentityEscrowDatum(tx.outputs[0]!.datumHex!);
    expect(escrow).toMatchObject({ state: "Open", buyer_pkh: wallets.keyB1.keyHash, submitted_at: null, result_receipt_hash: null, agent_id: agentC.id });
    expect(escrow.refund?.address).toEqual({ paymentCredential: { type: "Script", hash: world.vault.hash }, stakeCredential: null });
    expect(escrow.refund?.datum).toEqual(vaultDatumToData({ type: "Returned", owner: principal }));
    expect(tx.outputs[0]!.address).toBe(enterpriseAddress({ type: "Script", hash: world.escrow.hash }, 1));
    state.v1 = tx.outputs[tx.vaultOutput];
    expect(decodeVaultDatum(state.v1!.datumHex!)).toEqual({ type: "Live", owner: principal, delegation: state.d1Id, spent: 18n * AP3X, periodStart: window.hi });
    expect(state.v1!.lovelace).toBe(200n * AP3X - 18n * AP3X);
  });

  it("pays again in the same period, then refuses a payment over the period total or over per_tx", () => {
    const again = buildVaultPay(context(wallets.keyB1), vaultScripts, {
      vault: state.v1!,
      window,
      delegation: state.d1!,
      records: [agentB.record],
      escrows: [job(40n * AP3X)],
    });
    expectPass(again, [wallets.keyB1], ["vault Pay"]);
    state.v1 = again.outputs[again.vaultOutput];
    expect(decodeVaultDatum(state.v1!.datumHex!)).toMatchObject({ spent: 58n * AP3X, periodStart: window.hi });
    const base = { vault: state.v1!, window, delegation: state.d1!, records: [agentB.record] };
    expect(refusal(() => buildVaultPay(context(wallets.keyB1), vaultScripts, { ...base, escrows: [job(45n * AP3X)] })).reason).toBe("vault_total");
    expect(refusal(() => buildVaultPay(context(wallets.keyB1), vaultScripts, { ...base, escrows: [job(51n * AP3X)] })).reason).toBe("vault_per_tx");
    expect(refusal(() => buildVaultPay(context(wallets.keyB1), vaultScripts, { ...base, escrows: [job(1n * AP3X, 0n, 0n, { deliverBy: window.hi + DAYS_7_MS + 1 })] })).reason)
      .toBe("escrow_deliver_by");
    expect(refusal(() => buildVaultPay(context(wallets.keyB1), vaultScripts, { ...base, records: [] , escrows: [job(1n * AP3X)] })).reason).toBe("record_missing");
    // A new period begins after period_ms: the total starts again.
    const nextDay = testWindow(window.hi + DAY_MS + 2 * 60_000);
    const later = buildVaultPay(context(wallets.keyB1), vaultScripts, { ...base, window: nextDay, escrows: [job(45n * AP3X)] });
    expectPass(later, [wallets.keyB1], ["vault Pay"]);
    expect(decodeVaultDatum(later.outputs[later.vaultOutput]!.datumHex!)).toMatchObject({ spent: 45n * AP3X, periodStart: nextDay.hi });
    state.v1 = later.outputs[later.vaultOutput];
  });

  it("pays through a two-link chain: the sub-delegation's delegate key signs, both links are reference inputs", () => {
    const open = buildVaultOpen(context(wallets.agentB), vaultScripts, {
      owner: { type: "Agent", id: agentB.id }, delegation: state.d2!, amount: 60n * AP3X, window,
    });
    expectPass(open, [wallets.agentB], []);
    state.v2 = open.outputs[open.vaultOutput];
    const tx = buildVaultPay(context(wallets.keyC), vaultScripts, {
      vault: state.v2!,
      window,
      delegation: state.d2!,
      ancestors: [state.d1!],
      records: [agentB.record, agentC.record],
      escrows: [job(15n * AP3X, 2n * AP3X)],
    });
    expect(tx.referenceInputs.length).toBe(4 + 1);
    expectPass(tx, [wallets.keyC], ["vault Pay"]);
    expect(refusal(() => buildVaultPay(context(wallets.keyC), vaultScripts, {
      vault: state.v2!, window, delegation: state.d2!, records: [agentB.record, agentC.record], escrows: [job(1n * AP3X)],
    })).reason).toBe("delegation_ancestor_missing");
  });

  it("puts a min-UTxO top-up into the buyer bond, so each escrow holds exactly payment + both bonds", () => {
    const tx = buildVaultPay(context(wallets.keyC), vaultScripts, {
      vault: state.v2!,
      window,
      delegation: state.d2!,
      ancestors: [state.d1!],
      records: [agentB.record, agentC.record],
      escrows: [job(1n * AP3X), job(3n * AP3X, 1n * AP3X, 1n * AP3X)],
    });
    expectPass(tx, [wallets.keyC], ["vault Pay"]);
    const [small, large] = tx.escrowOutputs.map((i) => ({
      coin: tx.outputs[i]!.lovelace,
      datum: decodeIdentityEscrowDatum(tx.outputs[i]!.datumHex!),
    }));
    for (const escrow of [small!, large!]) {
      expect(escrow.coin).toBe(escrow.datum.payment_lovelace + escrow.datum.buyer_bond_lovelace + escrow.datum.supplier_bond_lovelace);
    }
    // 1 AP3X is below the min-UTxO of the escrow output: the difference is in the buyer bond.
    expect(small!.datum.payment_lovelace).toBe(1n * AP3X);
    expect(small!.datum.buyer_bond_lovelace).toBeGreaterThan(0n);
    expect(small!.datum.supplier_bond_lovelace).toBe(0n);
    // 5 AP3X is above it: no top-up.
    expect(large!.datum.buyer_bond_lovelace).toBe(1n * AP3X);
    expect(large!.coin).toBe(5n * AP3X);
  });

  it("closes a Live vault and a Returned refund output of two owners in one transaction", () => {
    const returned: Utxo = walletFunds("delegation: returned refund", wallets.agentB, 0n);
    const refund: Utxo = {
      ...returned,
      address: enterpriseAddress({ type: "Script", hash: world.vault.hash }, 1),
      lovelace: 12n * AP3X,
      datumHex: encodePlutusDataHex(vaultDatumToData({ type: "Returned", owner: { type: "Agent", id: agentB.id } })),
    };
    known.push(refund);
    expect(refusal(() => buildVaultClose(context(wallets.principal), vaultScripts, { vaults: [state.v1!, refund], window })).reason).toBe("record_missing");
    const tx = buildVaultClose(context(wallets.principal), vaultScripts, {
      vaults: [state.v1!, refund],
      window,
      ownerRecords: [agentB.record],
      to: wallets.principal.address,
    });
    expect(tx.extraSignatories).toEqual([wallets.principal.keyHash, wallets.agentB.keyHash].sort());
    expectPass(tx, [wallets.principal, wallets.agentB], ["vault Close 0", "vault Close 1"]);
    expect(refusal(() => buildVaultPay(context(wallets.keyB1), vaultScripts, {
      vault: refund, window, delegation: state.d1!, records: [agentB.record], escrows: [job(1n * AP3X)],
    })).reason).toBe("vault_returned");
  });
});

describe("Undelegate (§5.2)", () => {
  it("removes the sub-delegation by the delegator of its parent (the principal), with the parent as a reference input", () => {
    expect(refusal(() => buildUndelegate(context(wallets.principal), scripts, {
      delegation: state.d2!, window, revoker: { type: "PrincipalKey", hash: wallets.principal.keyHash },
    })).reason).toBe("delegation_ancestor_missing");
    const tx = buildUndelegate(context(wallets.principal), scripts, {
      delegation: state.d2!,
      window,
      revoker: { type: "PrincipalKey", hash: wallets.principal.keyHash },
      ancestors: [state.d1!],
    });
    expectPass(tx, [wallets.principal], ["delegation Undelegate (spend)", "delegation Undelegate (burn)"]);
  });

  it("removes the principal's delegation, and agent A's delegation by A's controller", () => {
    let tx = buildUndelegate(context(wallets.principal), scripts, {
      delegation: state.d1!, window, revoker: { type: "PrincipalKey", hash: wallets.principal.keyHash },
    });
    expectPass(tx, [wallets.principal], ["delegation Undelegate (spend)", "delegation Undelegate (burn)"]);
    expect(refusal(() => buildUndelegate(context(wallets.stranger), scripts, {
      delegation: state.d3!, window, revoker: { type: "PrincipalKey", hash: wallets.stranger.keyHash },
    })).reason).toBe("revoker_not_delegator");
    tx = buildUndelegate(context(wallets.agentA), scripts, {
      delegation: state.d3!,
      window,
      revoker: { type: "Agent", id: agentA.id },
      records: [agentA.record],
    });
    expect(tx.extraSignatories).toEqual([wallets.agentA.keyHash]);
    expectPass(tx, [wallets.agentA], ["delegation Undelegate (spend)", "delegation Undelegate (burn)"]);
  });
});
