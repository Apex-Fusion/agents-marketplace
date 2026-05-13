/**
 * run-agent-a.ts — Marketplace buyer happy-path runner (Agent A).
 *
 * Drives Marketplace.submitPrompt then runAccept for 3 cycles against the
 * live supplier on Vector L2 testnet. Logs every tx hash, HTTP code,
 * receipt verification step, and wallet delta. Throwaway script — not
 * committed.
 *
 * Usage:
 *   tsx buyer/scripts/run-agent-a.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { LiveOgmiosProvider, type ChainProvider, type OutputReference } from "@marketplace/shared/chain";
import { Marketplace, MemoryTaskHistoryStore } from "../src/sdk/index.js";
import { runAccept } from "../src/cli/acceptFlow.js";
import { deriveWalletKey } from "../src/index.js";

// Wire ed25519 sha512 hook (idempotent — matches buyer/src/index.ts).
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
const ADVERT_REF: OutputReference = {
  txHash: "9e9a86098c18cecf544d4c69e16ace850ab8c271a8bbea2facdaafc3be52701c",
  index: 0,
};
const PROMPTS = [
  "Summarize the Cardano EUTxO model in three concise bullets.",
  "Name three differences between Cardano and Ethereum smart contracts; one short bullet each.",
  "What is BLAKE2b used for in Cardano? Answer in two sentences.",
];
const FUND_REQUIRED_LOVELACE = 7_000_000n; // ≥ one cycle's working capital (5 + 1 + ~0.5 fee headroom)

const wk = deriveWalletKey(env.BUYER_PRIV_KEY_HEX, 1);
const chain: ChainProvider = new LiveOgmiosProvider({ ogmiosUrl: env.OGMIOS_URL });
const marketplace = new Marketplace({
  chain,
  indexerUrl: env.INDEXER_URL,
  walletKey: wk,
  networkParams: { networkId: 1 },
  historyStore: new MemoryTaskHistoryStore(),
});

marketplace.on("progress", (evt: unknown) => {
  // eslint-disable-next-line no-console
  console.log(`[progress] ${JSON.stringify(evt)}`);
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function walletLovelace(): Promise<bigint> {
  const utxos = await chain.queryUtxosByAddress(wk.address);
  return utxos.reduce((acc, u) => acc + BigInt(u.lovelace), 0n);
}

async function fetchTipSlot(): Promise<number> {
  return await chain.tip();
}

interface ChainEvent {
  type: string;
  ref: string;
  slot: number;
  txHash: string;
}

interface EscrowView {
  utxo_ref: string;
  buyer_pkh: string;
  prompt_hash: string;
  state: string;
  submitted_at: number | null;
  created_slot: number;
}

/**
 * Resolve the current Submitted-state escrow ref for our buyer given the
 * prompt_hash we committed. Polls the indexer until the row appears (the
 * supplier's Submit tx is already on chain by the time submitPrompt returns,
 * but the indexer needs a slot or two to roll forward).
 */
async function fetchBuyerEscrows(): Promise<EscrowView[]> {
  const resp = await fetch(`${env.INDEXER_URL}/escrows?buyer=${wk.pubKeyHash}`);
  if (!resp.ok) return [];
  return (await resp.json()) as EscrowView[];
}

/**
 * Resolve the current Submitted-state escrow ref for our buyer given the
 * prompt_hash we committed. Polls the indexer until the row appears (the
 * supplier's Submit tx is already on chain by the time submitPrompt returns,
 * but the indexer needs a slot or two to roll forward).
 */
async function findSubmittedEscrowRef(promptHash: string, postedAtMs: number, timeoutMs = 30_000): Promise<OutputReference> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await fetchBuyerEscrows();
    // The indexer returns separate rows for each state transition. Pick
    // state=Submitted, prompt_hash matches, and posted_at matches the new
    // cycle (so a stale already-accepted escrow with the same prompt_hash
    // doesn't shadow this run).
    const match = rows
      .filter((r) => r.prompt_hash === promptHash && r.state === "Submitted")
      .sort((a, b) => (b.submitted_at ?? 0) - (a.submitted_at ?? 0))[0];
    if (match) {
      const [tx, idxStr] = match.utxo_ref.split("#");
      return { txHash: tx, index: parseInt(idxStr, 10) };
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`indexer: no Submitted escrow with prompt_hash=${promptHash} within ${timeoutMs}ms`);
}

/**
 * Extract PostEscrow / Claim / Submit tx hashes for a specific prompt_hash
 * by looking at the indexer's per-state-row utxo_refs.
 */
