/**
 * The benchmark transactions of Part 2 §12.4: complete, signed Conway
 * transactions with the applied scripts (scripts.ts), evaluated offline by
 * `aiken tx simulate` through the harness of tests/legacy-registry. Every
 * script runs from a reference input, as on mainnet; every script transaction
 * has a collateral input; one wallet pays the fee and gets the change.
 *
 * Cases:
 * - the largest record (records.ts) through every identity action (Register,
 *   Adopt and the 12 spends, with both actors of Suspend and Revoke);
 * - Claim and Submit with the largest record of the escrow benchmarks;
 * - a depth-4 subagent Register with its four ancestors of the largest size;
 * - a vault Pay through a depth-4 delegation chain with several escrow outputs;
 * - the publication of each validator as a reference script.
 */
import {
  decodePlutusDataHex,
  delegationDatumToData,
  encodeEscrowRedeemer,
  encodeIdentityMint,
  encodeIdentitySpend,
  encodeVaultSpend,
  identityEscrowDatumToData,
  vaultDatumToData,
  type DelegationDatum,
  type Delegator,
  type IdentityDatum,
  type IdentityEscrowDatum,
  type IdentityMint,
  type IdentitySpend,
  type Hold,
  type Refund,
  type Signer,
} from "@marketplace/shared/cbor";
import {
  BURN,
  buildTx,
  constr,
  DEREGISTER,
  fromHex,
  identifierOf,
  LEGACY_ADDRESS,
  LEGACY_HASH,
  LEGACY_SCRIPT,
  legacyToken,
  rewardAddress,
  toHex,
  utf8,
  agentDatum,
  blake2b256,
  withChange,
  type BuiltTx,
  type Data,
  type MintEntry,
  type PlutusV3Script,
  type SpendInput,
  type TxOut,
  type Utxo,
  type Withdrawal,
} from "../../../tests/legacy-registry/harness/index.js";
import { harnessData } from "../../../tests/legacy-registry/harness/identity.js";
import {
  ALLOWLIST,
  ALLOWLIST_IDS,
  AP3X,
  CONFIG_RECORD,
  DELEGATION_ADDRESS,
  DELEGATION_HASH,
  ESCROW_ADDRESS,
  ESCROW_HASH,
  existing,
  IDENTITY_ADDRESS,
  IDENTITY_HASH,
  M1,
  REFERENCE,
  referenceScript,
  SCRIPTS,
  VAULT_ADDRESS,
  VAULT_HASH,
  wallet,
  type Wallet,
} from "./scripts.js";
import {
  CONTROLLER,
  CONTROLLER_SET,
  DAY,
  ESCROW_CAPABILITY,
  ESCROW_RECORD,
  HI,
  keyHashOf,
  keySigner,
  LARGEST,
  LARGEST_GUARDED,
  LARGEST_HOLDS,
  LARGEST_LAPSED,
  LARGEST_PARTIES,
  LISTED,
  LO,
  MODULE1,
  NEW_CONTROLLER,
  OTHER_CONTROLLER,
  PARTY,
  publicKey,
  recordData,
  SUCCESSOR_RECORD,
  SUPPLIER,
  tombstone,
  VALIDITY,
  ed25519,
  fullParty,
  p256,
} from "./records.js";

export type Group = "identity" | "subagent" | "escrow" | "vault" | "publication";

export interface BenchCase {
  readonly name: string;
  readonly group: Group;
  readonly description: string;
  readonly build: () => BuiltTx;
}

// ─── Common parts ────────────────────────────────────────────────────────

/** A fee that is larger than the real one; only the size of its field counts. */
const FEE = 2n * AP3X;
export const PAYER = wallet("fee payer");
export const COLLATERAL = existing("collateral", { address: PAYER.address, value: { coin: 10n * AP3X } });
/** The total collateral that the size accounting adds (150 % of the fee). */
export const TOTAL_COLLATERAL = 3n * AP3X;

const funds = (label: string, coin = 500n * AP3X): Utxo => existing(`funds for ${label}`, { address: PAYER.address, value: { coin } });

const asData = (hex: string): Data => harnessData(decodePlutusDataHex(hex));
const spendRedeemer = (r: IdentitySpend): Data => asData(encodeIdentitySpend(r));

/** The record deposit of the benchmarks: above the min-UTxO of the largest record output (about 18.1 AP3X). */
const DEPOSIT = 20n * AP3X;

