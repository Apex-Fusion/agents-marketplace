# Hetzner Inference Supplier Fleet — Setup Runbook

> **Status:** shipped. Configures 8 mainnet supplier nodes that use **Hetzner
> Inference** (`https://inference.hetzner.com`) as their **compute backend** for
> bonded inference work commissioned on Vector. Config only — no code changes.

---

## 1. What this is

Hetzner Inference is an OpenAI-compatible hosted API. Because the supplier's
upstream client (`supplier/src/openai.ts`) already speaks plain
`POST /v1/chat/completions` with a Bearer token, pointing it at Hetzner is
**pure configuration**: `LLM_BACKEND=openai` + `OPENAI_BASE_URL` + the API key.
This is the same pattern as the DeepSeek-direct and OpenRouter suppliers, and
the direct sibling of `docs/HUGGINGFACE_ROUTER_SETUP.md`.

One supplier per (model × capability) — 4 models, both the one-off
`llm.text.generate.v1` and the multi-turn `llm.chat.v1` capability:

| Supplier name | Model (on-chain + API param, verbatim) | Capability | Advert max_output_tokens |
|---|---|---|---|
| `kimi-code` | `Kimi-K2.7-Code` | `llm.text.generate.v1` | 262144 |
| `kimi-code-chat` | `Kimi-K2.7-Code` | `llm.chat.v1` | 262144 |
| `glm` | `GLM-5.2-NVFP4` | `llm.text.generate.v1` | 512000 |
| `glm-chat` | `GLM-5.2-NVFP4` | `llm.chat.v1` | 512000 |
| `ds-flash-htz` | `DeepSeek-V4-Flash-0731` | `llm.text.generate.v1` | 512000 |
| `ds-flash-htz-chat` | `DeepSeek-V4-Flash-0731` | `llm.chat.v1` | 512000 |
| `qwen35b` | `Qwen/Qwen3.6-35B-A3B-FP8` | `llm.text.generate.v1` | 262144 |
| `qwen35b-chat` | `Qwen/Qwen3.6-35B-A3B-FP8` | `llm.chat.v1` | 262144 |

Shared advert parameters: price **200000 lovelace (0.2 AP3X)** flat per job,
bonds **1000000 lovelace (1 AP3X)** both sides, `max_processing_ms` **300000**
for one-off / **1800000** for chat (the session spans the whole conversation).
`max_output_tokens` is set to the model's context length: no `max_tokens` is
forwarded upstream (`OPENAI_MAX_TOKENS` unset), so the advert value only gates
what buyers may request.

Names follow the brand-by-model convention; `ds-flash-htz` carries a `-htz`
suffix only because `deepseek-flash-*` was already taken by the OpenRouter
fleet serving `deepseek/deepseek-v4-flash`.

## 2. Prerequisites

1. A Hetzner account with Inference access and an API key (usage-based billing
   to you as the node operator — the flat 0.2 AP3X job price is a business
   choice, not cost-derived). One key is shared by all 8 suppliers; Hetzner
   rate limits apply to the aggregate.
2. Eight funded supplier wallets (50 AP3X each recommended; bonds are 1 AP3X
   per in-flight job and returned on completion).
3. The usual mainnet supplier deploy prerequisites (`deploy/README.md`); the
   wildcard DNS `*.vector.apexfusion.org` already covers the new hosts.

## 3. Verify the backend before spending on-chain

The four model ids come from `GET https://inference.hetzner.com/api/v1/models`
and are sent **verbatim** as the upstream `model` param (the runtime uses
`advert.model`). Before posting adverts, smoke-test each model:

```bash
curl -sS -X POST https://inference.hetzner.com/api/v1/chat/completions \
  -H "Authorization: Bearer $HETZNER_KEY" -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.2-NVFP4","messages":[{"role":"user","content":"ping"}]}' \
  | jq '.choices[0].message.content'
```

`choices[0].message.content` must be a non-empty string with **no `max_tokens`
sent** (matches runtime config) — the supplier throws `openai_malformed`
otherwise and forfeits its 1 AP3X bond per failed job. For chat suppliers also
verify a `tools`/`tool_choice` round-trip. All four models passed both checks
on 2026-08-11.

## 4. Per-supplier bring-up (repeat ×8)

```bash
# 1. wallet — prints privateKeyHex, publicKeyHex, pubKeyHash, address
pnpm --filter @marketplace/supplier tx:gen-keypair --network 1
# fund the printed address (50 AP3X recommended), then:

# 2. env file on the mainnet host
cp supplier/.env.hetzner.example /root/agents-marketplace/supplier/.env.<name>
chmod 600 /root/agents-marketplace/supplier/.env.<name>
# fill in: ALL FOUR wallet vars (PRIV_KEY_HEX, ADDRESS, PKH, PUB_KEY_HEX —
# they are NOT derived at boot; missing derived vars ⇒ 403 wrong_supplier),
# OPENAI_API_KEY, and the ADVERT_* values from the table above.

# 3. advert (one-off shown; chat: --capability-id llm.chat.v1 --max-processing-ms 1800000)
pnpm --filter @marketplace/supplier tx:post-advert \
  --capability-id llm.text.generate.v1 \
  --model 'GLM-5.2-NVFP4' \
  --max-output-tokens 512000 \
  --max-processing-ms 300000 \
  --price-lovelace 200000 \
  --endpoint-url https://mp-suppliers-<name>.vector.apexfusion.org
# paste the printed "<txHash>#0" into ADVERT_REF in the env file

# 4. first start is always manual (CD skips compose projects with no running
#    containers); subsequent rollouts ride the mainnet CD pipeline
docker compose -f deploy/mainnet/docker-compose.supplier-<name>.yml up -d

# 5. register the wallet for balance alerts
#    add {name, address} to wallet-monitor/wallets.json on the host
```

## 5. Verification

- `curl https://mp-suppliers-<name>.vector.apexfusion.org/healthz` → `{"ok":true}`;
  `/capability` shows the right model + pkh.
- Indexer: buyer `GET /v1/indexer/suppliers` lists the new entries with
  `advert_status: Active`, `status: free`.
- Gateway `GET /openai/v1/models` includes the four Hetzner model ids.
- Watch `docker logs -f marketplace-mainnet-supplier-<name>` through the first
  jobs for `openai_malformed` (reasoning-model content-shape risk).

## 6. Footguns

- `OPENAI_BASE_URL=https://inference.hetzner.com/api` — **no `/v1`**; the
  client appends `/v1/chat/completions`.
- Do **not** set `OPENAI_REASONING` — `reasoning:{enabled:false}` is an
  OpenRouter-only param.
- The advert `--model` must match the Hetzner id exactly, including the
  `Qwen/` prefix on `Qwen/Qwen3.6-35B-A3B-FP8` (slash is fine on-chain;
  precedent `moonshotai/kimi-k2.6`).
- `Kimi-K2.7-Code` and `DeepSeek-V4-Flash-0731` auto-join the buyer's PDF pool
  (case-insensitive substring allowlist `["kimi","deepseek","gpt"]` in
  `buyer/src/pdf/caps.ts`); GLM and Qwen stay out. Deliberate — adjust
  `PDF_MODEL_ALLOWLIST`/`PDF_MODEL_DENYLIST` in the buyer env to change it.
- `OPENAI_TIMEOUT_MS` must stay ≤ the advert's `max_processing_ms`.