function extractLifecycleTxs(rows: EscrowView[], promptHash: string): { post: string | null; claim: string | null; submit: string | null } {
  const out = { post: null as string | null, claim: null as string | null, submit: null as string | null };
  // The indexer stores one row per state transition keyed by utxo_ref.
  // For an in-flight escrow, all three rows share the same posted_at/prompt_hash.
  // Pick the rows that match our prompt_hash AND the most-recent posted_at
  // (in case we re-ran the same prompt earlier).
  const matching = rows.filter((r) => r.prompt_hash === promptHash);
  if (matching.length === 0) return out;
  // Sort by created_slot desc and take the freshest cluster.
  matching.sort((a, b) => b.created_slot - a.created_slot);
  const newestSlot = matching[0].created_slot;
  // Only keep rows within a small slot window of the newest (Submit slot).
  // Claim and PostEscrow are within a few slots of Submit.
  const recent = matching.filter((r) => newestSlot - r.created_slot < 500);
  for (const r of recent) {
    const [tx] = r.utxo_ref.split("#");
    if (r.state === "Submitted") out.submit = tx;
    else if (r.state === "Claimed") out.claim = tx;
    else if (r.state === "Open") out.post = tx;
  }
  return out;
}

/** Pull events since `sinceSlot - 1` and return as an array. */
async function fetchEvents(sinceSlot: number, limit = 200): Promise<ChainEvent[]> {
  const url = `${env.INDEXER_URL}/events?since_slot=${Math.max(0, sinceSlot - 1)}&limit=${limit}`;
  // The /events endpoint is SSE-only. Pull with manual abort after 2s.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2_500);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok || !resp.body) return [];
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const evts: ChainEvent[] = [];
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      // Process complete SSE messages (delimited by \n\n).
      while (true) {
        const i = buf.indexOf("\n\n");
        if (i === -1) break;
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = msg.split("\n");
        let type = "";
        let data = "";
        for (const ln of lines) {
          if (ln.startsWith("event:")) type = ln.slice(6).trim();
          else if (ln.startsWith("data:")) data = ln.slice(5).trim();
        }
        if (!type || type === "sync-progress" || !data) continue;
        try {
          const parsed = JSON.parse(data) as ChainEvent;
          evts.push(parsed);
        } catch {
          /* ignore */
        }
      }
    }
    return evts;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

interface CycleResult {
  cycle: number;
  promptSummary: string;
  postEscrowTx: string;
  escrowRef: string;
  claimTx: string | null;
  submitTx: string | null;
  acceptTx: string | null;
  wallclockMs: number | null;
  walltimeMs: number;
  netDeltaLovelace: string;
  status: "ok" | "failed";
  error?: string;
  response?: string;
}

