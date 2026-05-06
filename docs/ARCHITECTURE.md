# Local Agents Marketplace — Architecture (v1)

> Status: accepted for M0–M1 implementation
> Dated: 2026-04-24
> Scope: MVP validating "can agents drive prompts through a buyer → on-chain escrow → supplier inference path on Vector L2 / Cardano" — starting with a CPU-bound supplier on Hetzner.

---

## 1. Goal and scope

**What this is.** A two-sided marketplace where buyers (agents or humans) submit prompts to suppliers running inference on their own hardware, pay with AP3X via on-chain bonded escrow on Vector L2, and receive signed-receipt responses. The primary validation goal is **technical feasibility + lifecycle** ("can it be done end-to-end"), not demand modelling or economic stress testing.

**What v1 is NOT.**
- Not agentic on the supplier side. Suppliers answer single prompts. Buyer agents drive multiple prompts.
- Not LLM-only in design. Capability model is open from day 1 (whisper / kokoro / image generation are planned siblings), but the first supplier is an LLM.
- Not multi-slot. Single-slot per supplier process. Multi-capability operators run multiple processes.
- Not multi-chain. Vector testnet first, mainnet later. Masumi / Sokosumi / USDM is target #2 (adapter, not fork).
- Not disputed. M1 ships happy-path escrow only. Module-1 disputes wire in M2.
- Not streaming. `stream: true` is rejected by suppliers.
- Not tool-calling. `tools` / `tool_choice` / `functions` are rejected by suppliers.
- Not privacy-preserving end-to-end. TLS to supplier only, SaaS-parity model, documented in supplier ToS.

## 2. Decisions resolved (Q&A → architecture inputs)

| # | Decision |
|---|---|
| 1 | Payment token: **AP3X** (Vector testnet, later mainnet). Masumi = USDM, target #2. |
| 2 | v1 scope: **Option C** — happy-path escrow only, no disputes. Module-1 wiring is milestone 2. |
| 3 | Module-1 contract source: TBD — to be located or restored before M2. Not blocking M0–M1. |
| 4 | Evidence: **signed receipt** `{prompt_hash, response_hash, model, tokens, wallclock}` + Ed25519 supplier signature. Hash on-chain, plaintext off-chain. |
| 5 | Capability model: **one capability per supplier process**, flat-per-prompt pricing. Multi-capability operators run multiple processes. |
| 6 | Supplier status: **polled** by indexer every ~20 s, staleness visible to buyers. |
| 7 | Supplier registry: **separate script hash** from Module-1, independently indexed. |
| 8 | First capability: `llm.text.generate.v1` — single-shot, no tools, no stream, flat-per-prompt, tiny Ollama (`qwen2.5:0.5b`) on CPU. |
| 9 | Tests: three-tier (mock / Ogmios read-only / real chain) **with an explicit `ChainProvider` interface** from day 1. Real CBOR fixtures. Independent buyer/supplier fixture construction. |
| 10 | Chain follower: extend the apex-dashboard pattern (Node.js + Ogmios + SQLite + REST/SSE). |
| 11 | Supplier process: **single-slot**. |
| 12 | Pricing race: buyer's escrow datum **references the ad UTxO** (spec-lock). Supplier honors the price in the referenced ad or lets the escrow time out. |
| 13 | SLA: supplier publishes `max_processing_ms` in the advertisement. Buyer sets `deliver_by = posted_at + max_processing_ms + network_buffer`. |
| 14 | Bonds: **symmetric 1 AP3X** on both sides. Buyer miss → forfeits bond. Supplier miss → forfeits bond. |
| 15 | Endpoint auth: `X-Escrow-Ref` header. Supplier verifies escrow on-chain before computing. |
| 16 | Privacy: SaaS-parity. TLS to supplier. Documented in ToS. |

## 3. Component diagram

```
┌──────────────────┐                         ┌────────────────────────┐
│  Buyer app       │   HTTP + X-Escrow-Ref   │  Supplier node         │
│  (web UI + lib   │────────────────────────▶│  FastAPI / Node        │
│   for agents)    │                         │  /capability           │
│                  │                         │  /status               │
│  optional:       │                         │  /v1/chat/completions  │
│  OpenRouter      │                         │          │             │
│  client-side     │                         │          ▼             │
│  fallback        │                         │   Ollama (local LLM)   │
└────────┬─────────┘                         └──────────┬─────────────┘
         │                                              │
         │  REST / SSE                                  │
         ▼                                              │
┌──────────────────────────────┐                       │
│  Indexer                     │◀──── poll /status ────┘
│  (chain follower + status    │
│   poller, SQLite + REST/SSE) │
└──────────────┬───────────────┘
               │
               │  Ogmios (chain-sync + queryLedgerState)
               ▼
┌──────────────────────────────────────────────────────────────┐
│                     Vector L2 (Cardano)                      │
│  AdvertScript          EscrowScript       (Module-1, M2+)    │
└──────────────────────────────────────────────────────────────┘
```

