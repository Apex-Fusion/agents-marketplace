# Hetzner Inference Supplier Fleet — Setup Runbook

> **Status:** shipped; fleet trimmed 2026-08-21. Hetzner retired
> `Kimi-K2.7-Code`, `GLM-5.2-NVFP4`, and `DeepSeek-V4-Flash-0731` from
> Inference (gone from `/v1/models`), so the 6 suppliers serving them were
> deregistered (adverts retired on-chain, containers removed). `Qwen3.8-27B`
> was added in their place, reusing the retired kimi-code wallets. Configures
> mainnet supplier nodes that use **Hetzner Inference**
> (`https://inference.hetzner.com`) as their **compute backend** for bonded
> inference work commissioned on Vector. Config only — no code changes.

---

## 1. What this is

Hetzner Inference is an OpenAI-compatible Chat Completions backend. Configure
it explicitly with `LLM_BACKEND=openai`,
`OPENAI_UPSTREAM_API=chat-completions`, `OPENAI_BASE_URL`, and the API key.
Do not let the default native Responses mode select the wrong path. The
supplier still exposes the marketplace Responses contract and translates
supported text and function Items for Hetzner. There is no HTTP fallback.
This is the compatibility pattern for all four Hetzner suppliers.

One supplier per (model × capability) — both the one-off
`llm.text.generate.v1` and the multi-turn `llm.chat.v1` capability:

| Supplier name | Model (on-chain + API param, verbatim) | Capability | Advert max_output_tokens |
|---|---|---|---|
| `qwen35b` | `Qwen/Qwen3.6-35B-A3B-FP8` | `llm.text.generate.v1` | 262144 |
| `qwen35b-chat` | `Qwen/Qwen3.6-35B-A3B-FP8` | `llm.chat.v1` | 262144 |
| `qwen38` | `Qwen3.8-27B` | `llm.text.generate.v1` | 262144 |
| `qwen38-chat` | `Qwen3.8-27B` | `llm.chat.v1` | 262144 |

Deregistered 2026-08-21 (models dropped by Hetzner): `kimi-code`,
`kimi-code-chat` (`Kimi-K2.7-Code`), `glm`, `glm-chat` (`GLM-5.2-NVFP4`),
`ds-flash-htz`, `ds-flash-htz-chat` (`DeepSeek-V4-Flash-0731`). The qwen38
pair reuses the kimi-code / kimi-code-chat wallets; the other four wallets
still hold funds and their env files remain on the host.

Shared advert parameters: price **200000 lovelace (0.2 AP3X)** flat per job,
bonds **1000000 lovelace (1 AP3X)** both sides, `max_processing_ms` **300000**
for one-off / **1800000** for chat (the session spans the whole conversation).
`max_output_tokens` is set to the model context length. With
`OPENAI_MAX_TOKENS` unset, the supplier forwards a buyer
`max_output_tokens` request as Chat Completions `max_tokens`, clamped to the
advert cap. When the buyer omits it, no token limit is sent upstream.

Names follow the brand-by-model convention; the retired `ds-flash-htz`
carried a `-htz` suffix only because `deepseek-flash-*` was already taken by
the OpenRouter fleet serving `deepseek/deepseek-v4-flash`.

## 2. Prerequisites

1. A Hetzner account with Inference access and an API key (usage-based billing
   to you as the node operator — the flat 0.2 AP3X job price is a business
   choice, not cost-derived). One key is shared by all suppliers; Hetzner
   rate limits apply to the aggregate.
2. One funded supplier wallet per supplier (50 AP3X each recommended; bonds
   are 1 AP3X per in-flight job and returned on completion).
3. The usual mainnet supplier deploy prerequisites (`deploy/README.md`).
4. **DNS**: one A record per supplier — `mp-suppliers-<name>.vector.apexfusion.org`
   → `91.98.147.172`, **DNS-only/unproxied**. There is NO wildcard for
   `*.vector.apexfusion.org`; and because traefik issues certs on-box via
   Let's Encrypt HTTP-01 (port 80), a proxied/CDN record would break issuance.
   Certs are issued automatically within ~a minute of the record propagating —
   no restarts needed.