const recordOutput = (id: string, datum: IdentityDatum, coin = DEPOSIT): TxOut => ({
  address: IDENTITY_ADDRESS,
  value: { coin, assets: [{ policy: IDENTITY_HASH, name: fromHex(id), quantity: 1n }] },
  datum: { inline: recordData(datum) },
});

const recordUtxo = (label: string, id: string, datum: IdentityDatum, coin = DEPOSIT): Utxo => existing(label, recordOutput(id, datum, coin));

/** The withdrawal of 0 from `Script(M1)` that makes `ok(Script { M1 })`. */
const MODULE1_WITHDRAWAL: Withdrawal = {
  rewardAddress: rewardAddress({ script: M1 }),
  amount: 0n,
  redeemer: constr(0),
  label: "Module-1 withdraw (stand-in)",
};

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

interface Parts {
  /** The fee input; also the seed of a Register. */
  readonly payer?: Utxo;
  readonly inputs?: readonly SpendInput[];
  readonly referenceInputs: readonly Utxo[];
  readonly outputs: readonly TxOut[];
  readonly mint?: readonly MintEntry[];
  readonly withdrawals?: readonly Withdrawal[];
  /** The required signers; they also sign. */
  readonly signers: readonly Wallet[];
}

/** A signed script transaction with the window `[LO, HI]`, a collateral input and the change to the payer. */
function scriptTx(label: string, parts: Parts): BuiltTx {
  const signers = unique([PAYER, ...parts.signers]);
  return buildTx(
    withChange(
      {
        inputs: [{ utxo: parts.payer ?? funds(label) }, ...(parts.inputs ?? [])],
        referenceInputs: unique(parts.referenceInputs),
        collateral: [COLLATERAL],
        outputs: parts.outputs,
        fee: FEE,
        mint: parts.mint ?? [],
        withdrawals: parts.withdrawals ?? [],
        requiredSigners: unique(parts.signers).map((w) => w.key.keyHash),
        validity: VALIDITY,
        signers: signers.map((w) => w.key),
      },
      PAYER.address,
    ),
  );
}

// ─── Identity actions on the largest record ──────────────────────────────

/** The signers of the largest record at creation: the controller, the 5 Ed25519 keys and the 7 key parties. */
const CREATION_SIGNERS: readonly Wallet[] = [CONTROLLER, ...LISTED.slice(0, 5), ...[1, 2, 3, 4, 5, 6, 7].map((n) => PARTY[n]!)];

/** The largest record at creation: Active, `created_at = HI`. */
const NEW_LARGEST: IdentityDatum = { ...LARGEST, createdAt: HI, status: { type: "Active" } };

const RECORD_ID = toHex(blake2b256(utf8("identity bench: record")));
const SUCCESSOR_ID = toHex(blake2b256(utf8("identity bench: successor")));
const SUCCESSOR_UTXO = recordUtxo("successor record", SUCCESSOR_ID, SUCCESSOR_RECORD);

/** A Register of `datum`; `extra.without` leaves one creation signer out (a negative control). */
function register(
  label: string,
  datum: IdentityDatum,
  extra: { refs?: readonly Utxo[]; signers?: readonly Wallet[]; without?: Wallet } = {},
): BuiltTx {
  const seed = funds(label);
  const id = toHex(identifierOf(seed.ref));
  const mint: IdentityMint = { type: "Register", seed: { txHash: toHex(seed.ref.txId), index: seed.ref.index } };
  return scriptTx(label, {
    payer: seed,
    referenceInputs: [REFERENCE.identity, REFERENCE.module1, CONFIG_RECORD, ...(extra.refs ?? [])],
    outputs: [recordOutput(id, datum)],
    mint: [{ policy: IDENTITY_HASH, assets: [{ name: fromHex(id), quantity: 1n }], redeemer: asData(encodeIdentityMint(mint)), label: "identity mint Register" }],
    withdrawals: [MODULE1_WITHDRAWAL],
    signers: [...(extra.signers ?? []), ...CREATION_SIGNERS].filter((w) => w !== extra.without),
  });
}

const LEGACY_OWNER = wallet("legacy owner");
const LEGACY_REFERENCE = referenceScript("legacy registry", LEGACY_SCRIPT);

