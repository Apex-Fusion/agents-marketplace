# OpenAI-Compatible API Gateway for the Vector Marketplace

## Context

Today the only way to send a prompt to the marketplace is the single-operator **buyer** web app (cookie auth, one shared wallet). We want external developers to use **any OpenAI SDK** against the marketplace. Design (locked through interview + a 5-lens adversarial audit of an earlier draft):

- **Public, multi-tenant, custodial gateway.** Each API key is its **own buyer wallet** (own Ed25519 key, held AES-GCM-encrypted by the gateway). The user funds their own deposit address with AP3X; each request posts an on-chain escrow **from that user's wallet**. Not the deployed operator buyer.
- **Two surfaces, two escrow models:**
  - **One-shot completions** — `POST /openai/v1/chat/completions` (stateless, OpenAI-standard). Routes to an `llm.text.generate.v1` supplier. **One escrow per call.** `stream:true` → buffered pseudo-stream.
  - **Chat sessions** — a Vector REST extension. Routes to an `llm.chat.v1` supplier. **One escrow per session**: fixed price locked at open, **real token streaming** per turn (no per-turn charge), settled at session close.
- **Routing matches capability + model, not cheapest.** Per-prompt cost = the matched supplier's advertised price.
- **Gateway auto-maintains each user's wallet** (collateral + consolidation) so requests past #1 keep working.
- Onboarding is **self-serve via a small web UI**; the response is a **spec-clean OpenAI body + `x_vector` receipt extension**; custody is protected with **settle-on-success + a state-aware reclaim sweeper + a withdrawal path**.

The audit confirmed 39 holes in the first draft (10 distinct themes). This document incorporates every fix; the "Audit-driven corrections" section maps each theme to its resolution.

## Locked decisions

