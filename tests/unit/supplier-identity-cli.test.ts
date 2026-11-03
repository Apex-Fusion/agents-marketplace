/**
 * Supplier CLIs of the identity registry (Part 2 §6.2, §9.2, §9.6):
 * register-record (build, offline sign, submit), the Ogmios protocol
 * parameters, post-advert with agent_id, publish-reference-scripts and
 * release-escrows over both escrow addresses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { decodeIdentityAdvertDatum } from "../../packages/shared/src/cbor/IdentityAdvertDatum.js";
import { encodeAdvertDatum } from "../../packages/shared/src/cbor/AdvertDatum.js";
import { keyHash } from "../../packages/shared/src/identity/id.js";
import { loadBlueprint } from "../../packages/shared/src/tx/blueprint.js";
import type { IdentityEscrowDatum } from "../../packages/shared/src/cbor/IdentityEscrowDatum.js";
import { deriveSupplierKey } from "../../supplier/src/paper2agent/identity.js";
import {
  buildRegistration, parseAccountableParty, parseRegistration, recordsListingKey, registerWindow, signRegistration,
  submitRegistration, supplierRecord, SUPPLIER_KEY_PURPOSES, type RecordRegistrar, type RegisterRecordArgs,
} from "../../supplier/src/identity/register.js";
import { ogmiosProtocolParameters, vectorSlotConfig } from "../../supplier/src/identity/registrar.js";
import { runRegisterRecord } from "../../supplier/src/cli/register-record.js";
import { runPostAdvert } from "../../supplier/src/cli/postAdvertFlow.js";
import { parseCliArgs } from "../../supplier/src/cli/post-advert.js";
import { referenceScriptSet } from "../../supplier/src/cli/publish-reference-scripts.js";
import { runReleaseEscrows } from "../../supplier/src/cli/release-escrows.js";
import {
  AGENT_ID, CONTROLLER, IDENTITY, identityEscrowUtxo, identitySupplierKey, recordSubmissions, recordUtxo,
  supplierAgentRecord, testIdentity,
} from "../fixtures/supplier-side/identity.js";
import { tombstone } from "../fixtures/identity-builders/world.js";

const supplier = identitySupplierKey();
const CAPABILITY = "llm.text.generate.v1";
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "supplier-identity-cli-"));
  directories.push(directory);
  return directory;
}

/** A stand-in Register builder: the "transaction" is JSON hex; its ID hashes the body; witnesses list key hashes. */
function fakeRegistrar(): RecordRegistrar & { built: RegisterRecordArgs[] } {
  const encode = (tx: { body: unknown; witnesses: string[] }): string => Buffer.from(JSON.stringify(tx)).toString("hex");
  const decode = (hex: string): { body: unknown; witnesses: string[] } => JSON.parse(Buffer.from(hex, "hex").toString());
  const built: RegisterRecordArgs[] = [];
  return {
    built,
    async build(args) {
      built.push(args);
      const signers = [args.wallet.pubKeyHash, keyHash(args.controller)].sort();
      const body = { record: args.profile, signers };
      const txCborHex = encode({ body, witnesses: [] });
      return { txCborHex, txHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), agentId: AGENT_ID, requiredSigners: signers };
    },
    async sign(txCborHex, privateKeyHex) {
      const tx = decode(txCborHex);
      return encode({ ...tx, witnesses: [...tx.witnesses, deriveSupplierKey(privateKeyHex, 0).pubKeyHash] });
    },
    txId: (txCborHex) => createHash("sha256").update(JSON.stringify(decode(txCborHex).body)).digest("hex"),
  };
}

const profile = { name: "test supplier", description: "", endpoint: "https://supplier.example", capabilities: [CAPABILITY] };

