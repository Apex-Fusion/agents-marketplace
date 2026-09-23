# OpenAI-Compatible Gateway for the Vector Marketplace

## Public contract

The gateway is a multi-tenant custodial buyer. Each API key owns a separate buyer wallet. The gateway encrypts wallet keys with AES-256-GCM and decrypts them only for request handling.

The public inference surface supports the OpenAI Responses and Chat Completions APIs for text and function tools:

- `POST /openai/v1/responses`
- `POST /openai/v1/chat/completions`
- `GET /openai/v1/responses/:id`
- `DELETE /openai/v1/responses/:id`
- `GET /openai/v1/models`

Use `client.responses.create(...)` with `input`, or `client.chat.completions.create(...)` with `messages`. Both APIs use the same authentication, routing, execution, and settlement code. No custom session calls are required or exposed.

Optional `x_vector` receipt and supplier-routing fields and `public_preview` remain available for marketplace proof tools. Standard OpenAI clients do not need them.

The model list includes only Active models the key can use: `llm.text.generate.v1` for normal keys and `llm.chat.v1` for demo keys.

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

The Responses request is:

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

## Responses requests and Items

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

The gateway rejects an explicitly incompatible request before it funds or claims an escrow. Native Responses suppliers can preserve reasoning and text controls. Chat Completions adapters preserve JSON output formats, but still reject Responses reasoning options, reasoning Items, and text verbosity. Legacy Ollama restrictions remain unchanged. No adapter silently retries through another HTTP API.

`max_output_tokens` is capped to the selected advert and supplier limit before the committed request is sent.

### Supplier upstream modes

`OPENAI_UPSTREAM_API=responses` is the default. `chat-completions` is an explicit compatibility selection for providers that are not upgraded. The adapter never changes API mode after an HTTP error.

Chat Completions compatibility supports structured output without a
model-specific registration flag:

- `text.format: {"type":"json_object"}` becomes
  `response_format: {"type":"json_object"}`.
- `text.format: {"type":"json_schema","name":"t","strict":true,"schema":{...}}`
  becomes `response_format: {"type":"json_schema","json_schema":{"name":"t","strict":true,"schema":{...}}}`.
- The schema, name, optional description, and explicit `strict` value are
  preserved. The gateway does not replace schema enforcement with prompting
  or repair the generated JSON.

The public Chat Completions API normalizes `response_format` into the same
canonical request before the supplier restores the Chat envelope. Schema
enforcement remains the upstream model server's responsibility.

`OPENAI_RESPONSES_URL` can set an exact native endpoint, such as `https://api.deepseek.com/responses`. `OPENAI_RESPONSES_STREAM_ONLY=1` asks the adapter to collect native SSE even when the marketplace call is buffered. The collector still returns one verified terminal Response to the one-shot settlement flow.

Native OpenRouter, Hugging Face, and DeepSeek templates send `store:false` upstream and replay full Items. They do not depend on provider-side response storage. An omitted buyer or operator control remains omitted upstream; the adapter does not add output, reasoning, or sampling caps that neither side requested.

Production Ollama uses its native `/v1/responses` endpoint through `LLM_BACKEND=openai`. The legacy `LLM_BACKEND=ollama` adapter has the restricted behavior described above. Capability fields, not the provider brand, are authoritative.

## Chat Completions requests

Use standard Chat Completions messages and nested function definitions:

```python
completion = client.chat.completions.create(
    model="the-advertised-model",
    messages=[{"role": "user", "content": "Give one concise deployment check."}],
    max_completion_tokens=256,
)
print(completion.choices[0].message.content)
```

Supported request fields:

- `model` and non-empty `messages`.
- Text messages with roles `system`, `developer`, `user`, `assistant`, and `tool`.
  Content can be a string or text parts. Assistant messages can carry refusals
  or `tool_calls` with null or omitted content. Tool results use `role: "tool"`
  and `tool_call_id`.
- Function `tools`, `tool_choice`, and `parallel_tool_calls`.
- `max_completion_tokens` or `max_tokens`, but not both.
- `temperature`, `top_p`, `stream`, and `stream_options.include_usage`.
- `reasoning_effort` and `response_format` (`text`, `json_object`, or
  `json_schema`). JSON formats are preserved for native Responses and Chat
  Completions upstreams. Reasoning controls require a compatible native
  Responses supplier.
- `n: 1` and `store: false` (the defaults). Nullable default controls follow
  the Chat Completions request contract.
- Optional `x_vector.supplier_pkh` and `public_preview`.

Unsupported controls fail before execution. These include multiple choices,
`store: true`, named message participants, media, non-function tools, legacy
`functions`/`function_call`, stop sequences, penalties, log probabilities, and
other fields not listed above. Chat Completions has no stored-completion CRUD
API here; use Responses for stored objects and `previous_response_id`.

