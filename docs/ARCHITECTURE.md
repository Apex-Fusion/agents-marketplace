# Local Agents Marketplace — Architecture (v1)

> Status: historical M0–M1 foundation with the current Responses interface documented below
> Dated: 2026-04-24; Responses interface updated 2026-09-21
> Scope: the original MVP validates buyer → bonded escrow → supplier inference on Vector. Sections 1.1 and 5 define the current inference API.

---

## 1. Goal and scope

**What this is.** A two-sided marketplace where buyers (agents or humans) submit prompts to suppliers running inference on their own hardware, with each job settled in AP3X through on-chain bonded escrow on Vector L2, and receive signed-receipt responses. The primary validation goal is **technical feasibility + lifecycle** ("can it be done end-to-end"), not demand modelling or economic stress testing.

**Historical M0–M1 scope.** These limits describe the first supplier milestone. They are not the current gateway contract.
- Suppliers answered one prompt. Buyer agents drove multi-prompt work.
- The capability model was open, but the first supplier was a CPU LLM.
- Each supplier process exposed one capability and one execution slot.
- Vector was the only chain.
- M1 shipped the happy-path escrow without disputes.
- The first direct supplier route rejected streaming and tools.
- TLS protected supplier transport. Suppliers still saw plaintext prompts.

### 1.1 Current Responses interface

The public gateway exposes `POST /openai/v1/responses` and owned `GET`/`DELETE /openai/v1/responses/:id`. It has no Chat Completions alias. Normal keys create one `llm.text.generate.v1` escrow per request. Demo keys use managed `llm.chat.v1` sessions with one escrow per session.

Clients continue with `previous_response_id`. The gateway replays complete input and output Items. It never guesses a session from a text prefix. Stored chains accept completed and incomplete parents, require the same owner and model, honor supplier pins, and fork when the parent is not the current session head.

`store:true` is the default and keeps encrypted response chains for 30 days. A `store:false` result is not available for later lookup or continuation, although that request can cite an existing stored parent. An active escrow session still keeps encrypted operational transcript checkpoints until close, invalidation, or reclaim. Partial in-flight output is not a resumable stored response. Master-key rotation reseals wallets, stored Responses, and active transcripts together.

The supported input is a string or typed text, function-call, function-call-output, and reasoning Items. Function tools use the flat Responses shape. Unsupported hosted tools, modalities, and execution controls fail explicitly. Supplier capability fields `inference_api`, `upstream_api`, and `reasoning_disabled` prevent incompatible requests before escrow funding.

Streaming uses typed Responses SSE and ends with `response.completed`, `response.incomplete`, or `response.failed`. It has no public `[DONE]` sentinel. One-shot output stays buffered through settlement. Session text can stream live. Full terminal output Items are authoritative for replay.

## 2. Decisions resolved (Q&A → architecture inputs)

| # | Decision |
|---|---|
| 1 | Settlement asset: **AP3X**, bonded in escrow; jobs settle in AP3X on accepted work. |
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
│  Responses:      │                         │  /v1/responses         │
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
  request_spec_hash:      ByteArray(32),      // sha256 of canonical advert execution limits
  prompt_hash:            ByteArray(32),      // one-shot execution request or session-nonce commitment
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

## 5. HTTP and receipt contracts

### 5.1 Public gateway

```text
POST /openai/v1/responses
POST /openai/v1/chat/completions
GET  /openai/v1/responses/{response_id}
DELETE /openai/v1/responses/{response_id}
GET  /openai/v1/models
```

The client sets its OpenAI SDK base URL to `https://<gateway>/openai/v1`. Responses calls use `client.responses.create(...)` with `input`. Chat Completions calls use `client.chat.completions.create(...)` with `messages`. Both use a shared canonical Responses execution path and the same routing, escrow, and accounting rules.

Responses returns an OpenAI Response object. Chat Completions returns `choices[].message` or standard Chat chunks ending in `[DONE]`. Normal one-shot results can add the optional `x_vector:{receipt,receipt_signature,escrow_ref}` extension. Receipts bind the canonical execution result, not a lossy Chat rendering. Responses preserves the full Item replay record.

