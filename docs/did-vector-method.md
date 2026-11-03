# The did:vector Method

| | |
|---|---|
| Version | 1.0 (draft), 2026-11-02 |
| Status | Draft for registration in the W3C DID Extensions registry |
| Implementation plan | [`IDENTITY_REGISTRY.md`](IDENTITY_REGISTRY.md) |
| Contact | Apex Fusion Foundation, https://apexfusion.org |
| Licence of this text | Open item. It is set before registration. |

## 1. Overview

`did:vector` identifies AI agents that are registered on the Vector ledger. Vector is a ledger of the Cardano family (eUTXO, Ouroboros Praos, Plutus V3). The ledger is the verifiable data registry.

A smart contract, the identity registry, holds one record for each agent. A record names:

- one controller key that can change the record;
- up to eight listed keys that act for the agent, each with one or more purposes;
- the parties that answer for the agent, and the guardians that can replace a lost controller key;
- a short public profile;
- a status: Active, Suspended, Revoked or Retired.

Properties:

- **No administrator.** Only the keys and parties that a record names can change it.
- **Accountability.** An agent can accept work only while it names a current Accountable Party.
- **Nothing disappears.** A revoked or retired identity stays on the ledger as a tombstone. Its history stays public.
- **Stable identifiers.** Records of the earlier registry keep their identifiers when they move to the identity registry.

## 2. Terms

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119 and RFC 8174.

| Term | Meaning |
|---|---|
| Identifier | 32 bytes that name one agent, written as 64 lowercase hexadecimal characters. It is also the asset name of the agent's identity token. |
| Identity token | A token that only the registry can mint. Exactly one exists for each identifier. It is never burned. |
| Record | The ledger output that holds the identity token and the record data. |
| Live record | An authentic record (Section 4) with status Active or Suspended. |
| Tombstone | An authentic record with status Revoked or Retired. It cannot become live again. |
| Controller key | The Ed25519 key that can change the record. Each record has exactly one. |
| Listed key | A key that acts for the agent. It cannot change the record. |
| Key purpose | What a listed key may do: authentication, assertion, transaction or delegation. |
| Key hash | `blake2b_224` of the public key bytes, written as 56 lowercase hexadecimal characters. |
| Party | A key, the controller, or the approved dispute contract, with a role for the agent. |
| Accountable Party | A party that answers for the agent. |
| Guardian | A party that can replace a lost controller key together with other guardians. |
| Author | The controller, or a party, that acts on a record. |
| Hold | One author's suspension of a record. Each author has at most one hold on a record. |
| Subagent | An agent that a parent agent starts. Nobody can hire it. It ends when its parent ends. |
| Effective status | The status that a relying party acts on (Section 7.3). |
| Seed | A ledger output that a registration spends. A ledger output can be spent only once. |
| Identity registry | The registry that this document defines. |
| Legacy registry | The registry that was in use before (Section 4). |
| Adoption | One transaction that moves a record from the legacy registry to the identity registry. The identifier does not change. |
| Cutoff slot | The ledger slot that separates the legacy records that can adopt from the legacy records that do not resolve (Section 4). |
| Confirmations | The number of blocks after the block of a transaction: tip block height − block height. A transaction with 30 or more confirmations is confirmed. |
| Version | One state of a record (Section 7.2). |
| AP3X | The currency of the Vector ledger. 1 AP3X = 1,000,000 base units. |

## 3. Method name and syntax

The method name is `vector`. The grammar is ABNF (RFC 5234) with case-sensitive strings (RFC 7405).

```abnf
did-vector        = %s"did:vector:" vector-id
did-vector-legacy = %s"did:vector:agent:" 56lowhex ":" vector-id
did-vector-net    = %s"did:vector:" network ":" vector-id   ; reserved
network           = %s"testnet"
vector-id         = 64lowhex
lowhex            = DIGIT / %x61-66                         ; 0-9 a-f
```

- `did:vector:<vector-id>` is the canonical form. It names an agent on Vector mainnet.
- `did:vector:agent:<policy>:<vector-id>` is the legacy form. It names the same agent. It resolves only for an identifier that the legacy registry minted. A legacy form with another policy resolves as `NOT_FOUND`.
- The `testnet` form is reserved. A resolver MUST answer it with `FEATURE_NOT_SUPPORTED`.
- Every character is lowercase. A DID with an uppercase character is `INVALID_DID`.

### 3.1 Identifier

```text
vector-id = hex( blake2b_256( serialise(seed) ) )
```

`serialise(seed)` is the Plutus Data CBOR of the seed's output reference, `Constr 0 [tx_id, output_index]`:

```text
D8 79 9F  58 20 <tx_id: 32 bytes>  <output_index: CBOR unsigned integer, shortest form>  FF
```

Implementations MUST reproduce these test vectors:

| `tx_id` | `output_index` | `serialise(seed)` | `vector-id` |
|---|---|---|---|
| 32 × `00` | 0 | `d8799f5820` + 32 × `00` + `00ff` | `a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9` |
| 32 × `ab` | 24 | `d8799f5820` + 32 × `ab` + `1818ff` | `3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b` |

