# HuggingFace Router Supplier — Setup Runbook (V1 / W1)

> **Status:** shipped. Configures a Vector supplier node to use the HuggingFace
> **Inference Providers router** as its **compute backend** for bonded inference
> work commissioned on Vector. Config only — no code changes.

---

## 1. What this is

The HuggingFace **Inference Providers router** (`https://router.huggingface.co`)
is an OpenAI-compatible endpoint that fronts hundreds of hosted models across
partner providers (Together, Fireworks, DeepInfra, Groq, …). It is the direct
analogue of the OpenRouter backend the supplier already supports.

Because the supplier's upstream client (`supplier/src/openai.ts`) already speaks
plain `POST /v1/chat/completions` with a Bearer token, pointing it at HuggingFace
is **pure configuration**: set `LLM_BACKEND=openai` and point `OPENAI_BASE_URL` at
the router. It is the same as adding any OpenAI-compatible compute backend, with
the HuggingFace endpoint and token substituted in.

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

Fill in `SUPPLIER_PRIV_KEY_HEX`, `OPENAI_API_KEY` (your `hf_…` token),
`OGMIOS_URL`, and the `ADVERT_*` values. Key settings for this preset:

| Var | Value | Why |
|-----|-------|-----|
| `LLM_BACKEND` | `openai` | routes chat through the OpenAI-compatible client |
| `OPENAI_BASE_URL` | `https://router.huggingface.co` | HF router; the `/v1/chat/completions` suffix is appended by the client — do **not** add it |
| `OPENAI_API_KEY` | `hf_…` | your HF token (Bearer) |
| `OPENAI_REASONING` | **unset** | HF 400s on the OpenRouter-only `reasoning` param (see §5) |
| `ADVERT_MODEL` | provider-qualified id, e.g. `deepseek-ai/DeepSeek-V3:fastest` | see §4 |

### 3.2 Choose a model

HF uses **provider-qualified** model names. The value goes on-chain in
`AdvertDatum.model` and is forwarded verbatim to the router:

- `deepseek-ai/DeepSeek-V3:fastest` — bare id + `:fastest` picks the fastest provider
- `deepseek-ai/DeepSeek-V3:together` — pin a specific provider
- `openai/gpt-oss-120b` — open-weight, HF-hosted

Browse models and their providers at
<https://huggingface.co/models?inference_provider=all>.

Because the model is on-chain data, you can advertise any router-supported chat
model without changing the supplier code — just post a new advert.

### 3.3 Smoke-test the token before going on-chain

Confirm your token + model + base URL work end to end, independent of the chain:

```bash
curl https://router.huggingface.co/v1/chat/completions \
  -H "Authorization: Bearer $HF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-ai/DeepSeek-V3:fastest",
       "messages":[{"role":"user","content":"say hi in 3 words"}],
       "stream":false}'
```

A `choices[0].message.content` in the response means the compute backend is
reachable. (Note: **no** `reasoning` field — see §5.)

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

Start read-only first (`LIVE_CHAIN` unset) to confirm the node boots and can
reach both Ogmios and the HF router, then set `LIVE_CHAIN=1` and restart to
enable real Claim/Submit. Deploy via the supplier compose file as in
`deploy/README.md`.

---

## 4. Sizing the advert (read before you post one)

`ADVERT_PRICE_LOVELACE` is the **flat AP3X amount committed in escrow per job**,
but the HuggingFace backend meters **per token**. The committed amount is fixed
per job while upstream token usage varies, so:

- Size it for your **worst-case** prompt length, not the average.
- Cap output tightly with `--max-output-tokens` — it is your main lever on
  upstream token usage.
- Prefer **small** models here; large models have wide token-usage variance and
  are harder to size a fixed per-job amount around.
- Buyer **input** tokens are not capped on-chain today. Until an input-token
  ceiling lands, stick to small models or add your own request-size guard.

This is a pre-existing protocol design point (fixed per-job advert amount vs.
variable upstream token usage), not specific to HuggingFace. It is the main thing
to account for when sizing an advert.

---

## 5. Footgun: `OPENAI_REASONING` must stay unset

`reasoning:{enabled:false}` is an **OpenRouter-specific** parameter. The HF
router **rejects it with HTTP 400 on every request**. When copying an existing
OpenRouter env, it is easy to carry `OPENAI_REASONING=off` over by accident.

The supplier guards against this: `loadConfig` **refuses to boot** if
`OPENAI_REASONING` is disabled while `OPENAI_BASE_URL` resolves to
`router.huggingface.co`, with a clear error naming the fix
(`supplier/src/config.ts`). Just leave `OPENAI_REASONING` unset for HF.

---

## 6. Where this sits

This preset is the multi-model on-ramp that uses the HuggingFace router as a
compute backend. Further work items (additional task adapters, advert-sizing
refinements, and protocol-economics changes) are tracked separately in the team's
internal planning notes, along with the upstream-terms check every operator must
complete before pointing a node at a third-party compute backend.
