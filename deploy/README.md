# Deploy runbook — Local Agents Marketplace (M1-F)

Operator-facing instructions for bringing up the four-service stack on a
Hetzner VM (or any Docker host) against an external Ogmios endpoint.

This is a REVIEW DRAFT. The artifacts (`Dockerfile`s, per-service compose
files under `deploy/testnet/` and `deploy/mainnet/`, `.env.example`s) have
not been deployed end-to-end. Run the stack only after a careful review
per-section below.

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

A parallel `deploy/mainnet/` directory mirrors the testnet layout with
`marketplace-mainnet-` prefixes and the mainnet ogmios network. The
mainnet stubs are wired but **deferred** — see §7.

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

Fund the supplier address with ~5 AP3X via the Vector testnet faucet
before starting the supplier.

`ADVERT_REF` is left empty until the post-advert CLI ships (see §8 known
gaps). Until then, supplier `/capability` returns 503 and the buyer
chat endpoint will fail at the Claim stage.

The `env_file:` directive uses `required: false`, so the compose files
parse and come up even with an empty/missing `.env` — the service will
crash at boot if mandatory env vars are absent, which is the desired
loud-fail behavior.

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

## 5. Bringing up the whole testnet stack

End-to-end first-time bring-up:

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

See `deploy/mainnet/`. **Deferred** per ARCHITECTURE.md §9 #5 — do not
`docker compose up` until the mainnet safety env-gate, wallet allowlist,
and `MAINNET=1` flag are wired in. The compose files parse cleanly so the
operator can flip them on later by removing the warning headers.

## 8. Known gaps (post-M1-F-1)

These ARCHITECTURE.md §9 follow-ups affect *deployment*:

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
