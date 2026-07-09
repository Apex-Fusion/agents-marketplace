/**
 * gateway/src/sweeper.ts — state-aware custody safety net.
 *
 * Per key, classifies on-chain escrows and recovers stranded funds:
 *   Open|Claimed past the deliver_by deadline → Reclaim (returns funds + bond).
 *   Submitted (verified, in accept-window)    → retry Accept (settle + refund).
 *   Submitted past the accept-window          → leave for supplier Release (log).
 *
 * reclaim only works on Open/Claimed; Accept only on Submitted — so we branch by
 * state and never blind-reclaim a Submitted escrow. The on-chain validator is
 * the source of truth for deadlines, so premature/late attempts simply fail and
 * are caught here; the age thresholds just avoid racing in-flight requests.
 *
 * Chat sessions get special handling:
 *   - Their deliver_by is ~30 min (vs ~10 min one-shot), so rows belonging to
 *     an OPEN session use CHAT_RECLAIM_AFTER_MS — otherwise every open session
 *     older than 11 min would trigger a doomed Reclaim attempt per sweep while
 *     holding the key's mutex.
 *   - When a session's escrow reaches a terminal state (Accepted here, spent
 *     elsewhere, or Reclaimed), the session row is closed, its in-memory state
 *     dropped, and a usage row recorded — abandoned demo sessions (nobody calls
 *     /close) settle and get billed through this path.
 *
 * Escrow↔session lineage: the indexer keeps one row per utxo_ref per state
 * (terminal spends update nothing), and the validator preserves posted_at
 * across states — so a session's lineage is "rows sharing the posted_at of the
 * session's original Open ref row".
 */

import { randomUUID } from "crypto";
import type { GatewayDeps } from "./deps.js";
import type { SessionRow } from "./db/store.js";
import { fetchEscrows, acceptAndConfirm, reclaimAndConfirm, type EscrowRow } from "./onchain/settle.js";
import { parseRef } from "./routing/selectSupplier.js";
import { dropSessionState } from "./openai/transcripts.js";
import { dropDemoSession, sweepIdleDemoSessions } from "./openai/demoChat.js";
import { CAPABILITY as CHAT_CAPABILITY } from "./openai/sessions.js";

// Don't touch escrows newer than this — an in-flight request is settling them.
const MIN_AGE_MS = 90_000;
// Reclaim Open/Claimed escrows older than this (past deliver_by ~10m + buffer).
const RECLAIM_AFTER_MS = 11 * 60 * 1000;
// Chat-session escrows: deliver_by ≈ posted_at + 30 min, so wait longer.
const CHAT_RECLAIM_AFTER_MS = 35 * 60 * 1000;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[gateway:sweeper] ${msg}`);
}

function closeSessionRow(
  deps: GatewayDeps,
  session: SessionRow,
  outcome: { status: "completed" | "reclaimed"; costLovelace: string | null },
): void {
  // Re-read: an in-flight close (route handler or demo executor) may have won.
  const current = deps.store.getSession(session.id);
  if (!current || current.state !== "open") return;
  deps.store.setSessionState(session.id, "closed", Date.now());
  dropSessionState(session.id);
  dropDemoSession(session.id);
  deps.store.insertUsage({
    id: randomUUID(),
    key_id: session.key_id,
    created_at: Date.now(),
    kind: "chat_session",
    model: session.model,
    capability_id: CHAT_CAPABILITY,
    supplier_pkh: session.supplier_pkh,
    escrow_ref: session.escrow_ref,
    cost_lovelace: outcome.costLovelace,
    prompt_tokens: 0,
    completion_tokens: 0,
    status: outcome.status,
    failure_reason: null,
  });
  log(`closed abandoned session ${session.id} (${outcome.status})`);
}

export async function runSweepOnce(deps: GatewayDeps): Promise<void> {
  // Idle demo sessions first: closing them makes the supplier Submit, so this
  // sweep (or the next) can Accept the escrow right after.
  await sweepIdleDemoSessions(deps).catch((err) =>
    log(`demo idle janitor: ${err instanceof Error ? err.message : String(err)}`),
  );

  const now = Date.now();
  for (const keyRow of deps.store.listKeys()) {
    let rows: EscrowRow[];
    try {
      rows = await fetchEscrows(deps.config.indexerUrl, keyRow.wallet_pkh, deps.fetchFn);
    } catch (err) {
      log(`indexer error for ${keyRow.key_prefix}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Lineage-match open sessions: the session stores its ORIGINAL Open ref;
    // rows sharing that row's posted_at are the same escrow in later states.
    const sessionByPostedAt = new Map<number, SessionRow>();
    for (const session of deps.store.listOpenSessionsByKey(keyRow.id)) {
      const origin = rows.find((r) => r.utxo_ref === session.escrow_ref);
      if (origin) sessionByPostedAt.set(origin.posted_at, session);
    }

    const ctx = deps.registry.getContext(keyRow);
    for (const row of rows) {
      const ref = parseRef(row.utxo_ref);
      if (!ref) continue;
      const ageMs = now - (row.posted_at ?? 0);
      if (ageMs < MIN_AGE_MS) continue;
      const chatSession = sessionByPostedAt.get(row.posted_at);

      try {
        if (row.state === "Submitted") {
          try {
            await ctx.mutex.run(() => acceptAndConfirm(deps.chain, ctx.walletKey, ref));
            log(`accepted stranded Submitted escrow ${row.utxo_ref}`);
            if (chatSession) {
              closeSessionRow(deps, chatSession, { status: "completed", costLovelace: chatSession.price_lovelace });
            }
          } catch (err) {
            // Accept fails routinely when the UTxO is already spent (settled
            // by an in-flight request, an earlier sweep, or supplier Release).
            // For session lineages, confirm the spend on-chain before closing
            // the row — an Accept that failed for another reason (timeout)
            // must leave the session open for the next sweep.
            if (chatSession && (await deps.chain.queryUtxo(ref)) === null) {
              closeSessionRow(deps, chatSession, { status: "completed", costLovelace: chatSession.price_lovelace });
            } else if (!chatSession) {
              // Preserve the historical quiet-skip for one-shot escrows.
              void err;
            }
          }
        } else if (row.state === "Open" || row.state === "Claimed") {
          const reclaimAfterMs = chatSession ? CHAT_RECLAIM_AFTER_MS : RECLAIM_AFTER_MS;
          if (ageMs > reclaimAfterMs) {
            await ctx.mutex.run(() => reclaimAndConfirm(deps.chain, ctx.walletKey, ref));
            log(`reclaimed stranded ${row.state} escrow ${row.utxo_ref}`);
            if (chatSession) {
              // Funds returned — the session never settled; record no cost.
              closeSessionRow(deps, chatSession, { status: "reclaimed", costLovelace: null });
            }
          }
        }
      } catch {
        // Expected when the validator rejects (wrong window/state) or the UTxO
        // was already spent by an in-flight request; skip quietly.
      }
    }
  }
}

/** Start the periodic sweeper. Returns a stop() function. */
export function startSweeper(deps: GatewayDeps): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runSweepOnce(deps);
    } catch (err) {
      log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), deps.config.sweeperIntervalMs);
  return () => clearInterval(handle);
}
