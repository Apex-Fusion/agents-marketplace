# Deploy runbook — Local Agents Marketplace (M1-F)

Operator-facing instructions for bringing up the four-service stack on a
Hetzner VM (or any Docker host) against an external Ogmios endpoint.

This is a REVIEW DRAFT. The artifacts (`Dockerfile`s, per-service compose
files under `deploy/testnet/` and `deploy/mainnet/`, `.env.example`s) have
not been deployed end-to-end. Run the stack only after a careful review
per-section below.

> The current testnet has no functional marketplace. The testnet commands
> below remain useful for local service checks only. Use controlled mainnet
> smoke work for an end-to-end marketplace check.

---

## 1. Concepts

### Per-service compose projects

The four services (ollama, supplier, indexer, buyer) live in **independent
compose projects** under `deploy/testnet/`. The operator can start, stop,
rebuild, or pull images for each service in isolation:

```
deploy/testnet/
  docker-compose.ollama.yml      project name: marketplace-ollama
  docker-compose.supplier.yml    project name: marketplace-supplier
  docker-compose.indexer.yml     project name: marketplace-indexer
  docker-compose.buyer.yml       project name: marketplace-buyer
```

The `deploy/mainnet/` directory contains the controlled mainnet projects with
`marketplace-mainnet-` prefixes. Use the rollout rules in §10.

### Three-axis network model

Each service joins one or more **external** Docker networks. The networks
must already exist on the host before any of these compose files come up.

```
                          ┌─────────────────────────────────┐
                          │       dashboard_default         │  ← Traefik project
                          │  (Traefik ingress, port 80/443) │
                          └────┬───────────┬───────────┬────┘
                               │           │           │
                               ▼           ▼           ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                       marketplace-net                            │  ← service-to-service
   │   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   │
   │   │  ollama  │◀───│ supplier │    │ indexer  │◀───│  buyer   │   │
   │   └──────────┘    └────┬─────┘    └────┬─────┘    └──────────┘   │
   └──────────────────────────────────────────────────────────────────┘
                            │               │
                            ▼               ▼
              ┌─────────────────────────────────────────┐
              │     apex-dashboard_apex-net             │  ← apex-dashboard testnet stack
              │   ws://ogmios:1337   (Vector testnet)   │
              └─────────────────────────────────────────┘
```

| Network | Owner | Purpose |
|---|---|---|
| `marketplace-net` | this stack (`docker network create marketplace-net`) | service-to-service hostnames (`marketplace-ollama`, `marketplace-indexer`) |
| `apex-dashboard_apex-net` | `apex-dashboard` testnet compose project | gives supplier+indexer access to `ws://ogmios:1337` |
| `dashboard_default` | the Traefik compose project | gives supplier+indexer+buyer a public web entrypoint |

The buyer does **not** join `apex-dashboard_apex-net` — only the indexer
talks to Ogmios; the buyer reads chain state via the indexer's HTTP API.

### Container names + Traefik hosts (testnet)

| Service | container_name | Traefik host | Internal port |
|---|---|---|---|
| ollama | `marketplace-ollama` | (none, internal only) | 11434 |
| supplier | `marketplace-supplier` | `mp-suppliers.vector.testnet.apexfusion.org` | 8080 |
| indexer | `marketplace-indexer` | `mp-indexer.vector.testnet.apexfusion.org` | 8090 |
| buyer | `marketplace-buyer` | `mp.vector.testnet.apexfusion.org` | 8070 |

Mainnet domain mirror: `mp-suppliers.vector.apexfusion.org`, `mp-indexer.vector.apexfusion.org`, `mp.vector.apexfusion.org`. Router names suffixed `-mainnet` to stay globally unique on the shared Traefik (`mp-supplier-mainnet`, `mp-indexer-mainnet`, `mp-buyer-mainnet`).

## 2. Prerequisites

1. **Docker host** with Docker Engine 24+ and the Compose v2 plugin
   (`docker compose ...`, not legacy `docker-compose`).
2. **apex-dashboard testnet stack** running on the same host, providing
   `ws://ogmios:1337` on the `apex-dashboard_apex-net` network. Verify:
   ```bash
   docker network ls | grep apex-dashboard_apex-net
   ```
   *Fallback*: if you can't run apex-dashboard locally, point each
   service's `OGMIOS_URL` at a hosted endpoint
   (e.g. `wss://ogmios.vector.testnet.apexfusion.org`) via `.env` — but
   then drop `apex-net` from the supplier+indexer compose files, since
   they won't be reaching ogmios via the docker network. (This is a
   review-time decision; the wired default uses the docker network.)