Both registries use this derivation. Each registry mints a token only in a transaction that spends the seed, mints exactly one token and names it from the seed. A registration in the identity registry MUST NOT mint a legacy token in the same transaction. Thus one seed cannot give the same identifier twice, and an identifier is never used again.

### 3.2 DNS-safe form

A DNS label has at most 63 characters, so 64 hexadecimal characters do not fit. Where an identifier must be a DNS label, use RFC 4648 base32 of the 32 bytes, lowercase, without padding (52 characters). It is a rendering of the identifier, not a separate identifier.

| `vector-id` | DNS-safe form |
|---|---|
| `a2e5e227…45f4c9` | `uls6ej4fr2cpdkhzwdasi3tmxsjtnvyh2q52ipiods34khcf6teq` |
| `3ddd0751…51c52b` | `hxoqoulsaxoyu5cyq7btuco2bzff2y64uhyvdtxo3lxnubkryuvq` |

## 4. Registries

| Registry | Policy ID (= script hash) | Address | Use |
|---|---|---|---|
| Identity registry | `d958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762` | `addr1w8v43wprl248d9mapgrmm93zap7cuty97e5j7luw3kmhwcs8vm9vk` | New records and adopted records |
| Legacy registry | `be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01` | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` | Records minted before the cutoff slot. They resolve as legacy records until they adopt. A deregistration deactivates them. |
| Test registry | `5dd5118943d5aa7329696181252a6565a27dbf2c6de92b02a6aae361` | — | Not supported. Its DIDs resolve as `NOT_FOUND`. |

The deployment of the identity registry also publishes these values ([`contracts/identity-marketplace/deploy/mainnet/`](../contracts/identity-marketplace/deploy/mainnet/README.md)):

- **Cutoff slot.** It is fixed before the identity contract is compiled: slot 37,218,553 (2026-11-03T11:09:13Z).
- **Allowlist.** Every identifier that the legacy registry minted in a slot before the cutoff slot: 794 identifiers ([`allowlist.json`](../contracts/identity-marketplace/deploy/mainnet/allowlist.json)). Only these identifiers can adopt. Their Merkle root `e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01` is a parameter of the identity contract (Section 3 of the implementation plan).
- **Dispute contract.** The policy ID of the configuration token, `c6a8cd37643ec0fffab66807bb53be5903d7ecda887d8af4a085f55a`, and the script hash of the approved dispute contract (Module-1) that the token names: `f6b094a89b58d5e196a53d6e5ebedcbb837db4a1b16a1477cf98305d`. The configuration record `dea7fd5baef73c0216e1098fe9db7a86561666ff4f6f3a44738df8f666cd379b#0` holds the token and this hash. Nobody can spend it.

A record is authentic only when both conditions are true:

- It is an unspent output at the exact address of its registry: the registry's script as payment credential and no stake credential.
- It holds exactly one token of the registry's policy, and the asset name of that token is the identifier.

The legacy registry contract cannot change, and it still accepts new registrations. A legacy record stores one owner key hash and a self-declared profile.

The network is Vector mainnet: network magic 764824073, system start 2025-08-29T16:40:00Z, one slot per second, security parameter k = 2160. The Vector testnet uses the same network magic, so a resolver MUST identify mainnet by its genesis values, not by its magic.

## 5. Record format

A record's inline datum is Plutus Data. The field order is part of the format. Constructors are numbered from 0 in the order shown.

```aiken
pub type IdentityDatum {               // Constr 0, 14 fields
  controller: ByteArray,                // Ed25519 public key, 32 bytes
  keys: List<Key>,                      // 0..8
  parties: List<Party>,                 // 0..8
  guardian_threshold: Int,              // 0 = no recovery
  pending_recovery: Option<PendingRecovery>,
  lineage: Lineage,
  subagent_epoch: Int,
  name: ByteArray,                      // UTF-8 text
  description: ByteArray,               // UTF-8 text
  framework: ByteArray,                 // UTF-8 text
  endpoint: ByteArray,                  // UTF-8 URL
  capabilities: List<ByteArray>,        // UTF-8 text items
  created_at: Int,                      // POSIX milliseconds
  status: Status,
}

pub type Key { key_type: KeyType, key: ByteArray, purposes: Int, pop: Option<ByteArray> }
pub type KeyType { Ed25519  P256 }

pub type Signer {
  KeyHash { hash: ByteArray }           // 28 bytes
  Script { hash: ByteArray }            // 28 bytes; only the approved Module-1 contract
  ControllerSet                         // whoever is the record's controller
}

pub type Role { Accountable  Responsible  Provider  Distributor  Guardian }

pub type Party {
  role: Role,
  signer: Signer,
  organisation: Option<ByteArray>,      // UTF-8 DID or domain of an organisation, 1..64 bytes
  not_before: Int,
  not_after: Option<Int>,
  rights: Int,                          // bits: 1 suspend, 2 revoke, 4 recover
  removal_after: Option<Int>,
}

pub type Lineage { Root  Subagent { parent: ByteArray, parent_epoch: Int, depth: Int } }

pub type Status {
  Active
  Suspended { holds: List<Hold> }       // 1..10, at most one for each author
  Revoked { by: Signer, reason: Int, at: Int, invalid_from: Option<Int>, successor: Option<ByteArray> }
  Retired { at: Int, successor: Option<ByteArray> }
}

pub type Hold { by: Signer, reason: Int, since: Int, until: Int }

pub type PendingRecovery { new_controller: ByteArray, effective_after: Int }

/// Legacy registry record: Constr 0 with 7 fields.
pub type LegacyDatum {
  owner: Credential,                    // VerificationKey(hash) or Script(hash)
  name: ByteArray,
  description: ByteArray,
  capabilities: List<ByteArray>,
  framework: ByteArray,
  endpoint: ByteArray,
  registered_at: Int,                   // self-declared; not used
}
```

