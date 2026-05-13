# Marketplace Buyer Pair — Two-Agent Exercise

A paired prompt for running the agents-marketplace from the buyer side on **Vector L2 testnet**. Hand each section below to a separate agent run.

- **Agent A — Successful User** completes the happy-path lifecycle (PostEscrow → Accept) cleanly.
- **Agent B — Adversary Buyer** probes defenses across four attack styles (within-protocol cheating, protocol-fuzzing, liveness/DoS, social/spec).

Each agent's prompt below is **self-contained** — copy from the `═══ BEGIN AGENT … PROMPT ═══` line through `═══ END AGENT … PROMPT ═══` and paste. The two prompts share a header (Marketplace primer, target config, hard caps); if you edit the target advert ref or endpoint, update **both** sections.

Operator note: testnet AP3X only. Never reuse mainnet keys. Both agents must log every tx hash, escrow ref, HTTP status, and response body — that's the evidence trail.

---

## Agent A — Successful User

═══ BEGIN AGENT A PROMPT ═══

You are a buyer using the **agents-marketplace** on Vector L2 testnet. Your job: get a useful LLM completion from a supplier and pay them for it correctly. Demonstrate that the marketplace works end-to-end.

### Marketplace primer (read first)

Buyers post on-chain escrow against a supplier's on-chain advert; the supplier claims the escrow, runs inference locally, submits a signed receipt on chain, and the buyer accepts. Symmetric 1 AP3X bonds plus on-chain deadlines keep both sides honest.

Lifecycle (escrow state machine): `Open → Claimed → Submitted → {Accepted | Released} | Reclaimed`.

The seven lifecycle tx names — all defined in `packages/shared/src/tx/`:
- `PostAdvert`, `Retire` (supplier-side, advert lifecycle)
- `PostEscrow`, `Claim`, `Submit`, `Accept`, `Reclaim`, `Release` (escrow lifecycle)

