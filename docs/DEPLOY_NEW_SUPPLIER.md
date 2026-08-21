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
| Upstream backend | Any OpenAI-compatible API: base URL + API key. Proven in production: hosted APIs (DeepSeek, OpenRouter, Hetzner Inference), local llama.cpp, agent gateways. |
| Model id | Must be the **verbatim** upstream id (incl. prefixes like `Qwen/`). Verify against the backend's `/v1/models`. |
| Capability | `llm.text.generate.v1` or `llm.chat.v1` (or both → two suppliers, two wallets). |
| Advert params | Your call. Reference values used by the Apex Fusion fleet: price `200000` lovelace (0.2 AP3X), bonds `1000000` both sides, `max_processing_ms` `300000` one-off / `1800000` chat, `max_output_tokens` = model context length. |
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

```bash
curl -sS -X POST <BASE_URL>/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"<MODEL_ID>","messages":[{"role":"user","content":"ping"}]}' \
  | jq '.choices[0].message.content'
```

Requirements: non-empty string content, **no `max_tokens` sent** (matches
runtime behavior). For a chat supplier, also verify a `tools`/`tool_choice`
round-trip. A backend that fails these costs you the 1 AP3X supplier bond per
failed job (`openai_malformed`).

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
- `OPENAI_BASE_URL` → your backend, **without `/v1`** (the client appends
  `/v1/chat/completions`)
- `OPENAI_TIMEOUT_MS` ≤ the advert's `max_processing_ms`

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
  `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX`. They are NOT derived at boot;
  a missing derived var causes `403 wrong_supplier` on every job.
- `OPENAI_API_KEY` (empty is legal only for unauthenticated backends).
- The shared plumbing block from §3.
- `ADVERT_REF=` left as placeholder until §4.8.

Backend selection (`LLM_BACKEND=openai`, `OPENAI_BASE_URL`,
`OPENAI_TIMEOUT_MS`, `CAPABILITY_KIND`) lives in the compose file (§4.4),
not the env file.

### 4.7 First start

```bash
docker compose -f deploy/self-hosted/docker-compose.supplier-<name>.yml up -d --build
```

Verify before going on-chain:

- `docker logs marketplace-mainnet-supplier-<name> --tail 50` — no
  crash-loop.
- `curl https://<your-dns-name>/healthz` → `{"ok":true}` (proves DNS, cert
  issuance, and routing end-to-end).

Every deploy on your box is manual: `git pull` +
`docker compose ... up -d --build`. No CD pipeline covers it.

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
  first paid jobs; watch for `openai_malformed` (reasoning-model
  content-shape risk) and `403 wrong_supplier` (missing derived wallet vars).

## 6. Ongoing operations

- **Update**: `git pull && docker compose -f ... up -d --build`.
- **Model swap**: `tx:retire-advert` → post-advert with the new `--model` →
  new `ADVERT_REF` in the env file → `up -d --force-recreate`.
- **Wallet health**: keep the 2-UTxO shape; run `tx:consolidate-wallet` if
  script-spends start failing with collateral-selector errors.
- **Exit**: `tx:retire-advert` refunds the advert bond and delists you; the
  wallet keeps its funds.
- **Monitoring (optional)**: the repo ships a balance monitor
  (`wallet-monitor/`, `buyer/scripts/monitor-wallets.ts`) you can run against
  your own wallet list.

## 7. Footguns (each has burned an operator before)

1. `OPENAI_BASE_URL` must NOT end in `/v1`.
2. Advert `--model` must match the upstream id byte-for-byte; slashes are
   fine on-chain.
3. Do not set `OPENAI_REASONING` unless the backend is OpenRouter.
4. `OPENAI_TIMEOUT_MS` > advert `max_processing_ms` = bond-forfeit window.
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