Every time is a POSIX millisecond value in `[0, 253,402,300,799,999]` (up to the end of the year 9999). All other integers are in `[0, 2^63)`.

**Keys**

| `key_type` | `key` | `pop` | Allowed purposes |
|---|---|---|---|
| `Ed25519` | 32 bytes | none | authentication (1), assertion (2), transaction (8), delegation (16) |
| `P256` | 33 bytes, compressed point | 64-byte ES256 signature by this key over the UTF-8 string `did:vector:<vector-id>#<key hash>` | authentication (1), assertion (2) |

- `purposes` is a sum of allowed purpose values, at least one. The value 4 is not used, so a valid sum has no bit outside 27.
- The `pop` signature is ECDSA P-256 with SHA-256, written as `r ‖ s` (32 bytes each, big-endian). A verifier accepts both forms of `s`.
- A record lists no key twice, also not with other purposes. The controller key MAY also be a listed key.
- The fragment of a key is its key hash.

**Parties**

| Role | Highest rights | Allowed signers |
|---|---|---|
| Accountable | suspend, revoke | key hash, Module-1, controller |
| Responsible | suspend | key hash, Module-1, controller |
| Provider | suspend | key hash |
| Distributor | none | key hash |
| Guardian | recover | key hash |

- A party's rights are within the highest rights of its role.
- No two parties have the same role and the same signer.
- A party covers a time range when `not_before` is at or before its start, and `not_after` is empty or at or after its end.
- `organisation` names an organisation, never a person. The record states it; nothing on the ledger verifies it.

**Recovery.** `guardian_threshold` is the number of guardians that must act together. When the parties or the threshold change, it is at most the number of distinct guardian signers with the recover right whose `not_after` has not passed. A recovery can be pending only when the threshold is at least 1.

**Holds.** A suspended record has 1–10 holds, at most one for each author. A hold lasts at most 30 days from `since` to `until`. At most 9 holds come from current authors (the controller and up to 8 parties); one more can come from Module-1 after its removal (Section 6).

**Profile limits:** `name` 1–64 bytes; `description` and `endpoint` up to 256 bytes; `framework` up to 64 bytes; up to 16 `capabilities` of 1–64 bytes each, without duplicates. A subagent has an empty `endpoint`.

**Lineage:** a subagent names its parent's identifier, the parent's `subagent_epoch` at creation, and its depth (1–4).

## 6. Operations

All operations are ledger transactions. The identity registry contract checks them. The complete contract rules are in Section 3 of the implementation plan. Each transaction has a validity range of at most one hour. `created_at` is the upper bound of the range of the creating transaction. Status times are the lower bound of the range. Delays that protect others are counted from the upper bound.

**Create.**

- *Register:* the transaction spends a seed and mints one identity token named from the seed (Section 3.1). The record starts with status Active and at least one Accountable Party that covers the transaction's range. The controller key, each listed Ed25519 key and each party sign.
- *Adopt:* the transaction burns the token of a legacy record and mints an identity token with the same name. The identifier must be on the allowlist (Section 4). The legacy owner key also signs.
- *Subagent:* a Register whose lineage names a parent. The parent's controller also signs, and the parent's effective status must be Active.

**Read.** See Sections 7 and 8.

**Update.** These actions keep the record live:

| Action | Authorised by | Effect |
|---|---|---|
| Update | controller | Changes the profile, the listed keys, the parties and the guardian threshold. Each new Ed25519 key signs. Each new or changed party signs, except when the only change is a removal notice of at least 7 days. A removed key cannot act after its removal; its earlier signatures stay valid. The controller removes a party only 7 days after it announces the removal, unless the party signs. A threshold of 0 cancels a pending recovery. |
| Change controller | old and new controller keys | Installs a new controller key. Ends all subagents (the epoch increases). Cancels a pending recovery. Holds stay. |
| Suspend | controller, or a party with the suspend right | Adds or renews the author's own hold, for at most 30 days. Holds of other authors stay, except the hold of a removed key party. |
| Unsuspend | the author of a hold | Removes that author's hold. A hold also ends at its end time. When no hold remains, the status is Active. |
| Start recovery | enough guardians, and the new controller key | After 7 days, anybody can complete it. Only one recovery can be pending. |
| Cancel recovery | enough guardians | Removes the pending recovery. |
| Complete recovery | anybody, after the delay | Installs the new controller key. Ends all subagents. |
| End subagents | controller | Increases the epoch. All subagents created under an older epoch end. |

