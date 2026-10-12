import type { Database } from "better-sqlite3";

export interface Paper2AgentApprovalRow {
  key_id: string;
  manifest_hash: string;
  supplier_pkh: string;
  max_price_lovelace: string;
  max_total_spend_lovelace: string;
  max_calls: number;
  calls: number;
  spent_lovelace: string;
  reserved_lovelace: string;
  revoked: number;
}

export interface Paper2AgentCallRow {
  job_id: string;
  key_id: string;
  manifest_hash: string;
  reserved_lovelace: string;
  prepared_json: string | null;
  original_datum_hex: string | null;
  /** Confirmed PostedPaper2Agent snapshot (bigints as decimal strings), saved before supplier admission. */
  posted_json: string | null;
  result_json: string | null;
  result_status: "pending" | "verified" | "failed";
  financial_status: "reserved" | "funded" | "pending" | "accepted" | "reclaimed" | "unknown" | "unfunded";
  actual_cost_lovelace: string | null;
  locked_lovelace: string | null;
  error: string | null;
  accounted: number;
}

export interface Paper2AgentTransactionRow {
  job_id: string;
  phase: "post" | "accept" | "reclaim";
  tx_hash: string;
  tx_cbor: string;
  fee_lovelace: string;
  wallet_debit_lovelace: string;
  collateral_lovelace: string;
  supplier_payout_lovelace: string;
  facts_json: string;
  confirmed: number;
}

