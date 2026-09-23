# Deploy a New Supplier — Operator Runbook

> Audience: anyone who wants to sell inference on the agents-marketplace by
> running a **mainnet supplier** on a server they control. Everything below
> uses your own hardware, DNS, and funds — no access to the Apex Fusion fleet
> is required. (Fleet-internal runbooks: `docs/HETZNER_SETUP.md`,
> `deploy/README.md`. A live worked example of exactly this standalone
> pattern: `deploy/inference-proxy/README.md`.)

---

## 1. What a supplier is

A supplier is one Docker container that:

1. Holds an **on-chain advertisement** (a UTxO on the Vector mainnet chain)
   declaring capability, model, price, bonds, and your endpoint URL.
2. Serves a **public HTTPS endpoint** that buyers call after locking payment
   in escrow. Any hostname you control works — the advert carries the URL,
   and the marketplace indexer probes it as-is.
3. Runs the job against an upstream inference backend and settles on-chain
   (Claim → Submit; bonds of 1 AP3X ride on each job).

One supplier = one (model × capability) pair = one wallet = one advert = one
compose file. Capabilities: `llm.text.generate.v1` (one-off) or `llm.chat.v1`
(multi-turn session, `CAPABILITY_KIND=chat-session`). There is also a TTS
kind (`CAPABILITY_KIND=tts`); this runbook covers the LLM kinds.

## 2. Prerequisites

| Requirement | Notes |
|---|---|
| Linux server | Public IPv4, Docker installed, ports 80 + 443 free (for the bundled Traefik). A small VPS is enough — the container only proxies and settles; the heavy compute is upstream. |
| DNS name you control | One A record, e.g. `supplier.example.com` → your server IP. Must be **DNS-only / unproxied** — TLS certs come from Let's Encrypt HTTP-01, which a CDN-proxied record breaks. |
| Upstream backend | An OpenAI-compatible Responses API is preferred. Set `LLM_BACKEND=openai` and `OPENAI_UPSTREAM_API=responses`. Use `chat-completions` only for a backend that has not added Responses. Production Ollama also uses `LLM_BACKEND=openai` with its native `/v1/responses`; the legacy Ollama adapter has limited tool and reasoning support. |
| Model id | Use the **verbatim** upstream id, including prefixes such as `Qwen/`. Verify it against the backend's model list. |
| Capability | Use `llm.text.generate.v1` for one-shot keys or `llm.chat.v1` for demo session keys. One model with both capabilities needs two suppliers and two wallets. |
| Advert params | Your call. Reference fleet values are price `200000` lovelace (0.2 AP3X), bonds `1000000` on both sides, and `max_processing_ms` `300000` for one-shot or `1800000` for chat. The advert `max_output_tokens` is a buyer limit, not permission to exceed the model context. |
| Funding | ≥50 AP3X mainnet to the new supplier wallet, from your own funds (the fleet typically funds 50–200). Each advert locks a 1 AP3X supplier bond; each job rides another. |

## 3. Vector mainnet constants (same for every operator)

These are chain-level values, identical for all suppliers; put them in every
supplier env file:

```
NETWORK_ID=1
LIVE_CHAIN=1
OGMIOS_URL=https://ogmios.vector.mainnet.apexfusion.org
VECTOR_ZERO_TIME_MS=1756485600000
ESCROW_REF_UTXO=c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#0
ADVERT_REF_UTXO=c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#1
```

`OGMIOS_URL` above is a public endpoint; if you run your own Vector node +
Ogmios, point at that instead. Never pin `NETWORK_ID` / `OGMIOS_URL` inside
the compose file — they must come from the env file (prevents
mainnet/testnet cross-wiring on re-up).

## 4. Procedure

### 4.1 Smoke-test the backend first (before spending on-chain)

Use the native Responses probe when the backend supports it:

```bash
curl -sS -X POST <BASE_URL>/v1/responses \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"<MODEL_ID>","input":"ping","store":false}' \
  | jq '{status,output,usage}'
```

The result must have `status: "completed"`, a non-empty `output` Item array,
and canonical usage fields `input_tokens`, `output_tokens`, and
`total_tokens`. Text is inside a message Item's `content` as an
`output_text` part. Function tools use the flat Responses form:
`{"type":"function","name":"...","parameters":{...}}`.

Use this compatibility probe only when the backend needs
`OPENAI_UPSTREAM_API=chat-completions`:

```bash
curl -sS -X POST <BASE_URL>/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"<MODEL_ID>","messages":[{"role":"user","content":"ping"}]}' \
  | jq '{content:.choices[0].message.content,usage}'
```