The result uses `object: "chat.completion"`, `choices[].message`, and
`finish_reason`. Function calls appear in `message.tool_calls`. Usage uses
`prompt_tokens`, `completion_tokens`, and `total_tokens`.

Send the full conversation on every Chat Completions call. Append the returned
assistant message and any tool-result messages to that history. No session ID
or custom continuation field is needed. A normal key pays for each call.
A demo Chat Completions call starts a managed session with that full history;
the gateway does not infer session identity from matching message prefixes.

Optional receipts still bind the canonical Responses execution and output
Items, not the rendered Chat `choices` object. Use Responses when a proof
consumer needs the complete result commitment or native reasoning Items.

## Responses continuation, storage, and forks

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

A normal key starts a new `llm.text.generate.v1` escrow for every inference call in either API, including continuations. A demo key uses a managed `llm.chat.v1` session. It locks one escrow when the session opens and makes later Responses turns without a per-turn escrow. The session settles or reclaims as one unit. Demo session reuse depends only on `previous_response_id` and the checks above.

`GET /openai/v1/responses/:id` returns an owned stored terminal response. `DELETE` removes that response and its descendants. Deleted and expired responses cannot be read or used as `previous_response_id`.

A response made with `store:false` is not inserted into public response storage. Its ID cannot be read or used as a later `previous_response_id`. The same request can still cite an existing stored parent. In that case, the gateway loads the parent chain but does not save the new result.

This public storage choice does not remove the operational state that an active escrow session needs. Managed demo sessions keep encrypted transcript checkpoints until close, invalidation, or reclaim. This transcript supports session execution and settlement. It is not a public stored Response.

Do not treat in-flight work as fully resumable. The gateway checkpoints completed turns. It does not commit partial output deltas as a response. An ambiguous interruption can invalidate a session, while the sweeper handles escrow recovery separately.

## Streaming

### Responses streaming

Set `stream:true` to receive canonical typed Responses SSE events. Frames use both the event name and matching JSON `type`:

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_...","output_index":0,"content_index":0,"delta":"Check"}