/** Separate tables add safely to existing databases without rewriting the old journal. */
export class Paper2AgentStore {
  constructor(private readonly db: Database) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS paper2agent_approvals (
          key_id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, supplier_pkh TEXT NOT NULL,
          max_price_lovelace TEXT NOT NULL, max_total_spend_lovelace TEXT NOT NULL,
          max_calls INTEGER NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
          spent_lovelace TEXT NOT NULL DEFAULT '0', reserved_lovelace TEXT NOT NULL DEFAULT '0',
          revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS paper2agent_calls (
          job_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
          reserved_lovelace TEXT NOT NULL, prepared_json TEXT, original_datum_hex TEXT, posted_json TEXT,
          result_json TEXT, result_status TEXT NOT NULL DEFAULT 'pending',
          financial_status TEXT NOT NULL DEFAULT 'reserved', actual_cost_lovelace TEXT,
          locked_lovelace TEXT, error TEXT, accounted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_paper2agent_calls_key ON paper2agent_calls(key_id);
        CREATE TABLE IF NOT EXISTS paper2agent_transactions (
          job_id TEXT NOT NULL, phase TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE,
          tx_cbor TEXT NOT NULL, fee_lovelace TEXT NOT NULL, wallet_debit_lovelace TEXT NOT NULL,
          collateral_lovelace TEXT NOT NULL, supplier_payout_lovelace TEXT NOT NULL,
          facts_json TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (job_id, phase)
        );
      `);
      // Older rows keep a null snapshot, so their recovery stays fail-closed.
      const columns = db.pragma("table_info(paper2agent_calls)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "posted_json")) {
        db.exec("ALTER TABLE paper2agent_calls ADD COLUMN posted_json TEXT");
      }
    }).immediate();
  }

  approval(keyId: string): Paper2AgentApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM paper2agent_approvals WHERE key_id = ?").get(keyId) as Paper2AgentApprovalRow | undefined;
  }

  approve(row: Pick<Paper2AgentApprovalRow, "key_id" | "manifest_hash" | "supplier_pkh" | "max_price_lovelace" | "max_total_spend_lovelace" | "max_calls">): void {
    this.db.transaction(() => {
      if (this.approval(row.key_id)) throw new Error("paper2agent_approval_exists");
      const key = this.db.prepare("SELECT disabled, demo FROM api_keys WHERE id = ?").get(row.key_id) as { disabled: number; demo: number } | undefined;
      if (!key || key.disabled || key.demo) throw new Error("paper2agent_key_ineligible");
      // An outcome can be durable before legacy usage is written.
      for (const table of ["one_shot_jobs", "sessions", "usage", "pending_wallet_transactions", "wallet_transaction_outcomes"]) {
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE key_id = ? LIMIT 1`).get(row.key_id)) {
          throw new Error("paper2agent_requires_unused_key");
        }
      }
      this.db.prepare(`INSERT INTO paper2agent_approvals
        (key_id, manifest_hash, supplier_pkh, max_price_lovelace, max_total_spend_lovelace, max_calls)
        VALUES (@key_id, @manifest_hash, @supplier_pkh, @max_price_lovelace, @max_total_spend_lovelace, @max_calls)`).run(row);
    }).immediate();
  }

  /** Repeat revocation is safe. A missing approval is never reported as revoked. */
  revoke(keyId: string): void {
    if (this.db.prepare("UPDATE paper2agent_approvals SET revoked = 1 WHERE key_id = ?").run(keyId).changes !== 1) {
      throw new Error("paper2agent_approval_missing");
    }
  }

  /** Called inside one-shot admission's immediate transaction. One wallet call at a time. */
  reserve(jobId: string, keyId: string, manifestHash: string): void {
    this.db.transaction(() => {
      const approval = this.approval(keyId);
      const key = this.db.prepare("SELECT disabled, demo FROM api_keys WHERE id = ?").get(keyId) as { disabled: number; demo: number } | undefined;
      if (!key || key.disabled || key.demo || !approval || approval.revoked) throw new Error("paper2agent_not_approved");
      if (approval.manifest_hash !== manifestHash) throw new Error("paper2agent_manifest_not_approved");
      if (approval.calls >= approval.max_calls) throw new Error("paper2agent_call_limit");
      if (BigInt(approval.reserved_lovelace) !== 0n) throw new Error("paper2agent_budget_reserved");
      const remaining = BigInt(approval.max_total_spend_lovelace) - BigInt(approval.spent_lovelace);
      if (remaining <= 0n) throw new Error("paper2agent_budget_exhausted");
      this.db.prepare(`INSERT INTO paper2agent_calls (job_id, key_id, manifest_hash, reserved_lovelace)
        VALUES (?, ?, ?, ?)`).run(jobId, keyId, manifestHash, remaining.toString());
      this.db.prepare("UPDATE paper2agent_approvals SET calls = calls + 1, reserved_lovelace = ? WHERE key_id = ?")
        .run(remaining.toString(), keyId);
    }).immediate();
  }

  call(jobId: string): Paper2AgentCallRow | undefined {
    return this.db.prepare("SELECT * FROM paper2agent_calls WHERE job_id = ?").get(jobId) as Paper2AgentCallRow | undefined;
  }

  /** Newest first by (created_at, id). A cursor anchors only on this key's own job. */
  callPage(keyId: string, cursor: string | undefined, limit: number): string[] | undefined {
    const own = `FROM one_shot_jobs AS job JOIN paper2agent_calls AS call ON call.job_id = job.id
      WHERE job.key_id = @key_id AND call.key_id = @key_id`;
    const anchor = cursor === undefined ? undefined
      : this.db.prepare(`SELECT job.created_at, job.id ${own} AND job.id = @cursor`)
        .get({ key_id: keyId, cursor }) as { created_at: number; id: string } | undefined;
    if (cursor !== undefined && !anchor) return undefined;
    const after = anchor ? "AND (job.created_at < @created_at OR (job.created_at = @created_at AND job.id < @id))" : "";
    const rows = this.db.prepare(`SELECT job.id ${own} ${after} ORDER BY job.created_at DESC, job.id DESC LIMIT @limit`)
      .all({ key_id: keyId, limit, ...anchor }) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** Signed evidence is written once by saveResult. */
  update(jobId: string, patch: Partial<Pick<Paper2AgentCallRow, "prepared_json" | "original_datum_hex" | "posted_json" | "result_status" | "financial_status" | "locked_lovelace" | "error">>): void {
    const fields = Object.keys(patch);
    const allowed: Record<string, true> = { prepared_json: true, original_datum_hex: true, posted_json: true, result_status: true, financial_status: true, locked_lovelace: true, error: true };
    if (fields.some((field) => allowed[field] !== true)) throw new Error("immutable paper2agent call field");
    if (!fields.length) return;
    this.db.prepare(`UPDATE paper2agent_calls SET ${fields.map((field) => `${field} = @${field}`).join(", ")} WHERE job_id = @job_id`)
      .run({ ...patch, job_id: jobId });
  }

  /** Idempotent for identical evidence. Stored evidence, even corrupt evidence, is never replaced. */
  saveResult(jobId: string, ownerId: string, resultJson: string, receiptHash: string, submittedRef: string): void {
    this.db.transaction(() => {
      const call = this.call(jobId);
      if (!call) throw new Error("paper2agent_journal_missing");
      if (call.result_json !== null) {
        const job = this.db.prepare("SELECT receipt_hash FROM one_shot_jobs WHERE id = ?").get(jobId) as { receipt_hash: string | null } | undefined;
        if (call.result_json !== resultJson || job?.receipt_hash !== receiptHash) throw new Error("paper2agent_result_conflict");
        return;
      }
      const changed = this.db.prepare(`UPDATE one_shot_jobs SET receipt_hash = ?, submitted_ref = ?, state = 'submitted'
        WHERE id = ? AND owner_id = ? AND state NOT IN ('completed', 'failed', 'reclaimed')`)
        .run(receiptHash, submittedRef, jobId, ownerId);
      if (changed.changes !== 1) throw new Error("job_ownership_lost");
      // A verified result supersedes an earlier interruption label.
      this.db.prepare("UPDATE paper2agent_calls SET result_json = ?, result_status = 'verified', error = NULL WHERE job_id = ?")
        .run(resultJson, jobId);
    }).immediate();
  }

  transactions(jobId: string): Paper2AgentTransactionRow[] {
    return this.db.prepare("SELECT * FROM paper2agent_transactions WHERE job_id = ? ORDER BY rowid").all(jobId) as Paper2AgentTransactionRow[];
  }

  /** The exact signed bytes and pre-spend values survive guard reconciliation. */
  saveTransaction(row: Omit<Paper2AgentTransactionRow, "confirmed">, ownerId: string, patch: { escrow_ref?: string; original_datum_hex?: string; locked_lovelace?: string; post_valid_until_slot?: number | null }): void {
    this.db.transaction(() => {
      const call = this.call(row.job_id);
      if (!call || call.accounted) throw new Error("paper2agent_call_closed");
      const job = this.db.prepare("SELECT owner_id FROM one_shot_jobs WHERE id = ?").get(row.job_id) as { owner_id: string } | undefined;
      if (job?.owner_id !== ownerId) throw new Error("job_ownership_lost");
      const approval = this.approval(call.key_id)!;
      if (row.phase === "post") {
        const key = this.db.prepare("SELECT disabled FROM api_keys WHERE id = ?").get(call.key_id) as { disabled: number } | undefined;
        if (approval.revoked || !key || key.disabled) throw new Error("paper2agent_not_approved");
      }
      const existing = this.transactions(row.job_id);
      const same = existing.find((tx) => tx.phase === row.phase);
      if (same) {
        if (same.tx_hash !== row.tx_hash || same.tx_cbor !== row.tx_cbor) throw new Error("paper2agent_transaction_already_signed");
        return;
      }
      if (row.phase !== "post" && existing.some((tx) => tx.phase !== "post")) throw new Error("paper2agent_settlement_already_signed");
      const risk = [...existing, row].reduce((sum, tx) => sum + (BigInt(tx.wallet_debit_lovelace) > 0n ? BigInt(tx.wallet_debit_lovelace) : 0n) + BigInt(tx.collateral_lovelace), 0n);
      // Keep a settlement fee/collateral allowance before committing the Open escrow.
      const settlementReserve = row.phase === "post" ? 7_000_000n : 0n;
      if (risk + settlementReserve > BigInt(call.reserved_lovelace)) throw new Error("paper2agent_exposure_limit");
      this.db.prepare(`INSERT INTO paper2agent_transactions
        (job_id, phase, tx_hash, tx_cbor, fee_lovelace, wallet_debit_lovelace, collateral_lovelace, supplier_payout_lovelace, facts_json)
        VALUES (@job_id, @phase, @tx_hash, @tx_cbor, @fee_lovelace, @wallet_debit_lovelace, @collateral_lovelace, @supplier_payout_lovelace, @facts_json)`).run(row);
      if (row.phase === "post") {
        if (!patch.escrow_ref || !patch.original_datum_hex || !patch.locked_lovelace) throw new Error("paper2agent_post_evidence_missing");
        this.update(row.job_id, { original_datum_hex: patch.original_datum_hex, locked_lovelace: patch.locked_lovelace, financial_status: "pending" });
        this.db.prepare(`UPDATE one_shot_jobs SET escrow_ref = ?, post_valid_until_slot = ?, state = 'funding' WHERE id = ?`)
          .run(patch.escrow_ref, patch.post_valid_until_slot ?? null, row.job_id);
      } else {
        this.db.prepare("UPDATE one_shot_jobs SET settle_tx_hash = ?, state = 'settling' WHERE id = ?").run(row.tx_hash, row.job_id);
        this.update(row.job_id, { financial_status: "pending" });
      }
    }).immediate();
  }

  confirm(jobId: string, txHash: string): void {
    this.db.prepare("UPDATE paper2agent_transactions SET confirmed = 1 WHERE job_id = ? AND tx_hash = ?").run(jobId, txHash);
  }

  /** Unknown outcomes retain the whole liability. Known outcomes release it exactly once. */
  finalize(jobId: string, status: "accepted" | "reclaimed" | "unfunded" | "unknown", actual: bigint | null): void {
    this.db.transaction(() => {
      const call = this.call(jobId);
      if (!call || call.accounted) return;
      if (status === "unknown" || actual === null) {
        this.update(jobId, { financial_status: "unknown" });
        return;
      }
      if (actual > BigInt(call.reserved_lovelace)) throw new Error("paper2agent_accounting_out_of_bounds");
      const approval = this.approval(call.key_id)!;
      const txs = this.transactions(jobId);
      if (status === "unfunded" && txs.length !== 0) throw new Error("paper2agent_signed_liability");
      if (status !== "unfunded" && (!txs.some((tx) => tx.phase === "post") || !txs.some((tx) => tx.phase === (status === "accepted" ? "accept" : "reclaim")) || txs.some((tx) => !tx.confirmed))) {
        throw new Error("paper2agent_settlement_not_confirmed");
      }
      const net = txs.reduce((sum, tx) => sum + BigInt(tx.wallet_debit_lovelace), 0n);
      if (actual !== net) throw new Error("paper2agent_actual_cost_mismatch");
      this.db.prepare(`UPDATE paper2agent_approvals SET spent_lovelace = ?, reserved_lovelace = ?, calls = calls - ? WHERE key_id = ?`)
        .run((BigInt(approval.spent_lovelace) + (actual > 0n ? actual : 0n)).toString(), (BigInt(approval.reserved_lovelace) - BigInt(call.reserved_lovelace)).toString(), status === "unfunded" ? 1 : 0, call.key_id);
      this.db.prepare(`UPDATE paper2agent_calls SET financial_status = ?, actual_cost_lovelace = ?, accounted = 1 WHERE job_id = ?`)
        .run(status, actual.toString(), jobId);
      const job = this.db.prepare("SELECT model, supplier_pkh, escrow_ref, created_at FROM one_shot_jobs WHERE id = ?").get(jobId) as { model: string; supplier_pkh: string | null; escrow_ref: string | null; created_at: number };
      this.db.prepare(`INSERT INTO usage (id, key_id, created_at, kind, model, capability_id, supplier_pkh, escrow_ref, cost_lovelace, prompt_tokens, completion_tokens, status, failure_reason)
        VALUES (?, ?, ?, 'paper2agent', ?, 'mcp.tool.execute.v1', ?, ?, ?, 0, 0, ?, ?)
        ON CONFLICT(id) DO NOTHING`).run(jobId, call.key_id, job.created_at, job.model, job.supplier_pkh, job.escrow_ref, actual.toString(), call.result_status === "verified" && status === "accepted" ? "completed" : "failed", call.error);
    }).immediate();
  }
}