describe("supplier record (Part 2 §9.2)", () => {
  it("lists the supplier key with purposes 9 and one Accountable Party from the window start", () => {
    const window = registerWindow(1_700_000_000_123);
    expect(window).toEqual({ lo: 1_699_999_940_000, hi: 1_700_003_540_000 });
    const record = supplierRecord({ controller: CONTROLLER.pubKeyHex, accountable: parseAccountableParty(undefined),
      supplierPubKeyHex: supplier.pubKeyHex, profile, window });
    expect(SUPPLIER_KEY_PURPOSES).toBe(9);
    expect(record.keys).toEqual([{ keyType: "Ed25519", key: supplier.pubKeyHex, purposes: 9, pop: null }]);
    expect(record.parties).toEqual([{ role: "Accountable", signer: { type: "ControllerSet" }, organisation: null,
      notBefore: window.lo, notAfter: null, rights: 3, removalAfter: null }]);
    expect(parseAccountableParty("ab".repeat(28))).toEqual({ type: "KeyHash", hash: "ab".repeat(28) });
    expect(() => parseAccountableParty("nobody")).toThrow(/controller/);
    for (const bad of [{ ...profile, name: "" }, { ...profile, capabilities: [] }, { ...profile, capabilities: [CAPABILITY, CAPABILITY] },
      { ...profile, capabilities: ["x".repeat(65)] }]) {
      expect(() => supplierRecord({ controller: CONTROLLER.pubKeyHex, accountable: { type: "ControllerSet" },
        supplierPubKeyHex: supplier.pubKeyHex, profile: bad, window })).toThrow();
    }
  });

  it("finds a live record that already lists the key, and ignores a retired one", async () => {
    const chain = new MockChainProvider();
    expect(await recordsListingKey(chain, IDENTITY, 0, supplier.pubKeyHash)).toEqual([]);
    chain.seed(recordUtxo(supplierAgentRecord(supplier, [CAPABILITY])));
    expect(await recordsListingKey(chain, IDENTITY, 0, supplier.pubKeyHash)).toEqual([AGENT_ID]);
    chain.seed(recordUtxo(tombstone(supplierAgentRecord(supplier, [CAPABILITY]), { type: "Retired", at: 1, successor: null })));
    expect(await recordsListingKey(chain, IDENTITY, 0, supplier.pubKeyHash)).toEqual([]);
  });

  it("signs, checks every signer and the window, then submits", async () => {
    const registrar = fakeRegistrar();
    const window = registerWindow(1_000_000);
    const record = supplierRecord({ controller: CONTROLLER.pubKeyHex, accountable: { type: "ControllerSet" },
      supplierPubKeyHex: supplier.pubKeyHex, profile, window });
    const file = await buildRegistration(registrar, { ...record, wallet: supplier, window, networkId: 0 });
    expect(file).toMatchObject({ agent_id: AGENT_ID, agent_did: `did:vector:${AGENT_ID}`, signed_by: [supplier.pubKeyHash] });
    const chain = new MockChainProvider();
    await expect(submitRegistration(registrar, chain, file, { nowMs: 0, awaitTimeoutMs: 10 })).rejects.toThrow(/still needs/);
    const stranger = deriveSupplierKey("99".repeat(32), 0);
    await expect(signRegistration(registrar, file, stranger.privateKeyHex, stranger.pubKeyHex)).rejects.toThrow(/not a required signer/);
    const signed = await signRegistration(registrar, file, CONTROLLER.privateKeyHex, CONTROLLER.pubKeyHex);
    await expect(submitRegistration(registrar, chain, signed, { nowMs: window.hi, awaitTimeoutMs: 10 })).rejects.toThrow(/window has passed/);
    const submit = vi.spyOn(chain, "submitTx");
    vi.spyOn(chain, "awaitTx").mockResolvedValue();
    expect(await submitRegistration(registrar, chain, signed, { nowMs: window.lo, awaitTimeoutMs: 10 })).toBe(AGENT_ID);
    expect(submit).toHaveBeenCalledWith(signed.tx_cbor);
  });
});

describe("tx:register-record", () => {
  const env = {
    SUPPLIER_PRIV_KEY_HEX: supplier.privateKeyHex, NETWORK_ID: "0", OGMIOS_URL: "http://ogmios.invalid",
    IDENTITY_POLICY_ID: IDENTITY.identityHash, IDENTITY_CONTROLLER_PUB_KEY_HEX: CONTROLLER.pubKeyHex,
  };

  it("builds with the advert capabilities, signs offline, submits and prints AGENT_ID", async () => {
    const chain = new MockChainProvider();
    const advert = { supplier_pkh: supplier.pubKeyHash, capability_id: CAPABILITY, model: "m", max_output_tokens: 1,
      max_processing_ms: 60_000, price_lovelace: 1n, supplier_bond_lovelace: 1n, buyer_bond_lovelace: 1n, endpoint_url: "https://e",
      detail_uri: "", detail_hash: "a".repeat(64), advertised_at: 0, status: "Active" as const };
    chain.seed({ ref: { txHash: "ad".repeat(32), index: 0 }, address: loadBlueprint().advertScriptAddress(0), lovelace: 2n, assets: {},
      datumHex: encodeAdvertDatum(advert), scriptRef: null });
    const registrar = fakeRegistrar();
    const lines: string[] = [];
    const deps = { chain, registrar, now: () => 1_000_000, out: (line: string) => lines.push(line) };
    const out = join(temporary(), "registration.json");
    expect(await runRegisterRecord(["build", "--out", out, "--name", "Seller one"], env, deps)).toBe(0);
    expect(registrar.built[0]!.profile).toEqual({ name: "Seller one", description: "", endpoint: "", capabilities: [CAPABILITY] });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(parseRegistration(readFileSync(out, "utf8")).signed_by).toEqual([supplier.pubKeyHash]);

    expect(await runRegisterRecord(["submit", "--tx", out], env, deps)).toBe(1);
    expect(await runRegisterRecord(["sign", "--tx", out], { SIGNER_PRIV_KEY_HEX: CONTROLLER.privateKeyHex }, deps)).toBe(0);
    vi.spyOn(chain, "awaitTx").mockResolvedValue();
    expect(await runRegisterRecord(["submit", "--tx", out], env, deps)).toBe(0);
    expect(lines.at(-1)).toBe(`AGENT_ID=${AGENT_ID}`);
  });

  it("refuses a second record for a listed key, a missing capability and unknown flags", async () => {
    const chain = new MockChainProvider();
    const deps = { chain, registrar: fakeRegistrar(), now: () => 1_000_000, out: () => undefined };
    const out = join(temporary(), "r.json");
    expect(await runRegisterRecord(["build", "--out", out], env, deps)).toBe(1);
    chain.seed(recordUtxo(supplierAgentRecord(supplier, [CAPABILITY])));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runRegisterRecord(["build", "--out", out, "--capability", CAPABILITY], env, deps)).toBe(1);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toMatch(new RegExp(`already listed in record ${AGENT_ID}`));
    expect(await runRegisterRecord(["build", "--out", out, "--tx", out], env, deps)).toBe(1);
    expect(await runRegisterRecord(["publish"], env, deps)).toBe(1);
  });
});