| Area | Decision |
|---|---|
| Scope | Public multi-tenant OpenAI-compatible gateway; new `gateway/` pnpm package reusing the buyer `Marketplace` SDK |
| Identity | Each API key = its own custodial buyer wallet |
| Custody | AES-256-GCM, `GATEWAY_MASTER_KEY` (env), per-row nonce; decrypt in-memory at request time; **rotation CLI**; **withdrawal endpoint** is the user exit |
| One-shot | `/openai/v1/chat/completions` → `llm.text.generate.v1`, 1 escrow/call, buffered (+ pseudo-stream) |
| Chat session | `/openai/v1/chat/sessions*` → `llm.chat.v1`, 1 escrow/**session**, real SSE per turn, settle at close |
| Routing | match `model` + required capability; pick an available supplier (status `free`\|`unknown`); **not cheapest**; fallback to next match on busy/offline |
| Pricing | cost = matched supplier `price_lovelace`; **required balance = price + buyer_bond + supplier_bond + 5 ADA collateral + fee reserve** |
| Wallet health | gateway **auto-consolidates** each wallet to `{5-ADA collateral, working}` after settle / on a tick |
| Settlement | resolve the **Submitted** ref via indexer, `acceptResult`, **await confirm** before returning success; sweeper is backstop |
| Sweeper | state-aware: Open/Claimed past `deliver_by` → reclaim; Submitted → retry Accept in-window; never blind-reclaim Submitted |
| Response | OpenAI object `{id, object, created, model, choices, usage}` + `x_vector:{receipt, receipt_signature, escrow_ref}`; full streaming chunk transform + final usage chunk |
| Hardening | `/signup` IP rate-limit, per-key request rate-limit, `SdkRegistry` LRU cap, structured logging + audit trail |

## Architecture

New standalone pnpm package `gateway/` (add to `pnpm-workspace.yaml`). Boots **one** shared `ChainProvider` (Ogmios, `LIVE_CHAIN=1`) + indexer URL, and an `SdkRegistry` that lazily builds **one `Marketplace` per API key** bound to that user's `WalletKey` (LRU-capped, evicted by idle). All on-chain work for a key is serialized by a per-key promise-chain mutex.

### Verified reuse points (do not re-implement)
- `Marketplace` ctor `MarketplaceOpts{chain, indexerUrl, walletKey, networkParams, historyStore?}` — `buyer/src/sdk/Marketplace.ts:117`. Per-user field is only `walletKey`.
- `deriveWalletKey` + ed25519 hook — `buyer/src/index.ts:24-64`.
- SDK methods: `discoverSuppliers`, `submitPrompt` (`Marketplace.ts:242`, verifies receipt but **does not settle**), `startChat`/`endChat` (chat session; `endChat` returns `acceptedRef` and awaits Accept), `acceptResult`, `reclaim`.
- Escrow value/bonds: buyer funds `totalLocked = price + buyer_bond + supplier_bond` at PostEscrow — `packages/shared/src/tx/escrow/postEscrow.ts:132-200`. On Accept supplier gets `payment+supplier_bond`, buyer gets `buyer_bond` back.
- Submitted-ref resolution: the buyer `/v1/accept` queries the indexer and matches the Submitted row by `posted_at` — `buyer/src/server.ts` `/v1/accept`. Gateway must mirror this.
- Wallet health: `planConsolidate` / `consolidateWallet` (`{collateral, working}` shape, `DEFAULT_COLLATERAL_LOVELACE = 5 ADA`) — `packages/shared/src/tx/wallet/`. Collateral assertion: `assertCollateralCandidate` — `packages/shared/src/tx/internal/liveCbor.ts`.
- Supplier chat-session SSE `{type:"token"|"done"|"error"}` + headers — `supplier/src/server.ts` `makeChatSessionHandlers`; buyer relay in `buyer/src/server.ts` `/v1/chat/message` (note: **verbatim** passthrough — the gateway must transform to OpenAI chunks).
- SQLite pattern (`better-sqlite3`, WAL) — `buyer/src/db/archive.ts`. Auth helpers `timingSafeCompareStrings`, `createRateLimiter` — `buyer/src/auth.ts`.
- Indexer `SupplierView` (`model`, `capability_id`, `price_lovelace`, `buyer_bond_lovelace`, `supplier_bond_lovelace`, `status` free/working/offline/unknown, `advert_status`) — `indexer/src/routes/suppliers.ts`.

## Package layout (`gateway/`)
```
src/
  index.ts          # boot: config → shared chain/indexer → GatewayStore → SdkRegistry → app → listen + sweeper + wallet-health tick
  config.ts         # GATEWAY_MASTER_KEY(64hex), INDEXER_URL, OGMIOS_URL, LIVE_CHAIN, NETWORK_ID, GATEWAY_PORT, GATEWAY_DB_DIR, rate-limit knobs
  wallet.ts         # deriveWalletKey + ed25519 hook + genPrivKey
  crypto/seal.ts    # aes-256-gcm seal()/open(), per-row nonce
  db/{schema.ts,store.ts}        # api_keys, usage, sessions
  sdk/registry.ts   # per-key Marketplace cache (LRU) + per-key Mutex
  routing/selectSupplier.ts      # indexer query → capability+model match → available → fallback
  openai/{shapes.ts,errors.ts,chatCompletions.ts,sessions.ts,models.ts}
  account/routes.ts # POST /signup, GET /account, POST /account/withdraw
  middleware/apiKeyAuth.ts, middleware/rateLimit.ts
  walletHealth.ts   # post-settle + ticker consolidation (reuse planConsolidate)
  sweeper.ts        # state-aware reclaim/accept-retry
  ui/index.html
  cli/rotate-master-key.ts       # re-encrypt all rows old→new master key
```
Build wiring: add `"exports": { "./sdk": "./dist/sdk/index.js" }` to `buyer/package.json`, depend `@marketplace/buyer: workspace:*` + `@marketplace/shared: workspace:*`.

## SQLite schema
```sql
CREATE TABLE api_keys ( id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, key_prefix TEXT NOT NULL, label TEXT,
  wallet_pkh TEXT NOT NULL, deposit_address TEXT NOT NULL,
  enc_priv_nonce TEXT NOT NULL, enc_priv_ct TEXT NOT NULL, enc_priv_tag TEXT NOT NULL,
  master_key_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0 );
CREATE TABLE usage ( id TEXT PRIMARY KEY, key_id TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL,
  model TEXT, capability_id TEXT, supplier_pkh TEXT, escrow_ref TEXT, cost_lovelace TEXT,
  prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, status TEXT NOT NULL, failure_reason TEXT );
CREATE TABLE sessions ( id TEXT PRIMARY KEY, key_id TEXT NOT NULL, escrow_ref TEXT NOT NULL, session_nonce TEXT NOT NULL,
  supplier_base_url TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER );
```
Raw API key never persisted (only `sha256(key)`); `key_prefix` for display. `master_key_version` enables rotation.

## Endpoints

**One-shot (OpenAI standard):**
- `POST /openai/v1/chat/completions` — Bearer. Parse `{model, messages, max_tokens?, stream?}`; **reject** `tools`/`tool_choice`/`functions` with 400; **ignore** `temperature/n/stop/top_p/...` (documented). Lifecycle below.
- `GET /openai/v1/models` — distinct `model` over Active suppliers → OpenAI list shape.

**Chat sessions (Vector extension — documented as non-standard):**
- `POST /openai/v1/chat/sessions {model}` — open: route to `llm.chat.v1`, `startChat` (lock fixed price), persist session row → `{session_id, model}`.
- `POST /openai/v1/chat/sessions/{id}/messages {messages|content, stream}` — real SSE turn; transform supplier `{type:token}` → `chat.completion.chunk`; final usage chunk + `[DONE]`. No new escrow.
- `POST /openai/v1/chat/sessions/{id}/close` — settle: `endChat` (Submit+Accept, awaits), record usage, then run wallet-health.

**Account / UI:**
- `POST /signup {label?}` — IP rate-limited. Generate priv → derive → seal → store → `{api_key (once), deposit_address, key_prefix}`.
- `GET /account` — Bearer. `{deposit_address, balance:{available_lovelace, locked_in_escrow_lovelace, ap3x}, collateral_ok:bool, spend:{total_cost_lovelace, request_count}, recent_usage[]}`.
- `POST /account/withdraw {to_address, amount_lovelace?}` — Bearer. Build a wallet→address transfer (new `buildWithdrawTx` in packages/shared; repo has no send tx today) sending available funds out. **The custodial exit path.**
- `GET /` — self-serve UI (create key, copy deposit address, live balances, usage, withdraw).

## Request lifecycle — one-shot `/chat/completions`
All on-chain steps run inside the per-key `mutex.run(...)`.
1. **Route** (`selectSupplier`): indexer rows where `model` matches, `capability_id==="llm.text.generate.v1"`, `advert_status==="Active"`, live `status ∈ {free, unknown}`. Pick an available one (not cheapest). No match → 404 `model_not_found` (`type: invalid_request_error`).
2. **Pre-flight**: required = `price + buyer_bond + supplier_bond + 5_000_000 (collateral) + ~2 AP3X fee`. Verify total balance **and** a pure-ADA UTxO ≥5 ADA exists (`assertCollateralCandidate`-style). Else 402 `insufficient_funds` + `x_vector:{required_lovelace, available_lovelace, collateral_ok, deposit_address}`.
3. **Execute**: `submitPrompt({advertRef, messages, payment_lovelace:price, max_output_tokens})` (posts escrow → supplier → verifies receipt).
4. **Settle**: resolve the **Submitted** escrow ref via the indexer (mirror buyer `/v1/accept`: match by buyer pkh + `posted_at`), `acceptResult(submittedRef)`, **await confirmation**. On 409/offline mid-route, retry next matching supplier (bounded). On any post-escrow failure, record + leave for the sweeper (don't block the response on reclaim).
5. **Respond**: `{id:"chatcmpl-…", object:"chat.completion", created:<sec>, model, choices:[{index:0,message:{role:"assistant",content},finish_reason:"stop"}], usage:{prompt_tokens,completion_tokens,total_tokens}, x_vector:{receipt,receipt_signature,escrow_ref}}`. Record `usage`.
6. **Wallet health**: after settle, consolidate the wallet back to `{collateral, working}` (inside the mutex or queued).
7. `stream:true`: same flow; emit one (or chunked) `chat.completion.chunk` delta + final `finish_reason:"stop"` chunk **with `usage`** + `data: [DONE]`. Emit `: keepalive` SSE comments during the escrow-confirm gap.

## Chat-session lifecycle
- **open** → `startChat` (escrow at fixed price), store `{escrow_ref, session_nonce, supplier_base_url}`.
- **messages** → POST the turn to `${supplier_base_url}/v1/chat/message` with `X-Escrow-Ref`; transform each `{type:token,value}` → `chat.completion.chunk`; `{type:done}` → final chunk + usage + `[DONE]`. (System messages: fold into the first turn's content; documented limitation since chat.v1 has no system channel.)
- **close** → `endChat` (Submit + Accept, awaits) → settle + bond refund; record usage; wallet-health.
- Sessions are reclaimable by the sweeper if abandoned before close.

## Sweeper & wallet-health
- **Sweeper** (interval ~60s): per key, classify escrows. Open/Claimed past `deliver_by` → `reclaim`. Submitted **with a verified receipt** still in accept-window → retry `acceptResult`. Submitted past accept-window → leave for supplier Release (log). Never blind-`reclaim` Submitted.
- **Wallet-health tick**: periodically + after each settle, `planConsolidate` → `consolidateWallet` so every wallet keeps a ≥5 ADA collateral UTxO. Skip if already healthy.

## Errors (OpenAI shape `{error:{message, type, code, param:null}}`)
no supplier → 404 `invalid_request_error`/`model_not_found`; underfunded/no-collateral → 402 `invalid_request_error`/`insufficient_funds`; bad/missing key → 401 `authentication_error`/`invalid_api_key`; rate limit → 429 `rate_limit_error` + `Retry-After`; supplier timeout → 504 `server_error`; supplier busy race (after retries) → 503 `server_error`/`overloaded`; receipt verify → 502 `server_error`/`receipt_verification_failed`; tx build → 409/502 `server_error`/`escrow_failed`; unsupported `tools`/`functions` → 400 `invalid_request_error`/`unsupported_parameter`.

## Audit-driven corrections (themes → resolution)
1. **Settlement/Submitted-ref + fire-and-forget Accept** → lifecycle step 4 (indexer resolution + awaited Accept); sweeper backstop.
2. **No withdrawal** → `POST /account/withdraw` + new `buildWithdrawTx`.
3. **Master-key SPOF / offline-stranding** → documented backup, `rotate-master-key` CLI (`master_key_version`), withdrawal as exit; trustless recovery (pre-signed reclaim / multisig) explicitly **out of scope**, documented as residual risk.
4. **Stateless↔stateful chat** → sessions are explicit (open/messages/close), one escrow/session; system-message folding documented.
5. **Collateral/fragmentation** → corrected required-balance formula + pre-flight collateral check + auto wallet-health consolidation.
6. **~0.5 req/min throughput** (awaitTx in mutex) → documented per-key SLA; "move awaitTx out of the lock" noted as fast-follow.
7. **Sweeper can't reclaim Submitted** → state-aware sweeper.
8. **OpenAI wire format** → full response object + chunk transform + final usage chunk + keepalive + error taxonomy + param policy.
9. **Hardening** → `/signup` IP limit, per-key request limit, `SdkRegistry` LRU cap, `status ∈ {free,unknown}` + freshness + fallback retry.
10. **Economics/observability** → v1 = **no on-chain margin** (operator subsidizes infra; a fee needs a separate transfer or off-chain credit — folded into the deferred "billing" phase); add structured per-request logging + audit (request_id, key_id, model, supplier_pkh, escrow_ref, status, latency) + basic metrics/alerts (indexer stale, Ogmios slow, sweeper idle).
- **Doc fix**: clarify the **off-chain tx builder** enforces `payment==advert.price`; the validator only enforces the state machine, not pricing.

## Out of scope for v1 (documented)
Real billing/markup & fee hook; trustless/self-custody recovery; multi-funding-UTxO optimization beyond the consolidation loop; moving `awaitTx` out of the per-key lock; real chat.v1 system-role support (needs a supplier API change).

## Verification (testnet, end-to-end)
1. Indexer + Ogmios + ≥1 `llm.text.generate.v1` and ≥1 `llm.chat.v1` supplier for the same `model`, Active.
2. Boot gateway: `LIVE_CHAIN=1`, `GATEWAY_MASTER_KEY=$(openssl rand -hex 32)`, `OGMIOS_URL`, `INDEXER_URL`, `NETWORK_ID`, `GATEWAY_DB_DIR`, `GATEWAY_PORT`.
3. `POST /signup` → key + deposit address. Fund ≥ price + both bonds + 5 ADA collateral + ~2 ADA fees; confirm via `GET /account` (`collateral_ok:true`).
4. One-shot non-stream via curl and via the OpenAI Python/JS SDK (`base_url=…/openai/v1`) → valid `chat.completion` + `x_vector`; confirm the escrow **settled (Accepted)** and a `usage` row exists.
5. **Run a 2nd and 3rd request** → confirm wallet-health kept `collateral_ok` and they succeed (the audit's request-#2 failure must not reproduce).
6. One-shot `stream:true` → chunks + final usage + `[DONE]`.
7. Chat session: open → stream 2–3 turns → close; confirm **one** escrow for the whole session, settled at close.
8. `POST /account/withdraw` → unspent AP3X returns to an external address.
9. Underfunded / no-collateral key → 402 with guidance. Unknown model → 404. `tools:[…]` → 400.
10. Kill gateway mid-request → restart → sweeper reclaims Open/Claimed and retries Accept on Submitted; balances recover.
