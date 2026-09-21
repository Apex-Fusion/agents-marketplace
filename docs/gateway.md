# Responses API Gateway for the Vector Marketplace

## Public contract

The gateway is a multi-tenant custodial buyer. Each API key owns a separate buyer wallet. The gateway encrypts wallet keys with AES-256-GCM and decrypts them only for request handling.

The public inference surface is the OpenAI Responses API:

- `POST /openai/v1/responses`
- `GET /openai/v1/responses/:id`
- `DELETE /openai/v1/responses/:id`
- `GET /openai/v1/models`

There is no public `/chat/completions` alias. Migrate callers to `client.responses.create(...)` and use `input`, not `messages`.

The gateway also keeps a Vector session extension:

- `POST /openai/v1/chat/sessions`
- `POST /openai/v1/chat/sessions/:id/messages`
- `POST /openai/v1/chat/sessions/:id/close`

These session routes are not OpenAI standard routes. Their message bodies use Responses execution fields and Items.

## SDK example

Set the SDK base URL to the gateway path ending in `/openai/v1`:

```python
from openai import OpenAI

client = OpenAI(
    api_key="vma_...",
    base_url="https://gateway.example/openai/v1",
)

first = client.responses.create(
    model="the-advertised-model",
    input="Give one concise deployment check.",
)

second = client.responses.create(
    model="the-advertised-model",
    previous_response_id=first.id,
    input="Now explain why it matters.",
)
```

The corresponding request is:

```http
POST /openai/v1/responses
Authorization: Bearer vma_...
Content-Type: application/json

{
  "model": "the-advertised-model",
  "input": "Give one concise deployment check."
}
```

A completed response has the normal Responses shape. A one-shot marketplace response also has an `x_vector` receipt extension:

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1789900000,
  "model": "the-advertised-model",
  "status": "completed",
  "output": [
    {
      "id": "msg_...",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        {"type": "output_text", "text": "Check the health endpoint before routing traffic.", "annotations": []}
      ]
    }
  ],
  "usage": {"input_tokens": 12, "output_tokens": 9, "total_tokens": 21},
  "error": null,
  "incomplete_details": null,
  "previous_response_id": null,
  "x_vector": {
    "receipt": {
      "prompt_hash": "...",
      "response_hash": "...",
      "model": "the-advertised-model",
      "prompt_tokens": 12,
      "completion_tokens": 9,
      "wallclock_ms": 1800,
      "supplier_pkh": "...",
      "escrow_ref": "...#0"
    },
    "receipt_signature": "...",
    "escrow_ref": "...#0"
  }
}
```

Receipt token fields remain `prompt_tokens` and `completion_tokens`. The public Responses usage object uses `input_tokens` and `output_tokens`.

Read `output` Items as the authoritative result. A response can contain several message, function-call, or reasoning Items. Text extracted from `output_text` parts is only a convenience view. A refusal is a message content part such as `{"type":"refusal","refusal":"..."}`. It is not an empty text response.

An incomplete result is still a terminal and replayable response:

```json
{
  "status": "incomplete",
  "output": [{"type":"message","role":"assistant","status":"incomplete","content":[{"type":"output_text","text":"Partial result","annotations":[]}]}],
  "incomplete_details": {"reason":"max_output_tokens"},
  "error": null
}
```

Check `status` and `incomplete_details`. Do not infer completion from the presence of text.

## Requests and Items

`input` can be a string or an array of supported Responses Items. A string becomes one user message with an `input_text` part. Supported Items are:

- text messages with `system`, `developer`, `user`, or `assistant` roles;
- `function_call`;
- `function_call_output` with a matching pending `call_id`;
- `reasoning`, including encrypted replay content when supplied by a native provider.

Supported message content parts are `input_text`, `output_text`, and `refusal`. The gateway rejects image, audio, and other modalities on this route.

Function tools use the flat Responses form:

```json
{
  "model": "the-advertised-model",
  "input": "Get the weather for Paris.",
  "tools": [{
    "type": "function",
    "name": "get_weather",
    "description": "Get current weather",
    "parameters": {
      "type": "object",
      "properties": {"city": {"type": "string"}},
      "required": ["city"],
      "additionalProperties": false
    },
    "strict": true
  }]
}
```

Do not wrap the name and schema in a Chat Completions `function` object. Return tool results as `function_call_output` Items in a later request. Hosted tools are not supported.

The accepted execution controls are `instructions`, `max_output_tokens`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `text`, `temperature`, and `top_p`. Public controls are `model`, `stream`, `store`, `previous_response_id`, `metadata`, `include`, `public_preview`, and `x_vector.supplier_pkh`. The only supported `include` value is `reasoning.encrypted_content`.

Support at the public parser does not imply support by every supplier. Supplier capability data adds:

- `inference_api: "responses"`;
- `upstream_api`, such as `responses`, `chat-completions`, or `ollama`;
- `reasoning_disabled`.

The gateway rejects an explicitly incompatible request before it funds or claims an escrow. Native Responses suppliers can preserve reasoning and text controls. Compatibility adapters cannot represent every Responses feature. Legacy Ollama mode rejects function history, tools, reasoning, and other unsupported controls. No adapter silently retries through another HTTP API.

`max_output_tokens` is capped to the selected advert and supplier limit before the committed request is sent.

### Supplier upstream modes

`OPENAI_UPSTREAM_API=responses` is the default. `chat-completions` is an explicit compatibility selection for providers that are not upgraded. The adapter never changes API mode after an HTTP error.

`OPENAI_RESPONSES_URL` can set an exact native endpoint, such as `https://api.deepseek.com/responses`. `OPENAI_RESPONSES_STREAM_ONLY=1` asks the adapter to collect native SSE even when the marketplace call is buffered. The collector still returns one verified terminal Response to the one-shot settlement flow.

