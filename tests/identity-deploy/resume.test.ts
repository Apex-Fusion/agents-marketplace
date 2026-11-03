// The whole identity-side run of the deployment tool over an in-memory ledger, in the release order:
// keygen, allowlist, seed, plan, publish-refs, check (before the seal), seal (build, sign, submit),
// check. Resume: a submitted step records its transaction ID; a step whose result the chain shows
// is skipped, also when the state lost its record; a recorded step whose transaction is not on
// chain stops the run until --rebuild. Dry runs send nothing.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { blake2b256, toHex, utf8 } from "../legacy-registry/harness/index.js";
import { main } from "../../contracts/identity-marketplace/deploy/cli.js";
import { REFERENCE_NAMES, StateFile, type Deployment } from "../../contracts/identity-marketplace/deploy/state.js";
import { FakeIndex, FakeLedger, testIo, TIP_SLOT, type TestIo } from "./ledger.js";

const AP3X = 1_000_000n;
const M1 = "b7".repeat(28);
const dir = mkdtempSync(join(tmpdir(), "identity-deploy-state-"));
const keys = mkdtempSync(join(tmpdir(), "identity-deploy-keys-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(keys, { recursive: true, force: true });
});

const ledger = new FakeLedger();
const index = new FakeIndex(TIP_SLOT, Array.from({ length: 5 }, (_, i) => ({ name: toHex(blake2b256(utf8(`resume test: legacy record ${i}`))), slot: 1_000 + i })));
const file = new StateFile(dir);
const state = (): Deployment => file.load()!;
const io = (): TestIo => testIo(ledger, index);
const common = ["--network", "mainnet", "--dir", dir];
const operatorSkey = join(keys, "operator.skey");
const sealSeedSkey = join(keys, "seal-seed.skey");
let operator = "";
let sealSeedAddress = "";

async function run(args: string[], out = io()): Promise<TestIo> {
  const status = await main(args, out, {});
  expect(status, out.lines.join("\n")).toBe(0);
  return out;
}