function adopt(): BuiltTx {
  const id = ALLOWLIST_IDS[0]!;
  const legacy = existing("legacy record", {
    address: LEGACY_ADDRESS,
    value: { coin: 10n * AP3X, assets: [legacyToken(fromHex(id))] },
    datum: {
      inline: agentDatum({
        owner: { key: LEGACY_OWNER.key.keyHash },
        name: "Legacy Agent",
        description: "A legacy record that adopts.",
        capabilities: ["llm.text.generate.v1"],
        framework: "vector-agent",
        endpoint: "https://legacy.example/a2a",
        registeredAt: 1_760_000_000_000n,
      }),
    },
  });
  const mint: IdentityMint = { type: "Adopt", proof: ALLOWLIST.proof(id) };
  return scriptTx("adopt", {
    inputs: [{ utxo: legacy, redeemer: DEREGISTER, label: "legacy spend Deregister" }],
    referenceInputs: [REFERENCE.identity, LEGACY_REFERENCE, REFERENCE.module1, CONFIG_RECORD],
    // The legacy change rule: one output of at least 10 AP3X to the owner's key hash.
    outputs: [recordOutput(id, NEW_LARGEST), { address: LEGACY_OWNER.address, value: { coin: 10n * AP3X } }],
    mint: [
      { policy: IDENTITY_HASH, assets: [{ name: fromHex(id), quantity: 1n }], redeemer: asData(encodeIdentityMint(mint)), label: "identity mint Adopt" },
      { policy: LEGACY_HASH, assets: [{ name: fromHex(id), quantity: -1n }], redeemer: BURN, label: "legacy mint Burn" },
    ],
    withdrawals: [MODULE1_WITHDRAWAL],
    signers: [LEGACY_OWNER, ...CREATION_SIGNERS],
  });
}

interface SpendParts {
  readonly redeemer: IdentitySpend;
  readonly before: IdentityDatum;
  readonly after: IdentityDatum;
  readonly signers: readonly Wallet[];
  /** `ok(Script { M1 })`: the Module-1 withdrawal. */
  readonly module1?: boolean;
  /** The successor record as a reference input; its controller signs. */
  readonly successor?: boolean;
  /** The AP3X of the record output; the input holds `DEPOSIT`. */
  readonly outputCoin?: bigint;
}

/** Whether a datum has a Module-1 party: then the record output needs the configuration record (§3.8). */
const hasModule1 = (d: IdentityDatum): boolean => d.parties.some((p) => p.signer.type === "Script");

function spend(label: string, p: SpendParts): BuiltTx {
  const input = recordUtxo(`${label}: record`, RECORD_ID, p.before);
  const needsConfig = hasModule1(p.before) || hasModule1(p.after) || p.module1 === true;
  return scriptTx(label, {
    inputs: [{ utxo: input, redeemer: spendRedeemer(p.redeemer), label: `identity spend ${p.redeemer.type}` }],
    referenceInputs: [
      REFERENCE.identity,
      ...(needsConfig ? [CONFIG_RECORD] : []),
      ...(p.module1 ? [REFERENCE.module1] : []),
      ...(p.successor ? [SUCCESSOR_UTXO] : []),
    ],
    outputs: [recordOutput(RECORD_ID, p.after, p.outputCoin ?? DEPOSIT)],
    withdrawals: p.module1 ? [MODULE1_WITHDRAWAL] : [],
    signers: [...p.signers, ...(p.successor ? [OTHER_CONTROLLER] : [])],
  });
}

const signerName = (s: Signer): string => (s.type === "ControllerSet" ? "controller" : `${s.type}:${s.hash}`);

/** The holds of the largest record without `by` and without the removed key party 8 (§3.5). */
const holdsWithout = (by: Signer): Hold[] =>
  LARGEST_HOLDS.filter((h) => signerName(h.by) !== signerName(by) && signerName(h.by) !== signerName(keySigner(PARTY[8]!)));

const suspended = (d: IdentityDatum, holds: Hold[]): IdentityDatum => ({ ...d, status: { type: "Suspended", holds } });

/** A tombstone revoked by key party 1 a day before `LO`, without a successor. */
const ENDED = tombstone(LARGEST, { type: "Revoked", by: keySigner(PARTY[1]!), reason: 3, at: LO - DAY, invalidFrom: null, successor: null });

