/**
 * Attestation builders (Part 2 §4.1): Attest, RevokeAtt, Contest and Withdraw
 * with Burn, evaluated offline against the applied attestation script with
 * `aiken tx simulate`. Refusals happen in the builder.
 */
import { describe, expect, it } from "vitest";
import type { Utxo } from "../../packages/shared/src/chain/ChainProvider.js";
import { decodeAttestationDatum } from "../../packages/shared/src/cbor/Attestation.js";
import {
  buildAttest, buildContest, buildRevokeAtt, buildSuspend, buildWithdrawAttestation, ed25519Key, TxConstructionError,
  type AttestationContent, type UnsignedTx,
} from "../../packages/shared/src/identity/tx/index.js";
import { DAYS_90_MS, DAY_MS } from "../../packages/shared/src/identity/constants.js";
import { utf8ToHex } from "../../packages/shared/src/identity/id.js";
import { describeSimulation } from "../legacy-registry/harness/simulate.js";
import {
  AP3X, identityWorld, registerTestRecord, reportEvaluation, simulateUnsigned, TEST_NOW, testContext, testWallet,
  testWindow, walletFunds, type TestWallet,
} from "../legacy-registry/harness/identity.js";

const world = identityWorld();
const scripts = world.attestationScripts;
const window = testWindow();
const known: Utxo[] = [...world.utxos];
let counter = 0;

const wallets = {
  subject: testWallet("attest: subject controller"),
  issuerParent: testWallet("attest: issuer parent controller"),
  issuerAgent: testWallet("attest: issuer agent controller"),
  issuerKey: testWallet("attest: issuer key"),
  freeIssuer: testWallet("attest: unregistered issuer"),
  stranger: testWallet("attest: stranger"),
};

function context(payer: TestWallet) {
  const funds = walletFunds(`attest funds ${counter++}`, payer, 100n * AP3X);
  known.push(funds);
  return testContext(payer, [funds]);
}