Native OpenRouter, Hugging Face, and DeepSeek templates send `store:false` upstream and replay full Items. They do not depend on provider-side response storage. An omitted buyer or operator control remains omitted upstream; the adapter does not add output, reasoning, or sampling caps that neither side requested.

Production Ollama uses its native `/v1/responses` endpoint through `LLM_BACKEND=openai`. The legacy `LLM_BACKEND=ollama` adapter has the restricted behavior described above. Capability fields, not the provider brand, are authoritative.

## Continuation, storage, and forks

`store` defaults to `true`. Stored request Items and terminal response objects are encrypted at rest. They expire after 30 days. A new descendant extends the retained life of its ancestors so the stored chain remains complete.

Use `previous_response_id` for every continuation that should reuse prior context:

```python
next_response = client.responses.create(
    model=first.model,
    previous_response_id=first.id,
    input=[{
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "Continue with an example."}],
    }],
)
```

Continuation has these rules:

- The API key must own the parent response.
- The model must match the parent model.
- The parent can have `completed` or `incomplete` status.
- The gateway replays every input and output Item in order. It does not replay only derived text.
- `x_vector.supplier_pkh` pins routing. A reusable demo session must also match that supplier.
- A continuation from the current head can reuse its active demo session.
- A continuation from a non-head parent creates a fork. A demo fork opens a new session and replays that branch.
- Supplying a full history without `previous_response_id` does not trigger prefix matching. For a demo key, it opens a new session.

A normal key starts a new `llm.text.generate.v1` escrow for every Responses call, including continuations. A demo key uses a managed `llm.chat.v1` session. It locks one escrow when the session opens and makes later turns without a per-turn escrow. The session settles or reclaims as one unit. Demo session reuse depends only on `previous_response_id` and the checks above.

`GET /openai/v1/responses/:id` returns an owned stored terminal response. `DELETE` removes that response and its descendants. Deleted and expired responses cannot be read or used as `previous_response_id`.

A response made with `store:false` is not inserted into public response storage. Its ID cannot be read or used as a later `previous_response_id`. The same request can still cite an existing stored parent. In that case, the gateway loads the parent chain but does not save the new result.