const PENDING = { newController: publicKey(NEW_CONTROLLER), effectiveAfter: LO } as const;
const GUARDIANS: readonly Wallet[] = [PARTY[11]!, PARTY[12]!, PARTY[13]!];

/** Suspend by key party 1, which renews its hold; `outputCoin` below the deposit takes AP3X (a negative control). */
const suspendByParty = (label: string, outputCoin = DEPOSIT): BuiltTx =>
  spend(label, {
    redeemer: { type: "Suspend", actor: { type: "ByParty", index: 1 } },
    before: LARGEST,
    after: suspended(LARGEST, [...holdsWithout(keySigner(PARTY[1]!)), { by: keySigner(PARTY[1]!), reason: 9, since: LO, until: LO + 30 * DAY }]),
    signers: [PARTY[1]!],
    outputCoin,
  });

const identityCases: BenchCase[] = [
  {
    name: "Register",
    group: "identity",
    description: "Register of the largest record: 13 required signers (controller, 5 Ed25519 keys, 7 key parties), Module-1 appointed",
    build: () => register("register", NEW_LARGEST),
  },
  {
    name: "Adopt",
    group: "identity",
    description: "Adopt into the largest record with a 13-node allowlist proof; the legacy Deregister and Burn run in the same transaction",
    build: adopt,
  },
  {
    name: "Update",
    group: "identity",
    description: "Update: a new Ed25519 key replaces one, a removal notice, a new description",
    build: () =>
      spend("update", {
        redeemer: { type: "Update" },
        before: LARGEST,
        after: {
          ...LARGEST,
          description: "44".repeat(256),
          keys: [...LISTED.slice(0, 4).map((w) => ed25519(w)), ed25519(LISTED[5]!), p256(1), p256(2), p256(3)],
          parties: [...LARGEST_PARTIES.slice(0, 7), { ...fullParty("Provider", keySigner(PARTY[7]!), 1, false), removalAfter: HI + 8 * DAY }],
        },
        signers: [CONTROLLER, LISTED[5]!],
      }),
  },
  {
    name: "ChangeController",
    group: "identity",
    description: "ChangeController: the old and the new controller sign",
    build: () =>
      spend("change controller", {
        redeemer: { type: "ChangeController" },
        before: LARGEST,
        after: { ...LARGEST, controller: publicKey(NEW_CONTROLLER), subagentEpoch: 1 },
        signers: [CONTROLLER, NEW_CONTROLLER],
      }),
  },
  {
    name: "Suspend (key party)",
    group: "identity",
    description: "Suspend by key party 1, which renews its hold; the hold of the removed party 8 is dropped",
    build: () => suspendByParty("suspend by party"),
  },
  {
    name: "Suspend (Module-1)",
    group: "identity",
    description: "Suspend by the Module-1 party (reason 64), with the Module-1 withdrawal",
    build: () =>
      spend("suspend by Module-1", {
        redeemer: { type: "Suspend", actor: { type: "ByParty", index: 0 } },
        before: LARGEST,
        after: suspended(LARGEST, [...holdsWithout(MODULE1), { by: MODULE1, reason: 64, since: LO, until: LO + 30 * DAY }]),
        signers: [],
        module1: true,
      }),
  },
  {
    name: "Unsuspend",
    group: "identity",
    description: "Unsuspend by key party 1: 8 holds stay",
    build: () =>
      spend("unsuspend", {
        redeemer: { type: "Unsuspend", author: keySigner(PARTY[1]!) },
        before: LARGEST,
        after: suspended(LARGEST, holdsWithout(keySigner(PARTY[1]!))),
        signers: [PARTY[1]!],
      }),
  },
  {
    name: "Revoke (controller)",
    group: "identity",
    description: "Revoke by the controller: reason 1 with invalid_from, and a successor",
    build: () =>
      spend("revoke by controller", {
        redeemer: { type: "Revoke", actor: { type: "ByController" } },
        before: LARGEST,
        after: tombstone(LARGEST, { type: "Revoked", by: CONTROLLER_SET, reason: 1, at: LO, invalidFrom: LO, successor: SUCCESSOR_ID }),
        signers: [CONTROLLER],
        successor: true,
      }),
  },
  {
    name: "Revoke (Module-1)",
    group: "identity",
    description: "Revoke by the Module-1 party (reason 64), with the Module-1 withdrawal",
    build: () =>
      spend("revoke by Module-1", {
        redeemer: { type: "Revoke", actor: { type: "ByParty", index: 0 } },
        before: LARGEST,
        after: tombstone(LARGEST, { type: "Revoked", by: MODULE1, reason: 64, at: LO, invalidFrom: null, successor: null }),
        signers: [],
        module1: true,
      }),
  },
  {
    name: "Retire",
    group: "identity",
    description: "Retire with a successor",
    build: () =>
      spend("retire", {
        redeemer: { type: "Retire" },
        before: LARGEST,
        after: tombstone(LARGEST, { type: "Retired", at: LO, successor: SUCCESSOR_ID }),
        signers: [CONTROLLER],
        successor: true,
      }),
  },
  {
    name: "Reclaim",
    group: "identity",
    description: "Reclaim of a tombstone: the output keeps 2 AP3X",
    build: () => spend("reclaim", { redeemer: { type: "Reclaim" }, before: ENDED, after: ENDED, signers: [CONTROLLER], outputCoin: 2n * AP3X }),
  },
  {
    name: "SetSuccessor",
    group: "identity",
    description: "SetSuccessor on a tombstone that a key party revoked",
    build: () =>
      spend("set successor", {
        redeemer: { type: "SetSuccessor" },
        before: ENDED,
        after: { ...ENDED, status: { type: "Revoked", by: keySigner(PARTY[1]!), reason: 3, at: LO - DAY, invalidFrom: null, successor: SUCCESSOR_ID } },
        signers: [CONTROLLER],
        successor: true,
      }),
  },
  {
    name: "BumpEpoch",
    group: "identity",
    description: "BumpEpoch: the controller ends the subagents",
    build: () => spend("bump epoch", { redeemer: { type: "BumpEpoch" }, before: LARGEST, after: { ...LARGEST, subagentEpoch: 1 }, signers: [CONTROLLER] }),
  },
  {
    name: "RecoverInit",
    group: "identity",
    description: "RecoverInit by 3 guardians (threshold 3) and the new controller",
    build: () =>
      spend("recover init", {
        redeemer: { type: "RecoverInit", guardians: [5, 6, 7] },
        before: LARGEST_GUARDED,
        after: { ...LARGEST_GUARDED, pendingRecovery: { newController: publicKey(NEW_CONTROLLER), effectiveAfter: HI + 7 * DAY } },
        signers: [...GUARDIANS, NEW_CONTROLLER],
      }),
  },
  {
    name: "RecoverCancel",
    group: "identity",
    description: "RecoverCancel by 3 guardians",
    build: () =>
      spend("recover cancel", {
        redeemer: { type: "RecoverCancel", guardians: [5, 6, 7] },
        before: { ...LARGEST_GUARDED, pendingRecovery: PENDING },
        after: LARGEST_GUARDED,
        signers: GUARDIANS,
      }),
  },
  {
    name: "RecoverFinalize",
    group: "identity",
    description: "RecoverFinalize by anybody after the delay",
    build: () =>
      spend("recover finalize", {
        redeemer: { type: "RecoverFinalize" },
        before: { ...LARGEST_GUARDED, pendingRecovery: PENDING },
        after: { ...LARGEST_GUARDED, controller: publicKey(NEW_CONTROLLER), subagentEpoch: 1 },
        signers: [],
      }),
  },
];

