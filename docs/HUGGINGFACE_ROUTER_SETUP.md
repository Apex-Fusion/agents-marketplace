# HuggingFace Router Supplier — Setup Runbook (V1 / W1)

> **Purpose:** configure a Vector supplier node to use the HuggingFace
> Inference Providers router as its compute backend. This is configuration
> only. It does not state that a deployment has completed.

---

## 1. What this is

The HuggingFace **Inference Providers router**
(`https://router.huggingface.co`) fronts hosted models across partner
providers. The supplier uses its native Responses API.

Set `LLM_BACKEND=openai`, `OPENAI_UPSTREAM_API=responses`, and
`OPENAI_BASE_URL=https://router.huggingface.co`. The adapter sends
`POST /v1/responses` with `store:false` and full Item replay. A provider suffix
in the model id stays intact. There is no Chat Completions fallback.

```
buyer commissions bonded work ──▶ supplier node ──▶ HuggingFace router
   (AP3X escrow on Vector)             │              (compute backend, hf_ token)
                                       ▼
                    supplier fulfils the work; the escrow settles on-chain
```

The supplier node runs the inference to **fulfil work a buyer has commissioned
under stake**; HuggingFace is simply the compute it uses to produce the result.

**What this does NOT do:** it does not add creator/model-author work-sharing,
change protocol economics, or change how an advert's committed amount is sized.
Those are separate, larger pieces of work tracked in the team's internal planning
notes. This preset is the fast, low-risk on-ramp that proves the path.

---

## 2. Prerequisites

1. A HuggingFace account with **Inference Providers access** (a free monthly
   credit allowance, then usage-based per token — this is HuggingFace's billing
   to you as the node operator).
2. An access token from <https://huggingface.co/settings/tokens> with the
   **"Make calls to Inference Providers"** permission. It starts with `hf_`.
   Treat it like a password.
3. A funded supplier wallet (~5 AP3X for tx fees + bonds). Generate a seed with
   `openssl rand -hex 32`.
4. The usual supplier deploy prerequisites (Ogmios URL, a publicly reachable
   HTTPS endpoint for buyers). See `deploy/README.md`.

---

## 3. Steps

### 3.1 Create the env file

```bash
cp supplier/.env.huggingface-chat.example supplier/.env
chmod 600 supplier/.env
```

Fill in all four supplier wallet values, `OPENAI_API_KEY`, `OGMIOS_URL`, and
the `ADVERT_*` values. Key settings are:

| Var | Value | Why |
|-----|-------|-----|
| `LLM_BACKEND` | `openai` | selects the OpenAI-compatible adapter |
| `OPENAI_UPSTREAM_API` | `responses` | selects native Responses explicitly |
| `OPENAI_BASE_URL` | `https://router.huggingface.co` | the adapter appends `/v1/responses` |
| `OPENAI_API_KEY` | `hf_…` | HF Bearer token |
| `OPENAI_REASONING` | unset, or `off` only by policy | `off` sends native `reasoning.effort:"none"` |
| `ADVERT_MODEL` | provider-qualified id such as `deepseek-ai/DeepSeek-V3:fastest` | preserves provider selection |

### 3.2 Choose a model

HF uses **provider-qualified** model names. The value goes on-chain in
`AdvertDatum.model` and is forwarded verbatim to the router:

- `deepseek-ai/DeepSeek-V3:fastest` — bare id + `:fastest` picks the fastest provider
- `deepseek-ai/DeepSeek-V3:together` — pin a specific provider
- `openai/gpt-oss-120b` — open-weight, HF-hosted

Browse models and their providers at
<https://huggingface.co/models?inference_provider=all>.

The advert can use any router-supported model, but the operator must first
verify that its selected provider supports the Responses features buyers need.

### 3.3 Smoke-test the token before going on-chain

Confirm the token, model, endpoint, native output Items, and canonical usage:

```bash
curl -sS https://router.huggingface.co/v1/responses \
  -H "Authorization: Bearer $HF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-ai/DeepSeek-V3:fastest",
       "input":"say hi in 3 words",
       "store":false}' \
  | jq '{status,output,usage}'
```

Require `status: "completed"`, a non-empty `output` Item array, and usage with
`input_tokens`, `output_tokens`, and `total_tokens`. Text is an `output_text`
part inside a message Item. For tool-capable adverts, also probe the flat
Responses function form:
`{"type":"function","name":"...","parameters":{...}}`.

### 3.4 Post the advert

```bash
pnpm --filter @marketplace/supplier tx:post-advert \
  --capability-id llm.text.generate.v1 \
  --model deepseek-ai/DeepSeek-V3:fastest \
  --max-output-tokens 512 \
  --max-processing-ms 60000 \
  --price-lovelace 2000000 \
  --endpoint-url https://your-supplier.example.org
```

Copy the printed `<txHash>#0` into `ADVERT_REF` in `supplier/.env`. Use
`--dry-run` first to inspect the tx without submitting.

### 3.5 Boot

Boot locally without `LIVE_CHAIN=1` first. This checks configuration and
backend access without chain writes. The current testnet has no functional
marketplace. Use a controlled mainnet smoke only after the supplier, wallet,
advert, ingress, and native HF path are ready.

---

## 4. Sizing the advert (read before you post one)

`ADVERT_PRICE_LOVELACE` is the **flat AP3X amount committed in escrow per job**,
but the HuggingFace backend meters **per token**. The committed amount is fixed
per job while upstream token usage varies, so:

- Size for the worst-case full request, not only the visible prompt text.
- Cap output with the advert and, when required, `OPENAI_MAX_TOKENS`.
- Prefer small models when variable usage makes a flat job price risky.
- The base advert has no input-token field. A reseller capability can publish
  `max_input_tokens`; its bound counts the full transmitted JSON UTF-8,
  including instructions and tools, without NFC reduction.

This is a pre-existing protocol design point (fixed per-job advert amount vs.
variable upstream token usage), not specific to HuggingFace. It is the main thing
to account for when sizing an advert.

---

## 5. Reasoning policy

Native HF Responses accepts the standard reasoning control. Leave
`OPENAI_REASONING` unset to preserve buyer requests. Set it to `off` only when
the operator policy forbids reasoning. The supplier then sends
`reasoning:{effort:"none"}`, advertises `reasoning_disabled: true`, and rejects
an incompatible request before funding or Claim.

The old warning applies only to
`OPENAI_UPSTREAM_API=chat-completions`: HF rejects the OpenRouter-specific
`reasoning:{enabled:false}` form. This preset does not use that mode.

---

## 6. Where this sits

This preset is the multi-model on-ramp that uses the HuggingFace router as a
compute backend. Further work items (additional task adapters, advert-sizing
refinements, and protocol-economics changes) are tracked separately in the team's
internal planning notes, along with the upstream-terms check every operator must
complete before pointing a node at a third-party compute backend.
