# Vector Identity Registry — Implementation Plan

| | |
|---|---|
| Status | Approved design, 2026-11-02. Deployed on Vector mainnet, 2026-11-03. The Module-1 jury (`Module-1/jury/SPEC.md` in vector-agent-modules) decides the oracle resolutions. |
| Owner | David Cejtlin |
| Method specification | [`did-vector-method.md`](did-vector-method.md) (Part 1, public). This file is Part 2. |
| Private note | Operational details that must stay private are in `.omp/private/2026-11-02-identity-plan-private-notes.md`, outside git. |
| Replaces | Filip's October 27 drafts and the earlier minimal version of this file. |

Part 1 defines the identifier, the record format, the operations and resolution. This part tells builders what to build, release and test. Section numbers such as "Part 1 §5" refer to the method specification.

---

## 1. Scope

**Goal.** Every AAIF Identity and Trust primitive in Filip's list works on mainnet for any agent:

| Primitive | Implementation |
|---|---|
| Identifier | Identity registry and `did:vector` (Part 1) |
| Discovery metadata | On-chain profile; gateway renderings (§8.5); DNS-AID (§8.7, decision open) |
| Attestation | Attestation contract (§4) |
| Revocability | Statuses, holds, parties, tombstones, subagent cascade (§3); status lists (§8.6) |
| Accountability | An agent can accept work only with a current Accountable Party (§3, Part 1 §7.3) |

Delegation records and vaults (§5) are also in this phase. The gateway delivers renderings and Filip's M4 standards (§8). M5 is a later phase (§13.2).

**Process.**

- One combined release (§11) on mainnet.
- No testnet rehearsal and no external audit. Exploit tests and an independent review of the code are required (§12).

**Names.** Code and documents use "identity registry" and "legacy registry". They do not use "v1", "v2" or "generation" for registries.

## 2. Contracts

All new contracts live in the Aiken project `contracts/identity-marketplace/` with the library `vector_identity`. Each script address in this plan is an enterprise address: the script as payment credential and no stake credential. "At" an address always compares the whole address. Each compiled script is published as a reference script at the enterprise address whose key hash is 28 zero bytes (current practice, `supplier/src/cli/publish-reference-scripts.ts`).

| Contract | Purposes | Parameters | Deposit |
|---|---|---|---|
| `identity` | mint, spend | `legacy_hash`, `legacy_root`, `config_policy`, `config_holder` | ≥ 10 AP3X per live record |
| `config_holder` | spend (always fails) | — | ledger minimum |
| `config_seal` | mint (one use) | `seed`, `config_holder` | — |
| `attestation` | mint, spend | `identity_hash` | ≥ 5 AP3X per attestation |
| `delegation` | mint, spend | `identity_hash` | ledger minimum |
| `vault` | spend | `identity_hash`, `delegation_hash`, `escrow_hash` | the vault funds |
| `escrow` (new) | spend | `identity_hash` | the job funds |
| `advert` (new) | spend | — | as today |
| Module-1 `identity_party` (new) | mint (verdict tokens), spend (verdict outputs), withdraw | Module-1 configuration (with the verdict policy), challenge validator hash, claim validator hash | — |
| Modules 1, 3, 6 (new deployments) | as today | `identity_hash`, module parameters | as today |

`legacy_hash = be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01`. The script hash and the policy ID of the legacy registry are equal.

The project `contracts/marketplace/` stays: it holds the legacy escrow and advert blueprints, which the drain needs.

## 3. Identity contract

The datum types are in Part 1 §5.

### 3.1 Redeemers

```aiken
pub type IdentityMint {
  Register { seed: OutputReference }
  Adopt { proof: List<ByteArray> }       // Merkle proof against legacy_root (§3.4)
}

pub type Actor { ByController  ByParty { index: Int } }

pub type IdentitySpend {
  Update
  ChangeController
  Suspend { actor: Actor }
  Unsuspend { author: Signer }
  Revoke { actor: Actor }
  Retire
  Reclaim
  SetSuccessor
  BumpEpoch
  RecoverInit { guardians: List<Int> }
  RecoverCancel { guardians: List<Int> }
  RecoverFinalize
}
```

### 3.2 Definitions

- `IA`: the identity address. `LA`: the legacy address. `CA`: the `config_holder` address.
- `lo`, `hi`: the finite bounds of the validity range. **Every identity transaction has `hi − lo ≤ 3,600,000`.** Elapsed-time checks use `lo`. Deadlines that protect somebody else are counted from `hi`.
- `signed(pk)`: `blake2b_224(pk)` is in `extra_signatories`.
- `M1`: the script hash in the inline datum of the reference input at `CA` that holds the `config_policy` token `identity-config` (§3.8).
- `ok(s)`, for a signer `s`:
  - `KeyHash { hash }`: `hash` is in `extra_signatories`;
  - `ControllerSet`: `signed(D.controller)`, or `signed(D0.controller)` at creation;
  - `Script { hash }`: `hash = M1`, and the transaction has a withdrawal for `Script(M1)`.
- `covers(p)`: `p.not_before ≤ lo`, and `p.not_after` is empty or `≥ hi`.
- **Eligible guardian:** a party with role Guardian and the recover right that `covers`.
- **Guardian bound:** `guardian_threshold` ≤ the number of distinct signers of parties with role Guardian and the recover right whose `not_after` is empty or `≥ hi`.
- `accountable(D)`: some party of `D` with role Accountable `covers`.
- `D`: the datum of the spent record. `D'`: the datum of the new record output. `id`: the record's identifier.
- **Current author:** `ControllerSet`, the signer of a party in `D`, or any `Script` signer. Only Module-1 can set a `Script` hold (§3.3), so a Module-1 hold stays after Module-1 is removed, without a lookup of `M1`.
- **In force:** a hold `h` is in force when `h.until > lo`.
- **Record output for `id`:** an output at `IA` with a valid inline datum (§3.3), no reference script, exactly one token `(own hash, id)` and no other non-AP3X asset. It holds at least 10 AP3X while the status is Active or Suspended.
- **Value kept:** the output's AP3X is at least the input's AP3X, and no other asset changes.
- **Terminal:** status Revoked or Retired.

### 3.3 Valid datum

- `controller` is 32 bytes.
- `keys`: as Part 1 §5. The contract checks lengths, purposes, duplicates and the `pop` length (64 bytes for P-256, none for Ed25519). It does not check `pop` signatures; resolvers and gateways do.
- `parties`: at most 8; rights within the role's highest rights; signers as allowed for the role; a `Script` signer only with hash `M1`; `organisation` empty or 1–64 bytes; `not_after` empty or greater than `not_before`; no two parties with the same role and signer.
- `guardian_threshold ≥ 0`. The guardian bound is checked only where parties or the threshold change (§3.4, §3.6).
- `pending_recovery` is empty when `guardian_threshold = 0`. Else it is empty, or its `new_controller` is 32 bytes.
- `lineage` is `Root`, or `Subagent` with a 32-byte parent and depth 1–4.
- Profile limits as Part 1 §5. A subagent has an empty `endpoint`.
- `Suspended { holds }`: 1–10 holds with distinct `by`, and `since < until` for each.
- A terminal datum is a tombstone (§3.7).
- Every time is in `[0, 253,402,300,799,999]`. Every other integer is in `[0, 2^63)`.

### 3.4 Mint rules

**`Register { seed }`**

1. The transaction spends `seed`.
2. The mint under the own policy is exactly `{ id: +1 }`, where `id = blake2b_256(serialise(seed))` (Part 1 §3.1).
3. No token of `legacy_hash` is minted or burned.
4. No transaction input is at `IA`.
5. Exactly one output is at `IA`: a record output for `id` with datum `D0`.
6. `D0.status = Active`, `D0.pending_recovery = None`, `D0.subagent_epoch = 0`, `D0.created_at = hi`, `accountable(D0)` and the guardian bound.
7. `signed(D0.controller)`, and `signed(k.key)` for each Ed25519 key `k`.
8. `ok(p.signer)` for each party `p`.
9. If `D0.lineage = Subagent { parent, parent_epoch, depth }`:
   - the parent record `P` is a reference input (`find_record`);
   - `signed(P.controller)`;
   - `effective(P) = Active` over `[lo, hi]`, with `P`'s ancestors as reference inputs;
   - `parent_epoch = P.subagent_epoch`;
   - `depth` is one more than `P`'s depth (0 for `Root`).

**`Adopt { proof }`**

1. The mint under the own policy is exactly `{ id: +1 }` for one asset name `id`.
2. The mint under `legacy_hash` is exactly `{ id: −1 }`.
3. One transaction input is at `LA` and holds exactly one token of `legacy_hash`: `(legacy_hash, id)`. Its datum (inline, or by hash from the transaction) decodes as `LegacyDatum`. Its `owner` is `VerificationKey(h)`, and `h` is in `extra_signatories`.
4. `proof` shows that `id` is in `legacy_root`: start with `x = blake2b_256(id)`; for each element `s` of `proof`, `x = blake2b_256(min(x, s) ++ max(x, s))`; the result equals `legacy_root`.
5. Rules 4–8 of `Register` apply, with `D0.lineage = Root`.

The legacy contract also runs in this transaction, so its Deregister and Burn rules must pass.

**Allowlist tree.** The leaves are `blake2b_256(id)` for each allowlisted identifier, sorted in ascending byte order. Each level pairs the nodes from the left. A node is `blake2b_256(min(l, r) ++ max(l, r))`. A last node without a pair moves up unchanged. A proof lists the paired nodes from the leaf upward. The deployment publishes the list, the root and the script that builds them (§9.1).

### 3.5 Spend rules

For every spend:

1. The spent input is at `IA` and holds exactly one token `(own hash, id)`. `D` is its inline datum. No other input has payment credential `Script(own hash)`.
2. No token of the own policy is minted or burned.
3. Exactly one output is at `IA`: a record output for `id` with datum `D'`.
4. When `D` is terminal, only `Reclaim` and `SetSuccessor` are allowed.
5. Each field that the action does not change stays the same.