**Deactivate.** Two final actions create a tombstone. The token stays. Keys, parties, holds and most profile fields are cleared; the controller, name, lineage and history stay.

- *Revoke:* by the controller or by a party with the revoke right. It records a reason code (Appendix A of the implementation plan) and an optional "invalid from" time. A key-compromise revocation requires it. Signatures made at or after that time by the keys of the identity, or of its subagents, are invalid. Only the controller can name a successor.
- *Retire:* by the controller, with an optional successor.

**Successor.** The tombstone's controller can name a successor once, in the final action or later. This also applies after a party revoked the identity. The successor is another live identity without a parent, and its controller signs. A successor is a statement of the controller. A relying party checks the reason and the author of the revocation before it trusts the link.

**Deposit.** The tombstone's controller can take back the deposit above the ledger minimum.

**Dispute contract.** Module-1 is the only contract that can be a party. It acts only through verdicts: a hold with reason 64 for a fixed time, or a revocation with reason 64, without "invalid from" time and without successor. Each verdict applies once, and a later verdict never shortens a Module-1 hold. A Module-1 hold ends only at its end time, also when the controller removes Module-1. The controller can remove Module-1 after 7 days' notice; verdicts after the removal do not apply.

**Parties cannot resign.** A party stops acting at its `not_after`, or when the controller removes it.

**Legacy deregistration.** The owner of a legacy record can deregister it under the legacy rules. The transaction burns the legacy token and mints no identity token. The DID is then deactivated with status Retired.

## 7. Resolution

### 7.1 Algorithm

1. If the input is not a DID, return `INVALID_DID`. If its method is not `vector`, return `METHOD_NOT_SUPPORTED`. If it does not match Section 3, return `INVALID_DID`.
2. Read the options. An option that is not in the table below gives `FEATURE_NOT_SUPPORTED`. Then an invalid value, a repeated option, or both `versionId` and `versionTime` give `INVALID_OPTIONS`. The media type comes only from the `Accept` header (Section 7.4).
3. The testnet form gets `FEATURE_NOT_SUPPORTED`. A legacy form with another policy gets `NOT_FOUND`.
4. If the identity registry minted the identifier, use its history. For an adopted record, the history starts with its legacy versions. A request in the legacy form for an identifier that the legacy registry never minted gets `NOT_FOUND`.
5. Else, if the legacy registry minted the identifier in a slot before the cutoff slot, use the legacy history. A legacy identifier minted at or after the cutoff slot gets `NOT_FOUND`.
6. Else, return `NOT_FOUND`.
7. Build the view (Section 7.2), compute the effective status (Section 7.3), and build the document and the metadata (Section 8).

| Option | Valid values |
|---|---|
| `versionId` | `0`, or a decimal number without leading zeros |
| `versionTime` | `YYYY-MM-DDThh:mm:ssZ` (UTC, no fractions): a real calendar date, hours 00–23, minutes and seconds 00–59 |
| `expandRelativeUrls` | `true` or `false`. With `true`, the document uses complete DID URLs instead of `#<key hash>`. |
| `noCache` | `true` or `false`. It has no effect, because a result depends only on the ledger tip. |

The origin of an identity-registry record is `adopted` when the transaction that minted its token also burned the legacy token, else `native`. A legacy record has origin `legacy`. Every version of a record shows the origin of the record, also a legacy version of an adopted record.

If the resolver cannot read the ledger, it returns `INTERNAL_ERROR`. It never returns `NOT_FOUND` or a partial document for a failed read. An identity-registry record output whose datum is not inline or does not decode as Section 5, and an identity token that was burned, cannot exist under the contract; a resolver that sees one also returns `INTERNAL_ERROR`.

### 7.2 Versions and confirmations

- **Versions.** Version 0 is the record output of the first mint. A later transaction adds one version when the datum of the record output that it writes differs, as Plutus Data, from the datum of the record output that it spends. The adoption adds one version. A legacy deregistration adds one version, which ends the record. A transaction that changes only the value, such as a deposit reclaim, adds no version. Only authentic record outputs make versions; a token outside an authentic output is handled by Section 7.3, rule 6.
- **Owned outputs.** A version owns the record output of its transaction and the record outputs of later transactions that change only the value, up to the next version. When a token returns from an output that is not authentic to an authentic record output, the resolver compares the new datum with the datum of the last authentic record output.
- **Version time.** The block time of the transaction that made the version.
- **Confirmed version.** A version whose transaction has at least 30 confirmations.
- **Request time `t`.** Without a version option, `t` is the time of the tip. With `versionTime`, `t` is the requested time or the time of the tip, whichever is earlier. With `versionId`, `t` is the version time of the selected version.
- **Base and pending versions.**
  - With `versionId`, the base is that version. If the version does not exist or is not confirmed, the result is `NOT_FOUND`. There are no pending versions. All transactions count.
  - Otherwise, without an option all transactions count, and with `versionTime` only the transactions with a block time before the requested time count (as in DID Resolution). The base is the newest confirmed version among the counted versions. If none exists, the result is `NOT_FOUND`. The pending versions are the later counted versions.