// ─── Depth-4 subagent ────────────────────────────────────────────────────

const chainId = (depth: number): string => toHex(blake2b256(utf8(`identity bench: ancestor ${depth}`)));

/** The ancestor at `depth` (0 = root): the largest record with lapsed holds, controlled by `OTHER_CONTROLLER`. */
function ancestor(depth: number): IdentityDatum {
  const base: IdentityDatum = { ...LARGEST_LAPSED, controller: publicKey(OTHER_CONTROLLER) };
  return depth === 0 ? base : { ...base, endpoint: "", lineage: { type: "Subagent", parent: chainId(depth - 1), parentEpoch: 0, depth } };
}

const subagentCases: BenchCase[] = [
  {
    name: "Register depth-4 subagent",
    group: "subagent",
    description: "Register of a largest-size subagent at depth 4, with its 4 ancestors of the largest size as reference inputs",
    build: () =>
      register("subagent", { ...NEW_LARGEST, endpoint: "", lineage: { type: "Subagent", parent: chainId(3), parentEpoch: 0, depth: 4 } }, {
        refs: [0, 1, 2, 3].map((d) => recordUtxo(`ancestor ${d}`, chainId(d), ancestor(d))),
        signers: [OTHER_CONTROLLER],
      }),
  },
];

// ─── Claim and Submit ────────────────────────────────────────────────────