Three on-chain scripts: **AdvertScript** (registry), **EscrowScript** (happy-path escrow), **Module-1** (disputes, deferred). Indexer and Ogmios are shared infra. OpenRouter is a buyer-side client escape hatch — outside the protocol.

## 4. On-chain datum schemas

### 4.1 AdvertDatum

```
AdvertDatum {
  supplier_pkh:           VerificationKeyHash,
  capability_id:          ByteArray,          // "llm.text.generate.v1"
  model:                  ByteArray,          // "qwen2.5:0.5b"
  max_output_tokens:      Int,
  max_processing_ms:      Int,                // SLA for deliver_by math
  price_lovelace:         Int,                // AP3X lovelace, flat per prompt
  supplier_bond_lovelace: Int,
  buyer_bond_lovelace:    Int,
  endpoint_url:           ByteArray,          // https://...
  detail_uri:             ByteArray,          // off-chain JSON pointer
  detail_hash:            ByteArray(32),      // sha256 of detail JSON
  advertised_at:          POSIXTime,
  status:                 AdvertStatus        // Active | Retired
}

Redeemers: PostAdvert | UpdateAdvert | RetireAdvert
```

One supplier process = one `AdvertDatum` UTxO. Update = spend old + post new (spec-lock race resolved by referencing the specific UTxO in escrow).

### 4.2 EscrowDatum (happy path, v1)

```
EscrowDatum {
  buyer_pkh:              VerificationKeyHash,
  supplier_pkh:           VerificationKeyHash,
  advert_ref:             OutputReference,    // SPEC-LOCK to ad UTxO
  capability_id:          ByteArray,          // duplicated for indexer filter
  request_spec_hash:      ByteArray(32),      // sha256 canonical JSON of request envelope
  prompt_hash:            ByteArray(32),      // sha256 of messages
  payment_lovelace:       Int,
  buyer_bond_lovelace:    Int,
  supplier_bond_lovelace: Int,
  deliver_by:             POSIXTime,
  posted_at:              POSIXTime,
  submitted_at:           Option<POSIXTime>,  // set on Submit
  result_receipt_hash:    Option<ByteArray>,  // set on Submit
  state:                  EscrowState
}

EscrowState = Open | Claimed | Submitted | Accepted | Reclaimed | Released
```

### 4.3 Redeemers

| Redeemer | Signer | Precondition | Effect |
|---|---|---|---|
| `Claim`   | supplier | state=Open | Open → Claimed |
| `Submit`  | supplier | state=Claimed | Claimed → Submitted, writes `submitted_at` + `result_receipt_hash` |
| `Accept`  | buyer    | state=Submitted | Submitted → Accepted; supplier gets payment + own bond; buyer gets own bond |
| `Reclaim` | buyer    | state∈{Open,Claimed} AND now ≥ `deliver_by` | → Reclaimed; buyer takes payment + both bonds |
| `Release` | supplier | state=Submitted AND now ≥ `submitted_at + ACCEPT_WINDOW` | → Released; supplier gets payment + own bond + buyer bond |

**Constants** (proposed, v1):
- `ACCEPT_WINDOW = 10 min`
- `network_buffer = 30 s` (buyer-side convention, not enforced on-chain)

### 4.4 State diagram

```
                         Reclaim (after deliver_by)
                            ┌──────────────────────┐
                            ▼                      │
                       ┌─────────┐                 │
       PostEscrow ─▶   │  Open   │ ─ Claim ─┐      │
                       └─────────┘          ▼      │
                                        ┌─────────┐│
                            ┌────────── │ Claimed │┘
                            │           └────┬────┘
                         Reclaim             │ Submit
                  (after deliver_by)         ▼
                            │           ┌───────────┐
                            ▼           │ Submitted │
                       ┌──────────┐     └─────┬─────┘
                       │Reclaimed │  ┌────────┴────────┐
                       └──────────┘  │ Accept          │ Release
                                     │ (buyer)         │ (after ACCEPT_WINDOW)
                                     ▼                 ▼
                               ┌──────────┐      ┌──────────┐
                               │ Accepted │      │ Released │
                               └──────────┘      └──────────┘
```

Terminal states: `Accepted`, `Reclaimed`, `Released`.

## 5. HTTP contracts

### 5.1 Supplier endpoints