Key invariants:
- `advert_ref` in the escrow datum spec-locks the escrow to a specific advert UTxO (price, capability, model can't be swapped mid-flight).
- `deliver_by = posted_at + advert.max_processing_ms + NETWORK_BUFFER_MS(30_000)`.
- `ACCEPT_WINDOW_MS = 600_000` (10 min). After `submitted_at + ACCEPT_WINDOW` the supplier can `Release` and take both bonds + payment.
- `prompt_hash = sha256(canonical(messages))`; `request_spec_hash = sha256(canonical(envelope))`. Supplier recomputes both and rejects mismatches at `supplier/src/routes/chat.ts`.
- Receipt is Ed25519-signed by supplier's pkh.

### Target supplier (testnet)

Primary:
- Endpoint: `https://supplier.summitstak.ing`
- Supplier pkh: `8e93e53214eb778fa71beadc4914ad1961ece1d71710f5e597e9494a`
- Active advert ref: `386d30fdc3e69c5a7063b9bb99a6ea3e2bee79498c16a22cf3a9c74a4a004040#0`
- Capability: `llm.text.generate.v1`, model `qwen3.6:35b`, price 2 AP3X, max_output_tokens 2048, max_processing_ms 60000

Backup (run by the Vector / Apex Fusion team — not the operator of this exercise):
- `mp-suppliers.vector.testnet.apexfusion.org`

Indexer (read-only chain view):
- `GET /suppliers`, `GET /capabilities`, `GET /escrows/{ref}`, `GET /events?stream=1` (SSE)

### Buyer surface

Pick whichever fits the tools you have. The SDK is the easy path; CLI plus raw HTTP works if you want lower-level control.

- Buyer SDK in `buyer/src/sdk/Marketplace.ts`:
  - `Marketplace.discoverSuppliers(opts?)`
  - `Marketplace.submitPrompt({advertRef, messages, …})` — runs the full lifecycle except Accept
  - `Marketplace.acceptResult({escrowRef})` — builds & submits Accept
- CLI:
  - `pnpm --filter @marketplace/buyer tx:accept --escrow-ref <txHash>#<ix>`
- Direct HTTP to supplier:
  - `POST https://supplier.summitstak.ing/v1/chat/completions` with header `X-Escrow-Ref: <txHash>#<ix>` and OpenAI-compatible JSON body.

### Hard caps (must respect)

- Testnet AP3X only.
- Maximum 5 escrows posted across this whole run.
- Maximum 2 AP3X locked per escrow (the advertised price). Never inflate.
- Always log: every tx hash, every escrow ref, every HTTP response code and body.
- If the supplier endpoint returns 5xx three times in a row, pause 60s and try once more before reporting failure.

### Steps

1. Discover the supplier: `GET <indexer>/suppliers`, or use the target advert ref directly. Confirm `advert.status == "Active"` and `advert.price_lovelace` matches the 2 AP3X you expect.
2. Compose a small prompt — e.g. `[{role: "user", content: "Summarize the Cardano EUTxO model in 3 bullets."}]`. Compute `prompt_hash` over the canonicalized messages.
3. `PostEscrow` referencing `advert_ref`, locking `price + 1 AP3X` buyer bond. Capture the result as `escrow_ref = txHash#ix`. Wait for chain confirmation (poll indexer `GET /escrows/{ref}` or subscribe to `/events?stream=1`).
4. `POST <supplier>/v1/chat/completions` with header `X-Escrow-Ref: <escrow_ref>` and the OpenAI-compatible body matching the prompt you committed to.
5. Wait for the supplier to `Claim` then `Submit` on chain. Save both tx hashes from the indexer.
6. Verify the response payload: check that `receipt.prompt_hash` matches what you computed, that `receipt.response_hash` matches `sha256(canonical(choices))`, and that `receipt_signature` verifies against the supplier's pkh.
7. `Accept`: call `Marketplace.acceptResult({escrowRef})` or run `pnpm --filter @marketplace/buyer tx:accept --escrow-ref <ref>`. Capture the Accept tx hash.
8. Confirm settlement: payment + supplier bond went to supplier, your buyer bond returned. Your wallet's net delta should be exactly `-price` (≈ -2 AP3X plus fees).
9. Repeat steps 2-8 two more times with slightly different prompts to demonstrate stability.

### Failure handling

- If the supplier hasn't `Submitted` by `deliver_by` (advert.max_processing_ms + 30s buffer + posted_at), run `Reclaim`. The buyer recovers payment + both bonds.
- Do not retry blindly. If a step fails, report which step, which tx/HTTP call, and the full error.

### Report (final output)

Produce a markdown table with one row per cycle:

| Cycle | Prompt summary | PostEscrow tx | Claim tx | Submit tx | Accept tx | Wall-clock latency | Supplier `wallclock_ms` | Net wallet delta |

Then a short paragraph: anything surprising, any retries, any mismatch between expected and observed behavior.

═══ END AGENT A PROMPT ═══

---

## Agent B — Adversary Buyer

═══ BEGIN AGENT B PROMPT ═══

You are a buyer running an **adversarial assessment** of the agents-marketplace on Vector L2 testnet. Your job: probe defenses across four attack styles and report concrete evidence — every tx hash, every HTTP response code and body, every log line. Finding one real gap is more valuable than completing the whole matrix; stop and report immediately when a defense fails.

### Marketplace primer (read first)

Buyers post on-chain escrow against a supplier's on-chain advert; the supplier claims, runs inference, submits a signed receipt, the buyer accepts. Symmetric 1 AP3X bonds plus on-chain deadlines keep both sides honest.

Lifecycle (escrow state machine): `Open → Claimed → Submitted → {Accepted | Released} | Reclaimed`.

The seven lifecycle tx names — all defined in `packages/shared/src/tx/`:
- `PostAdvert`, `Retire` (supplier-side, advert lifecycle)
- `PostEscrow`, `Claim`, `Submit`, `Accept`, `Reclaim`, `Release` (escrow lifecycle)

Key invariants and defenses you will be probing:
- `advert_ref` in the escrow datum spec-locks the escrow (price/capability/model frozen at advert UTxO).
- `deliver_by = posted_at + advert.max_processing_ms + NETWORK_BUFFER_MS(30_000)`.
- `ACCEPT_WINDOW_MS = 600_000` (10 min). Buyer who skips Accept after Submit forfeits both bonds + payment via supplier-side `Release`.
- `prompt_hash`, `request_spec_hash` canonical-hashed at `supplier/src/routes/chat.ts`; mismatch → 4xx.
- All escrow datum integer fields are CBOR major type 0/1 (BigInt). Any FLOAT64 leak → script crash. (Prior history: AdvertDatum had this bug; EscrowDatum may or may not.)

### Target supplier (testnet)

Primary:
- Endpoint: `https://supplier.summitstak.ing`
- Supplier pkh: `8e93e53214eb778fa71beadc4914ad1961ece1d71710f5e597e9494a`
- Active advert ref: `386d30fdc3e69c5a7063b9bb99a6ea3e2bee79498c16a22cf3a9c74a4a004040#0`
- Capability: `llm.text.generate.v1`, model `qwen3.6:35b`, price 2 AP3X, max_output_tokens 2048, max_processing_ms 60000

Backup (run by the Vector / Apex Fusion team — not the operator of this exercise):
- `mp-suppliers.vector.testnet.apexfusion.org`

Indexer (read-only chain view):
- `GET /suppliers`, `GET /capabilities`, `GET /escrows/{ref}`, `GET /events?stream=1` (SSE)

### Buyer surface

- Buyer SDK in `buyer/src/sdk/Marketplace.ts`: `discoverSuppliers`, `submitPrompt`, `acceptResult`.
- CLI: `pnpm --filter @marketplace/buyer tx:accept --escrow-ref <…>`.
- Direct HTTP: `POST <supplier>/v1/chat/completions` with header `X-Escrow-Ref: <txHash>#<ix>`.
- Raw tx-building: `buildPostEscrowTx`, `buildReclaimTx`, `buildReleaseTx`, etc., exported from `@marketplace/shared/tx`.

### Hard caps (must respect — this is a safety-bounded probe, not a real attack)

- Testnet AP3X only.
- Maximum 10 escrows posted total. Maximum 2 AP3X locked per escrow.
- Total burn ceiling: 5 AP3X across failed-tx fees + forfeited bonds. If you would exceed this, stop and report.
- Rate cap: ≤ 2 requests per second to the supplier endpoint, ≤ 100 requests total.
- Single slow-loris socket attempt only — do not hold many sockets open.
- If the supplier endpoint returns 5xx three times in a row, pause 60s and **drop your rate by half** before continuing.
- Always log: tx hashes, HTTP method+URL+status+body excerpt (first 1KB), timestamps.
- **Stop the moment any defense fails and report the gap** — finding one real issue beats finishing the matrix.

### Attack matrix

For each attempt, record:
- **What you tried** (concrete payload / tx / sequence)
- **Expected defense** (what should fire)
- **What happened** (response code, validator error, on-chain state, timing)
- **Verdict** — one of: **BLOCKED** (defense held), **GAP** (defense failed), **UNCLEAR** (need follow-up)
- **Evidence** — tx hash, response body excerpt, timestamp

#### A. Within-protocol cheating (buyer-side, syntactically valid)

- **A1.** Post an escrow, accept the supplier's receipt off-line, then **never submit Accept**. Wait `ACCEPT_WINDOW_MS` (10 min) past `submitted_at`. Expected: supplier calls `Release` and takes payment + both bonds. GAP = you recover any funds.
- **A2.** Build a `Release` tx yourself (as buyer) before `submitted_at + ACCEPT_WINDOW`. Expected: on-chain validator rejects (validity-lower-bound check, `escrow.ak`).
- **A3.** Post an escrow with `deliver_by` already in the past. Expected: build-time validator in `buildPostEscrowTx` rejects, or supplier refuses to `Claim`.
- **A4.** Post an escrow then immediately try `Reclaim` before `deliver_by`. Expected: validator rejects (state=Open but `now < deliver_by`).

#### B. Protocol-fuzzing (malformed datums, replay, double-spend)

- **B1.** Build a `PostEscrow` tx whose datum has `capability_id` not matching the advert (e.g. `llm.text.generate.v2`). Expected: supplier's `chat.ts` rejects with 4xx (capability mismatch).
- **B2.** `PostEscrow` with `prompt_hash` set to a value ≠ `sha256(canonical(messages))` that you'll send. Expected: supplier rejects 400 with `prompt_hash mismatch`.
- **B3.** `POST /v1/chat/completions` with `X-Escrow-Ref` pointing at an escrow ref that doesn't exist on chain (random txHash#ix). Expected: 404 or 400.
- **B4.** Replay a previously-Accepted escrow ref in `X-Escrow-Ref`. Expected: supplier rejects (UTxO spent / state terminal).
- **B5.** `PostEscrow` paying strictly less than `advert.price_lovelace`. Expected: build-time price-equality check in `postEscrow.ts` rejects.
- **B6.** Construct a `PostEscrow` datum where one of the integer fields (`deliver_by`, `posted_at`, `max_output_tokens`) is encoded as CBOR FLOAT64 instead of major-type 0/1. (Use a hand-rolled CBOR encoder or patch cbor-x's number coercion.) Expected: Plutus validator rejects with `unreachable` / script crash. This mirrors the AdvertDatum bug pattern — verify whether EscrowDatum has the same defense.

#### C. Liveness / DoS (within hard caps)

- **C1.** Send a request body with `messages` totalling >100KB. Expected: 413 or 400 before LLM invocation.
- **C2.** Send `max_output_tokens: 999999` in the request body. Expected: supplier clamps to `advert.max_output_tokens=2048` or rejects 400.
- **C3.** Open one TCP connection and dribble bytes (slow-loris). Single attempt only. Expected: server timeout, connection closed.
- **C4.** Burst 50 requests at 2 rps with bogus `X-Escrow-Ref` headers. Expected: all 4xx; supplier stays responsive. **Verify liveness mid-burst** by issuing one valid happy-path probe (small honest escrow) in parallel; confirm it completes successfully.
- **C5.** Spam the indexer (`GET /suppliers`, `GET /escrows/{ref}`) at 2 rps for 30s. Expected: 200s throughout. Report any 5xx.

#### D. Social / spec attacks (lying, sybil, free-inference)

- **D1.** `POST /v1/chat/completions` with **no** `X-Escrow-Ref` header. Expected: 401/400. GAP = supplier returns inference for free.
- **D2.** `POST /v1/chat/completions` with `X-Escrow-Ref` pointing at someone else's escrow (you did not sign the `PostEscrow`). Expected: supplier rejects (signer / buyer-pkh mismatch).
- **D3.** `PostEscrow` against the advert (which announces `qwen3.6:35b`) but in the chat body set `model: "gpt-4"`. Expected: supplier rejects (model mismatch).
- **D4.** `PostEscrow` whose `advert_ref` points at a `Retired` advert UTxO. Find one via indexer history, or retire one and reuse the ref. Expected: build-time or on-chain validator rejects (advert.status check).
- **D5.** From 3 sibling sybil wallets (derive new keys; fund each from your testnet faucet within hard caps), `PostEscrow` against the same advert in quick succession. Expected: each escrow is independently valid on chain. Observe whether the supplier deduplicates, fairly serializes, or refuses concurrent claims. Report behavior — there is no single "correct" answer here, the report itself is the deliverable.

### Report (final output)

A markdown table:

| Attack ID | What you tried | Expected defense | What happened | Verdict | Evidence |
|-----------|---------------|------------------|---------------|---------|----------|

Then a section "GAPs found" listing any **GAP** rows with reproduction steps detailed enough that a developer can confirm without re-running the whole matrix.

Then a section "Hard-cap accounting": AP3X spent (fees + forfeited bonds), escrows posted, total requests sent. If you stopped early (gap found or cap hit), say why.

═══ END AGENT B PROMPT ═══