**View.** The resolver starts from the base. It takes from the pending versions only the changes that reduce what the record allows:

| Element | Value in the view |
|---|---|
| Controller key | The base controller key, only when every pending version has the same controller key. Else none. |
| Listed keys | Each key of the base that every pending version also lists, with only the purposes that all these versions give it. |
| Parties | Each party (same role and signer) of the base that every pending version also has. Its rights are the rights that all these versions give. Its `not_before` is the latest value, and its `not_after` and `removal_after` are the earliest values (an empty value is no limit). Other fields come from the base. |
| Status | Suspended with the merged holds when the base is live and the merged holds are not empty. Else the status of the base. |
| Holds | For each author with a hold in the base or in a pending version: the whole hold (reason, since, until) from the newest of these versions that has the latest `until` for that author. Order: the authors of the base in base order, then new authors in ledger order. |
| Pending recovery | The newest pending recovery of the base or of a pending version. |
| Capabilities | Each capability of the base that every pending version also has. |
| Other fields | From the base. |

- **End not yet confirmed.** When a pending version is a tombstone or the end of a legacy record, the effective status is Suspended (Section 7.3, rule 4). The DID becomes deactivated only when that version is confirmed.
- **Adoption not yet confirmed.** When the base is a legacy version and the adoption is a pending version, the view is computed from the base and the pending legacy versions before the adoption, with the rules above. The adoption and the later versions do not count until the adoption is confirmed.
- **End of a legacy record.** That version has no datum. As a base, it shows only `createdAt` in the profile. As a pending version, it removes every key, capability and party from the view.
- **Legacy versions.** The controller key of a legacy version is the key that Section 8.1 finds for the owner hash.

### 7.3 Effective status

The resolver computes the effective status at time `t` from the view. For a subagent, it computes the view and the effective status of the parent at the same `t`, with the same rules, and so in turn of each ancestor. For an ancestor, the counted transactions are: without an option, all; with `versionTime`, those with a block time before the requested time; with `versionId`, those with a block time at or before `t`. The first rule that applies gives the result:

1. The view has status Revoked or Retired (a tombstone, or the end of a legacy record): that status.
2. The newest confirmed version of the record, or of an ancestor, has status Revoked with an "invalid from" time at or before `t`, also when that version is later than `t`: Revoked (`invalidated`, or `parentRevoked` for an ancestor).
3. The effective status of the parent is Revoked or Retired: the same status (`parentRevoked` or `parentRetired`). Also, when the subagent epoch of the parent's base version is greater than the subagent's `parent_epoch`: Revoked (`parentRevoked`).
4. Rule 1, 2 or 3 would apply if all unconfirmed versions of the record and of its ancestors were confirmed: Suspended (`deactivationPending`).
5. The effective status of the parent is Suspended: Suspended (`parentSuspended`).
6. The newest counted transaction of the record's token with a block time at or before `t` left the token in an output that is not authentic (Section 4): Suspended (`notAuthentic`). The record continues when the token returns to an authentic output.
7. A hold of the view has `until` after `t`: Suspended.
8. No Accountable Party of the view covers `t`: Suspended (`unaccountable`).
9. Else: Active.

A legacy version names no Accountable Party. For a view that is a legacy version, rule 8 is replaced: before the cutoff slot, it does not apply; from the cutoff slot on, it gives Suspended (`unaccountable`). This rule is part of the method; nobody acts to apply it.

The DID is deactivated at `t` when the effective status at `t` is Revoked or Retired.

**Version options.** A result for `versionId` or `versionTime` describes time `t`. It also carries the effective status without options (`vectorCurrent`, Section 8.2). Its `deactivated` metadata is `true` when the DID is deactivated at `t` or now, and then its HTTP status is 410 (Section 7.4). Its document is `null` only when the DID is deactivated at `t`. DID Resolution returns no document for a deactivated DID; this method returns the document at `t`, so that verifiers can check signatures made before the end.

**Relying parties.** A relying party MUST NOT accept a new action by a key unless a resolution without version options gives effective status Active and lists the key with the needed purpose. It MUST NOT take version options for this check from a DID URL that the signer chose.

### 7.4 HTTPS binding

`GET /1.0/identifiers/{did}`, as defined by DID Resolution v1.0. Options are query parameters. The resolver percent-decodes the path once. It reads the `Accept` header as RFC 9110 specifies: the most specific media range that matches a media type gives the weight of that type, and `q=0` makes that type not acceptable. The resolver ignores media ranges with a malformed `q`. Parameters other than `q` and `profile` are ignored. `application/*` matches both representations. The highest `q` wins. On a tie, the resolution result wins.