Do not send an operator token limit during this probe unless you plan to set
`OPENAI_MAX_TOKENS`. For tool-capable models, also verify a function-call and
function-output round trip. A backend that fails the selected mode can cause
`openai_malformed` and forfeit the 1 AP3X supplier bond.

### 4.2 Prepare the host

```bash
curl -fsSL https://get.docker.com | sh              # if Docker is missing
git clone https://github.com/Apex-Fusion/agents-marketplace.git
cd agents-marketplace
docker network create traefik-net                   # one-shot

# TLS terminator (Traefik + Let's Encrypt). One per host; serves every
# supplier you run on it.
cd deploy/inference-proxy
echo 'ACME_EMAIL=<your email>' > .env && chmod 600 .env
docker compose -f docker-compose.traefik.yml up -d
cd ../..
```

Already have your own reverse proxy? Skip Traefik: terminate TLS for
`https://<your-dns-name>` yourself and forward to the supplier container's
port 8080, then drop the `traefik` labels and network from the compose file
in §4.4.

### 4.3 DNS

Create `<your-dns-name>` → A record for your server IP, **DNS-only /
unproxied**. Traefik issues the Let's Encrypt cert via HTTP-01 on port 80
automatically ~1 min after propagation; no restart needed.

### 4.4 Compose file

Copy the standalone-box template and rename its identity strings:

```bash
mkdir -p deploy/self-hosted
cp deploy/inference-proxy/docker-compose.supplier-local.yml \
   deploy/self-hosted/docker-compose.supplier-<name>.yml
```

(The relative paths inside — `build.context: ../..`,
`env_file: ../../supplier/.env.<name>` — assume the file sits two directory
levels below the repo root.)

Rename consistently:

- `name:` and `container_name` → `marketplace-mainnet-supplier-<name>`
- `env_file` path → `../../supplier/.env.<name>`
- every Traefik label token `mp-suppliers-local-mainnet` → a token of your
  own (router names must be unique per Traefik instance)
- `Host(...)` rules → your DNS name
- `OPENAI_BASE_URL` → the backend root without a trailing `/v1`
- `OPENAI_UPSTREAM_API` → `responses` for native Responses, or the explicit
  compatibility value `chat-completions`
- `OPENAI_TIMEOUT_MS` → no more than the advert's `max_processing_ms`


For native mode, the client appends `/v1/responses`. Set
`OPENAI_RESPONSES_URL` only when the provider needs an exact endpoint, such as
`https://api.deepseek.com/responses`. Set
`OPENAI_RESPONSES_STREAM_ONLY=1` only when a backend returns a complete result
through native SSE but not through a buffered JSON call. This is required for
the pinned Codex Responses proxy used with `gpt-5.6-sol`. The collector keeps
complete Items from `response.output_item.done`; it does not rebuild them from
partial deltas.

Native OpenRouter, HuggingFace, and DeepSeek calls use `store:false` and replay
the full Item history. Hetzner, local llama.cpp, and OpenClaw templates stay on
`chat-completions` until those endpoints support Responses. There is no
automatic HTTP fallback between modes.

The Chat Completions adapter preserves `json_object` and `json_schema` output
formats. It translates Responses `text.format` into upstream `response_format`
and preserves the full schema, name, description, and `strict` value. There is
no separate model-specific registration flag. Verify schema enforcement at
the upstream; the marketplace does not synthesize JSON from plain text.
Responses reasoning controls and text verbosity still require native support.

`OPENAI_REASONING=off` sets native `reasoning.effort` to `none`. In
compatibility mode it sends the OpenRouter extension
`reasoning.enabled=false`, so do not set it for Hetzner or HuggingFace Chat
Completions. A supplier that disables reasoning advertises
`reasoning_disabled: true` and rejects an incompatible request before Claim.

Capability kind:

- **One-off** (`llm.text.generate.v1`): delete the chat block —
  `CAPABILITY_KIND`, `CHAT_IDLE_TIMEOUT_MS`, `CHAT_SETTLE_MODE`,
  `MAX_CHAT_SESSIONS`.
- **Chat** (`llm.chat.v1`): keep `CAPABILITY_KIND: chat-session`. Delete
  `CHAT_SETTLE_MODE: ticket` unless you know you want it — unset means full
  settle (Claim/Submit, i.e. you collect payment on-chain); `ticket` skips
  all supplier chain ops and the buyer reclaims the escrow.

The mainnet fleet templates (`deploy/mainnet/docker-compose.supplier-*.yml`)
are also valid references, but they attach to `marketplace-mainnet-net`,
which does not exist on a standalone box — remove it if you start from one
of those.