3. **Traefik** running on the host and managing `dashboard_default`. Verify:
   ```bash
   docker network ls | grep dashboard_default
   ```
   *Fallback*: bring up Traefik via the apex-dashboard repo's
   `docker-compose.traefik.local.yml` — it creates `dashboard_default`
   identically.
4. **One-shot setup** (run once on the host):
   ```bash
   docker network create marketplace-net
   ```
   The compose files declare `marketplace-net` as `external: true` and
   will refuse to come up if it doesn't exist.

## 3. `.env` setup per service

Each service reads its env file at `<service>/.env` (paths resolved
relative to the repo root, since the compose files use `../..` as the
build context). Copy the examples:

```bash
cp supplier/.env.example supplier/.env
cp indexer/.env.example  indexer/.env
cp buyer/.env.example    buyer/.env
$EDITOR supplier/.env indexer/.env buyer/.env
```

Generate Ed25519 seeds:

```bash
openssl rand -hex 32   # → SUPPLIER_PRIV_KEY_HEX (64 hex chars)
openssl rand -hex 32   # → BUYER_PRIV_KEY_HEX
```

Fund the supplier wallet only when you intend to run chain-writing work on a
network that has a functional deployment. The current testnet is not an
end-to-end marketplace venue.

`ADVERT_REF` must name a real advert UTxO before `/capability` can be ready.

The `env_file:` directive uses `required: false`, so the compose files
parse and come up even with an empty/missing `.env` — the service will
crash at boot if mandatory env vars are absent, which is the desired
loud-fail behavior.

### Upstream API selection

The public gateway uses `POST /openai/v1/responses` and
`GET` or `DELETE /openai/v1/responses/:id`. It has no
`chat/completions` alias.

Each OpenAI-compatible supplier must select one upstream mode:

| Provider | `OPENAI_UPSTREAM_API` | Endpoint configuration |
|---|---|---|
| OpenRouter | `responses` | base URL; native adapter appends `/v1/responses` |
| HuggingFace router | `responses` | base URL; native adapter appends `/v1/responses` |
| DeepSeek direct | `responses` | set exact `OPENAI_RESPONSES_URL=https://api.deepseek.com/responses` |
| Codex Responses proxy v1.40 for `gpt-5.6-sol` | `responses` | set `OPENAI_RESPONSES_STREAM_ONLY=1` |
| Hetzner Inference | `chat-completions` | base URL; adapter appends `/v1/chat/completions` |
| Local llama.cpp and OpenClaw | `chat-completions` | keep the explicit compatibility mode |
| Production Ollama | `responses` with `LLM_BACKEND=openai` | point the base URL at Ollama's native `/v1/responses` service |

There is no HTTP fallback between modes. Native OpenRouter, HuggingFace, and
DeepSeek requests use `store:false` and full Item replay. The Codex stream
collector takes complete Items from `response.output_item.done`; it never
builds authoritative output from partial deltas.

The GPT rollout replaces the v1.36 Chat Completions pin with v1.40 native
Responses and `gpt-5.6-sol`. Keep its existing advert price and bonds. An
old-model restriction is not a reason to renew the Codex token.

`OPENAI_REASONING=off` means native `reasoning.effort:"none"`. In Chat
Completions mode it means the OpenRouter extension
`reasoning.enabled:false`. Leave it unset for Hetzner and HF compatibility
calls. `/capability` reports `inference_api`, `upstream_api`, and
`reasoning_disabled`, so incompatible requests can fail before funding or
Claim.

Native responses contain an `output` Item array and canonical usage fields
`input_tokens`, `output_tokens`, and `total_tokens`. Text is an `output_text`
part in a message Item. Function tools use the flat Responses shape with
`type`, `name`, and `parameters`.

Public streaming emits canonical typed events and ends with
`response.completed`, `response.incomplete`, or `response.failed`. It does not
emit a public `[DONE]` sentinel. One-shot text stays buffered until settlement.
Session text can stream live.

Gateway `store:true` is the default. It keeps encrypted response chains for
30 days. `store:false` disables saved-response lookup and continuation.
However, an active demo escrow session keeps encrypted operational transcript
checkpoints until close or reclaim. Master-key rotation must cover custodial
wallets, stored responses, and active transcript checkpoints.