const AGENT_ID = toHex(blake2b256(utf8("identity bench: supplier agent")));
const BUYER = wallet("buyer");
/** A vault refund (§5.3), the largest refund form. */
const returnedOwner: Delegator = { type: "PrincipalKey", hash: keyHashOf(BUYER), organisation: null };
const VAULT_REFUND: Refund = {
  address: { paymentCredential: { type: "Script", hash: toHex(VAULT_HASH) }, stakeCredential: null },
  datum: vaultDatumToData({ type: "Returned", owner: returnedOwner }),
};

const escrowDatum = (state: IdentityEscrowDatum["state"]): IdentityEscrowDatum => ({
  buyer_pkh: keyHashOf(BUYER),
  supplier_pkh: keyHashOf(SUPPLIER),
  advert_ref: { txHash: toHex(blake2b256(utf8("identity bench: advert"))), index: 0 },
  capability_id: Buffer.from(ESCROW_CAPABILITY, "hex").toString("utf8"),
  request_spec_hash: "11".repeat(32),
  prompt_hash: "22".repeat(32),
  payment_lovelace: 10n * AP3X,
  buyer_bond_lovelace: AP3X,
  supplier_bond_lovelace: AP3X,
  deliver_by: HI + DAY,
  posted_at: LO - DAY,
  submitted_at: null,
  result_receipt_hash: null,
  state,
  agent_id: AGENT_ID,
  refund: VAULT_REFUND,
});

const escrowOutput = (datum: IdentityEscrowDatum): TxOut => ({
  address: ESCROW_ADDRESS,
  value: { coin: 12n * AP3X },
  datum: { inline: harnessData(identityEscrowDatumToData(datum)) },
});

/** A Claim or Submit of the escrow with the largest record as reference input, signed by `signer`. */
function escrowSpend(label: string, before: IdentityEscrowDatum, after: IdentityEscrowDatum, redeemer: Data, signer: Wallet = SUPPLIER): BuiltTx {
  return scriptTx(label, {
    inputs: [{ utxo: existing(`${label}: escrow`, escrowOutput(before)), redeemer, label: `escrow spend ${label}` }],
    referenceInputs: [REFERENCE.escrow, recordUtxo("escrow agent record", AGENT_ID, ESCROW_RECORD)],
    outputs: [escrowOutput(after)],
    signers: [signer],
  });
}

const RECEIPT_HASH = "ee".repeat(32);

const escrowCases: BenchCase[] = [
  {
    name: "Claim",
    group: "escrow",
    description: "Claim with the largest record (supplier key, Accountable Party and capability last) and a vault refund",
    build: () => escrowSpend("Claim", escrowDatum("Open"), escrowDatum("Claimed"), asData(encodeEscrowRedeemer({ type: "Claim" }))),
  },
  {
    name: "Submit",
    group: "escrow",
    description: "Submit with the largest record and a vault refund",
    build: () =>
      escrowSpend(
        "Submit",
        escrowDatum("Claimed"),
        { ...escrowDatum("Submitted"), submitted_at: HI, result_receipt_hash: RECEIPT_HASH },
        asData(encodeEscrowRedeemer({ type: "Submit", receipt_hash: RECEIPT_HASH })),
      ),
  },
];

// ─── Vault payment through a depth-4 delegation chain ────────────────────

/** Agent `n` (0 to 4): the controller and the delegation key (listed key 5 of its record). */
const AGENT = [0, 1, 2, 3, 4].map((n) => ({ id: toHex(blake2b256(utf8(`identity bench: delegation agent ${n}`))), controller: wallet(`agent ${n} controller`), delegationKey: wallet(`agent ${n} delegation key`) }));

/** The record of agent `n`: the largest record with lapsed holds; its fifth Ed25519 key is the delegation key. */
const agentRecord = (n: number): IdentityDatum => ({
  ...LARGEST_LAPSED,
  controller: publicKey(AGENT[n]!.controller),
  keys: [...LISTED.slice(0, 4).map((w) => ed25519(w)), ed25519(AGENT[n]!.delegationKey), p256(1), p256(2), p256(3)],
});