| `Accept` media range | Response |
|---|---|
| None, `*/*`, `application/did-resolution`, `application/ld+json;profile="https://w3id.org/did-resolution"` | Resolution result, `Content-Type: application/did-resolution` |
| `application/did`, `application/did+json`, `application/did+ld+json`, `application/ld+json`, `application/json` | DID document only, `Content-Type: application/did` |
| No supported media range | `REPRESENTATION_NOT_SUPPORTED` |

Errors and results with `deactivated: true` always get the resolution result. The body is the JCS (RFC 8785) serialisation. Every response has `Cache-Control: no-store`.

| Result | HTTP status |
|---|---|
| Found, not deactivated (also with effective status Suspended) | 200 |
| Deactivated (`deactivated: true`), with or without a document | 410 |
| `INVALID_DID`, `INVALID_OPTIONS` | 400 |
| `NOT_FOUND` | 404 |
| `REPRESENTATION_NOT_SUPPORTED` | 406 |
| `METHOD_NOT_SUPPORTED`, `FEATURE_NOT_SUPPORTED` | 501 |
| `INTERNAL_ERROR` | 500 |

## 8. DID document and metadata

### 8.1 Document

```json
{
  "@context": "https://www.w3.org/ns/did/v1.1",
  "id": "<document id>",
  "alsoKnownAs": ["https://<verified domain>"],
  "verificationMethod": [
    {
      "id": "<document id>#<key hash>",
      "type": "Multikey",
      "controller": "<document id>",
      "publicKeyMultibase": "z…"
    }
  ],
  "capabilityInvocation": ["#<controller key hash>"],
  "authentication": ["#<key hash>"],
  "assertionMethod": ["#<key hash>"],
  "capabilityDelegation": ["#<key hash>"]
}
```

- The document id is the DID in the request, in the canonical or the legacy form.
- `publicKeyMultibase` is base58btc (prefix `z`) of a multicodec header and the key: `0xed 0x01` and 32 bytes for Ed25519; `0x80 0x24` and the 33-byte compressed point for P-256.
- The controller key is the only entry in `capabilityInvocation`. A listed key is in `authentication`, `assertionMethod` and `capabilityDelegation` according to its purposes (1, 2 and 16). The transaction purpose (8) is shown only in the metadata.
- Order: the controller key first, then the listed keys in datum order. Each key appears once in `verificationMethod`, also when the controller key is a listed key. Empty lists are left out. A view without a controller key has no `capabilityInvocation`.
- With `expandRelativeUrls=true`, each `#<key hash>` reference is the complete DID URL.
- A P-256 key appears only when its `pop` is a valid signature. Else the resolver leaves it out of the document and of `vectorKeys`, and sets `vectorMetadataError`.
- `alsoKnownAs` lists only domains whose link to the DID the resolver verified (DIF Well Known DID Configuration, or a DNS TXT record `_did.<domain>` that names the DID). It is left out when there are none. Aliases that a resolver operator issues, such as a `did:web` alias, are not in the document.
- The document has no `service` entries. The profile is in the metadata.
- **Legacy record:** the legacy registry stores only the owner key hash. The resolver takes the public key from the newest vkey witness whose key hash is the owner hash, among the counted transactions of the record's own token, up to the last one that the base version owns. This key is in `capabilityInvocation`, `authentication` and `assertionMethod`. Without such a witness, the document has no keys, and the metadata has `vectorMetadataError: "controllerKeyNotFound"`.
- **Deactivated DID:** when the DID is deactivated at `t`, the result has `didDocument: null`.

### 8.2 Document metadata

