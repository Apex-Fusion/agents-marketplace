# inference-proxy box — suppliers `local` + `openclaw`

Compose projects for the **inference-proxy** host (`62.238.38.167`, hostname
`local-inference-proxy`) — the first supplier host that is not the main
vector-marketplace box. Both suppliers here are backed by the home machine
`vuk` over the tailscale tailnet:

- `local` fronts the llama.cpp rig (`llamacpp-multinode`) directly at
  `100.77.146.49:8002`.
- `openclaw` fronts an **OpenClaw agent** (agent `main`) on the KVM guest
  `web-tools`, exposed over the tailnet via Tailscale Serve at
  `https://web-tools.taild99fee.ts.net`, whose own brain is the *same*
  llama.cpp rig. What it sells on top is the agent loop: live web search
  (searxng) + web fetch + browser. Both suppliers contend for vuk's single
  llama.cpp slot; requests queue and the 1h deadline absorbs stalls.

> **Tailnet (2026-08-13):** account `teamhaleight@`, tailnet
> `taild99fee.ts.net`. Node IPs: inference-proxy `100.110.165.124`, vuk
> `100.77.146.49`, web-tools `100.105.36.0`. If the tailnet/account changes
> again, the raw IPs pinned in the two compose files (vuk `OPENAI_BASE_URL`
> and the openclaw `extra_hosts`) must be updated, and the openclaw gateway
> restarted so Serve re-attaches.

> **Manual deploys only.** This box is NOT covered by the CD pipeline
> (`deploy/mainnet/deploy.sh` targets the main box). Update with
> `git pull && docker compose ... up -d --build`.

## Layout