```

Streams end with exactly one terminal event:

- `response.completed`;
- `response.incomplete`;
- `response.failed`.

The Responses API does not send a public `data: [DONE]` sentinel. Consumers must wait for a typed terminal event and inspect its `response` object. Refusals use `response.refusal.delta` and `response.refusal.done`. Function arguments use `response.function_call_arguments.delta` and `.done`.

A normal one-shot stream in either API remains buffered while inference and on-chain settlement finish. It can send keepalive comments, but it does not expose supplier output before settlement. A managed demo Responses stream relays text, refusal, function, reasoning, content-part, and item events live. The gateway emits the terminal public response after the turn checkpoint succeeds.

Native Codex-compatible providers can put complete output Items only in `response.output_item.done` and leave terminal `response.output` empty. The supplier adapter collects those complete Items by index. It never reconstructs authoritative Items from partial deltas.

### Chat Completions streaming

Set `stream: true` to receive `data:` frames containing
`object: "chat.completion.chunk"`. Text and refusals appear in `choices[].delta`.
Tool deltas carry stable call IDs and tool indices so clients can assemble
fragmented function arguments.

The terminal choice reports `stop`, `tool_calls`, `length`, or `content_filter`.
With `stream_options: {"include_usage": true}`, regular chunks have
`usage: null`. When the supplier reports usage, one final chunk carries it with
an empty `choices` array. Successful and incomplete streams then end with
`data: [DONE]`.

A failure after headers are sent produces an OpenAI-shaped error frame.
It does not produce a successful finish chunk or `[DONE]`. Managed demo Chat
streams convert live text, refusal, and function events into this format.

## Escrow and settlement

### Normal keys

Normal Responses and Chat Completions calls route to `llm.text.generate.v1`.

1. Route by model, capability, availability, and any supplier pin.
2. Check the request against supplier capability before funding.
3. Check balance and a pure AP3X collateral UTxO of at least 5 AP3X.
4. Post one escrow at the advert price.
5. Send the normalized Responses request to supplier `POST /v1/responses`.
6. Verify the signed receipt, prompt hash, response hash, model, supplier, and escrow reference.
7. Resolve the Submitted output, accept it on chain, and await confirmation.
8. Return the requested OpenAI response format and restore wallet health.

The required wallet balance covers price, buyer bond, supplier bond, collateral, and transaction fees. Routing matches capability and model. It does not promise the cheapest supplier.

The indexer's availability status is a cache. If no cached free or unknown
supplier matches, the gateway checks the matching working/offline suppliers'
live `/status` endpoints. This permits the next request after a completed job
without waiting for the indexer poll. Probes have a two-second timeout and
four-request concurrency. Live busy, offline, malformed, or unreachable
results do not become eligible. Hard supplier pins and preferred ordering
still apply.

### Managed demo sessions

Demo keys route both standard APIs to `llm.chat.v1`. The gateway handles
session creation, turns, and closure internally. Clients never call a public
session lifecycle API.

Responses can reuse an active managed session with `previous_response_id`.
Chat Completions sends full message history and opens a new managed session
for that request. It does not use heuristic prefix matching.

Settlement follows `CHAT_SETTLE_MODE`. Full mode uses Claim and Submit, with
gateway settlement and recovery handling the Submitted escrow. Ticket mode
uses the Open escrow as an entry ticket and later reclaims it. Ticket usage
records zero marketplace cost apart from chain fees.

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

Compatibility failures identify the rejected field in `error.param`, such as
`reasoning`, `reasoning_effort`, or `text.verbosity`. An unknown model or
required capability returns `model_not_found`. An existing Active model whose
matching suppliers are busy returns HTTP 503 `overloaded`; unavailable
suppliers return HTTP 503 `suppliers_unavailable`.

Migration from the removed custom session API:

1. Keep the SDK base URL ending in `/openai/v1`.
2. Use `client.responses.create` with `input`, or
   `client.chat.completions.create` with `messages`.
3. Remove session-open, session-message, and session-close calls.
4. Use Responses `previous_response_id` for stored continuation, or send
   complete Chat message history with assistant tool calls and tool results.
5. Parse the selected API's format: Responses Items and typed terminal
   events, or Chat `choices`, finish reasons, chunks, and `[DONE]`.
6. Keep Vector receipt processing only if the application needs it.

The former `/openai/v1/chat/sessions` routes now return OpenAI-shaped 404
errors. They are not compatibility aliases. Drain existing explicit sessions
before rolling out this API change.

## Account operations

- `POST /signup` creates a key and buyer deposit address.
- `GET /account` reports available and locked balances, collateral health, spend, and recent usage.
- `POST /account/withdraw` sends available funds to the requested address.
- `GET /` serves the self-service key and account UI.

Raw API keys are returned once. Withdrawal is the custodial exit path.

### Operator key inventory

The buyer application's **API Keys** tab lists every gateway key, including
demo and disabled keys. Each row shows the saved key prefix, label, status,
deposit address, creation time, and wallet balance in AP3X. Full keys remain
visible only at creation. The list contains no key hashes or encrypted wallet
secrets.

Balances come from current wallet UTxOs. They exclude funds held in escrow.
A failed wallet query shows **Balance unavailable**, not zero. Use **Refresh
balances** to load current values. Successful key creation also refreshes the
list.

The browser calls `GET /v1/api-keys` on the buyer service. This route requires
the operator session. The buyer then calls `GET /internal/api-keys` on the
gateway with a server-only bearer token. Customer and demo API keys cannot
access this inventory. Both responses use `Cache-Control: no-store`.

To enable the list:

1. Generate a separate random token with `openssl rand -hex 32`.
2. Set `GATEWAY_ADMIN_TOKEN` to that value in both `gateway/.env` and
   `buyer/.env`. Do not reuse `GATEWAY_MASTER_KEY` or a customer API key.
3. Set the buyer's `GATEWAY_INTERNAL_URL` to the gateway base URL. The mainnet
   buyer compose file sets `http://marketplace-mainnet-gateway:8080`. For local
   services, use the gateway's local URL, such as `http://localhost:3010`.
4. Rebuild and redeploy the gateway and buyer services.

The token must contain at least 32 characters. It is not included in the SPA
boot data or browser requests. Missing configuration disables the list but
does not disable public key creation. Existing keys need no migration.

The inventory response has a `keys` array ordered newest first. Each item
contains `id`, `key_prefix`, `label`, `deposit_address`, `created_at` (Unix
milliseconds), `disabled`, `demo`, `balance_lovelace`, and `balance_error`.
The balance is an integer string. If its query fails, the balance is `null`
and `balance_error` contains a public error message.

## Historical implementation notes

These notes describe resolved or retained behavior. They are not alternate API contracts.

- The old public `/openai/v1/chat/completions` route and pseudo-stream with `[DONE]` were removed during the Responses migration.
- The old chat-session adapter folded system messages into text. Responses sessions now carry typed system and developer message Items. Do not fold or guess textual prefixes.
- A 2026-09-05 through 2026-09-07 QA failure used a fixed gateway timeout shorter than the advert SLA. Current one-shot deadlines derive from `max_processing_ms` and include settlement budgets.
- Earlier request-number-two failures came from collateral fragmentation. The gateway now checks collateral before funding and consolidates wallets after settlement and on a health tick.
- Submitted escrows were once at risk from blind reclaim logic. The current sweeper retries Accept for Submitted state and only reclaims Open or Claimed state.
- Ticket-mode supplier restarts can forget an in-memory used-ticket record. The exposure remains bounded by the escrow deadline and sweeper. This is demo-grade session behavior, not normal one-shot billing.

The current testnet does not provide a functional end-to-end marketplace. Use local integration tests and a controlled mainnet smoke for lifecycle verification.