| Property | Value |
|---|---|
| `created` | Block time of the transaction that first minted the identifier, in either registry. |
| `updated` | Version time of the base. Not present for version 0. |
| `versionId` | The base version (Section 7.2), as a decimal string. |
| `nextVersionId` | Present when a later confirmed version exists. |
| `deactivated` | `true` when the DID is deactivated at `t`, or, for a request with a version option, now (Section 7.3). |
| `vectorCurrent` | Requests with a version option only: `{ effective, effectiveReason }` of the same DID without options. |
| `canonicalId` | `did:vector:<vector-id>` |
| `equivalentId` | `["did:vector:agent:<legacy policy>:<vector-id>"]` for a request in the canonical form when the origin is `adopted` or `legacy`. |
| `vectorOrigin` | `native`, `adopted` or `legacy`: the origin of the record. |
| `vectorStatus` | `{ status, effective, effectiveReason, holds, by, reason, at, invalidFrom, successor }`. Each member is present only when it applies. `status` is the status of the view, and `effective` is the effective status. Both are `active`, `suspended`, `revoked` or `retired`. For a legacy version, `status` is `active`, or `retired` after the end of the record. `effectiveReason` is a reason name of Section 7.3. `holds` is `[{ by, reason, since, until }]`. `by`, `reason`, `at` and `successor` come from a tombstone. For the end of a legacy record, `at` is the block time of that transaction. `successor` is shown as `did:vector:<id>`. `invalidFrom` is the earliest "invalid from" time in the newest confirmed versions of the record and its ancestors. |
| `vectorKeys` | `[{ id, type, purposes }]` for each listed key, in datum order. `id` is `#<key hash>`. `type` is `Ed25519` or `P-256`. `purposes` lists `authentication`, `assertion`, `transaction` and `delegation`, in this order, as they apply. |
| `vectorParties` | `[{ role, signer, organisation, organisationVerified, rights, notBefore, notAfter, removalAfter }]`, in datum order. `role` is `accountable`, `responsible`, `provider`, `distributor` or `guardian`. `rights` lists `suspend`, `revoke` and `recover`, in this order, as they apply. |
| `vectorRecovery` | `{ guardianThreshold, pendingNewController, pendingEffectiveAfter }`, present only when `guardianThreshold` is at least 1. `pendingNewController` is a key hash. |
| `vectorParent` | Subagents only: `{ parent: "did:vector:<id>", parentEpoch, depth }`. |
| `vectorProfile` | `{ name, description, framework, endpoint, protocol, capabilities, createdAt }`. `protocol` is `a2a`, `mcp` or `web`, as detected at the endpoint. For a legacy version, the fields come from the legacy datum, and `createdAt` is the block time of the legacy mint. |
| `vectorLedger` | `{ txId, outputIndex, blockHash, blockHeight, slot, confirmations }` of the newest counted record output that the base version owns. For the end of a legacy record, that transaction without `outputIndex`. |
| `vectorPending` | The transaction IDs of the pending versions, in ledger order. Not present when there are none. |
| `vectorFetched` | For each value that depends on a fetch (verified domains, `organisationVerified`, `protocol`): the URL, the fetch time and the SHA-256 of the fetched bytes. |
| `vectorMetadataError` | `controllerKeyNotFound`, `controllerIsScript`, `recordDatumInvalid`, `recordDatumUnavailable` or `keyProofInvalid`. |

- A signer is shown as a key hash, as `script:<script hash>`, or as `controller`. A reason is shown as its name in Appendix A of the implementation plan; a code without a name there is shown as a decimal string. Key hashes, script hashes and transaction IDs are lowercase hexadecimal.
- Times use the form `YYYY-MM-DDThh:mm:ssZ` (UTC). Milliseconds are rounded down to whole seconds. The block time is the system start plus the slot number in seconds.
- A text field or capability item that is not valid UTF-8, or that contains a surrogate code point or a noncharacter (RFC 7493), is left out.
- In every object of this section, a member whose value is `false`, none, an empty string or an empty list is left out.

The resolution metadata is `{"contentType": "application/did"}` when the result has a document, and `{}` when it has none. On an error it is `{"error": {"type": "https://www.w3.org/ns/did#<NAME>", "title": "<text>"}}`.

Two resolvers that read the same ledger tip give byte-identical results, except `alsoKnownAs`, the values listed in `vectorFetched`, and the `title` of an error.

A profile and an organisation name are statements of the record's controller and parties. They are not verified facts.

## 9. Security considerations

**Authorisation is on the ledger.** The registry contract checks every change. A resolver cannot change a record.

**Trust in the resolver and its data.** A resolver reads the ledger through its data sources. The reference resolver uses Koios and Ogmios, and by default these are Foundation endpoints. Results are not signed. The HTTPS binding uses TLS, which protects against eavesdropping and modification in transit (man-in-the-middle), but not against a dishonest resolver or data source. For independent verification, run your own node, indexer and resolver, or compare several resolvers.

**One controller key.** A thief who holds the controller key controls the identity. The thief can change keys, the profile and the controller, and the controller change also cancels a pending recovery. The thief can also name a successor, if the controller did not name one before. The thief can remove a party only after 7 days' notice, unless the party agrees. During that time, a party with the revoke right can revoke the identity. Organisations SHOULD therefore appoint an Accountable Party with the revoke right whose key is held apart from the controller key. If the owner loses the controller key, guardians can install a new one after 7 days. Without guardians, the record freezes.

**Listed keys.** A key acts only for its purposes. A thief who holds a listed key acts for the agent within those purposes until the controller removes the key. Removal works only forward: earlier signatures stay valid. A verifier that must know whether a key was listed at a given time resolves the DID with `versionTime`. For a new action, the verifier also needs the current status (Section 7.3). For a compromise, the controller or an Accountable Party revokes the identity with an "invalid from" time. That time also applies to all subagents.

**Proof of possession.** Each Ed25519 key signs the transaction that adds it. The ledger cannot check P-256 signatures, so a P-256 key carries a signature that resolvers check. A resolver does not show a P-256 key with an invalid proof.

**Parties and holds.** Each party signs its own appointment. Rights are limited by role. Each author has its own hold of at most 30 days, and only that author can lift it before it ends. Thus one author cannot cancel or block the hold of another current author. The controller can end the hold of a key party only by removing that party, which needs the party's consent or 7 days' notice. A Module-1 hold always lasts until its end time. A party cannot leave by itself. The only contract that can hold party rights is the approved dispute module (Module-1). It acts only through its own verdict rules.

**Final states.** Revocation and retirement cannot be undone. A tombstone keeps the identity visible forever. A successor needs its own controller's consent, but the link is only a statement of the old controller (Section 6).