| Action | Allowed when | Authorised by | Changes in `D'` | Value |
|---|---|---|---|---|
| `Update` | not terminal | `signed(D.controller)` | §3.6 | output ≥ 10 AP3X |
| `ChangeController` | not terminal | `signed(D.controller)` and `signed(D'.controller)` | `controller`; `subagent_epoch` + 1; `pending_recovery = None` | output ≥ 10 AP3X |
| `Suspend { actor }` | Active or Suspended | `ByController`: `signed(D.controller)`; author `A = ControllerSet`. `ByParty { index }`: that party has the suspend right, `covers` and `ok(signer)`; `A` = its signer | `status = Suspended { holds }`: the holds of `D` that are in force and whose author is a current author other than `A`, in their order, then the new hold `{ by: A, reason, since: lo, until }` with `hi < until ≤ lo + 30 days` | kept |
| `Unsuspend { author }` | `D` has a hold by `author` | `ok(author)` | the holds of `D` that are in force and whose author is a current author other than `author`, in their order; `Active` when none remains | kept |
| `Revoke { actor }` | not terminal | `ByController`: `signed(D.controller)`, `by = ControllerSet`. `ByParty { index }`: revoke right, `covers`, `ok(signer)`, `by = signer`, no successor | tombstone with `Revoked { by, reason, at: lo, invalid_from, successor }` (§3.7) | kept |
| `Retire` | not terminal | `signed(D.controller)` | tombstone with `Retired { at: lo, successor }` | output ≥ ledger minimum |
| `Reclaim` | terminal | `signed(D.controller)` | none | output ≥ ledger minimum |
| `SetSuccessor` | terminal, no successor | `signed(D.controller)`, successor rules (§3.7) | the successor only | kept |
| `BumpEpoch` | not terminal | `signed(D.controller)` | `subagent_epoch` + 1 | output ≥ 10 AP3X |
| `RecoverInit { guardians }` | not terminal, `pending_recovery = None`, `guardian_threshold ≥ 1` | `guardians` holds distinct indices of eligible guardians with distinct signers, at least `guardian_threshold` of them, each `ok`; `signed(new_controller)` | `pending_recovery = Some { new_controller, effective_after: hi + 7 days }` | kept |
| `RecoverCancel { guardians }` | `pending_recovery` is set | as for `RecoverInit`, without the new key | `pending_recovery = None` | kept |
| `RecoverFinalize` | `pending_recovery = Some { new_controller, effective_after }`, `effective_after ≤ lo` | anybody | `controller = new_controller`; `pending_recovery = None`; `subagent_epoch` + 1 | kept |

Notes:

- "Output ≥ 10 AP3X": the controller can add or take AP3X down to that floor. "Output ≥ ledger minimum": the controller decides where the rest goes.
- `reason` in a new hold or a revocation must be allowed for the action (Appendix A). Reason 64 is allowed only when the author is `Script { hash: M1 }`.
- Each author has its own hold. Nobody can remove or shorten the hold of another current author. A hold of a removed key party is dropped at the next `Suspend` or `Unsuspend`. A Module-1 hold stays until its `until`, also after Module-1 is removed.
- A controller change does not lift holds. A `ControllerSet` hold belongs to whoever is the controller.
- Module-1 never approves `Unsuspend`, and a later verdict never shortens its hold (§3.8). A Module-1 hold thus ends only at its `until`.
- Only `Register`, `Adopt` and an `Update` that changes `parties` or `guardian_threshold` check the guardian bound. A guardian whose period ends does not block any action.

### 3.6 Update rules

- **Keys.** A kept key (same key bytes) keeps its type, purposes and proof. Any key can leave the list. Each new Ed25519 key signs (`signed(key)`). Each new P-256 key carries `pop`.
- **Matching.** Each party of `D'` is matched to the party of `D` with the same role and signer, if one exists.
- **Parties in `D'`.** Each party `p` of `D'`:
  - is equal to its match; or
  - is equal to its match, except that `removal_after` goes from empty to `Some(t)` with `t ≥ hi + 7 days`; or
  - signs: `ok(p.signer)`. This covers appointments and every other change.
- **Removed parties.** Each party `q` of `D` without a match in `D'` signs (`ok(q.signer)`), or has `removal_after = Some(t)` with `t ≤ lo`.
- **Order.** Matched parties keep their order. New parties come last.
- **Guardian threshold.** An Update that changes `parties` or `guardian_threshold` checks the guardian bound. When a guardian leaves and the old threshold breaks the bound, the same transaction lowers it.
- **Recovery.** An Update that sets the threshold to 0 also sets `pending_recovery = None`. No other Update changes `pending_recovery`.
- **Profile.** `name`, `description`, `framework`, `endpoint` and `capabilities` can change within the limits.
- **Accountability.** An Update can remove the last Accountable Party. The agent then counts as suspended (unaccountable).
- `controller`, `lineage`, `subagent_epoch`, `created_at` and `status` do not change in an Update.

### 3.7 Tombstones, reasons and successors

- **Tombstone.** `keys = []`, `parties = []`, `guardian_threshold = 0`, `pending_recovery = None`, and empty `description`, `framework`, `endpoint` and `capabilities`. `controller`, `name`, `lineage`, `subagent_epoch` and `created_at` stay. Holds end.
- **Reason codes.** Each action allows only its codes from Appendix A. Reason 64 (`disputeVerdict`) is allowed only when the author is `Script { hash: M1 }`.
- **Invalid-from time.** `invalid_from` is empty or in `[D.created_at − 3,600,000, lo]`. `created_at` is the upper bound of the creating range, so this lower bound reaches the block that created the record. Reason 1 (`keyCompromise`) requires it.
- **Successor.** Only the controller names a successor: in `Revoke { ByController }`, in `Retire`, or later with `SetSuccessor` (also after a party revocation; decision of 2026-11-02). For `successor = Some(s)`:
  - `s ≠ id`;
  - a reference input holds the live record of `s` (`find_record`), with lineage `Root`;
  - `signed(S.controller)`.

### 3.8 Module-1 as a party

- **Configuration record.**
  - `config_holder` is a script that rejects every spend.
  - `config_seal` is a minting policy with the parameters `seed` and `config_holder`. It mints only in a transaction that spends `seed`. The mint is exactly one token named `identity-config` (UTF-8, hex `6964656e746974792d636f6e666967`). The token goes to the `config_holder` address with an inline datum: the 28-byte Module-1 hash as a Plutus Data byte string. The policy never burns.
  - Nobody can change or move the record.
- **Deployment order.**
  1. `config_holder`.
  2. `config_seal`, bound to the holder and a fixed seed.
  3. `identity`, bound to both.
  4. Module-1 with the new validator `identity_party`, built against `identity`.
  5. The seal: mint the configuration token with the hash of `identity_party`.
  6. Check that the configuration datum equals the blueprint hash of `identity_party` before anybody appoints Module-1.

  Until the seal, no `Script` party can be appointed.
- **`identity_party`.** `M1` is the hash of this Module-1 validator. Its parameters are the Module-1 configuration, the hash of the new Module-1 challenge validator and the hash of the new Module-1 claim validator, in this order. The verdict policy is part of the Module-1 configuration. Its stake credential is registered. It has three handlers:
  - **Mint (verdict tokens):**
    - A verdict is `{ agent, action, duration, challenge, deposit_to, expires_at }`: the agent's identifier, suspend or revoke, the duration of a suspension (at most 30 days), the reference of the challenge, the address that gets the verdict output's AP3X back when the verdict lapses, and the end of the application period. The token name is `blake2b_256(serialise(verdict))`.
    - The policy mints only in an oracle resolution (`OracleResolve`) of one challenge `c` of the new Module-1 challenge validator. It mints exactly one token. The verdict equals the result of the verdict policy for the outcome of `c`, with `challenge` = the reference of `c`. The agent comes from the claim input that holds the claim token of `c`, at the claim validator of the parameter. Jury and timeout resolutions give no verdict: the auditor chooses the list of eligible jurors, so a jury outcome cannot punish an identity (decision of 2026-11-02).
    - The resolution range is finite and at most one hour. `expires_at` is its upper bound plus 30 days. The resolution transaction names `deposit_to`: the address of the wallet that funds the verdict output.
    - The challenge validator requires that mint in each oracle resolution that the verdict policy turns into a verdict. It reads `M1` from the configuration record at `CA`, so it does not need the hash of `identity_party` at compile time. Only `identity_party` takes the other scripts' hashes as parameters. Nobody can resolve such a challenge without the verdict.
    - The token goes to the `identity_party` address with the verdict as its inline datum.
    - The policy burns a token only in a verdict application or in a lapse reclaim.
    - **Verdict policy:** fixed at deployment. It states which challenge outcome gives which action and duration (§13.4).
  - **Spend:** a verdict output can be spent only in the transaction that burns its token. That is either a verdict application with `hi ≤ expires_at`, or, when `expires_at < lo`, a lapse reclaim by anybody. A lapse reclaim pays all the AP3X of the output to `deposit_to` without datum, has no `identity_party` withdrawal and spends no other script input.
  - **Withdraw:** it approves only two kinds of transaction:
    - **Consent:** an identity `Register`, `Adopt` or `Update` in which Module-1 becomes a new party with role Accountable or Responsible, rights equal to the role's highest rights, `not_before ≤ lo`, no `not_after` and no `removal_after`. Every Module-1 party of `D` is in `D'` and unchanged. An `Update` keeps the status.
    - **Verdict application:** the transaction burns one verdict token with `hi ≤ expires_at`, and the verdict data matches the token name. Its single identity input is the record of the verdict's agent. For the action suspend, the redeemer is `Suspend { ByParty { index of the Module-1 party } }` with the new hold `{ reason: 64, until }`, where `until` is the later of `lo + duration` and the `until` of the Module-1 hold in force. For the action revoke, the redeemer is `Revoke { ByParty { index } }` with reason 64, no `invalid_from` and no successor. The withdrawal is the whole reward balance of `Script(M1)`, because the ledger accepts only that amount.
- **Limits.** Module-1 approves nothing else. It never lifts its holds and never consents to its own early removal. The controller can remove it after 7 days' notice. Verdicts after the removal cannot apply, because Module-1 is no longer a party. Holds that Module-1 set stay until their `until`.
- **Roles.** Module-1 can be an Accountable Party (suspend, revoke) or a Responsible Party (suspend).

### 3.9 Other purposes

The `identity`, `config_holder`, `config_seal`, `attestation`, `delegation` and `vault` scripts fail every purpose that their row in §2 does not list: withdraw, publish, vote and propose.

### 3.10 Library `vector_identity`

Every contract that needs identity uses only these functions:

```aiken
/// The record of `id`: a reference input at IA (exact address) that holds exactly one
/// token (identity_hash, id). Live records and tombstones count.
pub fn find_record(refs: List<Input>, identity_hash: ByteArray, id: ByteArray) -> Option<IdentityDatum>

/// Effective status over [lo, hi]: Revoked or Retired for a tombstone, or when an ancestor ended
/// or ended its subagents; Suspended when a hold has until > lo, when an ancestor is suspended,
/// or when no Accountable Party covers [lo, hi]; else Active. Fails when an ancestor is missing.
pub fn effective(record: IdentityDatum, refs: List<Input>, identity_hash: ByteArray, lo: Int, hi: Int) -> Effective

/// True when the record lists a key with `blake2b_224(key) == key_hash` and the purpose.
/// The transaction and delegation purposes count only for Ed25519 keys.
pub fn active_key(record: IdentityDatum, key_hash: ByteArray, purpose: Int) -> Bool