async function runCycle(idx: number, prompt: string): Promise<CycleResult> {
  const result: CycleResult = {
    cycle: idx,
    promptSummary: prompt.slice(0, 70),
    postEscrowTx: "",
    escrowRef: "",
    claimTx: null,
    submitTx: null,
    acceptTx: null,
    wallclockMs: null,
    walltimeMs: 0,
    netDeltaLovelace: "0",
    status: "failed",
  };

  // eslint-disable-next-line no-console
  console.log(`\n=== CYCLE ${idx} ===`);
  // eslint-disable-next-line no-console
  console.log(`prompt: ${prompt}`);

  const balBefore = await walletLovelace();
  const slotBefore = await fetchTipSlot();
  const tStart = Date.now();
  // eslint-disable-next-line no-console
  console.log(`bal_before=${balBefore} lovelace (~${Number(balBefore) / 1e6} AP3X), slot=${slotBefore}`);

  try {
    const messages = [{ role: "user" as const, content: prompt }];
    const submitResult = await marketplace.submitPrompt({
      advertRef: ADVERT_REF,
      messages,
      payment_lovelace: 5_000_000n,
    });
    result.escrowRef = `${submitResult.escrowRef.txHash}#${submitResult.escrowRef.index}`;
    result.postEscrowTx = submitResult.escrowRef.txHash;
    result.wallclockMs = submitResult.receipt.wallclock_ms ?? null;
    result.response = submitResult.response;

    // eslint-disable-next-line no-console
    console.log(`escrow_ref=${result.escrowRef}`);
    // eslint-disable-next-line no-console
    console.log(`receipt: pkh=${submitResult.receipt.supplier_pkh.slice(0, 12)}.. prompt_hash=${submitResult.receipt.prompt_hash.slice(0, 12)}.. wallclock=${submitResult.receipt.wallclock_ms}ms`);
    // eslint-disable-next-line no-console
    console.log(`response (${submitResult.response.length} chars): ${submitResult.response.slice(0, 200)}${submitResult.response.length > 200 ? "..." : ""}`);

    // The escrowRef returned by submitPrompt is the ORIGINAL Open UTxO,
    // which has been spent by Claim then Submit. Look up the current
    // Submitted-state ref via the indexer, then accept that.
    const submittedRef = await findSubmittedEscrowRef(submitResult.receipt.prompt_hash, Date.now() - 120_000);
    // eslint-disable-next-line no-console
    console.log(`submitted_escrow_ref=${submittedRef.txHash}#${submittedRef.index}`);

    // Extract Claim / Submit tx hashes from indexer.
    const buyerRows = await fetchBuyerEscrows();
    const lifecycle = extractLifecycleTxs(buyerRows, submitResult.receipt.prompt_hash);
    result.postEscrowTx = lifecycle.post ?? result.postEscrowTx;
    result.claimTx = lifecycle.claim;
    result.submitTx = lifecycle.submit;

    const acceptResult = await runAccept({
      chain,
      walletKey: wk,
      escrowRef: submittedRef,
      log: (line) => {
        // eslint-disable-next-line no-console
        console.log(`[accept] ${line}`);
      },
    });
    result.acceptTx = acceptResult.txHash;
    // eslint-disable-next-line no-console
    console.log(`accept_tx=${acceptResult.txHash}`);

    // eslint-disable-next-line no-console
    console.log(`claim_tx=${result.claimTx} submit_tx=${result.submitTx}`);

    // Give indexer a moment to roll forward past Accept (best-effort log).
    await new Promise((r) => setTimeout(r, 4_000));

    const tEnd = Date.now();
    result.walltimeMs = tEnd - tStart;
    const balAfter = await walletLovelace();
    result.netDeltaLovelace = (balAfter - balBefore).toString();
    result.status = "ok";
    // eslint-disable-next-line no-console
    console.log(`bal_after=${balAfter} lovelace; net_delta=${result.netDeltaLovelace} lovelace (~${Number(balAfter - balBefore) / 1e6} AP3X); wall=${result.walltimeMs}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = msg;
    result.walltimeMs = Date.now() - tStart;
    // eslint-disable-next-line no-console
    console.error(`cycle ${idx} FAILED: ${msg}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
  }
  return result;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`buyer addr=${wk.address}`);
  // eslint-disable-next-line no-console
  console.log(`buyer pkh=${wk.pubKeyHash}`);
  const bal0 = await walletLovelace();
  // eslint-disable-next-line no-console
  console.log(`starting balance: ${bal0} lovelace (~${Number(bal0) / 1e6} AP3X)`);
  if (bal0 < FUND_REQUIRED_LOVELACE) {
    // eslint-disable-next-line no-console
    console.error(`INSUFFICIENT FUNDS — need ≥ ${FUND_REQUIRED_LOVELACE} lovelace`);
    process.exit(2);
  }

  const results: CycleResult[] = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    const r = await runCycle(i + 1, PROMPTS[i]);
    results.push(r);
    if (r.status !== "ok") {
      // eslint-disable-next-line no-console
      console.error(`Cycle ${i + 1} failed — stopping; will report what we have.`);
      break;
    }
  }

  // Print final markdown table.
  // eslint-disable-next-line no-console
  console.log("\n\n=== REPORT ===\n");
  const header = "| Cycle | Prompt | PostEscrow tx | Claim tx | Submit tx | Accept tx | Wall ms | Supplier wallclock_ms | Net Δ (lovelace) |";
  const sep =    "|-------|--------|---------------|----------|-----------|-----------|---------|------------------------|------------------|";
  // eslint-disable-next-line no-console
  console.log(header);
  // eslint-disable-next-line no-console
  console.log(sep);
  for (const r of results) {
    if (r.status === "ok") {
      // eslint-disable-next-line no-console
      console.log(`| ${r.cycle} | ${r.promptSummary.slice(0, 40)} | \`${r.postEscrowTx.slice(0, 12)}…\` | \`${(r.claimTx ?? "?").slice(0, 12)}…\` | \`${(r.submitTx ?? "?").slice(0, 12)}…\` | \`${(r.acceptTx ?? "?").slice(0, 12)}…\` | ${r.walltimeMs} | ${r.wallclockMs} | ${r.netDeltaLovelace} |`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`| ${r.cycle} | ${r.promptSummary.slice(0, 40)} | FAILED: ${r.error} | | | | ${r.walltimeMs} | | |`);
    }
  }

  // Dump full JSON for the operator log.
  const out = `/tmp/run-agent-a-${Date.now()}.json`;
  writeFileSync(out, JSON.stringify(results, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nfull results written to ${out}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[runner] fatal:", err);
  process.exit(1);
});