function seedOf(payer: TestWallet): Utxo {
  const seed = walletFunds(`attest seed ${counter++}`, payer, 20n * AP3X);
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

const content = (changes: Partial<AttestationContent> = {}): AttestationContent => ({
  attType: 1,
  format: 50,
  profile: "11".repeat(32),
  digest: "22".repeat(32),
  locator: utf8ToHex("https://evidence.example/doc.json"),
  envelopeSig: "33".repeat(64),
  validFrom: null,
  validUntil: window.hi + 30 * DAY_MS,
  solicited: false,
  links: [{ rel: 2, target: "44".repeat(32) }],
  ...changes,
});

const subject = registerTestRecord({ label: "attest: subject", controller: wallets.subject });
const parent = registerTestRecord({ label: "attest: issuer parent", controller: wallets.issuerParent });
// A registered issuer that is a subagent: its parent must be a reference input too.
const issuer = registerTestRecord({
  label: "attest: issuer subagent",
  controller: wallets.issuerAgent,
  keys: [ed25519Key(wallets.issuerKey.publicKey, 2)],
  signers: [wallets.issuerKey, wallets.issuerParent],
  parent: { record: parent.record },
  known: [parent.record],
});
known.push(subject.record, parent.record, issuer.record);

const state: { registered?: Utxo; free?: Utxo; solicited?: Utxo } = {};

describe("Attest", () => {
  it("attests as an unregistered issuer key", () => {
    const tx = buildAttest(context(wallets.freeIssuer), scripts, {
      seed: seedOf(wallets.freeIssuer),
      window,
      subject: subject.record,
      issuer: wallets.freeIssuer.publicKey,
      content: content(),
    });
    expectPass(tx, [wallets.freeIssuer], ["attestation Attest"]);
    state.free = tx.outputs[tx.attestationOutput];
    const datum = decodeAttestationDatum(state.free!.datumHex!);
    expect(datum).toMatchObject({ subject: subject.id, issuerId: null, issuedAt: window.hi, status: { type: "AttActive" }, contested: null });
    expect(state.free!.lovelace).toBeGreaterThanOrEqual(5n * AP3X);
  });

  it("attests as a registered subagent issuer with the issuer's ancestors as reference inputs", () => {
    const tx = buildAttest(context(wallets.issuerKey), scripts, {
      seed: seedOf(wallets.issuerKey),
      window,
      subject: subject.record,
      issuer: wallets.issuerKey.publicKey,
      issuerRecord: { record: issuer.record, ancestors: [parent.record] },
      content: content({ attType: 2 }),
    });
    expect(tx.referenceInputs).toHaveLength(3 + 1);
    expectPass(tx, [wallets.issuerKey], ["attestation Attest"]);
    state.registered = tx.outputs[tx.attestationOutput];
    expect(decodeAttestationDatum(state.registered!.datumHex!).issuerId).toBe(issuer.id);
  });

  it("attests a solicited attestation with the subject controller's signature", () => {
    const tx = buildAttest(context(wallets.freeIssuer), scripts, {
      seed: seedOf(wallets.freeIssuer),
      window,
      subject: subject.record,
      issuer: wallets.freeIssuer.publicKey,
      content: content({ solicited: true, attType: 4, validUntil: null, links: [] }),
    });
    expect(tx.requiredSigners).toContain(wallets.subject.keyHash);
    expectPass(tx, [wallets.freeIssuer, wallets.subject], ["attestation Attest"]);
    state.solicited = tx.outputs[tx.attestationOutput];
  });

  it("refuses content and issuers that the contract rejects", () => {
    const ctx = context(wallets.issuerKey);
    const base = { seed: seedOf(wallets.issuerKey), window, subject: subject.record, issuer: wallets.issuerKey.publicKey };
    const registered = { ...base, issuerRecord: { record: issuer.record, ancestors: [parent.record] } };
    expect(refusal(() => buildAttest(ctx, scripts, { ...base, content: content({ attType: 6 }) })).reason).toBe("attestation_invalid");
    expect(refusal(() => buildAttest(ctx, scripts, { ...base, content: content({ attType: 3, validUntil: null }) })).reason).toBe("attestation_invalid");
    expect(refusal(() => buildAttest(ctx, scripts, { ...base, content: content({ validUntil: window.hi + 367 * DAY_MS }) })).reason).toBe("attestation_invalid");
    expect(refusal(() => buildAttest(ctx, scripts, { ...base, content: content({ links: [{ rel: 4, target: "44".repeat(32) }] }) })).reason)
      .toBe("attestation_invalid");
    expect(refusal(() => buildAttest(ctx, scripts, { ...base, content: content({ format: 65_536 }) })).reason).toBe("attestation_invalid");
    expect(refusal(() => buildAttest(ctx, scripts, { ...base, deposit: 4_999_999n, content: content() })).reason).toBe("deposit_too_low");
    expect(refusal(() => buildAttest(ctx, scripts, { ...registered, issuer: wallets.freeIssuer.publicKey, content: content() })).reason)
      .toBe("issuer_key_not_listed");
    expect(refusal(() => buildAttest(ctx, scripts, { ...base, issuerRecord: { record: issuer.record }, content: content() })).reason)
      .toBe("ancestor_missing");
  });

  it("refuses a registered issuer whose effective status is not Active", () => {
    const suspendedWindow = testWindow(TEST_NOW + 60 * 60_000);
    const funds = walletFunds("attest: suspend funds", wallets.issuerParent, 50n * AP3X);
    const suspend = buildSuspend(testContext(wallets.issuerParent, [funds]), world.identityScripts, {
      record: parent.record,
      window: suspendedWindow,
      actor: { type: "ByController" },
      reason: 68,
      until: suspendedWindow.hi + DAY_MS,
    });
    expect(simulateUnsigned(suspend, [...known, funds], [wallets.issuerParent.key]).passed).toBe(true);
    expect(refusal(() => buildAttest(context(wallets.issuerKey), scripts, {
      seed: seedOf(wallets.issuerKey),
      window: suspendedWindow,
      subject: subject.record,
      issuer: wallets.issuerKey.publicKey,
      issuerRecord: { record: issuer.record, ancestors: [suspend.outputs[0]!] },
      content: content(),
    })).reason).toBe("issuer_not_active");
  });
});

describe("RevokeAtt, Contest and Withdraw", () => {
  it("contests an attestation by the subject's controller", () => {
    const tx = buildContest(context(wallets.subject), scripts, {
      attestation: state.free!,
      window,
      subject: subject.record,
      anchor: { uri: utf8ToHex("ipfs://reply"), sha256: "55".repeat(32) },
    });
    expectPass(tx, [wallets.subject], ["attestation Contest"]);
    state.free = tx.outputs[0];
    expect(decodeAttestationDatum(state.free!.datumHex!).contested).toEqual({ uri: utf8ToHex("ipfs://reply"), sha256: "55".repeat(32) });
    expect(refusal(() => buildContest(context(wallets.subject), scripts, {
      attestation: state.free!,
      window,
      subject: subject.record,
      anchor: { uri: "", sha256: "55".repeat(32) },
    })).reason).toBe("anchor_invalid");
  });

  it("revokes by the unregistered issuer key", () => {
    const tx = buildRevokeAtt(context(wallets.freeIssuer), scripts, { attestation: state.free!, window, reason: 5 });
    expectPass(tx, [wallets.freeIssuer], ["attestation RevokeAtt"]);
    state.free = tx.outputs[0];
    expect(decodeAttestationDatum(state.free!.datumHex!).status).toEqual({ type: "AttRevoked", at: window.lo, reason: 5 });
    expect(refusal(() => buildRevokeAtt(context(wallets.freeIssuer), scripts, { attestation: state.free!, window, reason: 5 })).reason)
      .toBe("attestation_revoked");
  });

  it("revokes a registered issuer's attestation by the listed key", () => {
    const tx = buildRevokeAtt(context(wallets.issuerKey), scripts, { attestation: state.registered!, window, reason: 0, issuerRecord: issuer.record });
    expect(tx.requiredSigners).toContain(wallets.issuerKey.keyHash);
    expect(tx.referenceInputs.some((r) => r.txHash === issuer.record.ref.txHash)).toBe(true);
    expectPass(tx, [wallets.issuerKey], ["attestation RevokeAtt"]);
  });

  it("revokes a registered issuer's attestation by the issuer record's controller", () => {
    const attest = buildAttest(context(wallets.issuerKey), scripts, {
      seed: seedOf(wallets.issuerKey),
      window,
      subject: subject.record,
      issuer: wallets.issuerKey.publicKey,
      issuerRecord: { record: issuer.record, ancestors: [parent.record] },
      content: content({ validUntil: window.hi + DAY_MS }),
    });
    expectPass(attest, [wallets.issuerKey], ["attestation Attest"]);
    const tx = buildRevokeAtt(context(wallets.issuerAgent), scripts, {
      attestation: attest.outputs[attest.attestationOutput]!,
      window,
      reason: 3,
      issuerRecord: issuer.record,
      authority: "controller",
    });
    expect(tx.extraSignatories).toEqual([wallets.issuerAgent.keyHash]);
    expectPass(tx, [wallets.issuerAgent], ["attestation RevokeAtt"]);
    expect(refusal(() => buildRevokeAtt(context(wallets.issuerAgent), scripts, { attestation: state.solicited!, window, reason: 1, authority: "controller" })).reason)
      .toBe("issuer_unregistered");
    expect(refusal(() => buildRevokeAtt(context(wallets.issuerKey), scripts, { attestation: tx.outputs[0]!, window, reason: 1 })).reason)
      .toBe("attestation_revoked");
  });

  it("withdraws a revoked attestation at revoked_at + 90 days: spend Withdraw and Burn", () => {
    // Revoked at window.lo; lo of these windows is TEST_NOW - 60 s + the shift.
    const tooEarly = testWindow(TEST_NOW + DAYS_90_MS - 1000);
    expect(refusal(() => buildWithdrawAttestation(context(wallets.freeIssuer), scripts, { attestation: state.free!, window: tooEarly })).reason)
      .toBe("attestation_not_withdrawable");
    const later = testWindow(TEST_NOW + DAYS_90_MS);
    expect(later.lo).toBe(window.lo + DAYS_90_MS);
    const tx = buildWithdrawAttestation(context(wallets.freeIssuer), scripts, { attestation: state.free!, window: later });
    expect(tx.outputs.every((o) => Object.keys(o.assets).length === 0)).toBe(true);
    expectPass(tx, [wallets.freeIssuer], ["attestation Withdraw", "attestation Burn"]);
  });

  it("withdraws an active attestation 90 days after valid_until, by the registered issuer key", () => {
    const attest = buildAttest(context(wallets.issuerKey), scripts, {
      seed: seedOf(wallets.issuerKey),
      window,
      subject: subject.record,
      issuer: wallets.issuerKey.publicKey,
      issuerRecord: { record: issuer.record, ancestors: [parent.record] },
      content: content({ validUntil: window.hi + DAY_MS }),
    });
    expectPass(attest, [wallets.issuerKey], ["attestation Attest"]);
    const later = testWindow(window.hi + DAY_MS + DAYS_90_MS + 2 * 60_000);
    const tx = buildWithdrawAttestation(context(wallets.issuerKey), scripts, {
      attestation: attest.outputs[attest.attestationOutput]!,
      window: later,
      issuerRecord: issuer.record,
    });
    expectPass(tx, [wallets.issuerKey], ["attestation Withdraw", "attestation Burn"]);
  });
});