pub fn independent(record: IdentityDatum) -> Bool                 // lineage Root
pub fn has_capability(record: IdentityDatum, capability: ByteArray) -> Bool
pub fn controller_signed(record: IdentityDatum, tx: Transaction) -> Bool
```

The module contracts are in another repository, `vector-agent-modules`, and Aiken cannot depend on a local path. They vendor this library from a pinned commit, with a checksum test.

## 4. Attestation contract

```aiken
pub type AttestationDatum {
  subject: ByteArray,                // identifier of the agent
  issuer: ByteArray,                 // Ed25519 public key, 32 bytes
  issuer_id: Option<ByteArray>,      // set when the issuer is a registered agent
  att_type: Int,                     // 0 identity, 1 provenance, 2 software, 3 environment,
                                     // 4 principal binding, 5 approval, 15 other; others reserved
  format: Option<Int>,               // CoAP Content-Format of the document; None = unspecified
  profile: Option<ByteArray>,        // 32 bytes: hash of the profile or type URI
  digest: ByteArray,                 // 32 bytes: SHA-256 of the document
  locator: Option<ByteArray>,        // retrieval hint, up to 256 bytes
  envelope_sig: Option<ByteArray>,   // 64 bytes: COSE_Sign1 signature (§4.2)
  issued_at: Int,
  valid_from: Option<Int>,
  valid_until: Option<Int>,
  solicited: Bool,                   // the subject's controller co-signed
  status: AttStatus,
  contested: Option<Anchor>,         // the subject's reply
  links: List<Link>,                 // 0..4
}

pub type AttStatus { AttActive  AttRevoked { at: Int, reason: Int } }
pub type Anchor { uri: ByteArray, sha256: ByteArray }   // 1..256 bytes; 32 bytes
pub type Link { rel: Int, target: ByteArray }            // 0 supersedes, 1 depends_on, 2 corroborates, 3 disputes;
                                                         // target: token name of another attestation (32 bytes)

pub type AttestationMint { Attest { seed: OutputReference }  Burn }
pub type AttestationSpend { RevokeAtt { reason: Int }  Contest  Withdraw }
```

### 4.1 Rules

`AA` is the attestation address. An attestation is authentic only when it is an output at `AA` that holds exactly one token of the attestation policy. Every transaction has `hi − lo ≤ 3,600,000`.

**Issuer authority.** For an attestation with `issuer_id = None`: `signed(issuer)`. With `issuer_id = Some(i)`: the record `I` of `i` is a reference input, and either `signed(I.controller)`, or `signed(issuer)` and `active_key(I, blake2b_224(issuer), assertion)`. A removed issuer key thus has no authority.

- **`Attest { seed }`**
  - The transaction spends `seed`. It mints exactly `[(blake2b_256(serialise(seed)), +1)]`. It has no input at `AA`.
  - Exactly one output is at `AA`. It holds the minted token and at least 5 AP3X, no other asset and no reference script. It has an inline datum with `issued_at = hi`, `status = AttActive` and `contested = None`.
  - `signed(issuer)`.
  - The subject's record is a reference input. A live record or a tombstone is accepted.
  - If `issuer_id = Some(i)`: the record of `i` is a reference input, its effective status is Active, and `active_key(i, blake2b_224(issuer), assertion)`.
  - If `solicited`, the subject's controller also signs.
  - `att_type` is 0–5 or 15. `valid_until` is at or after `issued_at` and at most 366 days after it. Types 2 and 3 require it. `valid_from`, if set, is at or before `valid_until`. Lengths are as in the datum comments.
- **Common rules for `RevokeAtt` and `Contest`:**
  - exactly one input at `AA`, and it holds exactly one attestation token;
  - no mint or burn of the attestation policy;
  - exactly one output at `AA` with the same token, AP3X at least the input's AP3X, no other asset, no reference script and an inline datum;
  - only the fields that the action names change.
- **`RevokeAtt { reason }`:** issuer authority. The status goes from `AttActive` to `AttRevoked { at: lo, reason }`.
- **`Contest`:** the subject's controller signs, with the subject's record as a reference input. Only `contested` changes. Its `uri` is 1–256 bytes, and its `sha256` is 32 bytes.
- **`Withdraw` with `Burn`:**
  - issuer authority;
  - the attestation is revoked with `at + 90 days ≤ lo`, or `valid_until + 90 days ≤ lo`;
  - the burn is exactly `[(id, −1)]`, with exactly one attestation input. The deposit is released.

There is no in-place change. To correct an attestation, the issuer creates a new one with a `supersedes` link and revokes the old one.

For types 4 (principal binding) and 5 (approval), `digest` MUST be a salted commitment `SHA-256(salt ++ document)`. The salt stays off-chain with the document, so the owner can delete both.

### 4.2 Envelope (COSE_Sign1, Ed25519)

`envelope_sig` is an Ed25519 signature over `Sig_structure = ["Signature1", protected, h'', digest]`. `protected` uses RFC 8949 core deterministic encoding:

```text
{ 1: -19,                                ; alg Ed25519
  4: h'<kid>',                           ; UTF-8 key URL (below)
  15: { 1: "<issuer DID>", 2: "did:vector:<subject>", 6: floor(issued_at / 1000) },
  258: -16,                              ; payload hash algorithm SHA-256
  259: <format> }                        ; omitted when format is None
```

The issuer DID is `did:vector:<issuer_id>`, or the `did:key` of `issuer` when `issuer_id` is empty. The kid is `<issuer DID>#<key hash of issuer>`, or the `did:key` URL. Verifiers check the envelope off-chain.

### 4.3 Validity for relying parties

An attestation is valid only when all of these conditions are true:

- it is authentic (§4.1) and `AttActive`;
- the current time is inside its `valid_from` and `valid_until` range;
- its envelope signature verifies, if it has one;
- the issuer identity and its ancestors have no "invalid from" time at or before `issued_at` (Part 1 §7.3);
- for a registered issuer, the contract checked at creation that the issuer key was listed with the assertion purpose (§4.1). A later key removal does not undo an earlier signature, so relying parties do not check the key again.

Relying parties compute trust labels themselves from the issuer, `issuer_id`, `solicited`, links and their own trust list.

## 5. Delegation and vaults

### 5.1 Action and resource patterns

```abnf
action           = internal / external
resource         = script / external
action-pattern   = "*" / internal / prefix / external
resource-pattern = "*" / script / external
internal         = seg *( "." seg )
prefix           = seg *( "." seg ) ".*"
seg              = 1*( %x61-7A / DIGIT / "-" )
external         = ( %s"oauth:" / %s"mcp:" / %s"https://" ) 1*VCHAR
script           = %s"script:" 56lowhex                     ; lowhex as in Part 1 §3
```

- A pattern `p` covers a value `a` when `p = "*"`, or `p = a`, or `p = x ".*"` and `a` starts with `x "."`. External and script patterns match only exactly.
- A child list is narrower than a parent list when a parent pattern covers each child pattern. A child `x.*` is covered only by `*` or by a parent `y.*` where `x = y` or `x` starts with `y "."`. A plain string-prefix test is wrong: `oc.*` does not cover `ocr.*`.
- Capability IDs on records do not change. A single-part ID such as `document-extraction` can be matched exactly or by `*`.
- The action for vault payments is `marketplace.hire.v1`. Its resource is `script:<escrow_hash>`.

### 5.2 Delegation records

```aiken
pub type Delegator {
  PrincipalKey { hash: ByteArray, organisation: Option<ByteArray> }   // organisation: DID or domain of an organisation, 1..64 bytes
  Agent { id: ByteArray }                                             // a registered agent
}

pub type ValueLimit { per_tx: Int, total: Int, period_ms: Int }      // 1 ≤ period_ms; per_tx ≤ total ≤ 10,000 AP3X

pub type DelegationDatum {
  delegator: Delegator,
  parent: Option<ByteArray>,       // token name of the parent delegation (delegation policy)
  delegate: ByteArray,             // identifier of the delegate agent
  delegate_key: ByteArray,         // key hash of the delegate's Ed25519 delegation key
  actions: List<ByteArray>,        // 1..16 action patterns
  resources: List<ByteArray>,      // 0..8 resource patterns
  not_before: Int,
  not_after: Int,
  depth: Int,                      // 1..4
  remaining: Int,                  // further hops allowed below this one; depth + remaining ≤ 4
  purpose: Option<ByteArray>,      // 32 bytes: hash of a purpose text or mandate
  value: Option<ValueLimit>,
}

pub type DelegationMint { Delegate { seed: OutputReference }  Undelegate }
```

`DA` is the delegation address. A delegation is authentic only when it is an output at `DA` that holds exactly one token of the delegation policy. Every transaction has `hi − lo ≤ 3,600,000`. `organisation` follows the rules of Part 1 §5 and §10: an organisation, never a person.

- **`Delegate { seed }`**
  - **Output:** the transaction spends `seed` and mints exactly `[(blake2b_256(serialise(seed)), +1)]`. Exactly one output is at `DA`, with the token, an inline datum, no other asset and no reference script.
  - **Delegator without a parent:** a `PrincipalKey` signs. For an `Agent`, the agent's effective status is Active, and either `controller_signed` or a listed key with the delegation purpose signs. `depth = 1`.
  - **Delegator with a parent:** the authentic parent delegation is a reference input. Its `delegate` is this delegator's `Agent { id }`, its `remaining ≥ 1`, and its `delegate_key` signs. The record of that agent is a reference input, its effective status is Active, and `active_key(record, parent.delegate_key, delegation)` holds. The parent covers every action and resource. The period is inside the parent's period. `depth` is the parent's depth plus one. `remaining ≤` the parent's `remaining − 1`. If the parent has a value limit, this delegation has one with `per_tx` and `total` at most the parent's values and `period_ms` at least the parent's value.
  - **Delegate:** the delegate's effective status is Active, `active_key(delegate, delegate_key, delegation)`, and `delegate_key` signs.
  - **Other checks:** the patterns follow §5.1; `not_before < not_after`; the value limit is valid; lengths and counts are as in the datum comments.