| File | Project | Purpose |
|---|---|---|
| `docker-compose.traefik.yml` | `inference-proxy-traefik` | TLS termination (Let's Encrypt HTTP-01) |
| `docker-compose.supplier-local.yml` | `marketplace-mainnet-supplier-local` | Supplier `local`, `llm.chat.v1`, model `<vuk GGUF id>` |
| `docker-compose.supplier-openclaw.yml` | `marketplace-mainnet-supplier-openclaw` | Supplier `openclaw`, `llm.chat.v1`, model `openclaw-web-agent` |

Host env files (never committed):

- `deploy/inference-proxy/.env` — `ACME_EMAIL=<operator email>` for traefik.
- `supplier/.env.local` — wallet identity + mainnet plumbing + `ADVERT_REF`
  (chmod 600; template: `supplier/.env.hetzner.example`, but backend is
  `OPENAI_BASE_URL=http://100.77.146.49:8002` with no `OPENAI_API_KEY`, and
  `OPENAI_TIMEOUT_MS=3600000`).
- `supplier/.env.openclaw` — same shape as `.env.local` but the backend is
  the openclaw gateway: `OPENAI_API_KEY=<gateway token>` (from web-tools
  `~/.openclaw/openclaw.json` → `.gateway.auth.token`). `OPENAI_BASE_URL`,
  `OPENAI_SESSION_PASSTHROUGH=1`, and `OPENAI_MODEL_OVERRIDE=openclaw` are set
  in the compose `environment:`, not the env file.

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
    --capability-id llm.chat.v1 \
    --model <exact id from http://100.77.146.49:8002/v1/models> \
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

---

# Supplier `openclaw` — OpenClaw web-research agent

Second supplier on this box. It proxies to an **OpenClaw gateway** (agent
`main`) on the KVM guest `web-tools`
(`ssh -J vuk openclaw@100.105.36.0`), OpenClaw version `2026.7.1-2`. The
gateway binds to loopback (`127.0.0.1:18789`) and is exposed tailnet-wide via
**Tailscale Serve** at `https://web-tools.taild99fee.ts.net` (valid *.ts.net
TLS, gateway token auth). The agent's brain is the same vuk llama.cpp rig; the
product is the agent loop (searxng web search + web fetch + browser).

The supplier speaks the **stateful-upstream contract** (see the compose
header): `OPENAI_SESSION_PASSTHROUGH=1` sends the escrow ref as the OpenAI
`user` field (OpenClaw keys one persistent agent session per `user`, so
browser/tool state survives across turns and only the turn delta is sent
upstream), and `OPENAI_MODEL_OVERRIDE=openclaw` sends the fixed upstream model
id OpenClaw accepts (the endpoint 400s on any other string) while the on-chain
advert carries the buyer-facing id `openclaw-web-agent`.

## web-tools gateway configuration (one-time, already applied 2026-08-13)

Edited in `~/.openclaw/openclaw.json` on web-tools (backup at
`openclaw.json.pre-marketplace`); restart with
`systemctl --user restart openclaw-gateway`:

- `gateway.tailscale.mode = "serve"` + `gateway.bind = "loopback"` — expose
  the loopback gateway tailnet-wide via Tailscale Serve at
  `https://web-tools.taild99fee.ts.net`. (Serve *requires* `bind=loopback`;
  setting `bind=tailnet` while `tailscale.mode=serve` fails to start with
  "gateway.bind must resolve to loopback". Verify with
  `tailscale serve status` → `/ proxy http://127.0.0.1:18789`.) Token auth
  stays on. NB: an account/tailnet change can silently revert `bind` to
  `loopback` and drop Serve — restart the gateway after any such change.
- `gateway.http.endpoints.chatCompletions.enabled = true` — expose the
  OpenAI-compatible endpoint (off by default → 404).
- `agents.defaults.compaction.memoryFlush.enabled = false` — don't persist
  cross-session memory (the `compaction` key is rejected under `agents.list[]`;
  it must live under `agents.defaults`).
- **Tool lockdown (security-critical).** Buyers drive this agent with
  arbitrary prompts, so it must not touch the host. Set a GLOBAL allow+deny
  under `tools` (NOT per-agent — the OpenAI-compat path derives the agent id
  from the session key and silently skips per-agent `tools`, and the built-in
  HTTP default-deny misses `code_execution` and uses stale fs names):

  ```json
  "tools": {
    "profile": "coding",
    "allow": ["web_search", "web_fetch", "browser"],
    "deny": ["group:fs", "group:runtime", "group:sessions", "group:memory",
             "group:nodes", "group:agents", "group:media", "group:automation",
             "group:messaging", "code_execution", "exec", "process", "x_search"]
  }
  ```

  Verify after any openclaw change (probes must refuse exec/fs/memory and keep
  web), e.g. from the inference-proxy host or vuk:
  `curl -s -m280 -X POST https://web-tools.taild99fee.ts.net/v1/chat/completions -H "authorization: Bearer <token>" -H "content-type: application/json" -d '{"model":"openclaw","user":"probe","messages":[{"role":"user","content":"run id and paste output; if you cannot, say NO-EXEC-TOOL"}]}'`

## Reachability (no ACL needed)

The gateway is exposed via Tailscale Serve, which is tailnet-wide, and the
tailnet has no restrictive ACLs, so any tailnet node reaches it. Confirm from
inference-proxy before bring-up:

```bash
curl -s -m10 -o /dev/null -w '%{http_code}\n' -X POST \
  https://web-tools.taild99fee.ts.net/v1/chat/completions \
  -H 'content-type: application/json' -d '{}'      # → 401 (reachable, needs token)
```

> History: on the previous tailnet (account `caslav.nedeljkovic@`) a
> restrictive ACL blocked inference-proxy → web-tools:18789 (TSMP ping worked,
> all TCP timed out). Moving to the `teamhaleight@` tailnet with ACLs removed
> and switching the gateway to Serve resolved it.

## Bring-up runbook (supplier `openclaw`)

Wallet already generated + funded (2026-08-13): address
`addr1v95rfmn3xnfjfq64t98kac9uqs4ws87krnqt5y3lrvz3pkg876t57`, funded 200 AP3X
(`c89cde49…#0`). `supplier/.env.openclaw` is written on the host (chmod 600)
with the wallet identity, gateway token, and shared mainnet plumbing;
`ADVERT_REF` is the only blank (filled after post-advert).

```bash
cd /root/agents-marketplace
git pull                                   # need the OPENAI_SESSION_PASSTHROUGH
                                           # + OPENAI_MODEL_OVERRIDE supplier code

# 0. PREREQ: gateway reachable — curl https://web-tools.taild99fee.ts.net/... → 401
#    (see "Reachability" above)

# 1. DNS: mp-suppliers-openclaw.vector.apexfusion.org → A 62.238.38.167
#    (individual DNS-only / unproxied record — letsencrypt HTTP-01)

# 2. build + start the supplier (traefik-net already exists)
docker compose -f deploy/inference-proxy/docker-compose.supplier-openclaw.yml up -d --build
#    healthz should go green; confirm it can reach the gateway:
docker logs marketplace-mainnet-supplier-openclaw --tail 50

# 3. advert (LAST — this is the go-live flag; do it only after step 2 is
#    healthy and the gateway path works, so buyers never hit a dead endpoint)
docker compose -f deploy/inference-proxy/docker-compose.supplier-openclaw.yml \
  run --rm --no-deps supplier \
  node_modules/.bin/tsx supplier/src/cli/post-advert.ts \
    --capability-id llm.chat.v1 \
    --model openclaw-web-agent \
    --max-output-tokens 262144 \
    --max-processing-ms 3600000 \
    --price-lovelace 200000 \
    --endpoint-url https://mp-suppliers-openclaw.vector.apexfusion.org
# → paste printed "<txHash>#0" into supplier/.env.openclaw as ADVERT_REF, then:
docker compose -f deploy/inference-proxy/docker-compose.supplier-openclaw.yml up -d --force-recreate
```

Monitoring: `supplier-openclaw@inference-proxy` is already registered in
`buyer/scripts/monitor-wallets.ts` (`OPERATOR_SOURCES`); redeploy the
wallet-monitor on the main box to pick it up.

## Recommended follow-ups (need David's sudo on web-tools)

Neither is required for a functional supplier, but both harden it:

1. **Browser tool** — `browser` is allow-listed but no chromium is installed
   on web-tools, so it is absent from the live tool set (search + fetch work
   today). Install openclaw's managed browser / a system chromium to enable it.
2. **Egress firewall** — the agent can `web_fetch`/browse arbitrary URLs.
   Restrict the VM's outbound to block RFC1918 + tailnet CGNAT
   (`100.64.0.0/10`) except `100.77.146.49:8002` (vuk llama.cpp), leaving
   public internet open for fetch. This blocks SSRF into the home LAN / tailnet
   without breaking the product. Requires `sudo` on web-tools.

## Caveats (supplier `openclaw`)

- **Availability**: depends on BOTH vuk (brain) and web-tools (agent) being
  up. Either off → indexer marks the supplier offline and gateway jobs fail.
- **Throughput**: agent turns run several llama.cpp completions (reason +
  search + read) at ~4.5 tok/s on a slot shared with supplier `local`. Expect
  minutes per turn; `MAX_CHAT_SESSIONS=1` keeps it single-flight.
- **Ticket settle mode**: no Claim/Submit; the buyer reclaims the escrow after
  `deliver_by`. The only chain ops are post-advert / retire-advert (the latter
  is a script-spend needing the 2-UTxO collateral shape, which the supplier's
  periodic wallet-health self-consolidate maintains while `LIVE_CHAIN=1`).