## 3. Verify the backend before spending on-chain

The model ids come from `GET https://inference.hetzner.com/api/v1/models`.
This list changes, so check it before every new advert. The supplier sends
the advert model verbatim. Probe the configured compatibility API before
posting:

```bash
curl -sS -X POST https://inference.hetzner.com/api/v1/chat/completions \
  -H "Authorization: Bearer $HETZNER_KEY" -H "Content-Type: application/json" \
  -d '{"model":"Qwen3.8-27B","messages":[{"role":"user","content":"ping"}]}' \
  | jq '{content:.choices[0].message.content,usage}'
```

The content must be a non-empty string. Usage must include prompt,
completion, and total token counts so the adapter can produce canonical
Responses usage as `input_tokens`, `output_tokens`, and `total_tokens`.
Do not send `max_tokens` in this probe because the fleet operator ceiling is
unset. Also verify a tools and `tool_choice` round trip for chat suppliers.
The public supplier result is a Response object with authoritative `output`
Items, not a Chat Completions `choices` array.

## 4. Per-supplier bring-up (repeat per supplier)

```bash
# 1. wallet — prints privateKeyHex, publicKeyHex, pubKeyHash, address
pnpm --filter @marketplace/supplier tx:gen-keypair --network 1
# fund the printed address (50 AP3X recommended), then:

# 2. env file on the mainnet host
cp supplier/.env.hetzner.example /root/agents-marketplace/supplier/.env.<name>
chmod 600 /root/agents-marketplace/supplier/.env.<name>
# fill in all four wallet vars (PRIV_KEY_HEX, ADDRESS, PKH, PUB_KEY_HEX),
# OPENAI_API_KEY, and the ADVERT_* values from the table above. The wallet
# values are not derived at boot; a missing value causes 403 wrong_supplier.

# 3. advert (one-off shown; chat: --capability-id llm.chat.v1 --max-processing-ms 1800000)
pnpm --filter @marketplace/supplier tx:post-advert \
  --capability-id llm.text.generate.v1 \
  --model 'Qwen3.8-27B' \
  --max-output-tokens 262144 \
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

- `curl https://mp-suppliers-<name>.vector.apexfusion.org/healthz` returns
  `{"ok":true}`. `/capability` shows the right model and pkh, plus
  `inference_api: "responses"`, `upstream_api: "chat-completions"`, and
  `reasoning_disabled: false`.
- The indexer supplier list contains the advert with `advert_status: Active`
  and `status: free`.
- Gateway `GET /openai/v1/models` includes the Hetzner model ids.
- Use `POST /openai/v1/responses` for a controlled mainnet smoke. The current
  testnet has no functional marketplace.
- Watch supplier logs for `openai_malformed` or
  `upstream_api_incompatible`.

## 6. Footguns

- Keep `OPENAI_UPSTREAM_API=chat-completions`. Hetzner does not use the
  default native Responses path.
- Set `OPENAI_BASE_URL=https://inference.hetzner.com/api`. Do not add `/v1`;
  the compatibility adapter appends `/v1/chat/completions`.
- Leave `OPENAI_RESPONSES_URL` and `OPENAI_RESPONSES_STREAM_ONLY` unset.
- Leave `OPENAI_REASONING` unset. In Chat Completions mode, `off` sends the
  OpenRouter-only `reasoning:{enabled:false}` extension.
- The advert model must match the Hetzner id exactly, including the `Qwen/`
  prefix on `Qwen/Qwen3.6-35B-A3B-FP8`.
- Retired Kimi and DeepSeek ids matched the buyer PDF allowlist. Current Qwen
  ids do not. Buyer operators can change `PDF_MODEL_ALLOWLIST` and
  `PDF_MODEL_DENYLIST`.
- Keep `OPENAI_TIMEOUT_MS` at or below advert `max_processing_ms`.
- Chat compatibility cannot represent Responses reasoning Items or `text`
  controls. It rejects those requests before Claim. Supported function tools
  are translated to Chat Completions form.