This public storage choice does not remove the operational state that an active escrow session needs. Active demo and explicit chat sessions keep encrypted transcript checkpoints until close, invalidation, or reclaim. This transcript supports session execution and settlement. It is not a public stored Response.

Do not treat in-flight work as fully resumable. The gateway checkpoints completed turns. It does not commit partial output deltas as a response. An ambiguous interruption can invalidate a session, while the sweeper handles escrow recovery separately.

## Streaming

Set `stream:true` to receive canonical typed Responses SSE events. Frames use both the event name and matching JSON `type`:

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_...","output_index":0,"content_index":0,"delta":"Check"}

```

Streams end with exactly one terminal event:

- `response.completed`;
- `response.incomplete`;
- `response.failed`.

The gateway does not send a public `data: [DONE]` sentinel. Consumers must wait for a typed terminal event and inspect its `response` object. Refusals use `response.refusal.delta` and `response.refusal.done`. Function arguments use `response.function_call_arguments.delta` and `.done`.

A normal one-shot stream remains buffered while inference and on-chain settlement finish. It can send keepalive comments, but it does not expose supplier output before settlement. A session stream relays text, refusal, function, reasoning, content-part, and item events live. The gateway emits the terminal public response after the turn checkpoint succeeds.

Native Codex-compatible providers can put complete output Items only in `response.output_item.done` and leave terminal `response.output` empty. The supplier adapter collects those complete Items by index. It never reconstructs authoritative Items from partial deltas.

## Escrow and settlement

### Normal keys

Normal Responses calls route to `llm.text.generate.v1`.

1. Route by model, capability, availability, and any supplier pin.
2. Check the request against supplier capability before funding.
3. Check balance and a pure AP3X collateral UTxO of at least 5 AP3X.
4. Post one escrow at the advert price.
5. Send the normalized Responses request to supplier `POST /v1/responses`.
6. Verify the signed receipt, prompt hash, response hash, model, supplier, and escrow reference.
7. Resolve the Submitted output, accept it on chain, and await confirmation.
8. Return the public Response and restore wallet health.

The required wallet balance covers price, buyer bond, supplier bond, collateral, and transaction fees. Routing matches capability and model. It does not promise the cheapest supplier.

### Demo and explicit sessions

Demo Responses calls and the `/chat/sessions` extension route to `llm.chat.v1`. Session turns stream off chain. The ordered transcript is settled at session close. `full` mode Claims, Submits a transcript receipt, and Accepts. `ticket` mode uses the Open escrow as an entry ticket and later reclaims it; usage records zero marketplace cost apart from chain fees.

An explicit session uses this sequence:

```http
POST /openai/v1/chat/sessions
{"model":"the-advertised-model"}

POST /openai/v1/chat/sessions/{session_id}/messages
{"input":"Start the analysis.","stream":true}

POST /openai/v1/chat/sessions/{session_id}/close
{}
```

The open response identifies the session. Message responses use the Responses object or typed SSE shape. The close response returns the settlement result and receipt in full mode. The caller, not `previous_response_id`, selects an explicit session through the path ID.

The managed demo session controller can close idle or least-recently-used sessions. A parent response then remains valid stored history, but a later continuation opens a new session and replays the chain.

The sweeper is state aware. It reclaims expired Open or Claimed escrows. It retries Accept for Submitted escrows while valid. It never blindly reclaims Submitted state.

## Receipt commitments

All hashes below use SHA-256 over UTF-8 bytes of the repository canonical JSON function. That function recursively sorts object keys in code-unit order, NFC-normalizes keys and string values, preserves array order, drops undefined object values, and emits compact `JSON.stringify` number syntax. This is a defined subset with additional NFC handling. Do not call it plain RFC 8785 JCS.

For a one-shot Response:

```text
prompt_hash = sha256(canonical({
  input,
  ...each present execution control
}))