describe("protocol parameters and slot clock of the Register", () => {
  const result = {
    minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } }, minUtxoDepositCoefficient: 4310,
    scriptExecutionPrices: { memory: "577/10000", cpu: "721/10000000" }, collateralPercentage: 150, maxCollateralInputs: 3,
    maxTransactionSize: { bytes: 16384 }, maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
    minFeeReferenceScripts: { range: 25600, base: 15, multiplier: 1.2 }, plutusCostModels: { "plutus:v3": [100788, 420, 1] },
  };
  const ogmios = (value: unknown) => vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: value })));

  it("reads every value from Ogmios v6, the Plutus V3 cost model included", async () => {
    expect(await ogmiosProtocolParameters("http://ogmios.invalid", ogmios(result))).toEqual({
      minFeeA: 44, minFeeB: 155381, priceMem: 0.0577, priceStep: 0.0000721, coinsPerUtxoByte: 4310n, collateralPercentage: 150,
      maxCollateralInputs: 3, maxTxSize: 16384, maxTxExMem: 14000000n, maxTxExSteps: 10000000000n, minFeeRefScriptCostPerByte: 15,
      costModels: { PlutusV3: [100788, 420, 1] },
    });
  });

  it("never falls back to a default", async () => {
    await expect(ogmiosProtocolParameters("http://x", ogmios({ ...result, plutusCostModels: {} }))).rejects.toThrow(/Plutus V3/);
    await expect(ogmiosProtocolParameters("http://x", ogmios({ ...result, minUtxoDepositCoefficient: undefined })))
      .rejects.toThrow(/minUtxoDepositCoefficient/);
    await expect(ogmiosProtocolParameters("http://x", ogmios({ ...result, scriptExecutionPrices: { memory: 0.05 } })))
      .rejects.toThrow(/ratio/);
  });

  it("uses the mainnet slot clock, and VECTOR_ZERO_TIME_MS on the testnet", () => {
    expect(vectorSlotConfig(1, undefined)).toEqual({ zeroTimeMs: 1_756_485_600_000, zeroSlot: 0, slotLengthMs: 1000 });
    expect(vectorSlotConfig(0, "1752057484000")).toEqual({ zeroTimeMs: 1_752_057_484_000, zeroSlot: 0, slotLengthMs: 1000 });
    expect(() => vectorSlotConfig(0, undefined)).toThrow(/VECTOR_ZERO_TIME_MS/);
  });
});

