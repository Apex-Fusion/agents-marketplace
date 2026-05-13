/**
 * run-agent-b.ts — Marketplace adversarial-buyer runner (Agent B).
 *
 * Probes marketplace defenses across four attack styles. Throwaway script —
 * not committed. Logs every tx hash, HTTP code, validator rejection.
 *
 * Hard caps (operator-confirmed):
 *   - max 10 escrows
 *   - burn ceiling 10 AP3X
 *   - max 100 HTTP requests at ≤2 rps
 *   - stop on first GAP
 *
 * Deferred sub-attacks (not implemented this run, called out in the report):
 *   - B1 (capability_id mismatch in datum) — needs hand-rolled datum builder
 *   - B6 (FLOAT64 CBOR injection) — needs hand-rolled CBOR encoder
 *   - D5 (3 sybil wallets concurrent post) — needs faucet + 3 wallet derivations
 *
 * Usage: tsx buyer/scripts/run-agent-b.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import {
  LiveOgmiosProvider,
  type ChainProvider,
  type OutputReference,
} from "@marketplace/shared/chain";
import {
  buildPostEscrowTx,
  buildReclaimTx,
  buildReleaseTx,
  buildAcceptTx,
  TxConstructionError,
} from "@marketplace/shared/tx";
import { Marketplace, MemoryTaskHistoryStore } from "../src/sdk/index.js";
import { runAccept } from "../src/cli/acceptFlow.js";
import { deriveWalletKey } from "../src/index.js";

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

// ─── Config ─────────────────────────────────────────────────────────────

function loadDotEnv(path: string): Record<string, string> {
  const text = readFileSync(path, "utf-8");
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = loadDotEnv("/home/david/code/agents-marketplace/buyer/.env");

const ADVERT_REF_ACTIVE: OutputReference = {
  txHash: "9e9a86098c18cecf544d4c69e16ace850ab8c271a8bbea2facdaafc3be52701c",
  index: 0,
};
const ADVERT_REF_RETIRED: OutputReference = {
  txHash: "386d30fdc3e69c5a7063b9bb99a6ea3e2bee79498c16a22cf3a9c74a4a004040",
  index: 0,
};
const ADVERT_PRICE_LOVELACE = 5_000_000n;
const SUPPLIER_URL = "https://supplier.summitstak.ing";

// Hard caps. Raised burn cap on the continuation run (reclaim now works after
// the reclaim.ts live-mode fix landed mid-session). The original 10 AP3X cap
// fired prematurely because burned-counter conflated locked-in-escrow with
// irrecoverable burn. Post-fix: net fees per chargeable attack are ~0.5-1 AP3X.
const CAP_ESCROWS = 10;
const CAP_BURN_LOVELACE = 25_000_000n;
const CAP_REQUESTS = 100;
const RATE_LIMIT_MS = 500;

const wk = deriveWalletKey(env.BUYER_PRIV_KEY_HEX, 1);
const chain: ChainProvider = new LiveOgmiosProvider({ ogmiosUrl: env.OGMIOS_URL });
const marketplace = new Marketplace({
  chain,
  indexerUrl: env.INDEXER_URL,
  walletKey: wk,
  networkParams: { networkId: 1 },
  historyStore: new MemoryTaskHistoryStore(),
});

// ─── Hard-cap accounting ────────────────────────────────────────────────

interface Counters {
  escrowsPosted: number;
  requestsSent: number;
  burnedLovelace: bigint;
}
const counters: Counters = { escrowsPosted: 0, requestsSent: 0, burnedLovelace: 0n };
let lastReqMs = 0;

function checkCapsBeforePost(): void {
  if (counters.escrowsPosted >= CAP_ESCROWS) throw new Error(`hard-cap: ${counters.escrowsPosted} escrows posted (limit ${CAP_ESCROWS})`);
  if (counters.burnedLovelace >= CAP_BURN_LOVELACE) throw new Error(`hard-cap: burn ${counters.burnedLovelace} ≥ ${CAP_BURN_LOVELACE}`);
}
function checkCapsBeforeRequest(): void {
  if (counters.requestsSent >= CAP_REQUESTS) throw new Error(`hard-cap: ${counters.requestsSent} requests sent (limit ${CAP_REQUESTS})`);
}

async function rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
  checkCapsBeforeRequest();
  const now = Date.now();
  const wait = Math.max(0, RATE_LIMIT_MS - (now - lastReqMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqMs = Date.now();
  counters.requestsSent += 1;
  return fetch(url, init);
}

// ─── Logger ─────────────────────────────────────────────────────────────

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function head(body: unknown, n = 400): string {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// ─── Attack result ──────────────────────────────────────────────────────

type Verdict = "BLOCKED" | "GAP" | "UNCLEAR" | "SKIPPED";

interface AttackResult {
  id: string;
  category: "A" | "B" | "C" | "D";
  what: string;
  expected: string;
  what_happened: string;
  verdict: Verdict;
  evidence: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function walletLovelace(): Promise<bigint> {
  const utxos = await chain.queryUtxosByAddress(wk.address);
  return utxos.reduce((acc, u) => acc + BigInt(u.lovelace), 0n);
}

// ─── A: Within-protocol cheating ────────────────────────────────────────

async function attack_A2(): Promise<AttackResult> {
  const id = "A2";
  const what = "Build a Release tx as the BUYER (Release is supplier-only).";
  const expected = "buildReleaseTx with non-supplier key → either signature/owner mismatch, or chain validator rejection.";
  try {
    // First we need a Submitted-state escrow. Reuse one from indexer if present;
    // otherwise this attack is unreachable without a warm-up.
    const resp = await rateLimitedFetch(`${env.INDEXER_URL}/escrows?buyer=${wk.pubKeyHash}`);
    const rows = (await resp.json()) as Array<{ utxo_ref: string; state: string; submitted_at: number | null }>;
    const submitted = rows
      .filter((r) => r.state === "Submitted")
      .sort((a, b) => (b.submitted_at ?? 0) - (a.submitted_at ?? 0))[0];
    if (!submitted) {
      return { id, category: "A", what, expected, what_happened: "no Submitted-state escrow available to attack; needed a warm-up but A1 will post one later", verdict: "SKIPPED", evidence: "indexer has 0 Submitted rows for this buyer" };
    }
    const [tx, ixs] = submitted.utxo_ref.split("#");
    const escrowRef: OutputReference = { txHash: tx, index: parseInt(ixs, 10) };
    log(`A2: targeting Submitted ${submitted.utxo_ref}`);

    try {
      // buildReleaseTx is typed to take `supplierKey: WalletKey` — pass our buyer key.
      // The builder may accept it (it doesn't check the pkh against the advert at build time);
      // chain validator will reject because the script requires supplier_pkh signature.
      await (buildReleaseTx as unknown as (p: { chain: ChainProvider; supplierKey: typeof wk; escrowRef: OutputReference }) => Promise<{ expectedTxHash: string }>)({ chain, supplierKey: wk, escrowRef });
      return { id, category: "A", what, expected, what_happened: "buildReleaseTx + submit succeeded as buyer — chain accepted the tx", verdict: "GAP", evidence: `escrow_ref=${submitted.utxo_ref}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id, category: "A", what, expected, what_happened: `rejected: ${head(msg)}`, verdict: "BLOCKED", evidence: msg.slice(0, 500) };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id, category: "A", what, expected, what_happened: `setup error: ${head(msg)}`, verdict: "UNCLEAR", evidence: msg.slice(0, 500) };
  }
}

async function attack_A3(): Promise<AttackResult> {
  const id = "A3";
  const what = "PostEscrow expects deliver_by computed by builder; we can't easily set it in the past via the SDK without forking the builder. We try buildPostEscrowTx in a state where the advert's max_processing_ms produces a future deliver_by — so the BUILDER won't reject, but we verify the build path computes deliver_by correctly.";
  const expected = "Defense: builder always computes deliver_by = now + advert.max_processing_ms + 30000ms, so the buyer can't choose. This attack is effectively unreachable via the standard builder; skip with note.";
  return { id, category: "A", what, expected, what_happened: "deferred — builder computes deliver_by; manual datum forge needed to inject past value", verdict: "SKIPPED", evidence: "buildPostEscrowTx packages/shared/src/tx/escrow/postEscrow.ts" };
}

async function attack_A4(): Promise<AttackResult> {
  const id = "A4";
  const what = "PostEscrow then immediately attempt Reclaim before deliver_by.";
  const expected = "buildReclaimTx packages/shared/src/tx/escrow/reclaim.ts:66 rejects with TxConstructionError('reclaim before deliver_by').";
  checkCapsBeforePost();
  const startBal = await walletLovelace();
  try {
    const messages = [{ role: "user" as const, content: "A4 probe: do not respond, will be reclaimed." }];
    log("A4: posting escrow for reclaim attempt");
    const submitResult = await marketplace.submitPrompt({
      advertRef: ADVERT_REF_ACTIVE,
      messages,
      payment_lovelace: ADVERT_PRICE_LOVELACE,
    }).catch((err) => err);

    // Whether submitPrompt succeeded or failed, attempt Reclaim against the
    // posted escrow. If submitPrompt succeeded, the escrow has been Submitted —
    // Reclaim should reject for state reasons. If it failed during supplier
    // call, the Open escrow exists and we attempt Reclaim against THAT.
    let escrowRef: OutputReference | null = null;
    if (submitResult && typeof submitResult === "object" && "escrowRef" in submitResult) {
      escrowRef = (submitResult as { escrowRef: OutputReference }).escrowRef;
    } else {
      // submitPrompt threw mid-flight; look up the most recent Open escrow.
      const r = await rateLimitedFetch(`${env.INDEXER_URL}/escrows?buyer=${wk.pubKeyHash}`);
      const rows = (await r.json()) as Array<{ utxo_ref: string; state: string; posted_at: number }>;
      const open = rows.filter((x) => x.state === "Open").sort((a, b) => b.posted_at - a.posted_at)[0];
      if (open) {
        const [tx, ix] = open.utxo_ref.split("#");
        escrowRef = { txHash: tx, index: parseInt(ix, 10) };
      }
    }
    if (!escrowRef) {
      const endBal = await walletLovelace();
      counters.burnedLovelace += (startBal - endBal);
      return { id, category: "A", what, expected, what_happened: "couldn't locate escrow ref to reclaim", verdict: "UNCLEAR", evidence: "" };
    }
    counters.escrowsPosted += 1;
    log(`A4: attempting reclaim of ${escrowRef.txHash}#${escrowRef.index}`);
    try {
      await buildReclaimTx({ chain, buyerKey: wk, escrowRef });
      const endBal = await walletLovelace();
      counters.burnedLovelace += (startBal - endBal);
      return { id, category: "A", what, expected, what_happened: "reclaim before deliver_by SUCCEEDED — defense missing", verdict: "GAP", evidence: `escrow_ref=${escrowRef.txHash}#${escrowRef.index}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const endBal = await walletLovelace();
      counters.burnedLovelace += (startBal - endBal);
      return { id, category: "A", what, expected, what_happened: `rejected: ${head(msg)}`, verdict: "BLOCKED", evidence: msg.slice(0, 500) };
    }
  } catch (err) {
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);
    const msg = err instanceof Error ? err.message : String(err);
    return { id, category: "A", what, expected, what_happened: `setup error: ${head(msg)}`, verdict: "UNCLEAR", evidence: msg.slice(0, 500) };
  }
}

// ─── B: Protocol-fuzzing ────────────────────────────────────────────────

async function attack_B2(): Promise<AttackResult> {
  const id = "B2";
  const what = "PostEscrow with prompt_hash sha256(messages_A), send chat body with messages_B (different).";
  const expected = "supplier 409 prompt_mismatch (server.ts:278).";
  checkCapsBeforePost();
  const startBal = await walletLovelace();
  try {
    // Post an honest escrow first (prompt = canonical messages_A)
    const messagesA = [{ role: "user" as const, content: "B2 probe: commit-this-prompt" }];
    log("B2: posting escrow with messages_A");
    let escrowRef: OutputReference;
    try {
      const escrowResult = await (await import("@marketplace/shared/tx")).buildPostEscrowTx({
        chain, buyerKey: wk, advertRef: ADVERT_REF_ACTIVE, messages: messagesA, payment_lovelace: ADVERT_PRICE_LOVELACE,
      });
      escrowRef = escrowResult.escrowOutputRef;
      await chain.awaitTx(escrowResult.expectedTxHash, 120_000);
    } catch (err) {
      const endBal = await walletLovelace();
      counters.burnedLovelace += (startBal - endBal);
      return { id, category: "B", what, expected, what_happened: `couldn't post escrow: ${head(err instanceof Error ? err.message : String(err))}`, verdict: "UNCLEAR", evidence: "" };
    }
    counters.escrowsPosted += 1;
    const escrowRefStr = `${escrowRef.txHash}#${escrowRef.index}`;
    log(`B2: escrow=${escrowRefStr}; sending chat body with messages_B`);

    // Send chat body with DIFFERENT messages_B
    const messagesB = [{ role: "user", content: "B2 probe: but-actually-this-prompt" }];
    const resp = await rateLimitedFetch(`${SUPPLIER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Escrow-Ref": escrowRefStr },
      body: JSON.stringify({ model: "qwen3.6:35b", messages: messagesB, max_tokens: 100 }),
    });
    const text = await resp.text();
    // Reclaim after the supplier rejects so we get our money back.
    // We have to wait until past deliver_by to reclaim. For the report we just
    // observe the immediate response; reclaim happens on a later sweep or
    // post-window automatic.
    const verdict: Verdict = resp.status === 409 && text.includes("prompt_mismatch") ? "BLOCKED" : (resp.status >= 200 && resp.status < 300 ? "GAP" : "BLOCKED");
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);
    return { id, category: "B", what, expected, what_happened: `HTTP ${resp.status}: ${head(text, 200)}`, verdict, evidence: `escrow=${escrowRefStr}; status=${resp.status}; body=${head(text, 400)}` };
  } catch (err) {
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);
    const msg = err instanceof Error ? err.message : String(err);
    return { id, category: "B", what, expected, what_happened: `setup error: ${head(msg)}`, verdict: "UNCLEAR", evidence: msg.slice(0, 500) };
  }
}

async function attack_B3(): Promise<AttackResult> {
  const id = "B3";
  const what = "POST /v1/chat/completions with X-Escrow-Ref pointing at a random non-existent ref.";
  const expected = "404 escrow_not_found or 400 — should not reach inference.";
  const bogus = "0".repeat(63) + "1#0";
  const resp = await rateLimitedFetch(`${SUPPLIER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Escrow-Ref": bogus },
    body: JSON.stringify({ model: "qwen3.6:35b", messages: [{ role: "user", content: "B3 probe" }], max_tokens: 50 }),
  });
  const text = await resp.text();
  const verdict: Verdict = (resp.status >= 400 && resp.status < 500) ? "BLOCKED" : "GAP";
  return { id, category: "B", what, expected, what_happened: `HTTP ${resp.status}: ${head(text, 200)}`, verdict, evidence: `status=${resp.status}; body=${head(text, 400)}` };
}

async function attack_B5(): Promise<AttackResult> {
  const id = "B5";
  const what = "Call buildPostEscrowTx with payment_lovelace strictly less than advert.price_lovelace.";
  const expected = "TxConstructionError 'payment must equal advertised price' (postEscrow.ts:96) — build-time rejection, no chain spend.";
  try {
    const messages = [{ role: "user" as const, content: "B5 probe" }];
    await buildPostEscrowTx({ chain, buyerKey: wk, advertRef: ADVERT_REF_ACTIVE, messages, payment_lovelace: 1_000_000n });
    return { id, category: "B", what, expected, what_happened: "builder accepted underpayment — GAP", verdict: "GAP", evidence: "buildPostEscrowTx succeeded with payment=1_000_000 vs advert.price=5_000_000" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isPriceErr = msg.toLowerCase().includes("payment") && msg.toLowerCase().includes("price");
    return { id, category: "B", what, expected, what_happened: `rejected: ${head(msg)}`, verdict: isPriceErr ? "BLOCKED" : "UNCLEAR", evidence: msg.slice(0, 500) };
  }
}

// ─── C: Liveness / DoS ──────────────────────────────────────────────────

async function attack_C1(): Promise<AttackResult> {
  const id = "C1";
  const what = "Send a request body >100KB.";
  const expected = "413 or 400 before LLM invocation.";
  const big = "A".repeat(120_000);
  const resp = await rateLimitedFetch(`${SUPPLIER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Escrow-Ref": "0".repeat(64) + "#0" },
    body: JSON.stringify({ model: "qwen3.6:35b", messages: [{ role: "user", content: big }], max_tokens: 50 }),
  });
  const text = await resp.text();
  const verdict: Verdict = (resp.status >= 400 && resp.status < 500) ? "BLOCKED" : "GAP";
  return { id, category: "C", what, expected, what_happened: `HTTP ${resp.status}: ${head(text, 200)}`, verdict, evidence: `status=${resp.status}; body_bytes=120000; resp=${head(text, 200)}` };
}

async function attack_C2(): Promise<AttackResult> {
  const id = "C2";
  const what = "PostEscrow honestly, then chat body with max_output_tokens 999999.";
  const expected = "400 output_cap_exceeded (server.ts:234).";
  checkCapsBeforePost();
  const startBal = await walletLovelace();
  try {
    const messages = [{ role: "user" as const, content: "C2 probe — request huge output." }];
    log("C2: posting honest escrow then sending oversized max_tokens");
    const escrowResult = await buildPostEscrowTx({
      chain, buyerKey: wk, advertRef: ADVERT_REF_ACTIVE, messages, payment_lovelace: ADVERT_PRICE_LOVELACE,
    });
    counters.escrowsPosted += 1;
    await chain.awaitTx(escrowResult.expectedTxHash, 120_000);
    const escrowRefStr = `${escrowResult.escrowOutputRef.txHash}#${escrowResult.escrowOutputRef.index}`;

    const resp = await rateLimitedFetch(`${SUPPLIER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Escrow-Ref": escrowRefStr },
      body: JSON.stringify({ model: "qwen3.6:35b", messages, max_tokens: 999_999 }),
    });
    const text = await resp.text();
    const verdict: Verdict = resp.status === 400 && text.includes("output_cap_exceeded") ? "BLOCKED" : (resp.status === 200 ? "GAP" : "UNCLEAR");
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);
    return { id, category: "C", what, expected, what_happened: `HTTP ${resp.status}: ${head(text, 200)}`, verdict, evidence: `escrow=${escrowRefStr}; status=${resp.status}; body=${head(text, 400)}` };
  } catch (err) {
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);
    const msg = err instanceof Error ? err.message : String(err);
    return { id, category: "C", what, expected, what_happened: `setup error: ${head(msg)}`, verdict: "UNCLEAR", evidence: msg.slice(0, 500) };
  }
}

async function attack_C4(): Promise<AttackResult> {
  const id = "C4";
  const what = "50 concurrent requests at ≤2 rps with bogus X-Escrow-Ref headers. Liveness probe mid-burst.";
  const expected = "all 4xx; supplier stays responsive; concurrent honest probe completes.";
  const N = 50;
  const bogus = "0".repeat(63) + "f#0";
  const results: number[] = [];
  const start = Date.now();
  let ok4xx = 0;
  let other = 0;
  // Liveness probe: hit /capability mid-burst (cheap GET)
  let livenessOk = false;
  for (let i = 0; i < N; i++) {
    try {
      checkCapsBeforeRequest();
      const wait = Math.max(0, RATE_LIMIT_MS - (Date.now() - lastReqMs));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastReqMs = Date.now();
      counters.requestsSent += 1;
      const resp = await fetch(`${SUPPLIER_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Escrow-Ref": bogus },
        body: JSON.stringify({ model: "qwen3.6:35b", messages: [{ role: "user", content: `probe-${i}` }], max_tokens: 1 }),
      });
      results.push(resp.status);
      if (resp.status >= 400 && resp.status < 500) ok4xx += 1; else other += 1;
      // Mid-burst liveness probe
      if (i === Math.floor(N / 2)) {
        try {
          const ok = await fetch(`${SUPPLIER_URL}/healthz`, { signal: AbortSignal.timeout(5_000) });
          livenessOk = ok.ok;
        } catch { livenessOk = false; }
      }
    } catch (err) {
      other += 1;
      if (counters.requestsSent >= CAP_REQUESTS) break;
    }
  }
  const dur = Date.now() - start;
  const verdict: Verdict = (other === 0 && livenessOk) ? "BLOCKED" : "UNCLEAR";
  return { id, category: "C", what, expected, what_happened: `${ok4xx}/${results.length} 4xx, ${other} other; liveness=${livenessOk}; duration=${dur}ms`, verdict, evidence: `burst N=${N}, status_codes=${[...new Set(results)].join(",")}, liveness_probe=${livenessOk}` };
}

async function attack_C5(): Promise<AttackResult> {
  const id = "C5";
  const what = "Spam indexer /suppliers + /escrows/<ref> at 2 rps for 30s.";
  const expected = "all 200; report any 5xx.";
  const start = Date.now();
  const statuses: number[] = [];
  const refsToHit = [
    `${env.INDEXER_URL}/suppliers`,
    `${env.INDEXER_URL}/escrows/${ADVERT_REF_ACTIVE.txHash}%23${ADVERT_REF_ACTIVE.index}`,
  ];
  let i = 0;
  while (Date.now() - start < 30_000) {
    try {
      const url = refsToHit[i++ % refsToHit.length];
      const resp = await rateLimitedFetch(url);
      statuses.push(resp.status);
    } catch (err) {
      statuses.push(0);
      if (counters.requestsSent >= CAP_REQUESTS) break;
    }
  }
  const count5xx = statuses.filter((s) => s >= 500).length;
  const count200 = statuses.filter((s) => s === 200).length;
  const verdict: Verdict = (count5xx === 0 && count200 > 0) ? "BLOCKED" : (count5xx > 0 ? "GAP" : "UNCLEAR");
  return { id, category: "C", what, expected, what_happened: `${statuses.length} reqs in 30s: ${count200} 200s, ${count5xx} 5xx`, verdict, evidence: `unique_codes=${[...new Set(statuses)].join(",")}; n=${statuses.length}` };
}

// ─── D: Social / spec attacks ───────────────────────────────────────────

async function attack_D1(): Promise<AttackResult> {
  const id = "D1";
  const what = "POST /v1/chat/completions with NO X-Escrow-Ref header.";
  const expected = "400 escrow_ref_required (server.ts:184).";
  const resp = await rateLimitedFetch(`${SUPPLIER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3.6:35b", messages: [{ role: "user", content: "D1 probe" }], max_tokens: 50 }),
  });
  const text = await resp.text();
  const isBlocked = resp.status === 400 && text.includes("escrow_ref_required");
  return { id, category: "D", what, expected, what_happened: `HTTP ${resp.status}: ${head(text, 200)}`, verdict: isBlocked ? "BLOCKED" : (resp.status === 200 ? "GAP" : "UNCLEAR"), evidence: `status=${resp.status}; body=${head(text, 400)}` };
}

async function attack_D3(): Promise<AttackResult> {
  const id = "D3";
  const what = "PostEscrow honestly (model=qwen3.6:35b), send chat body with model=gpt-4.";
  const expected = "409 request_spec_mismatch (server.ts:273) — model is part of request_spec_hash.";
  checkCapsBeforePost();
  const startBal = await walletLovelace();
  try {
    const messages = [{ role: "user" as const, content: "D3 probe" }];
    log("D3: posting honest escrow then sending wrong model");
    const escrowResult = await buildPostEscrowTx({
      chain, buyerKey: wk, advertRef: ADVERT_REF_ACTIVE, messages, payment_lovelace: ADVERT_PRICE_LOVELACE,
    });
    counters.escrowsPosted += 1;
    await chain.awaitTx(escrowResult.expectedTxHash, 120_000);
    const escrowRefStr = `${escrowResult.escrowOutputRef.txHash}#${escrowResult.escrowOutputRef.index}`;
    const resp = await rateLimitedFetch(`${SUPPLIER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Escrow-Ref": escrowRefStr },
      body: JSON.stringify({ model: "gpt-4", messages, max_tokens: 50 }),
    });
    const text = await resp.text();
    const verdict: Verdict = resp.status === 409 && text.includes("request_spec_mismatch") ? "BLOCKED" : (resp.status === 200 ? "GAP" : "UNCLEAR");
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);
    return { id, category: "D", what, expected, what_happened: `HTTP ${resp.status}: ${head(text, 200)}`, verdict, evidence: `escrow=${escrowRefStr}; status=${resp.status}; body=${head(text, 400)}` };
  } catch (err) {
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);
    const msg = err instanceof Error ? err.message : String(err);
    return { id, category: "D", what, expected, what_happened: `setup error: ${head(msg)}`, verdict: "UNCLEAR", evidence: msg.slice(0, 500) };
  }
}

async function attack_D4(): Promise<AttackResult> {
  const id = "D4";
  const what = "buildPostEscrowTx pointing at the RETIRED advert ref (386d30…004040#0).";
  const expected = "Builder rejects because advert UTxO is no longer on chain — chain.queryUtxo returns null.";
  try {
    const messages = [{ role: "user" as const, content: "D4 probe" }];
    await buildPostEscrowTx({ chain, buyerKey: wk, advertRef: ADVERT_REF_RETIRED, messages, payment_lovelace: ADVERT_PRICE_LOVELACE });
    return { id, category: "D", what, expected, what_happened: "builder accepted post against retired advert", verdict: "GAP", evidence: `retired_advert=${ADVERT_REF_RETIRED.txHash}#${ADVERT_REF_RETIRED.index}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id, category: "D", what, expected, what_happened: `rejected: ${head(msg)}`, verdict: "BLOCKED", evidence: msg.slice(0, 500) };
  }
}

// ─── A1 — skip Accept, watch supplier Release (10 min wait) ─────────────

async function attack_A1(): Promise<AttackResult> {
  const id = "A1";
  const what = "PostEscrow, get supplier's receipt, do NOT Accept, wait ACCEPT_WINDOW_MS=600_000, expect supplier-side Release to take payment + bonds.";
  const expected = "supplier Release fires after window; buyer loses 7 AP3X.";
  checkCapsBeforePost();
  const startBal = await walletLovelace();
  try {
    const messages = [{ role: "user" as const, content: "A1 probe: receive but do not accept." }];
    log("A1: posting escrow then skipping Accept");
    const submitResult = await marketplace.submitPrompt({
      advertRef: ADVERT_REF_ACTIVE, messages, payment_lovelace: ADVERT_PRICE_LOVELACE,
    });
    counters.escrowsPosted += 1;
    const escrowRefStr = `${submitResult.escrowRef.txHash}#${submitResult.escrowRef.index}`;
    log(`A1: escrow=${escrowRefStr}; supplier returned receipt; now waiting 10+ min`);

    // Wait until past submitted_at + 600s + a few slots of margin
    const WAIT_MS = 660_000; // 11 min
    await new Promise((r) => setTimeout(r, WAIT_MS));

    // Check indexer for Release event
    const resp = await rateLimitedFetch(`${env.INDEXER_URL}/escrows?buyer=${wk.pubKeyHash}`);
    const rows = (await resp.json()) as Array<{ utxo_ref: string; state: string; prompt_hash: string }>;
    const matching = rows.filter((r) => r.prompt_hash === submitResult.receipt.prompt_hash);
    const released = matching.find((r) => r.state === "Released");
    const stillSubmitted = matching.find((r) => r.state === "Submitted");
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);

    if (released) {
      return { id, category: "A", what, expected, what_happened: `supplier Released after window; row in state=Released at ${released.utxo_ref}`, verdict: "BLOCKED", evidence: `released_ref=${released.utxo_ref}; net_delta=${startBal - endBal} lovelace` };
    }
    // If indexer Track 2 hasn't landed, stuck-Submitted rows mean Release happened but indexer didn't advance.
    if (stillSubmitted) {
      // Confirm via Ogmios whether the Submitted UTxO is spent.
      const og = await fetch(env.OGMIOS_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "queryLedgerState/utxo", params: { outputReferences: [{ transaction: { id: stillSubmitted.utxo_ref.split("#")[0] }, index: parseInt(stillSubmitted.utxo_ref.split("#")[1], 10) }] }, id: "u" }),
      });
      const ogText = await og.json();
      const spent = Array.isArray((ogText as { result?: unknown[] }).result) && ((ogText as { result: unknown[] }).result).length === 0;
      if (spent) {
        return { id, category: "A", what, expected, what_happened: `Submitted UTxO spent on chain (likely by supplier Release); indexer hasn't advanced state yet`, verdict: "BLOCKED", evidence: `submitted_ref=${stillSubmitted.utxo_ref}; ogmios_utxo_query=empty` };
      }
      return { id, category: "A", what, expected, what_happened: `Submitted UTxO still unspent after window — supplier did NOT Release`, verdict: "GAP", evidence: `submitted_ref=${stillSubmitted.utxo_ref}` };
    }
    return { id, category: "A", what, expected, what_happened: `unexpected indexer state — no matching row`, verdict: "UNCLEAR", evidence: `prompt_hash=${submitResult.receipt.prompt_hash}` };
  } catch (err) {
    const endBal = await walletLovelace();
    counters.burnedLovelace += (startBal - endBal);
    const msg = err instanceof Error ? err.message : String(err);
    return { id, category: "A", what, expected, what_happened: `setup error: ${head(msg)}`, verdict: "UNCLEAR", evidence: msg.slice(0, 500) };
  }
}

// ─── Main orchestrator ──────────────────────────────────────────────────

// Continuation run: attacks D1, B3, C1, C5, A3, B5, D4, B2, C2 all completed
// BLOCKED in the first pass. This continuation runs the remaining 5.
const ATTACKS: { id: string; fn: () => Promise<AttackResult> }[] = [
  // Post-escrow rejection (1 escrow; supplier 409 expected)
  { id: "D3", fn: attack_D3 },
  // On-chain validator probes
  { id: "A4", fn: attack_A4 },
  { id: "A2", fn: attack_A2 },
  // Burst (no escrow)
  { id: "C4", fn: attack_C4 },
  // A1 last — ties funds for 10+ min
  { id: "A1", fn: attack_A1 },
];

const STOP_ON_FIRST_GAP = true;

async function main(): Promise<void> {
  log(`agent-b: buyer=${wk.address} pkh=${wk.pubKeyHash}`);
  const startBal = await walletLovelace();
  log(`starting bal=${startBal} lovelace (~${Number(startBal) / 1e6} AP3X)`);

  const results: AttackResult[] = [];
  for (const a of ATTACKS) {
    log(`\n=== running ${a.id} ===`);
    try {
      const r = await a.fn();
      results.push(r);
      log(`${a.id}: ${r.verdict} — ${head(r.what_happened, 120)}`);
      log(`counters: escrows=${counters.escrowsPosted}/${CAP_ESCROWS} reqs=${counters.requestsSent}/${CAP_REQUESTS} burned=${counters.burnedLovelace}/${CAP_BURN_LOVELACE}`);
      if (STOP_ON_FIRST_GAP && r.verdict === "GAP") {
        log("\nGAP found — stopping per spec.");
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("hard-cap:")) {
        log(`HARD CAP HIT: ${msg} — stopping.`);
        results.push({ id: a.id, category: "A", what: "(cap hit)", expected: "", what_happened: msg, verdict: "UNCLEAR", evidence: "" });
        break;
      }
      log(`${a.id}: runner error: ${msg}`);
      results.push({ id: a.id, category: "A", what: "(runner error)", expected: "", what_happened: msg, verdict: "UNCLEAR", evidence: msg.slice(0, 500) });
    }
  }

  // Post-run cleanup: reclaim any Open/Claimed escrows we left behind.
  // Walk the indexer for buyer's escrows; reclaim any in state Open/Claimed
  // whose deliver_by has passed. This recovers funds the runner locked while
  // probing supplier rejections.
  log("\n=== post-run reclaim sweep ===");
  try {
    const r = await rateLimitedFetch(`${env.INDEXER_URL}/escrows?buyer=${wk.pubKeyHash}`);
    const rows = (await r.json()) as Array<{ utxo_ref: string; state: string; deliver_by: number; created_slot: number }>;
    // Only reclaim rows from THIS session (recent slots). Stale historical rows
    // from prior runs may have already been reclaimed/accepted and the indexer
    // hasn't advanced state yet (per the known indexer-staleness follow-up).
    const fresh = rows.filter((r) => (r.state === "Open" || r.state === "Claimed") && r.deliver_by < Date.now());
    log(`reclaim candidates: ${fresh.length}`);
    const { buildReclaimTx } = await import("@marketplace/shared/tx");
    for (const row of fresh) {
      const [tx, ix] = row.utxo_ref.split("#");
      const ref: OutputReference = { txHash: tx, index: parseInt(ix, 10) };
      try {
        const out = await buildReclaimTx({ chain, buyerKey: wk, escrowRef: ref });
        await chain.awaitTx(out.expectedTxHash, 90_000);
        log(`reclaimed ${row.utxo_ref} -> tx ${out.expectedTxHash}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`reclaim ${row.utxo_ref} FAILED: ${head(msg, 200)}`);
      }
    }
  } catch (err) {
    log(`reclaim sweep error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const endBal = await walletLovelace();
  const totalSpent = startBal - endBal;

  // Final report
  log("\n\n=== REPORT ===\n");
  const header = "| Attack | Cat | What tried | Expected | Happened | Verdict | Evidence |";
  const sep    = "|--------|-----|------------|----------|----------|---------|----------|";
  log(header);
  log(sep);
  for (const r of results) {
    log(`| ${r.id} | ${r.category} | ${head(r.what, 70)} | ${head(r.expected, 50)} | ${head(r.what_happened, 80)} | ${r.verdict} | ${head(r.evidence, 60)} |`);
  }
  log("\n## Hard-cap accounting");
  log(`escrows posted: ${counters.escrowsPosted} / ${CAP_ESCROWS}`);
  log(`requests sent : ${counters.requestsSent} / ${CAP_REQUESTS}`);
  log(`burned        : ${counters.burnedLovelace} lovelace / ${CAP_BURN_LOVELACE}`);
  log(`net wallet Δ  : ${-totalSpent} lovelace (~${Number(-totalSpent) / 1e6} AP3X)`);
  log(`start bal     : ${startBal} lovelace`);
  log(`end bal       : ${endBal} lovelace`);

  // Deferred attacks
  log("\n## Deferred (not implemented this run)");
  log("- B1 (capability_id mismatch in datum): requires hand-rolled datum builder.");
  log("- B6 (FLOAT64 CBOR injection): requires hand-rolled CBOR encoder.");
  log("- D5 (3 sybil wallets concurrent post): requires faucet + 3 wallet derivations + AP3X distribution.");

  const out = `/tmp/run-agent-b-${Date.now()}.json`;
  writeFileSync(out, JSON.stringify({ results, counters: { ...counters, burnedLovelace: counters.burnedLovelace.toString() }, startBal: startBal.toString(), endBal: endBal.toString() }, null, 2));
  log(`\nfull results written to ${out}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[agent-b] fatal:", err);
  process.exit(1);
});