response_hash = sha256(canonical({
  output,
  status,
  incomplete_details
}))
```

The prompt commitment contains the normalized execution request. Its possible controls are `instructions`, `max_output_tokens`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `text`, `temperature`, and `top_p`. It excludes public routing and storage controls such as `model`, `stream`, `store`, `previous_response_id`, `metadata`, and `x_vector`.

The one-shot response commitment includes full terminal output Items, including their item IDs and call IDs. It excludes the top-level response ID, `usage`, and the `x_vector` wrapper.

For an `llm.chat.v1` session:

```text
prompt_hash   = sha256(canonical({"kind":"llm.chat.v1","session_nonce":...}))
response_hash = sha256(canonical(ordered_input_and_output_items))
```

The session receipt therefore commits to the session nonce at open and the full ordered transcript at close.

Input-cap and cost accounting use the complete transmitted execution request JSON in UTF-8, including instructions and tools. They do not apply the hash function's NFC reduction before counting. Receipt signatures and the on-chain `result_receipt_hash` retain their existing schema.

## Privacy and key rotation

The gateway stores only a hash of each raw API key. Each custodial wallet private key uses a per-row AES-256-GCM nonce under `GATEWAY_MASTER_KEY`. Stored Responses and active session transcripts use the same sealed-row scheme.

Back up the gateway database and master key together. Losing the master key strands custodial wallets and encrypted response data. The rotation command decrypts and reseals all wallet keys, all stored request/response payloads, and every active session transcript in one database transaction. Restart the gateway with the new key after rotation.

TLS protects gateway and supplier transport. Suppliers receive plaintext execution requests to run inference. This design is not end-to-end private from suppliers. `public_preview:true` is a separate explicit disclosure control; it must not be inferred from response storage.

## Errors and migration notes

Errors use an OpenAI-shaped body: `{ "error": { "message", "type", "code", "param" } }`. Common cases include invalid API keys, unavailable models, insufficient funds or collateral, unsupported parameters, input limits, supplier overload, timeout, receipt verification failure, and escrow failure.

Migration from the removed Chat Completions surface:

1. Change the base URL to end in `/openai/v1`.
2. Call `client.responses.create` instead of `client.chat.completions.create`.
3. Replace `messages` with `input` Items or a string.
4. Use flat Responses function tools and `function_call_output` Items.
5. Keep every returned `output` Item for manual replay.
6. Prefer `previous_response_id` to manual replay when storage is enabled.
7. Stop parsing `choices`, finish reasons, chat chunks, or `[DONE]`.
8. Handle `completed`, `incomplete`, refusals, and typed stream failures explicitly.

## Account operations

- `POST /signup` creates a key and buyer deposit address.
- `GET /account` reports available and locked balances, collateral health, spend, and recent usage.
- `POST /account/withdraw` sends available funds to the requested address.
- `GET /` serves the self-service key and account UI.

Raw API keys are returned once. Withdrawal is the custodial exit path.

## Historical implementation notes

These notes describe resolved or retained behavior. They are not alternate API contracts.

- The old public `/openai/v1/chat/completions` route and pseudo-stream with `[DONE]` were removed during the Responses migration.
- The old chat-session adapter folded system messages into text. Responses sessions now carry typed system and developer message Items. Do not fold or guess textual prefixes.
- A 2026-09-05 through 2026-09-07 QA failure used a fixed gateway timeout shorter than the advert SLA. Current one-shot deadlines derive from `max_processing_ms` and include settlement budgets.
- Earlier request-number-two failures came from collateral fragmentation. The gateway now checks collateral before funding and consolidates wallets after settlement and on a health tick.
- Submitted escrows were once at risk from blind reclaim logic. The current sweeper retries Accept for Submitted state and only reclaims Open or Claimed state.
- Ticket-mode supplier restarts can forget an in-memory used-ticket record. The exposure remains bounded by the escrow deadline and sweeper. This is demo-grade session behavior, not normal one-shot billing.

The current testnet does not provide a functional end-to-end marketplace. Use local integration tests and a controlled mainnet smoke for lifecycle verification.