- **`Undelegate`:** exactly one input at `DA`, and it holds the delegation token `id`. The burn is exactly `[(id, −1)]`. The delegator of that delegation, or of an ancestor (ancestors as reference inputs), signs: a `PrincipalKey`, or, for an agent, its controller or a listed key with the delegation purpose (the agent's record as a reference input). Delegations below it become unusable at once, because their parent no longer exists.
- A delegation output never changes. Its spend handler accepts only `Undelegate`.
- **Use by a dependent contract.** These checks must all pass:
  - the delegation and every ancestor are authentic reference inputs;
  - each delegator agent and the delegate have effective status Active;
  - `active_key(delegate, delegate_key, delegation)` still holds, and `delegate_key` signed. The same `active_key` check holds for the delegate key of every ancestor link, so the removal of a key ends every sub-delegation that this key signed (decision of 2026-11-02, stricter than the first text);
  - the action and the resource are covered;
  - `[lo, hi]` is inside the period.
- **Fresh keys.** The gateway and the SDKs refuse a `delegate_key` that another live delegation uses. Thus one agent can hold at most 8 live delegations, one for each listed key.

### 5.3 Vaults

```aiken
pub type VaultDatum {
  Live { owner: Delegator, delegation: ByteArray, spent: Int, period_start: Int }
  Returned { owner: Delegator }      // escrow refunds; only Close spends them
}
pub type VaultSpend { Pay  Close }
```

`VA` is the vault address.

- **`Pay`**
  - **Scope:** the input is `Live`. `hi − lo ≤ 3,600,000`. The vault input is the only script input. No mint, withdrawal, certificate, vote or proposal.
  - **Delegation:** the delegation `(delegation_hash, datum.delegation)` and its ancestors pass the use checks (§5.2) for the action `marketplace.hire.v1` and the resource `script:<escrow_hash>`. Its delegator equals `owner`. It has a value limit.
  - **Amount:** the input AP3X minus the AP3X of the continuing output. The escrow outputs together hold at least the amount.
  - **Escrow outputs:** each is at the escrow address, with AP3X only and no reference script. Its inline datum is a new escrow datum (§6.1) with:
    - state Open, `submitted_at = None` and `result_receipt_hash = None`;
    - `buyer_pkh = delegate_key`;
    - `refund = Some { address: VA, datum: Some(Returned { owner }) }`;
    - payment + buyer bond + supplier bond ≤ 10,000 AP3X, and equal to the output's AP3X (a builder puts any min-UTxO top-up into the buyer bond);
    - `deliver_by ≤ hi + 7 days`.
  - **Limits:** the amount is at most `per_tx`. When `lo ≥ period_start + period_ms`, a new period starts with `period_start = hi`, and `spent` restarts with the amount. Otherwise, `spent` grows by the amount. In both cases, the new `spent` is at most `total`.
  - **Continuing output:** exactly one output is at `VA`, with AP3X only, no reference script and the datum `Live { owner, delegation, spent, period_start }` with the new values.
- **`Close`:** the owner signs: the `PrincipalKey`, or the agent's controller with the agent's record as a reference input. It works for `Live` and `Returned` outputs, after `Undelegate` too. Several vault inputs can close in one transaction. The funds can go anywhere.
- Escrow refunds arrive at `VA` as `Returned` outputs. Only the owner can spend them, so a refund never raises what the delegate can spend.
- The limits apply to each `Live` output. An owner who opens several vaults for one delegation adds their limits.

### 5.4 Presentation

The gateway's token service (§8.6) issues an RFC 8693 token for a delegation only after it checks the whole chain. The claims follow RFC 8693 §4.1 (decision of 2026-11-02; the first text had `sub` and `act` the other way round):

- `sub` is the root delegator, the principal: `did:vector:<id>` for an agent, or `https://id.vector.apexfusion.org/principals/key/<key hash>` for a `PrincipalKey`;
- `act` is the chain of actors: the current delegate (`did:vector:<id>`) is the outermost `act.sub`, and each earlier delegate agent is a nested `act`;
- the actions and resources are in RFC 9396 `authorization_details`;
- the lifetime is at most 5 minutes, and `cnf.jkt` binds the token to the delegate key.

A token without a delegation has `sub = did:vector:<id>` of the agent and no `act`.

## 6. Marketplace

### 6.1 New escrow

The datum keeps the 14 current fields (`contracts/marketplace/lib/marketplace/types.ak`) and adds two:

```aiken
//   14 agent_id   ByteArray        // 32 bytes, from the advert
//   15 refund     Option<Refund>   // where buyer payouts go; None = the buyer key
pub type Refund { address: Address, datum: Option<Data> }
```

Rules for every redeemer:

1. The spent escrow input is the only transaction input whose payment credential is a script.
2. The transaction has no mint, withdrawal, certificate, vote or proposal.
3. `hi − lo ≤ 3,600,000`.
4. **Supplier payouts** count outputs whose payment credential is `VerificationKey(supplier_pkh)`.
5. **Buyer payouts:**
   - when `refund` is set, they count outputs at exactly `refund.address`, with no datum when `refund.datum` is `None`, or with the inline datum `d` when it is `Some(d)`;
   - when `refund` is not set, they count outputs whose payment credential is `VerificationKey(buyer_pkh)`. For `RefundRevoked`, they count only outputs at the enterprise address of `buyer_pkh`.
6. **Full refund:** the buyer payouts are at least the AP3X of the escrow input, and together they hold every other asset of the escrow input, at least its quantity.

Rules 1 and 2 mean that no other script runs in an escrow transaction.

**Claim** also requires, with `R = find_record(reference_inputs, identity_hash, agent_id)`:

- `independent(R)`, and `effective(R) = Active` over `[lo, hi]`;
- `active_key(R, supplier_pkh, transaction)` and `has_capability(R, capability_id)`;
- payment + buyer bond + supplier bond ≤ 10,000 AP3X, and the escrow input holds at most 10,005 AP3X.

**Submit** also requires `R` to pass the same checks except the capability and value checks. `submitted_at` stays the validity upper bound.

**Continuing output.** Claim and Submit write exactly one continuing output at the escrow address, with the same value and an inline datum.

**Reclaim** keeps its current timing and states. When `refund` is not set, the buyer signs, and the buyer payouts are at least payment + buyer bond + supplier bond (as today). When `refund` is set, anybody can submit it, and the payouts are a full refund.

**RefundRevoked** is a new redeemer. Anybody can submit it, before or after `deliver_by`:

- when the state is Open or Claimed and `R` is Revoked or Retired; or
- when the state is Submitted and `R` is Revoked with `invalid_from ≤ submitted_at`.

Its payouts are a full refund.

The buyer funds all three amounts when it posts the escrow (`packages/shared/src/tx/escrow/postEscrow.ts`), so every refund returns all three. Filip's draft split the supplier bond on the assumption that suppliers fund it. They do not.

Accept and Release keep their current rules, with the payout rules above. Accept, Reclaim and Release do not read the registry. Claim and Submit keep `agent_id` and `refund` unchanged. If the owner removes the supplier key or the agent stops being Active, Claim and Submit stop, and the buyer gets the funds back by `RefundRevoked` or Reclaim.

### 6.2 New advert

The advert datum keeps its 13 fields and adds `agent_id` (32 bytes) as field 13. The contract rules stay as today:

- the supplier key signs UpdateAdvert and RetireAdvert;
- UpdateAdvert keeps `agent_id`;
- the contract does not check identity.

**Listing rule** (indexer, builders). An advert is listed only when all of these checks pass:

- the transaction that created it lists `supplier_pkh` as a required signer;
- the record of `agent_id` is live and independent, with effective status Active;
- `active_key(record, supplier_pkh, transaction)`;
- `has_capability(record, capability_id)`.

Escrow builders copy `agent_id` from a listed advert.

### 6.3 Receipts

- A receipt for a new escrow has 9 fields: the 8 current fields and `agent_did = "did:vector:<agent_id>"`.
- A receipt for a legacy escrow keeps the 8 current fields.
- Signing and hashing do not change.
- A verifier takes the supplier public key as today, from the caller or from `GET {endpoint}/capability`. It checks:
  - `blake2b_224(key) = supplier_pkh`;
  - `agent_did` against the escrow's `agent_id`;
  - `escrow_ref` and `supplier_pkh` against the escrow.

### 6.4 Indexer

- The indexer follows the legacy and new advert addresses, the legacy and new escrow addresses, and the identity address.
- The release that adds identity support syncs again from a block before the identity deployment, or it loads the current outputs at `IA` when it starts.
- For identity records, the indexer uses the view without options (Part 1 §7.2–7.3).
- The indexer decodes escrow redeemers. It records `RefundRevoked` as its own event, and a Reclaim by a third party as a Reclaim.
- The supplier view gets `agent_id`: 64 lowercase hexadecimal characters, or `null`.
- Before the switch (§9.6), legacy adverts stay listed with `agent_id: null`. After it, only listed new adverts appear.
- `vector_discover_agents` reads the indexer instead of scanning the registry address.

### 6.5 Builders and copies

| Item | Copies that change |
|---|---|
| Advert and escrow codecs | `packages/shared/src/cbor` (origin); the `vector-agent-template` copy; `mcp-server` `marketplace-datum.ts`; `vector-service-agents` `packages/vector-read/src/datum.ts` (imported by `buyer-core`) |
| Escrow and advert transaction builders | `packages/shared/src/tx` (origin); the template copy; `mcp-server` `marketplace-build.ts`; `buyer-core` `src/vendored/mcp/marketplace-build.ts` and `src/fleet-build.ts`; the template's `try-it/src/buy-once.ts` |
| Receipt code | `packages/shared/src/receipt`; the template copy; `mcp-server` `marketplace-verify.ts` and its `buyer-core` copy; `buyer-core` `src/fleet-verify.ts`; the template's `try-it/src/verify-receipt.ts`; `packages/shared/src/paper2agent/index.ts` and `buyer/src/sdk/paper2agent.ts` (both accept exactly 8 fields today) |
| Script pins | Every file that pins the legacy escrow hash `810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912`, its address `addr1wxqsaczee4upnn50n9dwgw9mkph77yqp0d9p0y5ul9c6jysrv9dl5`, the advert hash `9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da`, or their reference scripts (`ESCROW_REF_UTXO`, `ADVERT_REF_UTXO`) |
| Services | Indexer, gateway, buyer, supplier fleet, Paper2Agent publisher and runtime, template supplier, `chandra-supplier` (vendor again), and the `vector-service-agents` deployments (move the template pin `c4c378a`) |

- **Claim and Submit builders** add the agent's record as a reference input. They refuse when a check of §6.1 fails.
- **Validity ranges.** Every escrow and vault builder sets `hi − lo ≤ 3,600,000`. The current Claim builder sets `hi = deliver_by` (`packages/shared/src/tx/internal/liveCbor.ts`), which breaks this rule for adverts with 60-minute processing.
- **Refund address.** Post builders set `refund` to the buyer's own address with no datum. Vault payments set the vault refund (§5.3).
- **Value cap (F-29).** Post builders, the indexer and the gateway refuse to build, list or route an escrow whose payment + bonds exceed 10,000 AP3X. An escrow above the cap cannot be claimed; the buyer gets it back by Reclaim after `deliver_by`.
- **All escrow builders** put one escrow in each transaction, with no other script, mint, withdrawal or certificate.
- **Drain:** until it ends, every codec reads both layouts, and every spender holds the reference scripts of both escrows.

## 7. Modules 1, 3 and 6

All three modules get new deployments in this phase. They use `vector_identity` and the identity registry.

| Module | Actions that open or extend a position | Exits |
|---|---|---|
| Module-1 | Claim submission, challenge opening and juror registration. The agent's effective status is Active, and the declared credential is the record's controller or a listed key with the transaction purpose. Each resolution takes the claim from the input that holds the challenge's claim token. Verdicts come only from oracle resolutions (§3.8). The oracle signs the result of the Module-1 jury: AI jurors commit and reveal their votes in a separate jury contract, and the Foundation relay signs `OracleResolve` with the result (`Module-1/jury/SPEC.md` in vector-agent-modules). | No identity check |
| Module-3 | Stake creation, stake increase, capability update, endorsement, challenge and history bonus. The acting agent has effective status Active, `has_capability` holds for each staked capability, and `controller_signed(record)` holds. A challenge does not read the target's record: the target's stake binds the target and the capability, so the target cannot avoid a challenge by a change of its own record. A challenge locks the target's stake until the challenge closes. Each stake has a `stake_id` (the reference of its creation seed), and an endorsement names the stake that it backs. An escalation to a Module-1 audit uses a claim by the challenge target on the challenged capability. The challenger's age comes from `created_at`. | `controller_signed(record)` only. No status gate, so tombstones can exit. An exit pays the stored credential while the record still trusts it (the controller or a listed key with the transaction purpose); otherwise it pays the controller key. Permissionless payouts (challenge expiry, challenge outcome, endorsement slash, decay) use the same payee rule, with the payee's record as a reference input. An endorsement withdraws only when the stake that it backs has no challenge lock. A stake that decays below the minimum continues with 0, and the owner's payee gets the rest. |
| Module-6 | Proposals, critiques and endorsements. The agent's effective status is Active, and the declared credential is the controller or a listed transaction key. The checks read the new output. `submitted_at` and `created_at` equal `lo`. The self rule also compares controller keys, declared credentials and direct parents, and the proposer's record is a reference input. Each agent has at most one activity record: the records form a sorted list, and a first submission inserts the agent's record. A proposal expires as stale only when the Module-6 parameter that it names has another value now. | No identity check. Payouts go to the stored credentials. |

- **Time.** Every module action that reads an identity record has `hi − lo ≤ 3,600,000`. Ages use `lo`.
- **Agreed changes.** Apply the module changes agreed with the module owners.
- **Independent review.** Review all three modules. Fix every critical and high finding before deployment.
- **Module-1 as a party.** Add the `identity_party` validator of §3.8.
- **Deployment order:** the steps of §3.8, then Module-3, which embeds the Module-1 hashes, then Module-6.
- **Operator keys.** New Foundation keys deploy the modules and act as their operators. Old module keys are not reused.
- **Ownership.** We build the changes. The module owners review them.
- **Old positions.** Positions in the old module deployments stay there, under the old rules, until their owners exit.
- **Clients.** The Module-3 Python SDK, the Module-3 indexer and dashboard, the MCP Module-6 tools, the Python SDK's Module-6 client, Agent History and the Module-6 dashboard move to the new deployments. The defaults of the MCP Module-6 tools name the new mainnet deployment.

## 8. Gateway

### 8.1 Hosting

- **Host.** `id.vector.apexfusion.org` on the vector-marketplace machine, `91.98.147.172`. The same name is the SPIFFE trust domain.
- **DNS.** A DNS-only A record in the zone `apexfusion.org`, made with the Cloudflare CLI (profile `apexfusion`). Run it with `--dry-run` first.

  ```json
  {"type":"A","name":"id.vector.apexfusion.org","content":"91.98.147.172","proxied":false,"ttl":1}
  ```

- **Compose.** `deploy/mainnet/docker-compose.gateway-identity.yml` on the external network `traefik-net`.
- **Traefik labels:**
  - `traefik.enable=true`;
  - an HTTP router that redirects to HTTPS;
  - an HTTPS router on `websecure` with ``Host(`id.vector.apexfusion.org`)``, `tls.certresolver=letsencrypt` and a `ratelimit` middleware per client address (average 20 per second, burst 40);
  - service port 8080.
- **Container.** The memory limit is 512 MiB. The image sets `HOST=0.0.0.0` and `PORT=8080`.
- **Logs.** The gateway logs errors without the requested DID. It writes no request log. Traefik on this host writes an access log with request paths, which contain DIDs. The gateway publishes the retention time of that log at `/policy` (§13.4).
- **Release.** Use the selective release procedure (`docs/DEPLOY_NEW_SUPPLIER.md`): build images off-host and pull the version tag. Never build images on this host.

### 8.2 Gateway identity and keys

- The gateway registers itself as an agent. The Foundation's operator key is its controller and its Accountable Party.
- It has one Ed25519 key and one P-256 key. Both are listed in its record. The Ed25519 key has the authentication and assertion purposes. The P-256 key has the assertion purpose and a `pop`.
- The private keys are files that only the gateway container can read. There is no fixed rotation. After a suspected compromise, the controller replaces the keys with an Update.
- The Ed25519 key signs agent cards. The P-256 key signs tokens, SVIDs, status lists and identity credentials.

### 8.3 Resolver

- Implement Part 1 §7–8 in `identity-gateway`:
  - identity-registry and legacy lookups, with the cutoff slot;
  - versions, base and pending versions, views and confirmations;
  - effective status with holds, ancestors and inherited "invalid from" times;
  - the HTTPS binding with `Cache-Control: no-store`;
  - the document and the metadata.
- Changes from the current resolver:
  - the DID 1.1 context;
  - key-hash fragments instead of `#c0`;
  - P-256 keys;
  - all relationships;
  - `didDocument: null` for deactivated DIDs;
  - no `did:web` alias in the document. The alias document (§8.5) names the `did:vector` DID in its own `alsoKnownAs`;
  - the legacy key search limited to the record's own token transactions up to the last transaction that the base version owns;
  - a legacy deregistration as a version with status Retired, and a legacy token outside an authentic output as Suspended (`notAuthentic`);
  - the new metadata;
  - the options `versionId`, `versionTime`, `expandRelativeUrls` and `noCache`, `vectorCurrent`, and the errors `FEATURE_NOT_SUPPORTED`, `INVALID_OPTIONS` and `METHOD_NOT_SUPPORTED` in the order of Part 1 §7.1;
  - a failed Koios or Ogmios read gives `INTERNAL_ERROR`.
- Rename "generation" in the code to the registry names.
- Add `GET /healthz`, which answers 200 without a ledger call.
- Add `identity-gateway/LICENSE` (Apache-2.0, after Foundation approval), the `license` field in `package.json`, a Dockerfile and a README section on running, troubleshooting and updating the image.

### 8.4 Confirmation wait and listing rule

- Everything that the gateway issues uses the view without options (Part 1 §7.2–7.3).
- **Status lists.** A Revoked or Retired effective status sets the revocation bit. Part 1 gives that status only after 30 confirmations, because the bit cannot be cleared. A Suspended effective status, including `deactivationPending`, sets the suspension bit.
- **Listing rule.** Catalogs, the MCP subregistry and DNS-AID list only agents that meet all of these conditions:
  - independent;
  - effective status Active;
  - a reachable endpoint.
- `vector_discover_agents` reads the indexer, which applies the advert listing rule (§6.2).
- Attestations are marked `firstParty` when the issuer and the subject share a party key or the controller, or when the issuer key is a key of the subject. Attestations without `issuer_id` are marked `unattributed`. These marks are hints, not guarantees.
- The policy is published at `/policy`.

### 8.5 Renderings and endpoint detection

- **Protocol detection.** The gateway detects each listed agent's protocol:
  - **A2A:** `<endpoint origin>/.well-known/agent-card.json` returns a valid agent card.
  - **MCP:** the endpoint answers an MCP discovery request: first `server/discover` (MCP revision 2026-07-28, which removed `initialize`), then an `initialize` request of revision 2025-11-25.
  - **Web:** neither check succeeds.
- **Fetch rules** (Part 1 §9, amplification). Detection and domain linkage run as background jobs, never during a request. They fetch only `https` URLs whose host resolves to a public unicast address, checked for each connection and each redirect. They do not follow a redirect to another host. Each fetch is limited to 1 MiB and 10 seconds, with at most one fetch per host each minute.
- **Rechecks.** The gateway checks again daily and after each record change. The result goes to `vectorFetched`.
- **Rendering source.** Renderings use the on-chain profile, the detected protocol and the listed keys.

| Rendering | Path | Standard |
|---|---|---|
| `did:web` alias | `GET /agents/{id}/did.json` (for `did:web:id.vector.apexfusion.org:agents:{id}`; its `alsoKnownAs` names `did:vector:{id}`) | did:web |
| Agent card | `GET /agents/{id}/agent-card.json`, signed (JWS, Ed25519); A2A agents only, because an A2A card needs an A2A interface | A2A |
| MCP server card | `GET /agents/{id}/server-card` (MCP agents only) | MCP Server Cards |
| MCP subregistry | `GET /v0/servers` | MCP Registry API |
| Catalogs | `GET /.well-known/ai-catalog.json`, `GET /.well-known/ard.json`; they list A2A agents through the agent card and MCP agents through the server card, so web agents do not appear | AI Catalog, ARD |
| OASF record | `GET /agents/{id}/oasf.json` | OASF |
| ERC-8004 file | `GET /agents/{id}/registration.json` (`agentId` = the identifier as an unsigned 256-bit integer, in decimal; `agentRegistry = vector:mainnet:<identity policy>`, provisional until a CAIP namespace for Vector exists; the network magic cannot identify Vector) | ERC-8004 |
| JWKS | `GET /agents/{id}/jwks.json`, `GET /.well-known/jwks.json` | RFC 7517 |

### 8.6 M4 services

| Service | Path | Rules |
|---|---|---|
| Authorisation server metadata | `GET /.well-known/oauth-authorization-server` | RFC 8414 |
| Token service | `POST /token` | RFC 8693, `subject_token_type = urn:ietf:params:oauth:token-type:jwt`. The subject token is a JWT signed (EdDSA) by an authentication key of the agent, with `iss = sub = did:vector:<id>`, `aud = https://id.vector.apexfusion.org/token`, `exp − iat ≤ 5 min` and a single-use `jti` (kept for at least the token lifetime). RFC 7523 client assertions follow the same rules. Issued tokens use ES256, last at most 5 minutes, and carry `cnf.jkt` (RFC 9449) and a Token Status List claim. Without a delegation, `sub = did:vector:<id>`; with a delegation, `sub`, `act` and `authorization_details` follow §5.4. |
| Introspection, revocation | `POST /introspect`, `POST /revoke` | RFC 7662, RFC 7009. Tokens issued by the gateway only. A change that makes the agent's effective status other than Active revokes all tokens of that agent. |
| SPIFFE | `POST /spiffe/x509-svid`, `POST /spiffe/jwt-svid`, `GET /spiffe/bundle` | An X.509-SVID needs a CSR and a signature by an authentication key over the CSR public key and a single-use gateway nonce (at most 5 minutes old). P-256; one URI SAN `spiffe://id.vector.apexfusion.org/agent/{id}`; lifetime at most 1 hour; `noRevAvail`. JWT-SVIDs use ES256. The bundle endpoint uses the `https_web` profile with refresh hint 300 s. |
| Status lists | `GET /status/bsl/{n}`, `GET /status/tsl/{n}` | W3C Bitstring Status List (revocation and suspension purposes) and IETF Token Status List (2 bits: 0 valid, 1 invalid, 2 suspended), signed with ES256. Each list has 131,072 entries. Index `i` is in list `n = floor(i / 131,072)` at position `i mod 131,072`. |
| Identity credential | `GET /agents/{id}/credential` | A W3C VC 2.0 credential issued by the gateway's DID, with `credentialStatus` entries for both status-list purposes |
| Domain linkage | background job | Checks `https://<domain>/.well-known/did-configuration.json` (a Domain Linkage Credential signed by an assertion key) or a DNS TXT record `_did.<domain>` that names the DID. Domains come from the endpoint host and from party organisation identifiers. Verified domains go to `alsoKnownAs`. Verified organisations get `organisationVerified: true`. The fetch rules of §8.5 apply. |

**Status-list index.** Indices start at 0. They follow the ledger order (block height, transaction index, output index) of each identifier's first mint: legacy mints before the cutoff slot and identity-registry mints that are not adoptions. An adopted record keeps the index of its legacy mint. Legacy identifiers minted at or after the cutoff slot get no index. A mint gets its index when it has 30 confirmations.

### 8.7 DNS-AID

- **Decision open.** How the gateway publishes the DNS-AID zone is not decided (§13.4). Until it is, the gateway publishes no DNS-AID records.
- **Record content.** When the zone exists, each listed agent gets:
  - an SVCB record at `<DNS-safe identifier>.<zone>` (Part 1 §3.2), with `well-known=agent-card.json`;
  - `cap-sha256`, the SHA-256 of the gateway's agent card for that agent. Only A2A agents have an agent card (§8.5): the DNS-AID decision (§13.4) must also say what MCP and web agents publish.
- **Index.** `_index._agents.<zone>` points to the catalog.
- **DNSSEC.** The draft says that these records SHOULD be DNSSEC-signed.

### 8.8 Universal Resolver

- Build the image off-host or in CI from a version tag.
- Push `ghcr.io/apex-fusion/uni-resolver-driver-did-vector:<version>` with the labels `org.opencontainers.image.source=https://github.com/Apex-Fusion/agents-marketplace` and `org.opencontainers.image.licenses=Apache-2.0`.
- Make the package public once. Check this with an anonymous `docker pull`. Do not use a `latest` tag.
- The driver entry sets `supportsOptions: true`. Without it, the Universal Resolver drops `versionId` and `versionTime` and returns the current version.

## 9. Migration

### 9.1 Adoption

- **Cutoff slot.** Fix the cutoff slot shortly before `identity` is compiled. The allowlist holds every legacy identifier minted in a slot before it, including the simulation records. Publish the slot, the list, the root and the script that builds the tree (§3.4) with the deployment.
- **Builder inputs:**
  - the legacy DID;
  - the controller public key;
  - the listed keys with their purposes;
  - the parties, with at least one Accountable Party;
  - the profile.
- **Profile copy.** The builder copies each legacy field that obeys the limits. The caller gives a new value for each field that breaks a limit. A record with a script owner, or a datum that does not decode, cannot adopt; the builder says why.
- **Signers:** the legacy owner key, the controller key, each listed Ed25519 key and each party.
- **Funding.** The legacy Deregister requires exactly one output of at least 10 AP3X (10,000,000 base units) whose payment credential is the owner's key hash, with any stake credential. The legacy deposit itself need not return (measured, §12.2). The new record gets at least 10 AP3X from an AP3X-only output of the owner. In an adoption with a 10 AP3X legacy deposit, the owner thus adds 10 AP3X plus the fee.
- **Our agents first.** Chandra OCR, Agent History, Document Pipeline, Audio Snippets and Advocate adopt first.
- **Operator advice.** An agent that is the target of an open Module-3 challenge does not adopt until the challenge settles.

### 9.2 Our supplier records

On 2026-11-02, 36 of the 43 Active adverts used supplier keys without a legacy record: 19 `llm.text.generate.v1`, 12 `llm.chat.v1`, 3 Paper2Agent slots (`mcp.tool.execute.v1`), 1 `audio.synthesize.piper.v1` and 1 `demo.text.stats.v1`. Before registration, confirm which of these keys we run (§13.4). At least one advert (`summitstak.ing`) can belong to an outside operator.

- Each supplier key that we run gets one native record, with these values:
  - **Controller and Accountable Party:** the Foundation operator key is the controller (offline), and the controller (`ControllerSet`) is the Accountable Party.
  - **Listed key:** the supplier key, with the authentication and transaction purposes.
  - **Capabilities:** the `capability_id` values of that key's adverts.
- The deposit is 10 AP3X per record, at most about 360 AP3X in total.
- The Paper2Agent publisher registers a record for each new slot key before it posts the advert. A new supplier (`docs/DEPLOY_NEW_SUPPLIER.md`) registers a record before it posts an advert.
- Each Active advert of ours is posted again with the new advert contract and has exactly one agent before the switch. For a published Paper2Agent slot, the publisher posts it (`POST /targets/<id>/readvert`), moves the slot's supplier to it at the switch (`POST /targets/<id>/switch`) and then retires the legacy advert (`POST /targets/<id>/retire-legacy`); see `docs/DEPLOY_NEW_SUPPLIER.md`.

### 9.3 Outside suppliers

The identity tools (§10) are released first. The switch follows as soon as our supplier records and new adverts exist (decision of 2026-11-03). There is no 14-day notice period, because most escrows and most traffic are ours. The release announcement tells outside suppliers to register or adopt, name an Accountable Party and post new adverts; until then their legacy adverts are not routable. It also says that an escrow above 10,000 AP3X cannot be claimed and returns to the buyer only by Reclaim after `deliver_by`.

### 9.4 Legacy records after deployment

Un-adopted legacy records resolve as suspended (`unaccountable`) from the cutoff slot. Legacy identifiers minted at or after the cutoff slot resolve as `NOT_FOUND`. Legacy records cannot accept work through the new escrow.

A legacy Register and a legacy Update in one transaction can put two legacy tokens into one output (§12.2). That output is locked for ever: both records resolve as suspended (`notAuthentic`), and they can neither adopt nor deregister.

### 9.5 Simulation cleanup

- This work runs in parallel. It does not block the release.
- It covers 778 records (514 `Vector-Agent`, 255 `Apex-Sim`, 9 `TestFramework`) with 11,670 AP3X (Koios, 2026-11-02).
- It needs two key files that colleagues hold (private note).
- Each record needs one Deregister transaction. Write a pycardano batch tool in `vector-agent-modules` that builds them and meets the legacy change minimum.
- A sweep sends the returned deposits to the Foundation treasury multisig.
- The allowlist includes these records. Until they are deregistered, a leaked simulation key could adopt one (accepted risk, §13.1).

### 9.6 Escrow switch and drain

1. Deploy the new escrow and advert contracts, and publish their reference scripts.
2. Release the services, tools and copies that read and spend both escrow layouts (§6.5).
3. Register our supplier records and post their new adverts (§9.2), then announce the switch (§9.3).
4. Switch: all builders create new escrows and adverts only.
5. Drain:
   - Suppliers keep the legacy Claim and Submit paths until the last legacy escrow passes its `deliver_by`.
   - The buyer tools (MCP, buyer, gateway sweeper) keep the legacy Accept, Reclaim and Release paths until no legacy escrow output remains.

Legacy escrows keep the legacy rules until the drain ends.

### 9.7 Local cleanup

Before the next push, remove the local work that the private note lists, in this repository and in `vector-agent-template`.

## 10. Tools and SDKs

**MCP builder `@apexfusion/vector-mcp-builder`:**

- Registry tools: register (also subagents), adopt, update (profile, keys, parties, guardian threshold), change controller, suspend, unsuspend, revoke, retire, reclaim, set successor, start, cancel and complete recovery, and end subagents.
- Attestation tools: attest, revoke attestation, contest and withdraw.
- Delegation tools: delegate and undelegate. Vault tools: open, pay and close.
- Marketplace tools:
  - post escrow, with `agent_id` from a listed advert and `refund`;
  - accept, reclaim and release in both layouts during the drain;
  - `RefundRevoked`;
  - post, update and retire adverts in the new layout;
  - receipt verification with 8 or 9 fields;
  - supplier lists that show the agent DID.
- Read tools:
  - `vector_resolve_did` (new) returns the DID resolution result from the gateway;
  - `vector_get_agent_profile` accepts both DID forms;
  - `vector_discover_agents` reads the indexer.
- `vector_build_message_agent` is retired.
- `vector_build_deregister_agent` stays for legacy records that do not adopt.
- The registry constants of the legacy registry move into one separate module. Only legacy reads, adoption and legacy deregistration use it.
- Build tools return the transaction and the list of required key hashes. Each key holder signs in turn.

**MCP signer `@apexfusion/vector-mcp-signer`:** add `vector_signer_get_public_key`; accept a partly signed transaction; count only the value that the signer's own inputs fund.

**TypeScript SDK `@apexfusion/agent-sdk` 0.2.0 (breaking):**

- Add clients for the identity registry, attestations, delegations and vaults. The clients cover every identity-registry, attestation, delegation and vault operation of the MCP builder. The marketplace stays in the MCP tools and the buyer code.
- `src/registry/*` used the test registry. It now reads the deployed legacy registry (Part 1 §4) for legacy reads, adoption and deregistration. Its registration functions are deprecated; remove them after the switch date (§9.6).
- Mainnet becomes the default.
- The release also contains the unreleased 0.1.2 changes, and its notes state every breaking change.
- Publish with `npm publish` as the npm user `apexfusion`.

**Python SDK `apex-fusion-agent-sdk` 0.2.0:**

- The same clients as the TypeScript SDK.
- The Module-6 client moves to the new Module-6 deployment.
- Set `version = "0.2.0"` in `pyproject.toml` before the GitHub Release. The release also contains the unreleased 0.1.11 changes.
- The release pins `cbor2<6` (pycardano 0.19.2 fails on import with `cbor2` 6) and `mcp<2` (mcp 2 removed `streamablehttp_client`).

**Agent History** (`vector-service-agents`):

- It accepts both DID forms.
- It shows one timeline across both registries: legacy registration, updates and deregistration, adoption, identity changes, holds, statuses, parties and recoveries.
- Its module section moves to the new module deployments.
- Its manifests use the canonical DID and the identity registry address. They name the listed supplier key. The key-role check uses `active_key(record, key, transaction)` instead of a comparison with the controller key.
- A changed manifest no longer matches the advert's `detail_hash`. The new adverts (§9.2) fix this.

**Other consumers:**

- **`vector-agent-template`:** vendor the new codecs, transaction builders, receipt code and blueprints again. Update `try-it/src/verify-receipt.ts`, `try-it/src/buy-once.ts` and `docs/TRUST-LAYER.md`.
- **`chandra-supplier`:** vendor `packages/shared` and the supplier again.
- **Documents:** documents that list DIDs or advert references (`vector-service-agents` `specs/`, `docs/HIRE.md`, `docs/E2E.md`, `scripts/`) change after the adoptions and the new adverts.

## 11. Release

One combined release, in this order:

1. **Before the release:**
   - Remove the local work (§9.7). Do this first, because the permalink needs a push.
   - Filip completes the name check.
   - The Foundation sets the licence of the Part 1 text.
   - Register `did:vector` with W3C, using a permalink to Part 1. The identity registry's values are "published at deployment" until step 3.
2. **Contracts**, in two parts (decision of 2026-11-03):
   - **Identity side:**
     - fix the cutoff slot and build the allowlist (§9.1);
     - the configuration holder and seal policy. The seal seed is the only output of a key that nothing else uses, so no other transaction can spend it before the seal;
     - `identity`, `attestation`, `delegation`, the new `escrow`, `vault` and the new `advert`;
     - publish their reference scripts at an address that nobody can spend.
   - **Module side**, after the module owners decide the Module-1 mode and the verdict policy (§13.4). It can come after steps 3 to 7:
     - Module-1 with `identity_party`, then the seal with its hash, then the check of §3.8;
     - Modules 3 and 6;
     - their reference scripts.

     Until the seal, no `Script` party can be appointed (§3.8). Every other identity action works.
3. **Publication:**
   - Add the policy ID, the address, the cutoff slot, the allowlist and its root, the configuration policy and, after the module side, the Module-1 hash to Part 1 §4 and to every consumer.
   - Send a second pull request to `w3c/did-extensions` that moves the permalink to that commit.
4. **Off-chain release:**
   - the gateway (resolver, renderings, M4 services) and the indexer with its backfill;
   - the MCP packages and both SDKs;
   - Agent History, the services and the copies (§6.5);
   - the module clients.
5. **Records:** our agents adopt (§9.1). Our supplier records are registered (§9.2). The gateway registers itself (§8.2).
6. **Smoke test** (§12.6).
7. **Escrow switch:** as soon as our supplier records and new adverts exist (§9.3). Switch and drain (§9.6).
8. **Universal Resolver:** after the W3C merge, submit the driver (§8.8). Its test identifiers are one live native DID, one adopted DID, one legacy DID and one deactivated DID.

Use the selective release procedure for every service. A push to `main` must never start image builds on the production host.

## 12. Tests and launch checks

There is no testnet rehearsal and no external audit (§13.1). Before the mainnet deployment:

### 12.1 Exploit tests (Aiken)

Each attack must fail on-chain, unless the row says that it must pass.

| Area | Attacks |
|---|---|
| Identifier | A name not derived from the seed; a seed that is not spent; a mint of quantity 2 or of a second name; a legacy mint or burn in a Register |
| Record output | The token leaves `IA`; an output at the identity script with a stake credential; a datum hash or no datum; a foreign asset; a reference script; less than 10 AP3X on a live record; two outputs at `IA`; a field outside a limit; duplicate keys or capabilities; two parties with the same role and signer; a P-256 key with a transaction or delegation purpose; a P-256 key without `pop`; the purpose value 4 |
| Time | An unbounded range or a range over one hour on any action; `created_at ≠ hi`; `created_at` changed; a time after the year 9999; a negative time |
| Signatures | The controller does not sign; a new Ed25519 key does not sign; a new controller does not sign; a party does not sign its appointment |
| Adopt | No legacy burn; a burn of another name (mint X, burn Y); the legacy owner does not sign; a name outside `legacy_root`; a script owner |
| Spend scope | Two identity inputs; an identity input with a stake credential; an input at `IA` without a token; a Register together with an Update; any mint or burn of the own policy in a spend |
| Parties | Removal without consent or notice; notice shorter than 7 days from `hi`; a changed party without its signature; rights above the role's highest rights; a Distributor or Guardian that suspends; a party outside its period; a party revocation that names a successor; a `Script` party that is not Module-1; a Module-1 action without the withdrawal; reason 64 from another author; a Module-1 consent withdrawal attached to Revoke, Retire, Suspend, Unsuspend, RecoverInit or RecoverCancel (F-05) |
| Holds | A hold over 30 days; Unsuspend by anybody but the author; a Suspend that drops or shortens a hold in force of another current author; two holds by one author; more than 10 holds; the controller that holds a hold through its own party key and so blocks another party's Suspend; a Module-1 hold dropped after the removal of Module-1, also in a transaction without the configuration reference input. Must pass: a Suspend that drops the hold of a removed key party |
| Module-1 verdicts | A verdict mint without a challenge resolution; a verdict mint in a jury or timeout resolution; a verdict whose agent, action, duration or challenge differs from the resolution; a verdict agent taken from a claim input without the challenge's claim token or at another claim validator; two verdict mints in one resolution; an oracle resolution that the verdict policy turns into a verdict, without the verdict mint; a verdict burn without a verdict application or a lapse reclaim; verdict data that does not match the token name; a suspend verdict applied as a revocation, and the reverse; a verdict application after `expires_at`; a lapse reclaim before `expires_at`, to another address than `deposit_to`, or with another script input; a verdict hold with an `until` other than the later of `lo + duration` and the current Module-1 hold; a later, shorter verdict that shortens a Module-1 hold; a verdict revocation with `invalid_from` or a successor; one verdict used twice; a verdict applied to another agent; Unsuspend of a Module-1 hold; Consent to a Module-1 party with rights below the role's highest rights, with `not_after` or `removal_after`, or with `not_before` after `lo`; a Consent Update that removes or changes another Module-1 party |
| Statuses | Any spend of a tombstone except Reclaim and SetSuccessor; SetSuccessor twice; SetSuccessor that the controller does not sign, for example by the revoking party; a successor without consent; a successor that is the record itself, a subagent or a tombstone; reason 1 without `invalid_from`; `invalid_from` more than 3,600,000 ms before `created_at`; a reason not allowed for the action. Must pass: SetSuccessor by the controller after a party revocation; reason 1 at once after the creation, with `invalid_from = lo` |
| Value | Value taken on Suspend, Unsuspend, Revoke, SetSuccessor or any recovery action; Reclaim or Retire by anybody but the controller |
| Recovery | RecoverInit below the threshold, with an ineligible guardian, with one guardian counted twice (same index or same signer), with a recovery pending, or without the new key's signature; RecoverFinalize before `effective_after`; recovery after a controller change; an Update with a threshold above the guardian bound; a pending recovery with threshold 0. Must pass: Suspend, Unsuspend and RecoverFinalize after a guardian's period ended |
| Subagents | Depth 5; a stale `parent_epoch`; a parent that does not sign or is not Active; an endpoint on a subagent; a subagent that survives an epoch increase, a controller change or a recovery |
| Attestation | No subject record; the issuer does not sign; an `issuer_id` key without the assertion purpose; RevokeAtt or Withdraw by a removed issuer key; `solicited` without the subject's controller; an output with a foreign asset, a reference script or a stake credential; a RevokeAtt or Contest that moves the token away from `AA` or lowers the value; `issued_at ≠ hi`; `valid_until` before `issued_at`; a reserved `att_type`; RevokeAtt by the subject; Contest by the issuer; Withdraw before 90 days; a burn of two attestations with one input |
| Delegation | A child wider than its parent (actions, resources, period, depth, remaining, value or a shorter `period_ms`); `oc.*` treated as covering `ocr.*`; an external pattern used as a prefix; `period_ms = 0`; a delegate key without the delegation purpose; a delegate key that does not sign; a sub-delegation without the signature of the parent's delegate key; a sub-delegation signed by a parent delegate key that its agent removed; a parent token from another policy or address; a change to a delegation output; Undelegate by a stranger; use after the parent's Undelegate; use with a delegate key that the delegate removed |
| Vault | Pay without the delegate key; pay above `per_tx` or `total`; a new period that starts before `hi`; pay to an escrow that is not Open, not at the exact escrow address, above the cap, not fully funded, with more AP3X than payment + bonds, with `deliver_by` beyond 7 days, without the vault refund, or with another buyer key; a second script input; Pay from a `Returned` output; Close by anybody but the owner. Must pass: Close after Undelegate |
| Escrow | Two escrow inputs; a legacy escrow input; any second script input; a mint, withdrawal or certificate; Claim with an unlisted key, a key without the transaction purpose, a controller-only key, no capability, a subagent, a suspended or unaccountable agent, a record at a wrong address or with a fake token, or the record of another agent; Claim above the cap; Claim or Submit with a range over one hour; a continuing escrow output with a stake credential; Submit after key removal, suspension or revocation; a changed `agent_id` or `refund`; a buyer payout to a wrong refund address or with a wrong datum; Reclaim with a refund address and less than a full refund; RefundRevoked against a live agent; RefundRevoked of a Submitted escrow without an "invalid from" time at or before `submitted_at`; RefundRevoked with less than a full refund or to a buyer address with a stake credential; a full refund that leaves out a non-AP3X asset of the escrow input; each payout below its due amount |
| Other purposes | Each script used as withdraw, publish, vote or propose, except the Module-1 withdraw handler |

Also port the 17 current escrow tests (`contracts/marketplace/validators/escrow.ak`) to the new escrow.

### 12.2 Legacy script tests

Run these tests against the deployed legacy script bytes: the blueprint `agent-registry/deploy/agent-registry/plutus.json` in `Apex-Fusion/vector-ai-agents@f6ae4bb` (hash `be1a0a29…`). The deployed bytes match the source `agent-registry-audit/compliant/agent-registry/` of the same repository at commit `eb05a62` (stdlib v3.0.0, Aiken v1.1.21, silent traces). The source `agent-registry/compliant/` at `f6ae4bb` compiles to another hash, and `agent-registry/original/contracts/agent-registry/` compiles to the test registry `5dd51189…`.

The tests are in `tests/legacy-registry/` (offline, `aiken tx simulate`). Results on 2026-11-02:

- **Deployment blockers:** the legacy Register fails, as required, when the seed is not an input (also when it is only a reference input), when the quantity is not 1, when a second name is minted, or when the name is not derived from the seed.
- The legacy Deregister and Burn pass in an adoption-shaped transaction. Repeat this test with the identity validator when it is built.
- The Deregister change rule is recorded in §9.1. One Deregister per transaction is a legacy script rule.
- A legacy Update cannot move the token to another address, also not to the legacy script address with a stake credential. A Register together with an Update can put two legacy tokens into one output, which is then locked (§9.4).
- The deployed Register and Update reject script owners and datums that are not legacy datums. The legacy datum limits are wider than the identity limits, so the adoption builder asks for new values (§9.1).

### 12.3 Property tests

- The effective status of a child is never better than its parent's.
- A live subagent under an old epoch is Revoked. A subagent tombstone keeps its own status (Part 1 §7.3 rule 1 applies before rule 3).
- A subagent has the earliest "invalid from" time of its ancestors and itself.
- No sequence of valid transactions moves a tombstone back to a live status.
- No sequence changes `created_at` or the token name.
- No path lets anybody except the controller reduce a record's value.
- No action by one author removes or shortens the hold in force of another current author.
- No vault action lets the delegate spend a `Returned` output.
- A record's datum, rendered to a DID document and read back, gives the same keys, relationships and status.

### 12.4 Benchmarks and vectors

- **Benchmarks.** Measure execution units and transaction size against the ledger limits: 16,000,000 memory units, 10,000,000,000 CPU units and 16,384 bytes per transaction. Run these cases:
  - the largest record (8 keys, 8 parties, 10 holds, 16 capabilities, the longest profile) through every identity action;
  - Claim and Submit with that record;
  - a depth-4 subagent with its ancestors;
  - a depth-4 delegation chain used by a vault payment with several escrow outputs;
  - verdict applications (Suspend and Revoke) and a Consent Update on the largest record, and a challenge resolution with the verdict mint.
- **Vectors.** Publish these with the resolver:
  - identifier derivation and the DNS-safe form (Part 1 §3);
  - `legacy_root` membership proofs, including a tree with an odd number of leaves;
  - DID documents of a root agent, a subagent, a suspended agent with holds by two authors, an unaccountable agent, a revoked agent with `invalid_from`, a retired agent with a successor, an adopted agent, a deregistered legacy agent, a view with pending versions and a legacy agent before and after the cutoff slot;
  - status-list bits for the same set;
  - one attestation `Sig_structure` and its signature.

### 12.5 Resolver tests and review

- Resolver tests cover:
  - native, adopted, legacy, deregistered and deactivated records, and a legacy token in an output that is not authentic;
  - `versionId` and `versionTime`, also before an adoption, before the cutoff slot of an adopted record, later than the tip, for an unconfirmed version, and before a revocation, a hold, a retirement or an epoch end (`vectorCurrent`, `deactivated`);
  - views with pending versions: new and removed keys and parties, holds set and lifted, a controller change, a final action, an adoption;
  - an "invalid from" time applied to earlier versions and to subagents;
  - `NOT_FOUND`, `INVALID_DID` (also with an uppercase character), `INVALID_OPTIONS` (bad values, dates such as `2026-02-30`, repeated options, both version options), `METHOD_NOT_SUPPORTED`, `FEATURE_NOT_SUPPORTED` (checked before `INVALID_OPTIONS`) and query parameters;
  - `expandRelativeUrls` and `noCache`;
  - testnet and other policies;
  - `Accept` lists with q-values;
  - P-256 keys with valid and invalid proofs;
  - the legacy key search;
  - a failed ledger read;
  - the JCS output, `Cache-Control` and the HTTP status codes.
- Run the image in a local Universal Resolver with `docker compose`. Check that `versionTime` reaches the driver.
- **Independent review.** A fresh reviewer gets Part 1, this file and the code, with the brief "break it". Fix each finding, or record that we accept it.

### 12.6 Mainnet smoke test

- **Configuration:** check that the configuration datum equals the hash of `identity_party` (§3.8).
- **Test agents:** register two test agents. On the first, run these actions:
  - add a party and a guardian;
  - suspend by the controller and by the party; lift one hold and check that the other stays;
  - change the controller;
  - start and cancel a recovery;
  - create a subagent and end it with an epoch increase.
- **Second test agent:** revoke it.
- **Other records:**
  - adopt one of our agents;
  - register one supplier record;
  - issue and revoke one attestation;
  - create a delegation and a vault, pay one escrow from the vault, and close the vault.
- **Resolution:** resolve all of these through `id.vector.apexfusion.org`.
- **Escrow:** run one job from end to end through the new escrow.
- **Token check:** get one token and one SVID.
- Keep the first test agent live for the Universal Resolver test identifiers.

## 13. Risks, deferred work and open items

### 13.1 Accepted risks

| Risk | Effect |
|---|---|
| One controller key | A thief gets full control. The thief can cancel a recovery by changing the controller, and can remove parties after 7 days' notice. The thief can also name a successor, also after a party revocation (decision of 2026-11-02). An Accountable Party with the revoke right can still revoke during the notice time. One Foundation operator key controls all our records. |
| Guardians fix loss only | Guardians cannot stop a thief who holds the controller key. |
| Forward-only key removal | Signatures made by a stolen key before its removal stay valid, unless the identity is revoked with `invalid_from`. |
| Old module deployments | Positions in the old module deployments stay under the old rules until their owners exit. |
| One large release, mainnet only | No testnet rehearsal and no external audit for permanent contracts. The 10,000 AP3X caps limit each escrow, and the value limits limit each vault payment and each period of a vault output. |
| Shared gateway host | The gateway's signing keys are on the vector-marketplace host, without rotation. A compromise of the host lets an attacker issue tokens, SVIDs and status lists until the keys are replaced. |
| Simulation records on the allowlist | A leaked simulation key can adopt a simulation record that is still live. |
| Fixed AAIF target | Filip's five primitives can differ from later working-group drafts. |
| Detected protocols | Endpoint detection depends on fetches, so renderings can differ between gateways. |
| Legacy registry stays open | New legacy records can appear. From the cutoff slot on, they resolve as `NOT_FOUND`. |
| Delegation keys | Each delegation needs its own delegate key, so one agent can hold at most 8 live delegations. |
| No resignation | A party, also a guardian with a leaked key, stays listed until its `not_after` or until the controller removes it (decision of 2026-11-02). |

### 13.2 Deferred work

- **M5:** OIDC Provider with Back-Channel Logout, DNSid, GNAP and AAuth. The answers of 2026-11-02 stay recorded for M5:
  - permissions only for services that the operator controls;
  - AAuth tokens of at most 5 minutes;
  - DNSid only for Foundation agents;
  - DNSid history after 30 confirmations;
  - a new DNSid address when continuity fails;
  - no hardware-attestation demonstration.
- **Delegation formats:** UCAN and AP2.
- **Identity features:**
  - subagent promotion;
  - key expiry and retroactive invalidation of one key;
  - scripts as controllers, and script parties other than Module-1;
  - X25519, secp256k1 and RSA keys.
- **Resolver features:**
  - testnet support;
  - a history endpoint;
  - signed resolution results;
  - the capability-name check.

### 13.3 Differences from Filip's drafts

| Topic | Filip's drafts | This plan |
|---|---|---|
| Controller | 1–5 key or script signers, threshold, next-key hash | One Ed25519 key |
| Recovery | Next keys and guardians | Guardians |
| Identifier | Commits to the first record | Seed only |
| Keys | Five types, key names, expiry, retroactive revocation | Ed25519 and P-256, key-hash fragments, forward-only removal |
| Profile | Off-chain document with on-chain hash | On-chain fields; detected protocol |
| Suspensions | One suspension | One hold for each author |
| Subagents | With promotion | Without promotion; also end at controller changes and recoveries |
| Party organisation | Salted hash | Optional on-chain identifier |
| Attestation issuer | Key or script | Ed25519 key, optionally as a listed key of a registered agent |
| Delegator organisation | Salted commitment | Optional on-chain identifier |
| Refund after revocation | Supplier bond split by reason, deadline credit | Full refund to the buyer, who funds both bonds; no deadline credit |
| Escrow rule | One escrow input | One escrow input and no other script; optional refund address |
| Delegation | Specified for v2.1 | Records and vaults now; RFC 8693 presentation only |
| Gateway | Separate repository; signed results; M4 and M5 | `identity-gateway` in this repository; unsigned results; M4 now, M5 later |
| Release | Milestones M0–M5 | One combined release |
| Publication | Registry spec internal | Part 1 and Part 2 public; private operational details in a private note |

### 13.4 Open items

| Item | Owner |
|---|---|
| Name and trademark check for `vector` | Filip |
| Filip's `DECISIONS.md`, `CONTEXT.md` and `research/`, to check the recorded decisions | Filip |
| DNS-AID zone and publishing method (§8.7) | David |
| Licence of the Part 1 text | David |
| Foundation operator keys: record controllers, Accountable Party, gateway controller, module operators | David (done 2026-11-03: one new operator key) |
| Guardian key holders for Foundation records | David (none at launch; add them later with an Update) |
| Owners of the 36 supplier keys without a legacy record (§9.2) | David |
| Key files for the simulation cleanup, from colleagues (private note) | David |
| Module owners' review of the module changes | David |
| Module-1 verdict policy: the action and the duration for each challenge outcome (§3.8) | David, module owners |
| Module change list for the module owners | David |
| Foundation approval of Apache-2.0 for `identity-gateway` | David |
| Contact email for the W3C and DIF entries | David |
| npm and PyPI publication rights | David |
| The switch date | David (decided 2026-11-03: as soon as our supplier records and new adverts exist) |
| Retention time of the Traefik access log on the gateway host | David (decided 2026-11-03: 7 days) |
| Check that the default Ogmios endpoint answers public requests from the driver | Builder |

## Appendix A — Reason codes

RFC 5280 numbers are kept where they exist. Codes 64 and above are Vector codes. The codes are coarse on purpose: the reason is public forever, and evidence never goes on-chain. The typical actor is a guide; the contract enforces only the "Allowed in" column and the Module-1 rule for code 64.

| Code | Name | Typical actor | Allowed in |
|---|---|---|---|
| 0 | unspecified | any | Suspend, Revoke |
| 1 | keyCompromise (requires `invalid_from`) | controller, Accountable | Revoke |
| 3 | affiliationChanged | Accountable | Revoke |
| 4 | superseded (with a successor) | controller | Revoke |
| 5 | cessationOfOperation | controller | Revoke |
| 6 | hold | any with the suspend right | Suspend |
| 9 | privilegeWithdrawn | Accountable, Provider | Suspend, Revoke |
| 64 | disputeVerdict | Module-1 only (enforced) | Suspend, Revoke |
| 65 | legalOrder | Accountable | Suspend, Revoke |
| 66 | parentRevoked | nobody; computed | effective status only |
| 67 | providerWithdrawn | Provider | Suspend |
| 68 | securityInvestigation | any with the suspend right | Suspend |
| 69 | unaccountable | nobody; computed | effective status only |
| 70 | parentRetired | nobody; computed | effective status only |
| 71 | parentSuspended | nobody; computed | effective status only |
| 72 | deactivationPending | nobody; computed | effective status only |
| 73 | invalidated | nobody; computed | effective status only |
| 74 | notAuthentic | nobody; computed | effective status only |