## 4. Per-service operations (testnet)

All commands assume you're at the repo root. Start order matters
(supplier depends on ollama, buyer depends on indexer) — Compose's
`depends_on` doesn't cross project boundaries, so the operator
sequences these manually.

### Ollama

```bash
docker compose -f deploy/testnet/docker-compose.ollama.yml up -d
docker compose -f deploy/testnet/docker-compose.ollama.yml logs -f
docker compose -f deploy/testnet/docker-compose.ollama.yml down
docker compose -f deploy/testnet/docker-compose.ollama.yml pull
```

After the container is healthy, **pull the model** (one-shot, ~400 MB):

```bash
docker exec marketplace-ollama ollama pull qwen2.5:0.5b
```

### Supplier

```bash
docker compose -f deploy/testnet/docker-compose.supplier.yml build
docker compose -f deploy/testnet/docker-compose.supplier.yml up -d
docker compose -f deploy/testnet/docker-compose.supplier.yml logs -f
docker compose -f deploy/testnet/docker-compose.supplier.yml down
```

### Indexer

```bash
docker compose -f deploy/testnet/docker-compose.indexer.yml build
docker compose -f deploy/testnet/docker-compose.indexer.yml up -d
docker compose -f deploy/testnet/docker-compose.indexer.yml logs -f
docker compose -f deploy/testnet/docker-compose.indexer.yml down
```

### Buyer

```bash
docker compose -f deploy/testnet/docker-compose.buyer.yml build
docker compose -f deploy/testnet/docker-compose.buyer.yml up -d
docker compose -f deploy/testnet/docker-compose.buyer.yml logs -f
docker compose -f deploy/testnet/docker-compose.buyer.yml down
```

## 5. Legacy testnet service bring-up

This sequence starts the old testnet service layout. It is not an end-to-end
marketplace verification path.


```bash
# One-shot (skip if marketplace-net already exists)
docker network create marketplace-net

# Ollama, then pull the model
docker compose -f deploy/testnet/docker-compose.ollama.yml up -d
docker exec marketplace-ollama ollama pull qwen2.5:0.5b

# Supplier (needs ollama healthy)
docker compose -f deploy/testnet/docker-compose.supplier.yml up -d

# Indexer (independent of supplier)
docker compose -f deploy/testnet/docker-compose.indexer.yml up -d

# Buyer (needs indexer healthy)
docker compose -f deploy/testnet/docker-compose.buyer.yml up -d
```