describe("tx:post-advert with agent_id", () => {
  const advert = { supplier_pkh: supplier.pubKeyHash, capability_id: CAPABILITY, model: "qwen", max_output_tokens: 64,
    max_processing_ms: 60_000, price_lovelace: 2_000_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://supplier.example", detail_uri: "", detail_hash: "a".repeat(64), advertised_at: 0,
    status: "Active" as const, agent_id: AGENT_ID };

  it("parses --agent-id and AGENT_ID", () => {
    const env = { NETWORK_ID: "0", SUPPLIER_PRIV_KEY_HEX: supplier.privateKeyHex, ADVERT_CAPABILITY_ID: CAPABILITY,
      ADVERT_MODEL: "qwen", ADVERT_MAX_OUTPUT_TOKENS: "64", ADVERT_MAX_PROCESSING_MS: "60000", ADVERT_PRICE_LOVELACE: "1",
      ADVERT_ENDPOINT_URL: "https://e" };
    expect(parseCliArgs([], env).agentId).toBeUndefined();
    expect(parseCliArgs([], { ...env, AGENT_ID }).agentId).toBe(AGENT_ID);
    expect(parseCliArgs(["--agent-id", AGENT_ID], env).agentId).toBe(AGENT_ID);
    expect(() => parseCliArgs(["--agent-id", "xyz"], env)).toThrow(/64 lowercase hex/);
  });

  it("refuses unless the record lists the key and the capability, then posts at the new advert address", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(1_000);
    const identity = testIdentity(chain);
    const post = () => runPostAdvert({ chain, walletKey: supplier, advertDatum: advert, identity, log: () => undefined, awaitTimeoutMs: 100 });
    await expect(runPostAdvert({ chain, walletKey: supplier, advertDatum: advert, log: () => undefined }))
      .rejects.toMatchObject({ reason: "agent record lookup required" });
    await expect(post()).rejects.toMatchObject({ reason: "agent record not found" });
    chain.seed(recordUtxo(supplierAgentRecord(supplier, ["audio.synthesize.piper.v1"])));
    await expect(post()).rejects.toMatchObject({ reason: "capability not listed" });
    chain.seed(recordUtxo(supplierAgentRecord(deriveSupplierKey("98".repeat(32), 0), [CAPABILITY])));
    await expect(post()).rejects.toMatchObject({ reason: "supplier key not listed" });
    chain.seed(recordUtxo(supplierAgentRecord(supplier, [CAPABILITY])));
    const bodies = recordSubmissions(chain);
    const result = await post();
    const output = bodies[0]!.outputs[0]!;
    expect(output.address).toBe(IDENTITY.advertScriptAddress(0));
    expect(decodeIdentityAdvertDatum(output.datumHex!)).toMatchObject({ agent_id: AGENT_ID, supplier_pkh: supplier.pubKeyHash });
    expect(result.advertRef.index).toBe(0);
  });
});

describe("tx:publish-reference-scripts", () => {
  it("publishes the new pair by default and the legacy pair with --legacy", () => {
    const identity = referenceScriptSet([], { IDENTITY_POLICY_ID: IDENTITY.identityHash });
    expect(identity).toMatchObject({ escrowEnv: "IDENTITY_ESCROW_REF_UTXO", advertEnv: "IDENTITY_ADVERT_REF_UTXO",
      escrow: { hash: IDENTITY.escrowScriptHash, compiledCode: IDENTITY.escrowCompiledCode },
      advert: { hash: IDENTITY.advertScriptHash } });
    const legacy = referenceScriptSet(["--legacy"], {});
    expect(legacy).toMatchObject({ escrowEnv: "ESCROW_REF_UTXO", advertEnv: "ADVERT_REF_UTXO",
      escrow: { hash: loadBlueprint().escrowScriptHash }, advert: { hash: loadBlueprint().advertScriptHash } });
    expect(() => referenceScriptSet([], {})).toThrow(/IDENTITY_POLICY_ID/);
    expect(() => referenceScriptSet(["--identity"], {})).toThrow(/unknown flag/);
  });
});

describe("tx:release-escrows over both escrow addresses", () => {
  it("releases a Submitted new escrow found at the new escrow address", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(10_000);
    const submittedAt = 1_000_000;
    const escrow: IdentityEscrowDatum = { buyer_pkh: "44".repeat(28), supplier_pkh: supplier.pubKeyHash,
      advert_ref: { txHash: "ad".repeat(32), index: 0 }, capability_id: CAPABILITY, request_spec_hash: "c".repeat(64),
      prompt_hash: "d".repeat(64), payment_lovelace: 2_000_000n, buyer_bond_lovelace: 1_000_000n, supplier_bond_lovelace: 1_000_000n,
      deliver_by: 2_000_000, posted_at: 500_000, submitted_at: submittedAt, result_receipt_hash: "e".repeat(64), state: "Submitted",
      agent_id: AGENT_ID, refund: null };
    chain.seed(identityEscrowUtxo(escrow, { txHash: "e7".repeat(32), index: 0 }));
    vi.stubEnv("IDENTITY_POLICY_ID", IDENTITY.identityHash);
    const bodies = recordSubmissions(chain);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const result = await runReleaseEscrows({ escrowAddresses: [loadBlueprint().escrowScriptAddress(0), IDENTITY.escrowScriptAddress(0)],
      supplierKey: supplier, refs: [], limit: Number.POSITIVE_INFINITY, awaitTimeoutMs: 1_000, dryRun: false },
    { chain, now: () => submittedAt + 3_600_000 });
    stdout.mockRestore();
    expect(result).toMatchObject({ released: 1, failed: 0 });
    expect(bodies[0]).toMatchObject({ type: "release", inputs: [{ txHash: "e7".repeat(32), index: 0 }] });
  });
});