```
GET /capability
  → { capability_id, model, max_output_tokens, max_processing_ms,
      price_lovelace, advert_ref, supplier_pkh }
  Must match on-chain advertisement. Buyer SHOULD verify.

GET /status
  → { status: "free"|"working"|"offline",
      current_escrow_ref?: "txHash#ix",
      last_seen: iso8601 }

POST /v1/chat/completions
  Headers: X-Escrow-Ref: <txHash>#<ix>
  Body: OpenAI-compatible ChatCompletionRequest
  Rejects: stream=true, tools[], tool_choice, functions
  Rejects: capability mismatch, max_output_tokens > advertised
  Flow:
    1. Pull escrow UTxO by ref (via Ogmios query)
    2. Verify: state=Open, supplier_pkh=me, capability_id matches,
       request_spec_hash = sha256(canonical(envelope)),
       prompt_hash = sha256(messages)
    3. Submit Claim tx (Open → Claimed)
    4. Call local LLM
    5. Build receipt: { prompt_hash, response_hash, model,
                        prompt_tokens, completion_tokens, wallclock_ms,
                        supplier_pkh, escrow_ref }
    6. Sign receipt (Ed25519 with supplier key)
    7. Submit Submit tx with result_receipt_hash = sha256(canonical(receipt))
    8. Return { choices, usage, receipt, receipt_signature }
```

### 5.2 Indexer endpoints

```
GET /suppliers                       — all Active adverts + cached status
GET /suppliers/{pkh}                 — single supplier detail + recent jobs
GET /capabilities                    — distinct capability_id list with counts
GET /capabilities/{id}/suppliers     — filtered list, sortable by price/latency
GET /escrows/{ref}                   — state lookup by OutputReference
GET /escrows?buyer={pkh}|supplier={pkh}
GET /events?stream=1                 — SSE: new ads, escrow transitions
GET /health                          — sync cursor, Ogmios status
```

Every field traces back to chain via `advert_ref` / `escrow_ref`. Indexer serves cached data for speed.

## 6. Chain-follower extension (from apex-dashboard)

**Reused as-is**: `WsTransport`, `SqliteCache` core, `ChainSyncWorker` cursor/rollback logic, HTTP+SSE scaffold.

**Added for marketplace**:
- Config entry `config/marketplace-deployments.json` with `advert_script_hash` + `escrow_script_hash`.
- Two new address roles: `advert`, `escrow`.
- Two new decoders: `decodeAdvertDatum`, `decodeEscrowDatum`.
- Two new tables: `advertisements`, `escrows` (keyed by OutputReference).
- New event types: `PostAdvert`, `UpdateAdvert`, `RetireAdvert`, `PostEscrow`, `ClaimEscrow`, `SubmitEscrow`, `AcceptEscrow`, `ReclaimEscrow`, `ReleaseEscrow`.
- Status poller: background loop polling each Active supplier's `/status` every 20 s; writes to `supplier_status` table (off-chain).
- Aggregator: per-capability active-supplier counts, p95 wallclock from receipts.

Rollback semantics inherited: soft-delete + UTxO resurrection, per apex-dashboard `sqlite-cache.ts:328-360`.

## 7. Test architecture

### 7.1 Repository layout (target)

```
packages/
  shared/
    chain/
      ChainProvider.ts               # interface: queryUtxo, submitTx, evaluateTx, tip
      MockChainProvider.ts           # Tier 1 — in-memory, synthetic slots
      ReadOnlyOgmiosProvider.ts      # Tier 2 — eval+query only, no submit
      LiveOgmiosProvider.ts          # Tier 3 — full submit
    cbor/
      AdvertDatum.ts
      EscrowDatum.ts
      canonical.ts                   # deterministic JSON (RFC-8785 subset)
    receipt/
      build.ts  sign.ts  verify.ts
buyer/
supplier/
indexer/
contracts/
  escrow/     advert/
tests/
  unit/                              # Tier 1, vitest
  ogmios/                            # Tier 2, read-only
  lifecycle/                         # Tier 3, docker-composed
  fixtures/
    buyer-side/                      # independent CBOR builders (no shared helper)
    supplier-side/                   # independent CBOR builders
    golden/                          # cross-validation CBOR blobs
```

### 7.2 Discipline (from apex-dashboard + refinements)

- Real CBOR in fixtures (cbor-x), not JSON stubs.
- Buyer and supplier tests each build datums **independently from the spec**. No shared helper. Golden files cross-validate.
- `ChainProvider` is DI, not convention — fixes the missing seam in apex-dashboard.
- Property/fuzz tests on the escrow state machine (not present in apex-dashboard).
- Tier 3 runs under `SKIP_BEFORE_SLOT` from day 1 to avoid the glacial-sync pit.
- Mainnet kill-switch: env-gate + explicit `MAINNET=1` flag, hardcoded wallet allowlist.