const delegationId = (n: number): string => toHex(blake2b256(utf8(`identity bench: delegation ${n}`)));

/** 16 action patterns and 8 resource patterns; the ones that cover the vault payment come last. */
const ACTIONS = [...Array.from({ length: 15 }, (_, i) => `svc${i + 1}.*`), "marketplace.*"].map((s) => Buffer.from(s).toString("hex"));
const RESOURCES = [...Array.from({ length: 7 }, (_, i) => `script:${(i + 1).toString(16).padStart(2, "0").repeat(28)}`), `script:${toHex(ESCROW_HASH)}`].map((s) =>
  Buffer.from(s).toString("hex"),
);
/** The largest value limit: 10,000 AP3X per transaction and in total, per day. */
const LIMIT = { perTx: 10_000n * AP3X, total: 10_000n * AP3X, periodMs: DAY };

/** Link `n` (1 to 4): agent `n - 1` delegates to agent `n`; link 1 has the root delegator agent 0. */
const link = (n: number): DelegationDatum => ({
  delegator: { type: "Agent", id: AGENT[n - 1]!.id },
  parent: n === 1 ? null : delegationId(n - 1),
  delegate: AGENT[n]!.id,
  delegateKey: keyHashOf(AGENT[n]!.delegationKey),
  actions: ACTIONS,
  resources: RESOURCES,
  notBefore: LO - 7 * DAY + n,
  notAfter: LO + 30 * DAY - n,
  depth: n,
  remaining: 4 - n,
  purpose: "99".repeat(32),
  value: LIMIT,
});

const delegationUtxo = (n: number): Utxo =>
  existing(`delegation ${n}`, {
    address: DELEGATION_ADDRESS,
    value: { coin: 0n, assets: [{ policy: DELEGATION_HASH, name: fromHex(delegationId(n)), quantity: 1n }] },
    datum: { inline: harnessData(delegationDatumToData(link(n))) },
  });

/** The owner of the vault: agent 3, the delegator of link 4. Agent 4 is the delegate. */
const VAULT_OWNER: Delegator = { type: "Agent", id: AGENT[3]!.id };
const VAULT_FUNDS = 1_000n * AP3X;
const PERIOD_START = LO - 3_600_000;

const vaultOutput = (spent: bigint, coin: bigint): TxOut => ({
  address: VAULT_ADDRESS,
  value: { coin },
  datum: { inline: harnessData(vaultDatumToData({ type: "Live", owner: VAULT_OWNER, delegation: delegationId(4), spent, periodStart: PERIOD_START })) },
});

/** A new escrow of a vault payment: AP3X equal to the payment and both bonds; the vault refund. */
function paidEscrow(index: number, coin: bigint): TxOut {
  const datum: IdentityEscrowDatum = {
    buyer_pkh: keyHashOf(AGENT[4]!.delegationKey),
    supplier_pkh: keyHashOf(SUPPLIER),
    advert_ref: { txHash: toHex(blake2b256(utf8(`identity bench: advert ${index}`))), index: 0 },
    capability_id: "ocr.extract.v1",
    request_spec_hash: "11".repeat(32),
    prompt_hash: "22".repeat(32),
    payment_lovelace: coin - 2n * AP3X,
    buyer_bond_lovelace: AP3X,
    supplier_bond_lovelace: AP3X,
    deliver_by: HI + 7 * DAY,
    posted_at: HI,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    agent_id: AGENT_ID,
    refund: {
      address: { paymentCredential: { type: "Script", hash: toHex(VAULT_HASH) }, stakeCredential: null },
      datum: vaultDatumToData({ type: "Returned", owner: VAULT_OWNER }),
    },
  };
  return { address: ESCROW_ADDRESS, value: { coin }, datum: { inline: harnessData(identityEscrowDatumToData(datum)) } };
}

/**
 * A Pay of `escrows` escrows of 20 AP3X each from the vault of agent 3, signed by `signer` (agent 4's
 * delegation key, the delegate key of link 4).
 */