describe("identity-side run with resume", () => {
  test("keygen writes the key pair and prints only the address and the key hash", async () => {
    const first = await run(["keygen", "--network", "mainnet", "--out", keys, "--name", "operator"]);
    expect(first.lines).toHaveLength(2);
    expect(first.lines[0]).toMatch(/^address: addr1v[0-9a-z]+$/);
    expect(first.lines[1]).toMatch(/^key hash: [0-9a-f]{56}$/);
    operator = first.lines[0]!.slice("address: ".length);
    sealSeedAddress = (await run(["keygen", "--network", "mainnet", "--out", keys, "--name", "seal-seed"])).lines[0]!.slice("address: ".length);
    expect(statSync(operatorSkey).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(operatorSkey, "utf8"))).toMatchObject({ type: "PaymentSigningKeyShelley_ed25519" });
    expect(JSON.parse(readFileSync(join(keys, "operator.vkey"), "utf8"))).toMatchObject({ type: "PaymentVerificationKeyShelley_ed25519" });
    await expect(main(["keygen", "--network", "mainnet", "--out", keys, "--name", "operator"], io(), {})).rejects.toThrow(/never replaces a key file/);
    ledger.add({ ref: { txHash: "f0".repeat(32), index: 0 }, address: operator, lovelace: 700n * AP3X, assets: {}, datumHex: null, scriptRef: null });
  });

  test("allowlist, then seed: a dry run sends nothing; --submit records the seed; a second run skips it", async () => {
    await run(["allowlist", ...common, "--cutoff", "now"]);
    const seedArgs = ["seed", ...common, "--skey", operatorSkey, "--to", sealSeedAddress, "--amount", "5"];
    await expect(main(["seed", ...common, "--skey", operatorSkey, "--to", operator, "--amount", "5"], io(), {})).rejects.toThrow(/must not be the operator address/);
    const dry = await run(seedArgs);
    expect(dry.lines.join("\n")).toMatch(/seed output of 5\.000000 AP3X at the seal-seed address[\s\S]*dry run: signed with/);
    expect(ledger.submitted).toHaveLength(0);
    expect(state().steps.seed).toBeUndefined();
    await run([...seedArgs, "--submit"]);
    expect(ledger.submitted).toHaveLength(1);
    const seedTx = ledger.submitted[0]!;
    expect(state()).toMatchObject({ steps: { seed: { tx: seedTx } }, config_seed: `${seedTx}#0`, seal_seed_address: sealSeedAddress, operator_address: operator });
    expect((await ledger.utxo({ txHash: seedTx, index: 0 }))?.lovelace).toBe(5n * AP3X);
    const again = await run(seedArgs);
    expect(again.lines.join("\n")).toMatch(/seed: done/);
    expect(ledger.submitted).toHaveLength(1);
  });

  test("plan checks the seed of the seed step and writes the plan", async () => {
    const out = await run(["plan", ...common, "--skey", operatorSkey]);
    expect(out.lines.join("\n")).toMatch(/is unspent at the seal-seed address \(5\.000000 AP3X\)/);
    expect(state().identity_hash).toMatch(/^[0-9a-f]{56}$/);
    expect(state().config_seed).toBe(`${ledger.submitted[0]}#0`);
  });

  test("publish-refs: one transaction per script; published scripts are skipped", async () => {
    await run(["publish-refs", ...common, "--skey", operatorSkey, "--scripts", "identity,attestation", "--submit"]);
    expect(ledger.submitted).toHaveLength(3);
    expect(Object.keys(state().refs).sort()).toEqual(["attestation", "identity"]);
    const all = await run(["publish-refs", ...common, "--skey", operatorSkey, "--submit"]);
    expect(all.lines.join("\n")).toMatch(/publish-identity: done/);
    expect(ledger.submitted).toHaveLength(7);
    for (const name of REFERENCE_NAMES) {
      expect(state().refs[name]).toBe(`${state().steps[`publish-${name}`]!.tx}#0`);
      const output = await ledger.utxo({ txHash: state().steps[`publish-${name}`]!.tx, index: 0 });
      expect(output?.scriptRef).toBe(state().scripts[name]!.compiled_code);
    }
    await expect(main(["publish-refs", ...common, "--scripts", "config_seal"], io(), {})).rejects.toThrow(/needs no reference output/);
  });

  test("a lost record is found on chain; a recorded transaction that is not on chain stops the run until --rebuild", async () => {
    const published = { ...state().refs };
    const lost = state();
    lost.refs = {};
    for (const step of Object.keys(lost.steps)) if (step.startsWith("publish-")) delete lost.steps[step];
    file.save(lost);
    const found = await run(["publish-refs", ...common, "--skey", operatorSkey]);
    expect(found.lines.join("\n")).toMatch(/every listed reference script is on chain/);
    expect(ledger.submitted).toHaveLength(7);
    expect(state().refs).toEqual(published);

    const missing = state();
    missing.refs.advert = `${"ab".repeat(32)}#0`;
    missing.steps["publish-advert"] = { tx: "ab".repeat(32), time: "2026-11-03T12:00:00.000Z" };
    file.save(missing);
    await expect(main(["publish-refs", ...common, "--skey", operatorSkey], io(), {})).rejects.toThrow(/is not on chain\. Wait until it is and run again, or add --rebuild/);
    await run(["publish-refs", ...common, "--skey", operatorSkey, "--rebuild"]);
    expect(state().refs.advert).toBe(published.advert);
    expect(ledger.submitted).toHaveLength(7);
  });

  test("check before the seal: the seal is not yet; the env snippet holds the published values", async () => {
    const out = await run(["check", ...common]);
    const text = out.lines.join("\n");
    expect(text).toMatch(/not yet \(the seal waits for Module-1\)/);
    expect(text).toMatch(/Module-1 hash \(M1\): not yet/);
    expect(text).toContain(`IDENTITY_POLICY_ID=${state().identity_hash}`);
    expect(text).toContain(`VECTOR_IDENTITY_REF_UTXO=${state().refs.identity}`);
    expect(text).toContain(`CUTOFF_SLOT=${state().cutoff_slot}`);
    expect(text).toMatch(/no problems/);
  });

  test("seal: build, sign offline, submit; refuses a malformed M1 and other identity values", async () => {
    const s = state();
    const manifest = (m1: string, identityHash = s.identity_hash): string => {
      const path = join(dir, `module1-${m1.slice(0, 4)}-${identityHash!.slice(0, 4)}.json`);
      writeFileSync(path, JSON.stringify({
        network: "mainnet",
        identity: { identity_hash: identityHash, identity_ref: s.refs.identity, config_policy: s.config_policy, config_holder: s.config_holder },
        hashes: { identity_party: m1 },
        identity_party_ref: `${"cd".repeat(32)}#0`,
      }));
      return path;
    };
    await expect(main(["seal", ...common, "--module1-manifest", manifest("B7".repeat(28))], io(), {})).rejects.toThrow(/hashes\.identity_party \(M1\) must be/);
    await expect(main(["seal", ...common, "--module1-manifest", manifest("00".repeat(28))], io(), {})).rejects.toThrow(/all-zero placeholder/);
    await expect(main(["seal", ...common, "--module1-manifest", manifest(M1, "ee".repeat(28))], io(), {})).rejects.toThrow(/differs from the plan: identity\.identity_hash/);

    const good = manifest(M1);
    await run(["seal", ...common, "--module1-manifest", good, "--build"]);
    const unsigned = join(dir, "tx", "seal.unsigned.json");
    const pending = state().pending.seal!;
    expect(pending).toMatchObject({ file: unsigned, module1_hash: M1 });
    await expect(main(["sign", "--tx", unsigned, "--skey", operatorSkey], io(), {})).rejects.toThrow(/needs the signatures of/);
    await run(["sign", "--tx", unsigned, "--skey", sealSeedSkey]);
    const signed = join(dir, "tx", "seal.signed.json");
    await expect(main(["submit", ...common, "--tx", unsigned, "--submit"], io(), {})).rejects.toThrow(/lacks the signatures/);
    const dry = await run(["submit", ...common, "--tx", signed]);
    expect(dry.lines.join("\n")).toMatch(/dry run: nothing was sent/);
    expect(ledger.submitted).toHaveLength(7);
    await run(["submit", ...common, "--tx", signed, "--submit"]);
    expect(ledger.submitted).toHaveLength(8);
    expect(state().seal).toEqual({ tx: pending.tx, module1_hash: M1, config_record: `${pending.tx}#0` });
    expect(state().pending.seal).toBeUndefined();
    expect(await ledger.utxo({ txHash: state().steps.seed!.tx, index: 0 })).toBeNull();

    const again = await run(["seal", ...common, "--module1-manifest", good]);
    expect(again.lines.join("\n")).toMatch(/seal: done/);
    expect((await run(["seed", ...common, "--skey", operatorSkey])).lines.join("\n")).toMatch(/seed: done; the seal .* spent it/);

    const checked = (await run(["check", ...common, "--module1-manifest", good])).lines.join("\n");
    expect(checked).toContain(`inline datum M1 = ${M1}`);
    expect(checked).toMatch(/M1 equals hashes\.identity_party/);
    expect(checked).toContain(`Module-1 hash (M1): ${M1}`);
    expect(checked).toContain(`VECTOR_IDENTITY_MODULE1_REF_UTXO=${"cd".repeat(32)}#0`);
    expect(checked).toContain(`VECTOR_IDENTITY_CONFIG_UTXO=${pending.tx}#0`);
    expect(ledger.submitted).toHaveLength(8);
  });

  test("the seal-seed key funds no other transaction", async () => {
    // A state without the operator: the seal-seed address given as operator is refused, and
    // with the operator key the wallet holds no output of the seal-seed key, so nothing is built.
    const copy = mkdtempSync(join(tmpdir(), "identity-deploy-guard-"));
    try {
      const unpublished = state();
      unpublished.operator_address = null;
      unpublished.refs = {};
      for (const step of Object.keys(unpublished.steps)) if (step.startsWith("publish-")) delete unpublished.steps[step];
      new StateFile(copy).save(unpublished);
      const other = new FakeLedger();
      other.add({ ref: { txHash: "5f".repeat(32), index: 0 }, address: sealSeedAddress, lovelace: 1_000n * AP3X, assets: {}, datumHex: null, scriptRef: null });
      const args = ["publish-refs", "--network", "mainnet", "--dir", copy];
      await expect(main([...args, "--operator", sealSeedAddress], testIo(other), {})).rejects.toThrow(/must not be the seal-seed address/);
      await expect(main([...args, "--skey", sealSeedSkey], testIo(other), {})).rejects.toThrow(/must not be the seal-seed address/);
      await expect(main([...args, "--skey", operatorSkey], testIo(other), {})).rejects.toThrow(/short/);
      expect(other.submitted).toHaveLength(0);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