### 7.3 Must-have adversarial cases for v1

Malformed datum · escrow to wrong script · supplier claims escrow addressed to other supplier · `request_spec_hash` / `prompt_hash` mismatch · Submit after `deliver_by` · Accept after `ACCEPT_WINDOW` · Reclaim before `deliver_by` · double-claim · double-submit · replay of Accept/Release · two concurrent escrows to same single-slot supplier · supplier status lies (`free` while actually `working`) · advert updated mid-flight (spec-lock must hold).

## 8. Milestones

| M  | Goal | Duration | Exit criteria |
|----|------|----------|---------------|
| **M0** | Skeleton + `ChainProvider` seam | ~1 wk | Monorepo + CI + Tier 1 mock escrow lifecycle green |
| **M1** | Happy-path end-to-end, Hetzner CPU supplier | 2–3 wks | `qwen2.5:0.5b` on Hetzner, buyer posts → supplier claims → submits → buyer accepts; full Vector testnet lifecycle; indexer serves discovery |
| **M2** | Module-1 dispute wiring | 2–3 wks post-M1 | Contract source located; supplier=claimer / buyer=auditor mapping; Dispute state; evidence URI; mainnet-dry-run lifecycle |
| **M3** | Capability expansion + local lab | 2–4 wks (may overlap M2) | `speech.transcribe.v1` via Whisper live; local-lab GPU supplier with larger model; heterogeneous discovery validated |
| **M4** | Masumi / Sokosumi adapter | later | MIP-003 HTTP shim; MIP-002 NFT registration; USDM payment path; Sokosumi listing |

## 9. Open follow-ups (not blocking M0 / M1)