Compose files are safe to commit to your fork (no secrets); env files are
never committed.

### 4.5 Generate and fund the wallet

No Node needed on the host — build the supplier image once and run the CLI
inside it:

```bash
docker compose -f deploy/self-hosted/docker-compose.supplier-<name>.yml build
docker compose -f deploy/self-hosted/docker-compose.supplier-<name>.yml \
  run --rm --no-deps supplier \
  node_modules/.bin/tsx supplier/src/cli/gen-keypair.ts --network 1
# prints privateKeyHex, publicKeyHex, pubKeyHash, address
```

(With Node + pnpm available locally:
`pnpm --filter @marketplace/supplier tx:gen-keypair --network 1`.)

Fund the printed address from your own wallet (≥50 AP3X). Optimal UTxO shape
is **2 UTxOs**: one ≥5 AP3X collateral + one working UTxO. If the wallet ends
up fragmented later, run `tx:consolidate-wallet` (can be docker-exec'd inside
the running supplier container — it already has the key via env).

### 4.6 Env file

```bash
cp supplier/.env.example supplier/.env.<name>
chmod 600 supplier/.env.<name>
```

Must contain, at minimum:

- **All four wallet vars**: `SUPPLIER_PRIV_KEY_HEX`, `SUPPLIER_ADDRESS`,
  `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX`. They are not derived at boot.
  A missing value causes `403 wrong_supplier` on every job.
- `OPENAI_API_KEY`. An empty value is legal only for an unauthenticated
  backend.
- The shared plumbing block from §3.
- `ADVERT_REF=` left as a placeholder until §4.8.

Backend selection normally lives in the compose file: `LLM_BACKEND=openai`,
`OPENAI_UPSTREAM_API`, `OPENAI_BASE_URL`, `OPENAI_TIMEOUT_MS`, and
`CAPABILITY_KIND`. Keep any secret API key in the env file.

The supplier accepts string input and supported text, function, and reasoning
Items. Hosted tools, unsupported modalities, and unsupported execution
controls fail explicitly. `OPENAI_MAX_TOKENS` is an operator output ceiling.
The advert cap still applies. A reseller `max_input_tokens` bound counts the
full transmitted JSON UTF-8, including instructions and tools.

### 4.7 First start

```bash
docker compose -f deploy/self-hosted/docker-compose.supplier-<name>.yml up -d --build
```

Verify before going on-chain:

- `docker logs marketplace-mainnet-supplier-<name> --tail 50` — no
  crash-loop.
- `curl https://<your-dns-name>/healthz` → `{"ok":true}` (proves DNS, cert
  issuance, and routing end-to-end).

Later updates are manual on this box. Follow the drain procedure in §6 before
`git pull` and `docker compose ... up -d --build`.

### 4.8 Post the advert (go-live — do this LAST)

The advert is the go-live flag: the moment it confirms, the indexer starts
probing `<endpoint>/status` and buyers can lock escrows. Post it only after
§4.7 is green, so buyers never hit a dead endpoint.

```bash
docker compose -f deploy/self-hosted/docker-compose.supplier-<name>.yml \
  run --rm --no-deps supplier \
  node_modules/.bin/tsx supplier/src/cli/post-advert.ts \
    --capability-id llm.text.generate.v1 \
    --model '<MODEL_ID>' \
    --max-output-tokens <CTX_LEN> \
    --max-processing-ms 300000 \
    --price-lovelace 200000 \
    --endpoint-url https://<your-dns-name>
# chat variant: --capability-id llm.chat.v1 --max-processing-ms 1800000
```

Paste the printed `<txHash>#0` into `ADVERT_REF` in `supplier/.env.<name>`,
then:

```bash
docker compose -f deploy/self-hosted/docker-compose.supplier-<name>.yml up -d --force-recreate
```

Note: adverts are immutable — changing the model, price, or endpoint later
requires `tx:retire-advert` (refunds the advert bond) + a fresh post-advert
+ a new `ADVERT_REF`.

## 5. Verification checklist

