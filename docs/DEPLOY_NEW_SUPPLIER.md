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
kind (`CAPABILITY_KIND=tts`). Sections 2–8 cover the LLM kinds.
For reviewed local MCP tools, use [Paper2Agent setup](#9-paper2agent-tools).

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

## 9. Paper2Agent tools

`CAPABILITY_KIND=paper2agent` runs one configured local MCP tool.
It does not use an LLM backend or accept a buyer-supplied executable.
The package can expose other tools, but the configured name must be unique.
Only that tool can run through the advert.

### Agent-assisted operator workflow

Use the buyer app's `/paper2agent` page to submit a PDF, paper URL, or paper text.
Submission starts code generation and execution automatically under marketplace limits.
No source repository is required.
The [workflow guide](PAPER2AGENT_PLAN.md#paper-submission-and-review) explains results, review, and optional publication.
The manual package setup below remains available for already prepared tools.

#### Host and network boundaries

- Run build control on a wallet-free host with its own Docker daemon.
  Paper parsing, generated code, and verifier code are untrusted.
  On a shared CI host, use a dedicated rootless daemon and unprivileged account.
  Do not mount the CI Docker socket, CI credentials, or wallet keys.
  Docker shares the host kernel; it does not provide a VM boundary.
- Run the publisher on a separate trusted host.
  It holds the configured wallet slots and supervises the tool suppliers.
  Do not put a model API key on this host.
- Both service containers have Docker socket access.
  A rootful socket grants host-root access.
  A rootless build socket controls the dedicated build account, not the host root daemon.
  Do not use the build daemon for wallet services.
- Keep management endpoints behind a private TLS proxy or a private tunnel.
  The Compose defaults expose only host loopback ports: control `8095`, publisher `8096`.
  `PAPER2AGENT_CONTROL_PUBLISHED_PORT` selects a different host loopback port.
  `PAPER2AGENT_DOCKER_SOCKET` selects the dedicated build daemon socket.
  Keep `PAPER2AGENT_CONTROL_BIND_HOST` at `127.0.0.1` on a shared host.
  Configure URLs that are reachable from inside the calling containers.
  A container's `127.0.0.1` is not the host or another container.
- The publisher's public HTTPS proxy exposes only `/tools/*` and `/healthz`.
  Do not expose `/targets` or `/publications` to the public network.
  Management bearer tokens are separate from buyer access keys.

#### Rootless Docker on build-nixos-2

`paper2agent/deploy/build-host/provision.sh` installs the pinned Docker runtime and host guards.
It does not rebuild NixOS or restart the CI Docker daemon.
The dedicated account is `paper2agent-build`; its Docker socket is `/run/user/994/docker.sock`.
The `paper2agent-docker` command runs the CLI as that account and clears the caller environment.
Keep the release files under `/var/lib/paper2agent-build/release`, owned by that account.

Add these Compose values to the private `paper2agent/.env.control` file:

```dotenv
DOCKER_GID=0
PAPER2AGENT_DOCKER_SOCKET=/run/user/994/docker.sock
PAPER2AGENT_CONTROL_BIND_HOST=127.0.0.1
PAPER2AGENT_CONTROL_PUBLISHED_PORT=18095
PAPER2AGENT_MODEL_BASE_URL=https://api.marketplace.vector.apexfusion.org/v1/paper2agent/model
PAPER2AGENT_MODEL=auto
PAPER2AGENT_MODEL_API_KEY=<the same value as PAPER2AGENT_MODEL_TOKEN in production buyer/.env>
```

Keep the control token private and set the exact loaded runtime image ID.
Generate the model token with `openssl rand -hex 32` and set it in both files.
Each build model call is then a paid marketplace call from the buyer wallet.
See [Paid build model calls](PAPER2AGENT_PLAN.md#paid-build-model-calls).
Pass `--env-file` so Compose can read its interpolation values; service `env_file` alone is not sufficient.
After loading the built images, run this command from the release root:

```bash
paper2agent-docker compose -p paper2agent -f paper2agent/compose.control.yml \
  --env-file paper2agent/.env.control up -d --no-build --wait --wait-timeout 180
```

The user manager limits the whole build service to 8 GiB, four CPUs, and 4,096 processes.
Each generated-code container also has its own limits and no network.
The host guard permits public HTTPS, including the buyer's paid model endpoint, but blocks loopback services and private networks.
The root Docker socket and CI credentials remain inaccessible to the build account.
Disk use is not capped. Keep enough free space for build artifacts.

On the production host, `deploy/mainnet/docker-compose.paper2agent-link.yml` runs the restricted SSH link.
It forwards buyer control traffic to build-host loopback port `18095`.
Set the buyer control URL to `http://paper2agent-link:8095`.
The link publishes no host ports and holds no wallet keys.
Its Compose file documents the pinned host key, private key permissions, and recovery commands.

The production host also runs the publisher, with `deploy/mainnet/docker-compose.paper2agent-publisher.yml`.
Traefik serves it on the gateway host under `/p2a` and removes that prefix.
Public routes are `/p2a/tools/<target id>/*` and `/p2a/healthz`.
The management routes `/p2a/targets` and `/p2a/publications` accept only the build host IPv4 address and the bearer token.
The build host's `paper2agent/.env.control` sets `PAPER2AGENT_PUBLISHER_URL=https://api.marketplace.vector.apexfusion.org/p2a`.
It also sets `PAPER2AGENT_PUBLISHER_TOKEN` to the value in production `paper2agent/.env.publisher`.
The wallet slots are in `/root/paper2agent-publisher/publisher-targets.json`, outside the checkout.
That file is the only copy of each slot key. Back it up privately.
The publisher has six live slots, `paper-tool-1` to `paper-tool-6`. Each slot has its own wallet:

| Slot | Wallet |
|---|---|
| `paper-tool-1` | `addr1vy78w47xjc9mjqxucg0aguslpdgakf3tvwzlkuv2pl6cndgvk27hx` |
| `paper-tool-2` | `addr1vytv6mwyeun07qmgg49q0zhmxhz59qn0ym00k2xtg94dt5spa8572` |
| `paper-tool-3` | `addr1v86wzs8azj64heh7y9slcd9fvz60vma0cprae0fpwu9cu7c2dewht` |
| `paper-tool-4` | `addr1vx36s8tpwd82x4y290pyjux5a5tfqrw52wq39pv0x5w9g2qjez9jm` |
| `paper-tool-5` | `addr1vy53jeuvplmk4lvz7kegkeysqmmqs397u59394w7425fajq7mmw7u` |
| `paper-tool-6` | `addr1vxu2qc7k8h7vr7j628l630cgz76w3rjq6am049s38p4drqqrvg66t` |

Each slot endpoint is `https://api.marketplace.vector.apexfusion.org/p2a/tools/<slot>`.
To add a slot, append a target with a new key to the targets file.
Then run `docker compose -f deploy/mainnet/docker-compose.paper2agent-publisher.yml up -d --no-build --force-recreate --wait`.
The recreate drains and restarts the live tools.
Each published tool adds one supplier process of about 100 MiB inside the publisher's 768 MiB `mem_limit`.
Each tool session runs in a separate container with a 2 GiB memory limit.
An advert endpoint is permanent on chain. A new public URL or target ID needs a new advert.
`deploy.sh` does not manage the publisher. The Compose file lists the start command.

The production host has about 8 GiB of RAM and no swap.
During the 2026-10-12 image build, the kernel ran out of memory and killed Ollama.
Docker restarted it automatically.
Build application images off the production host.
Transfer the built images with `docker save` and `docker load`.
Then activate the selected services with `docker compose up --no-build`.
Do not run a second production build just to apply a documentation-only commit.

#### Build and transfer the trusted runtime

Build the base image once on the isolated host:

```bash
docker build -f paper2agent/runtime.Dockerfile -t vector-paper2agent-runtime:local .
docker image inspect vector-paper2agent-runtime:local --format '{{.Id}}'
docker save -o paper2agent-runtime.tar vector-paper2agent-runtime:local
```

Transfer the archive through the operator's trusted file channel.
Load it on the publisher host:

```bash
docker load -i paper2agent-runtime.tar
docker image inspect vector-paper2agent-runtime:local --format '{{.Id}}'
```

Verify that both Docker engines report the same exact `sha256:` image ID.
Use compatible engines and the transferred image, not two independent rebuilds.
Set `PAPER2AGENT_RUNTIME_IMAGE` to that exact ID on both hosts.
The control artifact binds this ID; the publisher rejects a different base.
The base provides Python 3.12 and FastMCP.
Generated packages can add pinned binary wheels through the restricted build path.
They cannot run online package installation or a package-supplied Dockerfile.

#### Configure the two services

On the build host:

1. Copy `paper2agent/.env.control.example` to `paper2agent/.env.control`.
2. Set a new random `PAPER2AGENT_CONTROL_TOKEN` of at least 32 characters.
3. Set the OpenAI-compatible model URL, model name, and API key.
   The endpoint must support function calls and the requested output-token limit.
4. Set the exact runtime image ID.
5. Set the private publisher URL and token only if publication is configured.
   Leave both empty for paper generation, execution, review, and downloads without publication.
6. Restrict the environment file to the operator.

On the publisher host:

1. Copy `paper2agent/.env.publisher.example` to `paper2agent/.env.publisher`.
2. Set `PAPER2AGENT_PUBLISHER_TOKEN` to the same publisher token used by control.
3. Set `PAPER2AGENT_TOOL_CALL_TOKEN` to the same value as the gateway's `PAPER2AGENT_TOOL_CALL_TOKEN`.
   Use a new random value of at least 32 characters, for example `openssl rand -hex 32`.
   It must differ from the publisher token.
   Leave it empty to disable unpaid tool calls.
4. Set the public HTTPS base URL and exact runtime image ID.
5. Copy `paper2agent/publisher-targets.json.example` to `paper2agent/publisher-targets.json`.
6. Configure one fresh, dedicated wallet key for each target slot.
   Do not reuse an existing LLM supplier wallet.
7. Set the target's Ogmios URL, network, and required chain settings.
   Live publication requires `LIVE_CHAIN=1` and `NETWORK_ID=1`.
   The publisher process and live target must use the same `VECTOR_ZERO_TIME_MS`.
   The template defaults to read-only operation.
8. Set the target file owner to UID `1000` and permissions to `0600`.
   The service image runs as that UID and refuses group/world-readable keys.

Start each role only on its designated host.
Run these commands from the repository root.
On the build host:

```bash
export DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
docker compose -f paper2agent/compose.control.yml up -d --build
```

On the publisher host:

```bash
export DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
docker compose -f paper2agent/compose.publisher.yml up -d --build
```

The named volumes store the build queue, packages, reviews, publication journal,
and supplier journals under `/repo/data`.
Keep them across upgrades.
Use a consistent backup of each volume.
Keep wallet key backups private and separate.

#### Connect the UI and roll out

Set `PAPER2AGENT_CONTROL_URL` and `PAPER2AGENT_CONTROL_TOKEN` in `buyer/.env`.
The buyer's existing `env_file` passes these settings to its server.
Neither setting is sent to the browser.

Update the indexer before the first advert publication.
The new Plutus codec reads chunked byte strings required by the 76-byte tool identity.
Roll out the buyer app and gateway with the normal drain and restart procedure.
These services need the operator UI, tool API, and shared codec changes.

A targeted manual rollout does **not** require restarting existing LLM suppliers.
It adds build control and its private link.
The optional publisher starts a managed supplier only after approved publication.
A publisher upgrade restarts its own managed tool suppliers after they drain.
The Compose stop grace is 17 minutes for the publisher and 3 minutes for control.

Do not push this release to `main` before the selective rollout completes.
The main auto-deploy rules select all running supplier projects for shared-code and lockfile changes.
Push an immutable release branch first; its CI does not trigger mainnet CD.
Back up the indexer, gateway database, and private configuration.
Hold `/run/marketplace-deploy.lock` while deploying that exact commit.
Build only the indexer, buyer, gateway, and new Paper2Agent services.
Keep each existing Compose project name and volume.
Restart and health-check the indexer, buyer, and gateway in that order.
Do not run `FORCE=1`, the full deploy script, or a combined Compose project.
After live checks pass, push the same commit to `main`.
The automatic deploy then finds the already deployed commit and has no restart work.

Open `/paper2agent` after the buyer restart.
Check build readiness and submit a paper.
Review the exact package and verification evidence before preparation.
Fund the displayed target address manually before approving a live advert.
The publication limit covers actual wallet debit, not just the supplier bond.
After the advert confirms, the gateway's public `/mcp` lists the tool and calls it for free.

If publication has an unknown outcome, use **Refresh publication status**.
Do not post a replacement advert.
The stored signed transaction fixes the publication identity.
A prepared slot stays reserved; there is no slot-release API.
A slot with a signed publication is not reused.

An interrupted build needs a new model-spend approval.
Control startup removes only the containers that belong to its recorded attempts.
If removal fails, restore Docker access and restart control before another build.
Do not delete the attempt records to bypass cleanup.

### Prepare the local package

Review the code, licenses, data rights, and dependencies first.
Pin the interpreter and dependencies.
Install them in the supplier environment before registration.
The standard Node supplier image does not install a Python scientific environment for you.

The MCP server must use stdio.
It must declare object input and output schemas.
It must return an inline object in `structuredContent`.
Text-only results, resource attachments, and file transfer are not supported.
Tool discovery also executes local package code.
Do not register untrusted code in a wallet process.
Environment filtering is not a sandbox.
Use operating-system isolation where needed.

`PAPER2AGENT_PACKAGE` names one regular artifact file, not a directory.
The digest covers that file.
It does not cover the whole environment.
Use a reviewed entry point or a prepared bundle with separately pinned dependencies.
Keep the artifact unchanged while its advert is active.

Set these absolute paths to the prepared installation:

```bash
export PAPER2AGENT_EXECUTABLE=/srv/tool-venv/bin/python
export PAPER2AGENT_ARGV_JSON='["/srv/reviewed-tool/server.py"]'
export PAPER2AGENT_CWD=/srv/reviewed-tool
export PAPER2AGENT_PACKAGE=/srv/reviewed-tool/server.py

export PAPER2AGENT_STATE_DIR="$HOME/.local/share/vector-paper2agent"
install -d -m 700 "$PAPER2AGENT_STATE_DIR"
export PAPER2AGENT_MANIFEST="$PAPER2AGENT_STATE_DIR/tool-v1.json"
export PAPER2AGENT_JOURNAL_DIR="$PAPER2AGENT_STATE_DIR/jobs"
```

`PAPER2AGENT_STATE_DIR` is a shell convenience, not a supplier setting.
Set `PAPER2AGENT_TOOL_NAME` to the exact name returned by the prepared MCP server.
Choose explicit byte and runtime limits.
For example:

```bash
export PAPER2AGENT_MAX_INPUT_BYTES=4096
export PAPER2AGENT_MAX_OUTPUT_BYTES=4096
export PAPER2AGENT_MAX_RUNTIME_MS=10000
pnpm exec tsx supplier/src/cli/register-paper2agent.ts
```

Registration inspects the real local MCP server.
It checks the artifact digest and both schemas.
It does not invoke the selected tool, install code, or call the chain.
It creates a new manifest file with mode `0600`.
It refuses to overwrite an existing manifest.
Use a new filename for a new version.

The global input limit is 65,536 bytes.
The global output limit is 262,144 bytes.
The runtime limit is at most 120,000 milliseconds.
The manifest limits can be smaller.
They must be positive.

### Publish and start

Retain the registration output.
It contains the full manifest hash and the required `post_advert_env` values.
Use the same tool paths when posting the advert and starting the supplier.
Set `CAPABILITY_KIND=paper2agent`.

The advert uses:

- Capability: `mcp.tool.execute.v1`.
- Model: `paper2agent:<full-manifest-hash>`.
- `max_output_tokens`: `0`.
- Default `max_processing_ms`: the tool runtime limit plus `270000`.

Use the normal wallet, network, endpoint, price, and bond settings.
The registration defaults supply the tool capability and model to `post-advert.ts`.
The default SLA allows time for Post confirmation before supplier admission.
An explicit shorter SLA must still meet the supplier execution allowance.
Do not exceed `390000` milliseconds: the buyer SDK rejects longer advert SLAs.

Unlike the LLM bootstrap sequence, tool startup requires a confirmed matching advert.
Complete offline registration before posting it.
Post the advert only with approval to spend real funds.
Set `ADVERT_REF` to its confirmed output reference.
Then start the configured supplier.
The supplier checks the advert, signing identity, and package digest at startup.
It checks the package and live tool schemas again before Claim.

Tool mode derives the address, public key, and PKH from `SUPPLIER_PRIV_KEY_HEX`.
If the corresponding public identity variables are also set, they must match.
Keep the private key out of the child configuration.
Supply the required interpreter and reviewed artifact in the runtime image or mounts.
Keep the journal directory on durable storage.

Check `/healthz`, `/status`, and `/capability` after startup.
The capability response includes the manifest, hash, and supplier public key.
The gateway's public `/mcp` lists a confirmed tool without an operator step.
See [public MCP access](gateway.md#paper2agent-tools).

### Recovery and upgrades

The supplier exposes four dedicated routes:

| Route | Purpose |
|---|---|
| `POST /v1/paper2agent/run` | One paid admission for the original Open escrow |
| `GET /v1/paper2agent/run/:jobId` | Read an existing job and its signed result |
| `POST /v1/paper2agent/lookup` | Find an existing job without another admission |
| `POST /v1/paper2agent/call` | One unpaid tool call, only when `PAPER2AGENT_FREE_CALLS=1` |

Admission and lookup use `X-Escrow-Ref`.
Their body is exactly `{manifest_hash,input}`.
Lookup requires the original request preimage.
It returns the job ID, escrow reference, manifest hash, and stored status.
It never starts a process, takes an execution slot, or signs a transaction.
It can find a previous-version job after restart.

The unpaid call uses the same body as admission, without `X-Escrow-Ref`.
It returns `{manifest_hash,result,wallclock_ms}` with HTTP 200.
It uses the same execution slot as paid admission.
When the slot is in use, it returns HTTP 409 `supplier_busy`.
It writes no journal entry, sends no transaction, and signs no receipt.
The supplier route has no authentication.
Do not set `PAPER2AGENT_FREE_CALLS` on a supplier with a public endpoint.
The publisher sets it for its managed suppliers only when `PAPER2AGENT_TOOL_CALL_TOKEN` is set.
The publisher forwards `POST /tools/<id>/v1/paper2agent/call` only with `Authorization: Bearer <token>`.
It returns HTTP 401 for a missing or wrong token, and HTTP 404 when no token is set.
It never forwards the token to the supplier.
During a drain, it refuses new calls with HTTP 503 `supplier_draining` and waits for active calls.
A direct buyer whose escrow arrives during an unpaid call gets `supplier_busy`.

Treat job IDs and request preimages as sensitive.
Supplier lookup is not separate customer authentication.
Low-entropy inputs can be guessed.
The gateway has no job routes for tool calls.

Do not delete old journal files when changing a package.
They preserve duplicate protection and result recovery.
Drain active work before an upgrade.
Register a new manifest instead of changing the old file.
Publish the matching advert.
Keep historical results available.

Execution that exceeds the declared runtime produces no signed result or Submit.
The remaining Claim can be reclaimed after its deadline.
A Submit confirmation error can still carry a valid signed result.
The buyer must check the chain before deciding the financial outcome.