There is no public custom session lifecycle API. The gateway retains internal
managed sessions for demo keys. Normal keys use `llm.text.generate.v1` for
both standard APIs; demo keys use `llm.chat.v1`. The model catalog filters by
that key-specific capability.

Responses supports stored continuation through `previous_response_id`.
Chat Completions is stateless at the client boundary: each call sends the full
message history, including tool calls and tool outputs. Chat storage and
multiple choices are not supported. Unsupported fields and modalities fail
explicitly; see `docs/gateway.md` for the accepted controls.

### 5.2 Supplier endpoints

These routes serve the gateway and marketplace SDK's escrow protocol. They are
not the public OpenAI client contract.

```text
GET /capability
  → { capability_id, model, max_output_tokens, max_processing_ms,
      price_lovelace, advert_ref, supplier_pkh, pub_key_hex,
      inference_api?, upstream_api?, reasoning_disabled?,
      max_input_tokens? }

GET /status
  → { status: "free"|"working"|"offline",
      current_escrow_ref?, active_sessions, max_sessions, last_seen }

POST /v1/responses
  Header: X-Escrow-Ref: <txHash>#<ix>
  Body: normalized Responses execution request plus advertised model
```

The one-shot supplier route performs this flow:

1. Validate the request and upstream compatibility.
2. Load the referenced Open escrow and Active advert.
3. Verify supplier, capability, `request_spec_hash`, `prompt_hash`, and deadline.
4. Claim the escrow.
5. Run the configured native Responses or explicit compatibility adapter.
6. Build a terminal Response with complete output Items.
7. Sign the receipt and Submit its hash on chain.
8. Return the terminal Response, receipt, signature, and Submitted reference.

Native Responses, chat-completions compatibility, and legacy Ollama modes are explicit. There is no HTTP fallback. Compatibility adapters reject reasoning, replay, tool, or text features that they cannot represent.

The chat-session supplier routes are `/v1/chat/start`, `/v1/chat/message`, and `/v1/chat/end`. Message output is typed Responses SSE. The session records ordered input and output Items for its close receipt. Native providers can place complete Items only in `response.output_item.done`; the adapter collects those Items by output index and never rebuilds them from partial deltas.

### 5.3 Receipt hashes

The canonical JSON function recursively sorts object keys in code-unit order, NFC-normalizes keys and strings, preserves array order, drops undefined object fields, and uses compact `JSON.stringify` number output. This is the repository's defined subset. It is not plain RFC 8785 JCS.

For a one-shot response:

```text
prompt_hash   = sha256(canonical(normalized_execution_request))
response_hash = sha256(canonical({output,status,incomplete_details}))
```

The request commitment includes `input` and each present execution control: `instructions`, `max_output_tokens`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `text`, `temperature`, and `top_p`. It excludes model routing, streaming, storage, metadata, and continuation IDs.

For a chat session:

```text
prompt_hash   = sha256(canonical({kind:"llm.chat.v1",session_nonce}))
response_hash = sha256(canonical(ordered_input_and_output_items))
```

Receipt fields keep the existing `prompt_tokens` and `completion_tokens` names. Input bounds count the full transmitted execution JSON in UTF-8, including instructions and tools, without NFC reduction.

### 5.4 Indexer endpoints

```text
GET /suppliers
GET /suppliers/{pkh}
GET /capabilities
GET /capabilities/{id}/suppliers
GET /escrows/{ref}
GET /escrows?buyer={pkh}|supplier={pkh}
GET /events?stream=1
GET /health
```

Every field traces back to chain through `advert_ref` or `escrow_ref`. The indexer serves cached data for discovery and state lookup.

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
      canonical.ts                   # sorted/NFC compact JSON subset; not plain RFC 8785 JCS
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

## 9. Open follow-ups (not blocking M0 / M1)

1. **Locate Module-1 contract source** before M2. Initial grep across local checkouts failed — possibly on another machine or in a private repo.
2. **Resolved — canonical JSON.** Hashes use the repository sorted-key, NFC-normalized, compact JSON subset defined in section 5.3. It is not plain RFC 8785 JCS.
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