1. **Locate Module-1 contract source** before M2. Initial grep across local checkouts failed — possibly on another machine or in a private repo.
2. **Canonical JSON** for `request_spec_hash`, `prompt_hash`, receipt. Proposal: RFC-8785 JCS subset (sorted keys, UTF-8 NFC, no whitespace).
3. **`ACCEPT_WINDOW` and `network_buffer` constants**. Proposed 10 min / 30 s.
4. **Receipt signing key**: same wallet key as `supplier_pkh`, or derived Ed25519 sub-key? Same-key is simpler; sub-key isolates risk.
5. **Mainnet safety**: env-gate + explicit flag + wallet allowlist before any mainnet Tier-3 run.
6. **Ollama-failure-leaves-Claimed (v1 hazard)**: if the supplier fails between Claim and Submit, the escrow stays in `Claimed` state on-chain. v1 has no recovery path — buyer must wait for `deliver_by` and `Reclaim`. M2+ should add either a supplier-side "abandonment" redeemer or a "failure receipt" path that releases funds without going through the dispute module.
7. **Buyer-side wallet fixture has invalid Ed25519 priv** (62 hex chars / 31 bytes; `tests/fixtures/buyer-side/wallet-keys.ts:32`). Currently harmless because no test signs with the buyer key, but M1-E will need this fixed via the same `priv → pub → pkh → bech32` derivation Catherine used for the supplier in M1-C.
8. **Supplier `index.ts` boots with `ReadOnlyOgmiosProvider`** which throws on `submitTx`. Real-chain Claim/Submit is therefore broken until M1-F adds a `LiveOgmiosProvider`. Boot script must either swap providers or branch on env.
9. **Buyer SDK uses structural receipt-signature check, not real Ed25519** in Tier-1 unit tests. The supplier-side wallet fixture's `SUPPLIER_PKH` is currently a hand-typed placeholder that does NOT equal `blake2b224(SUPPLIER_PUB_KEY_HEX)`, so the SDK can't perform cryptographic `verifyReceipt(...)` end-to-end against fixtures. M1-F must (a) re-derive `SUPPLIER_PKH` from the real pubkey and update any hardcoded references, (b) ensure mocks return a real `pub_key_hex` from `/capability` matching that derivation, (c) replace the structural check (`receipt_signature` is 128-char hex and not all zeros) with `verifyReceipt({receipt, signature}, pub_key_hex)` from `@marketplace/shared/receipt`. Real-chain Tier-3 lifecycle in M1-F naturally exercises the cryptographic path.
10. **Buyer SDK `httpClient.ts` carries an `HttpError.isSyncThrow` flag** and a "record-failure-and-return-sentinel" branch in `submitPrompt`. This was Catherine's defensive workaround for a Caroline test fixture that produced invalid hex synchronously (now fixed). Production fetch never throws synchronously; the branch is dead code. M1-F should remove the flag and the sentinel branch.
11. **`supplier/src/index.ts` reads `SUPPLIER_PUB_KEY_HEX`/`SUPPLIER_PKH`/`SUPPLIER_ADDRESS` from env** with `?? ""` fallbacks rather than deriving them from the priv. Inline note in code: "M1-D will plug in the proper Ed25519 + blake2b-224 pipeline." For testnet rollout 2026-04-27 we pass these explicitly via supplier/.env (computed from cardano-cli `address key-hash` + the .vkey cbor). Proper fix: derive in `main()` using `@noble/ed25519` + `blake2b224` + `bech32` (the same pipeline the buyer fixture wallet uses) and stop reading the env vars.
12. **Marketplace tx-builders produce synthetic JSON-in-hex CBOR**, not real Cardano tx CBOR. `LiveOgmiosProvider.submitTx` will get HTTP 400 from Ogmios on any real tx. Workaround used 2026-04-27: a one-shot `pycardano` script (`/tmp/post-advert.py`, modelled on `~/.openclaw/workspace-apex/testnet/deploy_agent_registry.py`) builds a real Cardano CBOR PostAdvert tx and submits via `https://submit.vector.testnet.apexfusion.org/api/submit/tx`. Proper fix (M1-F-4): rewrite all tx builders in `packages/shared/src/tx/**` using `@lucid-evolution/lucid` (already installed) so `pnpm tx:post-advert` and the supplier's Claim/Submit paths work without pycardano. Without this, the supplier `/v1/chat/completions` path will fail at the Claim stage (same 400 from Ogmios) — `/healthz` and `/capability` work today because they're read-only.
13. **Min-UTxO at advert script address requires ≥ ~1.69 AP3X** (datum size dependent). The on-chain advert posted 2026-04-27 locks 2 AP3X (rounded up). The Aiken validator does not constrain the locked value, so the operator-side tx builder must pick `max(supplier_bond_lovelace, min_utxo_for_datum)` — currently hardcoded as `max(SBOND, 2_000_000)` in `/tmp/post-advert.py`; M1-F-4's lucid-evolution rewrite should compute it dynamically from protocol params.
14. **`tests/fixtures/supplier-side/wallet-keys.ts` `SUPPLIER_PKH` is a placeholder `"abcdef0123…01"`**, NOT `blake2b224(SUPPLIER_PUB_KEY_HEX)`. The correct value is `9f356dd4cb466bbdddbfcfa3f4f61aa2a264cdb48707e60d1c829263` and address `addr1vx0n2mw5edrxh0wahl868a8kr232yexdkjrs0esdrjpfyccgazpvh`. This was tolerable until M1-F-4 because tests didn't run real lucid UPLC; with M1-F-4 live-CBOR tests, the local validator rejects on `signed_by` because the wallet's derived signing key produces a vkey witness that doesn't match the placeholder. **Production is unaffected** — the supplier's `/capability` returns its real priv-derived pkh, buyer constructs EscrowDatum with that pkh, validator checks pass. Cleanup queued as `M1-F-4-fix-fixtures`. Blast radius: 17+ files (both goldens regenerate). After cleanup, the test-only `presetWalletInputs ≥5 ADA padding` workaround in `packages/shared/src/tx/internal/liveCbor.ts` should also be removed.
15. **`tests/fixtures/...` invalid-checksum `addr_test1wrqq9…` script address** decode-fails in CML; Catherine workaround: override input UTxO address to blueprint-derived form before `collectFrom`. Same `M1-F-4-fix-fixtures` round.
16. **lucid-evolution / pnpm-store interaction**: `libsodium-wrappers-sumo`'s wrapper does `import "./libsodium-sumo.mjs"` but pnpm hoists the `.mjs` to a sibling pkg. Today's runtime workaround: copy the file into the wrapper's dir post-install. Clean fix: `pnpm patch libsodium-wrappers-sumo` with the import-path change, commit the patch.

## 10. Reference pointers (external)

- Apex-dashboard chain-follower pattern: `apex-dashboard/server/chain-sync-worker.ts` (private project; clone alongside this repo for cross-reference)
- Apex-dashboard CBOR decoders: `apex-dashboard/server/cbor-decoder.ts`
- Apex-dashboard test discipline: `apex-dashboard/tests/`
- Prior Python reference (AP3X buyer/supplier): `./docs/buyer/`, `./docs/supplier/`
- Masumi docs: https://docs.masumi.network/
- MIP-003 spec: https://docs.masumi.network/mips/_mip-003