- `curl https://<your-dns-name>/healthz` → `{"ok":true}`.
- `/capability` on the same host shows the right model + pkh.
- Public marketplace indexer lists your advert:
  `curl https://mp-indexer.vector.apexfusion.org/suppliers` → your entry with
  `advert_status: "Active"`, `status: "free"`. The indexer follows the chain,
  so a confirmed advert appears automatically — no registration step.
  (The buyer API and OpenAI gateway at `marketplace.vector.apexfusion.org` /
  `api.marketplace.vector.apexfusion.org` require buyer API keys; buyers with
  keys will see your model in the gateway's `/openai/v1/models`.)
- Tail `docker logs -f marketplace-mainnet-supplier-<name>` through the
  first controlled mainnet jobs. Watch for `openai_malformed`,
  `upstream_api_incompatible`, `reasoning_disabled`, and
  `403 wrong_supplier`. The current testnet has no functional marketplace,
  so use local checks and a controlled mainnet smoke for end-to-end proof.

## 6. Ongoing operations

- **Update**: stop new admission before any restart. Create
  `/dev/shm/marketplace-draining` in the supplier container. Wait until
  `/status` reports `active_sessions: 0` and `status` is `free` or `offline`.
  Treat an unreadable response, an unknown value, or a timeout as failure.
  Leave the old container running. After a successful recreate, the tmpfs
  marker disappears with the old container. If the old container survives an
  aborted update, remove the marker before restoring traffic.
- **First incompatible rollout**: the old image does not enforce the drain
  marker. Put ingress into maintenance before any supplier restart. Remove
  maintenance only after every supplier is healthy on the new image.
- **Model swap**: `tx:retire-advert` → post-advert with the new `--model` →
  new `ADVERT_REF` in the env file → drain, then `up -d --force-recreate`.
- **Wallet health**: keep the 2-UTxO shape; run `tx:consolidate-wallet` if
  script-spends start failing with collateral-selector errors.
- **Stuck Submitted escrows**: a job you Submitted that the buyer never
  Accepted (buyer-side timeout, crash) sits in `Submitted` holding the
  payment and both bonds. After the 10 min accept window only your
  `Release` can resolve it, and it pays you payment + both bonds. Run
  `pnpm --filter @marketplace/supplier tx:release-escrows [--dry-run]`
  (can be docker-exec'd inside the running supplier container like
  `tx:consolidate-wallet`). It scans the escrow script address on chain for
  Submitted escrows addressed to your wallet (the indexer misses some Submit
  transitions, so it is not consulted), skips any still inside their window,
  and releases the rest serially. Nothing does this automatically yet.
- **Exit**: `tx:retire-advert` refunds the advert bond and delists you; the
  wallet keeps its funds.
- **Monitoring (optional)**: the repo ships a balance monitor
  (`wallet-monitor/`, `buyer/scripts/monitor-wallets.ts`) you can run against
  your own wallet list.

## 7. Footguns (each has burned an operator before)

1. Match `OPENAI_BASE_URL`, `OPENAI_UPSTREAM_API`, and the real provider
   endpoint. Native mode appends `/v1/responses`; compatibility mode appends
   `/v1/chat/completions`. Use `OPENAI_RESPONSES_URL` for an exact native URL.
2. Advert `--model` must match the upstream id byte-for-byte. Slashes are
   valid on-chain.
3. Apply `OPENAI_REASONING=off` only when the selected upstream mode supports
   its wire control.
4. `OPENAI_TIMEOUT_MS` above advert `max_processing_ms` creates a
   bond-forfeit window.
5. Model ids containing `kimi`, `deepseek`, or `gpt` (case-insensitive) are
   auto-enrolled in the marketplace buyer's PDF-summarizer pool
   (`buyer/src/pdf/caps.ts`), so expect PDF jobs too. The
   `PDF_MODEL_ALLOWLIST` / `PDF_MODEL_DENYLIST` overrides are buyer-side —
   only relevant if you also operate your own buyer.
6. `LIVE_CHAIN` accepts only the literal `"1"`; `true`/`yes` silently means
   off, and the supplier then never broadcasts.
7. The compose `env_file` uses `required: false`, so a typo'd env path comes
   up and crash-loops instead of failing to parse — check logs on first boot.
8. Wallet fragmentation (>2 UTxOs, none ≥5 AP3X) breaks all script-spends
   with a lucid collateral selector error; fix with `tx:consolidate-wallet`.

## 8. Key references in this repo

- `deploy/inference-proxy/README.md` — a live standalone box built exactly
  this way (two suppliers, incl. a tailnet-backed home rig).
- `deploy/README.md` — networks, Traefik, per-service ops.
- `docs/HETZNER_SETUP.md` — the Apex Fusion fleet runbook (hosted-API
  suppliers at scale).
- `docs/HUGGINGFACE_ROUTER_SETUP.md` — OpenRouter/HF-router backend variant.
- `supplier/.env.example` — every env var, annotated (plus `.env.*.example`
  variants per backend).
- `supplier/src/cli/` — `gen-keypair`, `post-advert`, `retire-advert`,
  `consolidate-wallet`, `publish-reference-scripts`.