Health summary:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep marketplace-
```

If a service stays unhealthy for more than ~60s, inspect logs via the
per-service `logs -f` commands in §4.

## 6. Stopping

Per-service:

```bash
docker compose -f deploy/testnet/docker-compose.<svc>.yml down
```

Wipe the named volumes (Ollama models, indexer DB):

```bash
docker compose -f deploy/testnet/docker-compose.ollama.yml  down -v
docker compose -f deploy/testnet/docker-compose.indexer.yml down -v
```

The supplier and buyer don't own volumes; their `down` is sufficient.

## 7. Mainnet

Use the mainnet compose projects only through a controlled rollout. Apply the
safe drain and health gates in §10. Use ingress maintenance for the first
incompatible drain-protocol rollout.

## 8. Historical M1-F gaps

The items below preserve the original M1-F review record. They do not describe
the current deployment state:

- **#5 mainnet safety** — hard requirement before any mainnet attempt.
- **#6 Ollama-failure leaves Claimed** — if Ollama crashes mid-request,
  on-chain escrow stays in `Claimed` until `deliver_by`. M1 has no
  automated recovery; the operator waits for the buyer to `Reclaim`.
- **#8 supplier boots `ReadOnlyOgmiosProvider`** — `submitTx` will throw.
  Real-chain Claim/Submit is broken until M1-F-2 swaps in
  `LiveOgmiosProvider`. The supplier image will boot and serve `/status`
  correctly; chat completions will fail at the Claim stage with
  `chain_submit_failed`. The supplier compose now points at real Ogmios
  via `apex-dashboard_apex-net` — no further compose changes needed when
  M1-F-2 lands.
- **#9 structural-vs-real-Ed25519** — buyer SDK currently does a
  structural receipt-signature check; tier-3 lifecycle exercises real
  Ed25519 by virtue of using real keys.
- **`ADVERT_REF` posting flow (M1-F-3)** — no CLI yet; supplier
  `/capability` returns 503 until a real advert UTxO exists.
- **Vector relay + Ogmios in compose** — Ogmios remains external (lives
  with apex-dashboard). Bringing it into the marketplace compose project
  is M1-F-vector-stack and is **not** planned.
- **`INDEXER_TIMEOUT_MS`** — referenced in `buyer/.env.example` but not
  yet honoured by `buyer/src/config.ts`. Buyer SDK uses a hardcoded
  timeout.
- **Buyer Vite UI build — Node-only imports leak into browser bundle** —
  `packages/shared/src/tx/blueprint.ts` imports Node-only modules into
  the buyer's browser bundle. This is **separate** from the M1-F-1
  alias-ordering fix and will need to be addressed by splitting
  `@marketplace/shared` into browser-safe and Node-only entry points.
  The Express server side of the buyer (which is what Docker actually
  runs) is unaffected — only `pnpm --filter @marketplace/buyer build:ui`
  is currently blocked.

## 9. Quick reference

| Service  | Internal URL                           | Health endpoint     | Compose project name      |
|----------|----------------------------------------|---------------------|---------------------------|
| ollama   | http://marketplace-ollama:11434        | (CMD ollama list)   | marketplace-ollama        |
| supplier | http://marketplace-supplier:8080       | /healthz            | marketplace-supplier      |
| indexer  | http://marketplace-indexer:8090        | /healthz            | marketplace-indexer       |
| buyer    | http://marketplace-buyer:8070          | /healthz            | marketplace-buyer         |

For the M1-F-2 (LiveOgmiosProvider) handoff: the supplier compose already
joins `apex-dashboard_apex-net` and overrides `OGMIOS_URL=ws://ogmios:1337`,
so once the supplier code stops booting `ReadOnlyOgmiosProvider` and
starts talking to a real Ogmios, no compose changes are needed.

## 10. Continuous deployment (mainnet, vector-marketplace host)

Merges to `main` deploy automatically to the mainnet host once CI is green:

1. `.github/workflows/ci.yml` runs typecheck + vitest on the merge commit.
2. On success, `.github/workflows/deploy-mainnet.yml` SSHes into the host
   (secret `DEPLOY_SSH_KEY`, host key pinned in the workflow) and executes
   `deploy/mainnet/deploy.sh` **at the new commit** (`git show FETCH_HEAD:...`),
   so deploy logic always matches the code being deployed.
3. The script checks out `origin/main`, maps the old-to-new diff to affected
   compose projects, and builds all affected images before restarts.
4. Before each supplier restart, it creates
   `/dev/shm/marketplace-draining`. This blocks new admission.
5. It waits for `/status` to report `active_sessions: 0` and no working job.
   An unknown value, unreadable status, or drain timeout fails closed and
   leaves the supplier running.
6. A health gate follows each restart. A stopped container loses the tmpfs
   marker. If a container survives an aborted rollout, the script clears the
   marker before it exits. Failure to clear it is a deployment failure.


The first rollout that introduces this drain protocol is incompatible with
the old supplier image because the old image does not enforce the marker.
Put supplier ingress into maintenance before any restart in that rollout.
Keep maintenance active until all suppliers run the new image and pass their
health gates.

Manual controls:

- **Manual deploy / redeploy**: Actions → "Deploy mainnet" → Run workflow
  (check *force* to redeploy the same sha), or on the host:
  `bash /root/agents-marketplace/deploy/mainnet/deploy.sh` (`FORCE=1` to
  redeploy, `DRY_RUN=1` to preview which projects would restart).
- **Rollback**: choose the known good commit from
  `/var/log/marketplace-deploy.log`, then run
  `cp /root/agents-marketplace/deploy/mainnet/deploy.sh /run/marketplace-rollback.sh`.
  Run `DEPLOY_REF=<old-sha> FORCE=1 bash /run/marketplace-rollback.sh`.
  `DEPLOY_REF` selects an existing local commit without fetching main.
  Do not reset the checkout and then run a script that resets back to
  `origin/main`.

Projects with no running containers on the host (e.g. wallet-monitor) are
skipped; image-only projects (ollama, chatmock, tts-piper) redeploy only when
their own compose file changes.