export function vaultPay(escrows: number, signer: Wallet = AGENT[4]!.delegationKey): BuiltTx {
  const each = 20n * AP3X;
  const amount = each * BigInt(escrows);
  return scriptTx(`vault pay ${escrows}`, {
    inputs: [{ utxo: existing("vault", vaultOutput(0n, VAULT_FUNDS)), redeemer: asData(encodeVaultSpend({ type: "Pay" })), label: "vault spend Pay" }],
    referenceInputs: [
      REFERENCE.vault,
      ...[1, 2, 3, 4].map(delegationUtxo),
      ...[0, 1, 2, 3, 4].map((n) => recordUtxo(`agent ${n} record`, AGENT[n]!.id, agentRecord(n))),
    ],
    outputs: [vaultOutput(amount, VAULT_FUNDS - amount), ...Array.from({ length: escrows }, (_, i) => paidEscrow(i, each))],
    signers: [signer],
  });
}

/**
 * The escrow counts of the vault benchmarks. 25 is the most that stays under 70 % of every limit;
 * 38 is the most that fits into 16,384 bytes (39 escrows need 16,787 bytes).
 */
export const VAULT_ESCROW_COUNTS = [1, 5, 10, 25, 38] as const;

const vaultCases: BenchCase[] = VAULT_ESCROW_COUNTS.map((escrows) => ({
  name: `Vault Pay, ${escrows} escrow${escrows === 1 ? "" : "s"}`,
  group: "vault" as const,
  description: `Pay through a depth-4 delegation chain (4 delegations with 16 actions and 8 resources, 5 agent records of the largest size) into ${escrows} escrow output${escrows === 1 ? "" : "s"}`,
  build: () => vaultPay(escrows),
}));

// ─── Reference-script publication ────────────────────────────────────────

function publication(label: string, script: PlutusV3Script): BuiltTx {
  const output = referenceScript(label, script).output;
  return buildTx(
    withChange(
      { inputs: [{ utxo: funds(`publication of ${label}`) }], outputs: [output], fee: FEE, signers: [PAYER.key] },
      PAYER.address,
    ),
  );
}

const PUBLISHED: ReadonlyArray<readonly [string, PlutusV3Script]> = [
  ["identity", SCRIPTS.identity],
  ["config_holder", SCRIPTS.configHolder],
  ["config_seal", SCRIPTS.configSeal],
  ["attestation", SCRIPTS.attestation],
  ["delegation", SCRIPTS.delegation],
  ["vault", SCRIPTS.vault],
  ["escrow", SCRIPTS.escrow],
  ["advert", SCRIPTS.advert],
];

const publicationCases: BenchCase[] = PUBLISHED.map(([label, script]) => ({
  name: `Publish ${label}`,
  group: "publication" as const,
  description: `Publication of the applied ${label} script (${script.compiledCode.length} bytes) as a reference script at the zero key hash address`,
  build: () => publication(label, script),
}));

export const CASES: readonly BenchCase[] = [...identityCases, ...subagentCases, ...escrowCases, ...vaultCases, ...publicationCases];

/**
 * Changed cases that the scripts must reject, with the purpose that fails. They show that the
 * benchmarks run the real rules.
 */
export const CONTROLS: ReadonlyArray<BenchCase & { readonly fails: string }> = [
  {
    name: "Register without key party 7",
    group: "identity",
    description: "A party does not sign its appointment",
    fails: "identity mint Register",
    build: () => register("register without party 7", NEW_LARGEST, { without: PARTY[7]! }),
  },
  {
    name: "Suspend that takes 1 AP3X",
    group: "identity",
    description: "A party's Suspend takes value",
    fails: "identity spend Suspend",
    build: () => suspendByParty("suspend taking AP3X", DEPOSIT - AP3X),
  },
  {
    name: "Claim by an unlisted key",
    group: "escrow",
    description: "The supplier key is not a listed key of the record",
    fails: "escrow spend Claim",
    build: () =>
      escrowSpend(
        "Claim",
        { ...escrowDatum("Open"), supplier_pkh: keyHashOf(BUYER) },
        { ...escrowDatum("Claimed"), supplier_pkh: keyHashOf(BUYER) },
        asData(encodeEscrowRedeemer({ type: "Claim" })),
        BUYER,
      ),
  },
  {
    name: "Vault Pay signed by another delegation key",
    group: "vault",
    description: "Agent 3's delegation key signs instead of the delegate key of link 4",
    fails: "vault spend Pay",
    build: () => vaultPay(1, AGENT[3]!.delegationKey),
  },
];

/** Escrow outputs one above the most that fit into a transaction. */
export const VAULT_ESCROWS_OVER_SIZE = 39;

