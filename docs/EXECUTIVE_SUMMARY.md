---
marp: true
paginate: true
size: 16:9
---

<!--
  EXECUTIVE_SUMMARY.md — slide-style overview of the Local Agents Marketplace.
  Build PDF + PPTX with: bash docs/build-deck.sh
  Edit this file; mermaid blocks are pre-rendered to docs/img/diagram-*.png.
-->

<style>
  /* ── Local Agents Marketplace — unified dark theme ────────────────────
   * Every slide uses the same navy→indigo gradient as the title slide so
   * the deck reads as one continuous document. Title and closing slides
   * keep the centered hero treatment; content slides stay top-aligned but
   * share the same palette and accent rules. */
  :root {
    --ink: #f1f5f9;          /* primary text on dark gradient */
    --muted: #94a3b8;
    --accent: #818cf8;       /* indigo-400, readable on the dark gradient */
    --accent-deep: #4f46e5;  /* used for solid accents (h2 bar, table head) */
    --accent-soft: rgba(129,140,248,0.12);
    --gradient: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #312e81 100%);
    --row-even: rgba(255,255,255,0.04);
    --row-odd:  rgba(255,255,255,0.02);
    --border:   rgba(255,255,255,0.10);
  }
  section {
    background: var(--gradient);
    color: var(--ink);
    font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
    font-size: 22px;
    padding: 40px 60px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
  }
  section::after {
    content: attr(data-marpit-pagination) ' / ' attr(data-marpit-pagination-total);
    color: var(--muted);
    font-size: 13px;
  }
  h1 {
    font-size: 48px;
    font-weight: 700;
    color: #ffffff;
    border-bottom: 4px solid var(--accent);
    padding-bottom: 10px;
    margin: 0 0 18px 0;
  }
  h2 {
    font-size: 34px;
    font-weight: 700;
    color: #ffffff;
    margin: 0 0 14px 0;
  }
  h2::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 28px;
    background: var(--accent);
    margin-right: 14px;
    vertical-align: middle;
    border-radius: 2px;
  }
  h3 { color: #c7d2fe; font-weight: 600; font-size: 24px; margin: 8px 0; }
  p, li { margin: 6px 0; line-height: 1.45; }
  ul, ol { margin: 8px 0 12px 0; padding-left: 28px; }
  strong { color: #ffffff; }
  a { color: #a5b4fc; }
  blockquote {
    border-left: 4px solid var(--accent);
    background: rgba(255,255,255,0.06);
    padding: 10px 18px;
    color: #e0e7ff;
    border-radius: 0 8px 8px 0;
    margin: 10px 0;
  }
  code {
    background: rgba(255,255,255,0.10);
    color: #e0e7ff;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.9em;
  }
  /* Constrain mermaid images so they always fit on a 720px-tall slide
   * (16:9 @ 1280×720 default). Soft white card behind the diagram so the
   * mermaid SVG (which renders on a transparent canvas with dark ink)
   * stays readable on the navy gradient. */
  img {
    display: block;
    margin: 8px auto;
    max-width: 92%;
    max-height: 420px;
    object-fit: contain;
    background: #ffffff;
    border-radius: 10px;
    padding: 10px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  }
  /* Tile grid for the local-agent versatility slide. */
  .backends {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin: 14px 0 12px 0;
  }
  .tile {
    background: var(--accent-soft);
    border: 2px solid var(--accent);
    border-radius: 10px;
    padding: 14px 16px;
    text-align: center;
    font-weight: 600;
    color: #ffffff;
  }
  .tile small {
    display: block;
    margin-top: 4px;
    font-weight: 400;
    color: var(--muted);
    font-size: 0.8em;
  }
  .tile.dots {
    background: rgba(255,255,255,0.04);
    border-style: dashed;
    color: var(--muted);
    font-size: 28px;
  }
  .pipeline {
    text-align: center;
    background: rgba(255,255,255,0.08);
    border: 1px solid var(--border);
    color: #f8fafc;
    padding: 12px 18px;
    border-radius: 10px;
    margin: 6px auto 14px auto;
    max-width: 760px;
    font-weight: 600;
  }
  .pipeline span {
    display: inline-block;
    margin: 0 10px;
  }
  /* Tables sit on a solid white card so cell text reads cleanly against
   * the dark gradient backdrop. Rounded outer corners + shadow match the
   * mermaid card styling. `display:table` + `table-layout:fixed` are
   * needed so the table actually consumes the full slide width — Marp's
   * default theme leaves tables at content-natural width, which left
   * blank gutters on either side. */
  table {
    display: table !important;
    width: 100% !important;
    table-layout: fixed;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 0.82em;
    color: #0f172a;
    background: #ffffff;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  }
  td, th { word-wrap: break-word; overflow-wrap: anywhere; }
  th {
    background: var(--accent-deep);
    color: #ffffff;
    text-align: left;
    padding: 9px 12px;
    font-weight: 700;
  }
  td {
    padding: 7px 12px;
    border-bottom: 1px solid #e2e8f0;
    color: #0f172a;
  }
  tr:nth-child(even) td { background: #ffffff; }
  tr:nth-child(odd)  td { background: #f8fafc; }
  /* code spans inside table cells need a light pill, not the dark one
   * defined globally — otherwise they'd disappear into the white row. */
  td code {
    background: #eef2ff;
    color: #1e293b;
  }
  /* Bold/strong inside cells must stay dark — the global rule paints
   * <strong> white for the dark-gradient body text, which would render
   * invisible against the white table card. */
  td strong, th strong {
    color: #0f172a;
  }
  th strong {
    color: #ffffff;
  }
  /* Title slide — centered hero treatment on the same gradient. */
  section.title {
    text-align: center;
    padding: 100px 80px;
    justify-content: center;
  }
  section.title h1 {
    display: inline-block;
    font-size: 64px;
    margin: 0 auto 20px auto;
  }
  section.title blockquote {
    margin: 28px auto;
    max-width: 900px;
  }
  /* Closing slide — same centered treatment. */
  section.closing {
    text-align: center;
    padding: 100px 80px;
    justify-content: center;
  }
  section.closing h2::before { display: none; }
  section.closing blockquote { font-size: 26px; max-width: 900px; }
</style>

<!-- _class: title -->

# Local Agents Marketplace

### A trust-minimised, on-chain marketplace for LLM inference

Buy and sell prompt → response with **bonded escrow** on **Vector** (UTxO).
No platform fee. No central rate-limiter. Verifiable receipts on chain.

> *Status: M1 lifecycle proven end-to-end on Vector testnet — 2026-05-05.*

---

## The problem

* AI inference is **centralised** — a handful of providers, opaque pricing, account-level rate limits.
* Local-AI hardware is **idle most of the time** — GPUs and CPUs sit unused between user prompts.
* Buyers and sellers can't transact directly without a **trusted intermediary** taking a cut.
* "Verifiable" claims about which model ran are usually nothing more than the provider's word.

We need a **two-sided marketplace** where:
1. Sellers monetise spare compute,
2. Buyers get a **cryptographic receipt** of what was actually computed,
3. **Neither side has to trust the other** — bonds + on-chain settlement enforce honesty.

---

## How it works — three actors, one chain

```mermaid
flowchart LR
    subgraph CHAIN[Vector — UTxO]
        ADV[Advert UTxO<br/>capability, price, bonds]
        ESC[Escrow UTxO<br/>locked funds + state]
    end

    SUP[🧠 Supplier<br/>local LLM node]
    BUY[💼 Buyer<br/>app or agent]
    IDX[🔭 Indexer<br/>read-only bulletin board]

    SUP -->|publish advert| ADV
    BUY -->|discover| IDX
    IDX -.->|index events| CHAIN
    BUY -->|post escrow| ESC
    BUY -->|prompt + escrow_ref| SUP
    SUP -->|signed receipt| BUY
    SUP -->|claim & submit| ESC
    BUY -->|accept & pay| ESC
```

* **Supplier** runs the inference and publishes a price.
* **Buyer** posts the work as a bonded escrow, sends the prompt, accepts the receipt.
* **Indexer** is a public mirror of chain state — anyone can run one. No platform middleman.

---

## The bonded-escrow lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant B as Buyer
    participant Chain as Vector
    participant S as Supplier
    participant LLM as Local LLM<br/>(OpenAI-compatible)

    S->>Chain: PostAdvert (locks supplier_bond)
    B->>Chain: PostEscrow → Open<br/>(locks payment + bonds)
    B->>S: POST /v1/chat/completions
    S->>Chain: ClaimEscrow → Claimed
    S->>LLM: run inference
    LLM-->>S: assistant message
    S->>Chain: SubmitEscrow → Submitted
    S-->>B: 200 OK + signed receipt
    B->>Chain: AcceptEscrow — supplier paid
```

Every transition is on-chain, validated by an Aiken Plutus V3 script. The receipt is signed by the supplier's advert key; prompt and response hashes are bound on chain.

---

## What if someone misbehaves?

```mermaid
flowchart LR
    OPEN[Open]:::norm --> CLAIMED[Claimed]:::norm --> SUBMITTED[Submitted]:::norm --> ACCEPTED[Accepted ✓]:::good
    OPEN -->|deliver_by passed| RECLAIM[Reclaimed<br/>buyer recovers funds]:::warn
    CLAIMED -->|deliver_by passed| RECLAIM
    SUBMITTED -->|accept_window passed| RELEASE[Released<br/>supplier collects]:::warn

    classDef norm fill:#e0e7ff,stroke:#4f46e5
    classDef good fill:#dcfce7,stroke:#16a34a
    classDef warn fill:#fef3c7,stroke:#d97706
```

| Failure mode | Recovery | Loss bearer |
|---|---|---|
| Supplier never claims/submits | Buyer **Reclaim** after `deliver_by` | Supplier — forfeits supplier_bond |
| Buyer disappears after Submit | Supplier **Release** after `submitted_at + 10 min` | Buyer — forfeits buyer_bond |

Bonds make honesty cheaper than running away. Both sides have skin in the game; no third-party arbiter is needed for the M1 happy/timeout paths.

---

## Local-agent versatility — any OpenAI-compatible engine

<div class="pipeline">
  <span>💼 Buyer</span> →
  <span>🧠 Supplier (OpenAI-compatible HTTP wrapper)</span> →
  <span>backend ↓</span>
</div>

<div class="backends">
  <div class="tile">Ollama<br/><small>local model runner</small></div>
  <div class="tile">vLLM<br/><small>high-throughput GPU</small></div>
  <div class="tile">llama.cpp<br/><small>CPU · Metal · ROCm</small></div>
  <div class="tile">OpenRouter<br/><small>cloud API mux</small></div>
  <div class="tile">openclaw / custom<br/><small>arbitrary stack</small></div>
  <div class="tile dots">…<br/><small>any OpenAI-shaped API</small></div>
</div>

The supplier service is a thin HTTP wrapper — it forwards `/v1/chat/completions` to whatever backend is configured. Each supplier picks its own model, hardware, and engine, then advertises a `capability_id`. Buyers shop on capability + model + price.

---

## Capability + model = task selection

| Capability ID | Example models | Use case |
|---|---|---|
| `llm.text.generate.v1` | Llama 3 · Qwen 2.5 · Mistral · GPT-4 | Q&A, drafts, summarisation |
| `code.completion.v1` | Codestral · DeepSeek-Coder · StarCoder | IDE tab-complete, refactor |
| `vision.describe.v1` | LLaVA · Qwen-VL · Pixtral | Image captioning, OCR |
| `embedding.text.v1` | nomic-embed · BGE · ada-002 | RAG indexing |
| `audio.transcribe.v1` | whisper-large-v3 · distil-whisper | Voice-to-text |
| `…` | … | … |

* New capabilities = **just publish a new advert**. No marketplace governance gate.
* Today's deploy uses Ollama + Qwen 2.5; switching to vLLM with Llama 3 70B is a config change, not a code change.

---

## OpenClaw — agentic teams on your existing OpenAI seat

<div class="pipeline">
  <span>🧠 Supplier wrapper</span> →
  <span>🦾 OpenClaw</span> →
  <span>🪪 OpenAI ChatGPT seat (flat-rate)</span>
</div>

* **Cost-efficient by default.** OpenClaw exposes your existing **OpenAI ChatGPT subscription** as an OpenAI-compatible API. The marketplace supplier dispatches its inference against it, so an entire **agentic team** (coders, QA automation testers, release curators…) draws from the **flat-rate seat you already pay for** — no per-token metering, no surprise invoices.
* **Reliability layer (optional, marginal cost).** OpenClaw can fall back to the **Anthropic API** or **OpenRouter** model pool when the primary seat is rate-limited, the prompt requires a different model, or you want a **second-layer hardening** of responses (e.g. cross-provider consensus on critical outputs). You only pay metered tokens for the requests that actually fall through.

---

## Proven on Vector testnet — 2026-05-05

| Step | Tx hash |
|---|---|
| Buyer posts escrow | `af762561…c2f7bc5` |
| Supplier claims | (lifecycle tx) |
| Supplier submits receipt | (lifecycle tx) |
| Buyer accepts | `125e3cfe…7dc100d` |

Funds flowed correctly: supplier received `payment + supplier_bond` (3 ADA); buyer got `buyer_bond` back.

* **Browser demo:** https://mp-buyers.vector.testnet.apexfusion.org
* **Live event stream:** https://mp-indexer.vector.testnet.apexfusion.org
* **Test suite:** 1098 unit tests passing, full lifecycle exercised in CI.

---

## Why UTxO + Vector

* **Bonded escrow is native** — Plutus validators enforce the state machine without a custom token or oracle.
* **Vector settles in seconds** — the buyer→claim→submit→accept loop fits inside a single chat-completion's wall clock.
* **AP3X token** for fees and bonds — fungible, transparent, on-chain.
* **No custom rollup, no bridge** — runs on a production chain today.

---

<!-- _class: closing -->

## The pitch in one sentence

> Local Agents Marketplace turns any OpenAI-compatible inference endpoint into a **trustlessly billable service** — buyer and supplier exchange prompt, response, and payment with on-chain proof that what was paid for is what was delivered.

### Try it

* **Indexer (live event stream):** https://mp-indexer.vector.testnet.apexfusion.org
* **Buyer:** https://mp-buyers.vector.testnet.apexfusion.org
* **Supplier:** https://mp-suppliers.vector.testnet.apexfusion.org/capability