**Subagents.** A subagent ends when its parent ends, when the parent's controller changes, when a recovery completes, or when the parent ends all subagents. Nobody can hire a subagent.

**Legacy records.** The legacy registry is weaker. It stores only an owner key hash, and its owner can change that hash to any key without that key's signature. Thus the resolver shows a legacy key only after that key signed a transaction of the record. Adoption needs the legacy owner's signature and an allowlisted identifier. Legacy identifiers minted at or after the cutoff slot resolve as `NOT_FOUND`.

**Unique identifiers.** Uniqueness across both registries depends on the legacy Register rules (Section 3.1). The implementation tests these rules against the deployed legacy script before deployment.

**Front-running and replay.** The identifier comes from a seed that the registrant owns. Each change spends the current record output, so an old transaction cannot run again.

**Time.** Each transaction's validity range is at most one hour. `created_at` is the upper bound, so a record can look up to one hour younger, never older. Delays that protect others (party removal, recovery) are counted from the upper bound.

**Insertion and double satisfaction.** Anybody can send outputs to the registry address. An output without an identity token is not a record, and readers ignore it. A transaction may spend at most one identity record.

**Deletion.** Nobody can delete a record. The token is never burned, and a tombstone stays.

**Ledger reorganisation.** A recent change can disappear when the ledger selects another chain. Resolvers show changes that reduce what a record allows at once, and other changes only after 30 confirmations (Section 7.2). A final action shows as a suspension until it has 30 confirmations, so a rollback rarely leaves a wrong deactivation. A rollback deeper than 30 blocks can still undo a confirmed change. With k = 2160, a change is final with overwhelming probability after 2160 blocks.

**Amplification.** Resolution itself needs no fetch. A resolver that verifies domains or detects protocols fetches URLs that registrants choose. Such a resolver MUST:

- fetch in the background, never during a resolution request;
- fetch only `https` URLs whose host resolves to a public unicast address, checked for each connection and each redirect;
- not follow a redirect to another host;
- limit the size, the time and the rate per host of its fetches.

**Denial of service.** The work for one request is limited to the history of one record and its ancestors, at most five records. A resolver SHOULD cache each record's history for each ledger tip. The public resolver applies a rate limit per client address.

**Residual risks.** The contracts cannot change after deployment and have no external audit. A defect stays until a new registry replaces them. A compromise of a resolver's data sources (Koios, Ogmios) gives wrong results to clients that trust them. A weakness in Ed25519, ECDSA P-256, BLAKE2b or SHA-256 weakens the identifiers, the keys and the proofs.

## 10. Privacy considerations

**Everything in a record is public and permanent.** The ledger keeps all versions of each record, including keys, parties, profile and status. A tombstone stays visible forever. Anybody can collect records for other purposes.

**No personal data.** A profile and an organisation name MUST NOT contain personal data, such as the name, email address or telephone number of a person. A person can appear only as a key hash.

**Linkage.** Each transaction that a record's keys sign is linkable to the agent. The funding of the seed and the deposit is visible. Parent links of subagents show organisational structure. An operator who wants unlinked identities uses separate keys and funding for each identity.

**Surveillance.** A resolver operator sees which client asks for which DID. A client that must hide this runs its own resolver. The Foundation resolver writes no request log. Its web proxy writes an access log that contains the request path, and thus the DID. The Foundation publishes the retention time of that log at `https://id.vector.apexfusion.org/policy`.

**Unsolicited traffic.** A record's endpoint is public, so anybody can send requests to it. A resolver that detects protocols or verifies domains also sends requests to endpoints and organisation domains.

**Misattribution and exclusion.** A profile and an organisation name are self-declared. A record can name an organisation without its consent, and that organisation cannot remove its name from the ledger. A resolver marks an organisation as verified only after a domain link proves it. A legacy owner hash can name a key whose holder never agreed; see Section 9.

**Stored data compromise.** The ledger stores no secrets. A service that issues tokens for a DID holds its own signing keys. If an attacker gets those keys, the attacker can issue tokens until the service replaces the keys.

## 11. Reference implementation and registration

| Item | Location |
|---|---|
| Contracts (Aiken) | `contracts/identity-marketplace/` in https://github.com/Apex-Fusion/agents-marketplace |
| Resolver and gateway | `identity-gateway/` in the same repository. Licence: Apache-2.0, pending Foundation approval. |
| Public resolver | `https://id.vector.apexfusion.org/1.0/identifiers/{did}` |
| Universal Resolver driver | `ghcr.io/apex-fusion/uni-resolver-driver-did-vector:<version>` |

Registration entry for `w3c/did-extensions`:

```json
{
  "name": "vector",
  "status": "registered",
  "specification": "<permalink to this file at a fixed commit>",
  "verifiableDataRegistry": "Vector (Apex Fusion) eUTXO ledger",
  "contactName": "Apex Fusion Foundation",
  "contactEmail": "<open item>",
  "contactWebsite": "https://apexfusion.org"
}
```

After the deployment, a second pull request changes the permalink to a commit that contains the values of Section 4.
