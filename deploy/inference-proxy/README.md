# inference-proxy box — supplier `local`

Compose projects for the **inference-proxy** host (`62.238.38.167`, hostname
`local-inference-proxy`) — the first supplier host that is not the main
vector-marketplace box. It fronts a llama.cpp rig (`llamacpp-multinode`) on
the home machine `vuk`, reachable only over the tailscale tailnet at
`100.82.111.46:8002`.

> **Manual deploys only.** This box is NOT covered by the CD pipeline
> (`deploy/mainnet/deploy.sh` targets the main box). Update with
> `git pull && docker compose ... up -d --build`.

## Layout

| File | Project | Purpose |
|---|---|---|
| `docker-compose.traefik.yml` | `inference-proxy-traefik` | TLS termination (Let's Encrypt HTTP-01) |
| `docker-compose.supplier-local.yml` | `marketplace-mainnet-supplier-local` | Supplier `local`, capability `llm.text.generate.v1` |

Host env files (never committed):

- `deploy/inference-proxy/.env` — `ACME_EMAIL=<operator email>` for traefik.
- `supplier/.env.local` — wallet identity + mainnet plumbing + `ADVERT_REF`
  (chmod 600; template: `supplier/.env.hetzner.example`, but backend is
  `OPENAI_BASE_URL=http://100.82.111.46:8002` with no `OPENAI_API_KEY`, and
  `OPENAI_TIMEOUT_MS=3600000`).

## Bring-up order (fresh box)

```bash
# 1. docker + network (one-shot)
curl -fsSL https://get.docker.com | sh
docker network create traefik-net

# 2. repo
git clone https://github.com/Apex-Fusion/agents-marketplace.git /root/agents-marketplace
cd /root/agents-marketplace/deploy/inference-proxy

# 3. traefik
echo 'ACME_EMAIL=<operator email>' > .env && chmod 600 .env
docker compose -f docker-compose.traefik.yml up -d

# 4. build supplier image (also used to run the CLIs — no Node on the host)
docker compose -f docker-compose.supplier-local.yml build

# 5. wallet: generate, then write all four values into supplier/.env.local
docker compose -f docker-compose.supplier-local.yml run --rm --no-deps supplier \
  node_modules/.bin/tsx supplier/src/cli/gen-keypair.ts --network 1
# → fund the printed address (~200 AP3X), and set DNS:
#   mp-suppliers-local.vector.apexfusion.org → A 62.238.38.167 (DNS-only/unproxied)

# 6. advert (after funding confirmed)
docker compose -f docker-compose.supplier-local.yml run --rm --no-deps supplier \
  node_modules/.bin/tsx supplier/src/cli/post-advert.ts \
    --capability-id llm.text.generate.v1 \
    --model <exact id from http://100.82.111.46:8002/v1/models> \
    --max-output-tokens 262144 \
    --max-processing-ms 3600000 \
    --price-lovelace 200000 \
    --endpoint-url https://mp-suppliers-local.vector.apexfusion.org
# → paste printed "<txHash>#0" into supplier/.env.local as ADVERT_REF

# 7. supplier
docker compose -f docker-compose.supplier-local.yml up -d
```

Register the wallet in monitoring on the **main** box: add the address to
`wallet-monitor/wallets.json` and `buyer/scripts/monitor-wallets.ts`
(`OPERATOR_SOURCES`).

## Model swap on vuk

The advert carries the exact model id (buyer-facing, routed on by the
gateway), while vuk serves whatever GGUF is loaded and ignores the request's
`model` field. After swapping the model on vuk:

```bash
cd /root/agents-marketplace/deploy/inference-proxy
docker compose -f docker-compose.supplier-local.yml run --rm --no-deps supplier \
  node_modules/.bin/tsx supplier/src/cli/retire-advert.ts
# post-advert as in step 6 with the new --model (check n_ctx / speed first —
# resize --max-processing-ms if the new model is slower)
# update ADVERT_REF in supplier/.env.local, then:
docker compose -f docker-compose.supplier-local.yml up -d --force-recreate
```

## Caveats

- **Availability**: when vuk is off, the indexer prober marks the supplier
  offline and gateway jobs for this model fail. Accepted for a home rig.
- **Throughput**: ~4.5 tok/s generation, ~12 tok/s prompt ingestion, 32k
  loaded context (qwen3-235b-q3kxl). Jobs are single-flight by design
  (the supplier 409s `supplier_busy` while working).
- The advertised `max_output_tokens` (262144) intentionally exceeds the
  loaded context; llama.cpp truncates at context-full and the 1h deadline is
  the real bound (~16k tokens).
