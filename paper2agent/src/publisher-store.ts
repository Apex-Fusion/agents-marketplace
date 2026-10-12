/**
 * Durable Paper2Agent publisher state: publication records and the append-only
 * advert transaction journal. SQLite only: an open, schema, or write failure is
 * fatal and never falls back to memory.
 *
 * Schema triggers keep the money invariants even if service code is wrong: a
 * journaled transaction never changes or disappears, a publication with a signed
 * transaction never returns to a publishable phase, and one wallet slot holds at
 * most one publication that is unfinished or has signed a transaction.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { PaperPackageArtifact, PaperPublicationState, PaperPublishTerms } from "@marketplace/shared/paper2agent/workflow";

/** "preparing" is internal: the runtime image is still being built. */
export type PublicationPhase = "preparing" | PaperPublicationState;

const PHASES: readonly PublicationPhase[] = ["preparing", "prepared", "publishing", "confirmation_pending", "published", "failed"];

export interface PublicationRecord {
  id: string;
  target_id: string;
  phase: PublicationPhase;
  /** SHA-256 of the canonical job ID, terms and artifact; detects exact replays. */
  request_hash: string;
  terms: PaperPublishTerms;
  artifact: PaperPackageArtifact;
  /** Private attempt directory: bundle.tar, manifest.json and the build context. */
  work_dir: string;
  runtime_image_id: string | null;
  supplier_pkh: string;
  deposit_address: string;
  endpoint_url: string;
  advert_ref: string | null;
  tx_hash: string | null;
  actual_debit_lovelace: string | null;
  error: string | null;
  prepared_at: number | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

export type NewPublication = Pick<PublicationRecord, "id" | "target_id" | "request_hash" | "terms" | "artifact" | "work_dir" |
  "supplier_pkh" | "deposit_address" | "endpoint_url">;

export type PublicationPatch = Partial<Pick<PublicationRecord, "phase" | "runtime_image_id" | "error" | "prepared_at" | "published_at">>;

const PATCH_COLUMNS: Record<keyof PublicationPatch, true> = {
  phase: true, runtime_image_id: true, error: true, prepared_at: true, published_at: true,
};

export interface WalletInput {
  ref: string;
  lovelace: string;
}

/** The signed advert transaction, journaled before broadcast. */
export interface AdvertTransaction {
  publication_id: string;
  target_id: string;
  tx_hash: string;
  tx_cbor: string;
  advert_ref: string;
  advert_address: string;
  advert_datum_hex: string;
  /** Wallet inputs and their values before broadcast: unspent inputs prove nothing moved. */
  wallet_inputs: WalletInput[];
  fee_lovelace: string;
  wallet_debit_lovelace: string;
  max_debit_lovelace: string;
  valid_until_slot: number | null;
  signed_at: number;
  confirmed_at: number | null;
}

/** A guarded write found another publication in the slot or an unexpected phase. */
export class PublicationConflictError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (${PHASES.map((phase) => `'${phase}'`).join(", ")})),
  request_hash TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  work_dir TEXT NOT NULL,
  runtime_image_id TEXT,
  supplier_pkh TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  advert_ref TEXT,
  tx_hash TEXT,
  actual_debit_lovelace TEXT,
  error TEXT,
  prepared_at INTEGER,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS publications_one_per_slot ON publications (target_id)
  WHERE phase <> 'failed' OR tx_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS advert_transactions (
  publication_id TEXT PRIMARY KEY REFERENCES publications (id),
  target_id TEXT NOT NULL UNIQUE,
  tx_hash TEXT NOT NULL UNIQUE,
  tx_cbor TEXT NOT NULL,
  advert_ref TEXT NOT NULL,
  advert_address TEXT NOT NULL,
  advert_datum_hex TEXT NOT NULL,
  wallet_inputs_json TEXT NOT NULL,
  fee_lovelace TEXT NOT NULL,
  wallet_debit_lovelace TEXT NOT NULL,
  max_debit_lovelace TEXT NOT NULL,
  valid_until_slot INTEGER,
  signed_at INTEGER NOT NULL,
  confirmed_at INTEGER
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS advert_transactions_append_only BEFORE DELETE ON advert_transactions
BEGIN SELECT RAISE(ABORT, 'the advert transaction journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS advert_transactions_immutable BEFORE UPDATE ON advert_transactions
WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.target_id IS NOT OLD.target_id OR NEW.tx_hash IS NOT OLD.tx_hash
  OR NEW.tx_cbor IS NOT OLD.tx_cbor OR NEW.advert_ref IS NOT OLD.advert_ref OR NEW.advert_address IS NOT OLD.advert_address
  OR NEW.advert_datum_hex IS NOT OLD.advert_datum_hex OR NEW.wallet_inputs_json IS NOT OLD.wallet_inputs_json
  OR NEW.fee_lovelace IS NOT OLD.fee_lovelace OR NEW.wallet_debit_lovelace IS NOT OLD.wallet_debit_lovelace
  OR NEW.max_debit_lovelace IS NOT OLD.max_debit_lovelace OR NEW.valid_until_slot IS NOT OLD.valid_until_slot
  OR NEW.signed_at IS NOT OLD.signed_at OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
BEGIN SELECT RAISE(ABORT, 'a journaled advert transaction is immutable'); END;
CREATE TRIGGER IF NOT EXISTS publications_retained BEFORE DELETE ON publications
BEGIN SELECT RAISE(ABORT, 'publication records are retained'); END;
CREATE TRIGGER IF NOT EXISTS publications_signed_final BEFORE UPDATE ON publications
WHEN OLD.tx_hash IS NOT NULL AND (NEW.tx_hash IS NOT OLD.tx_hash OR NEW.phase IN ('preparing', 'prepared')
  OR NEW.request_hash IS NOT OLD.request_hash OR NEW.target_id IS NOT OLD.target_id)
BEGIN SELECT RAISE(ABORT, 'a publication with a signed advert transaction cannot be reset'); END;
CREATE TRIGGER IF NOT EXISTS publications_inputs_fixed BEFORE UPDATE ON publications
WHEN OLD.phase <> 'failed' AND (NEW.request_hash IS NOT OLD.request_hash OR NEW.target_id IS NOT OLD.target_id
  OR NEW.terms_json IS NOT OLD.terms_json OR NEW.artifact_json IS NOT OLD.artifact_json OR NEW.work_dir IS NOT OLD.work_dir)
BEGIN SELECT RAISE(ABORT, 'publication inputs change only after a failed preparation'); END;
`;

interface PublicationRow extends Omit<PublicationRecord, "terms" | "artifact"> {
  terms_json: string;
  artifact_json: string;
}

interface TransactionRow extends Omit<AdvertTransaction, "wallet_inputs"> {
  wallet_inputs_json: string;
}

function publication(row: PublicationRow): PublicationRecord {
  const { terms_json: terms, artifact_json: artifact, ...rest } = row;
  return { ...rest, terms: JSON.parse(terms) as PaperPublishTerms, artifact: JSON.parse(artifact) as PaperPackageArtifact };
}

export class PaperPublisherStore {
  private constructor(private readonly db: SqliteDatabase) {}

  static open(path: string): PaperPublisherStore {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path);
    try {
      db.pragma("journal_mode = WAL");
      // A signed transaction is journaled before broadcast: commits must survive power loss.
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      db.exec(SCHEMA);
    } catch (error) {
      db.close();
      throw error;
    }
    return new PaperPublisherStore(db);
  }

  get(id: string): PublicationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as PublicationRow | undefined;
    return row && publication(row);
  }

  all(): PublicationRecord[] {
    return (this.db.prepare("SELECT * FROM publications ORDER BY created_at").all() as PublicationRow[]).map(publication);
  }

  /** The publication occupying a wallet slot, if any. */
  slotHolder(targetId: string): PublicationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM publications WHERE target_id = ? AND (phase <> 'failed' OR tx_hash IS NOT NULL)")
      .get(targetId) as PublicationRow | undefined;
    return row && publication(row);
  }

  heldTargets(): Set<string> {
    const rows = this.db.prepare("SELECT target_id FROM publications WHERE phase <> 'failed' OR tx_hash IS NOT NULL")
      .all() as Array<{ target_id: string }>;
    return new Set(rows.map((row) => row.target_id));
  }

  /** Start a preparation. The slot index rejects a second unfinished publication for a target. */
  create(record: NewPublication, at: number): PublicationRecord {
    try {
      this.db.prepare(`INSERT INTO publications (id, target_id, phase, request_hash, terms_json, artifact_json, work_dir,
        supplier_pkh, deposit_address, endpoint_url, created_at, updated_at)
        VALUES (@id, @target_id, 'preparing', @request_hash, @terms_json, @artifact_json, @work_dir,
        @supplier_pkh, @deposit_address, @endpoint_url, @at, @at)`).run(this.params(record, at));
    } catch (error) {
      if (error instanceof Database.SqliteError && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new PublicationConflictError("target_slot_in_use");
      }
      throw error;
    }
    return this.get(record.id)!;
  }

  /** Restart a preparation that failed before any transaction, possibly with new inputs. */
  retry(record: NewPublication, at: number): PublicationRecord {
    let changes: number;
    try {
      changes = this.db.prepare(`UPDATE publications SET phase = 'preparing', target_id = @target_id, request_hash = @request_hash,
        terms_json = @terms_json, artifact_json = @artifact_json, work_dir = @work_dir, supplier_pkh = @supplier_pkh,
        deposit_address = @deposit_address, endpoint_url = @endpoint_url, runtime_image_id = NULL, error = NULL,
        prepared_at = NULL, updated_at = @at
        WHERE id = @id AND phase = 'failed' AND tx_hash IS NULL`).run(this.params(record, at)).changes;
    } catch (error) {
      if (error instanceof Database.SqliteError && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new PublicationConflictError("target_slot_in_use");
      }
      throw error;
    }
    if (changes !== 1) throw new PublicationConflictError("publication_state_changed");
    return this.get(record.id)!;
  }

  /** Compare-and-set on the current phase. */
  update(id: string, from: readonly PublicationPhase[], patch: PublicationPatch, at: number): PublicationRecord {
    const columns = Object.keys(patch).filter((key): key is keyof PublicationPatch => Object.hasOwn(PATCH_COLUMNS, key));
    const assignments = [...columns.map((column) => `${column} = @${column}`), "updated_at = @at"].join(", ");
    const phases = from.map((_phase, index) => `@from${index}`).join(", ");
    const params: Record<string, unknown> = { ...patch, id, at };
    from.forEach((phase, index) => { params[`from${index}`] = phase; });
    const changes = this.db.prepare(`UPDATE publications SET ${assignments} WHERE id = @id AND phase IN (${phases})`).run(params).changes;
    if (changes !== 1) throw new PublicationConflictError("publication_state_changed");
    return this.get(id)!;
  }

  /** Durable before broadcast; one signed transaction per publication and per slot, ever. */
  journal(transaction: AdvertTransaction, at: number): PublicationRecord {
    const { wallet_inputs: inputs, ...columns } = transaction;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO advert_transactions (publication_id, target_id, tx_hash, tx_cbor, advert_ref, advert_address,
        advert_datum_hex, wallet_inputs_json, fee_lovelace, wallet_debit_lovelace, max_debit_lovelace, valid_until_slot,
        signed_at, confirmed_at)
        VALUES (@publication_id, @target_id, @tx_hash, @tx_cbor, @advert_ref, @advert_address, @advert_datum_hex,
        @wallet_inputs_json, @fee_lovelace, @wallet_debit_lovelace, @max_debit_lovelace, @valid_until_slot,
        @signed_at, @confirmed_at)`).run({ ...columns, wallet_inputs_json: JSON.stringify(inputs) });
      const changes = this.db.prepare(`UPDATE publications SET tx_hash = ?, advert_ref = ?, actual_debit_lovelace = ?, updated_at = ?
        WHERE id = ? AND target_id = ? AND phase = 'publishing' AND tx_hash IS NULL`)
        .run(transaction.tx_hash, transaction.advert_ref, transaction.wallet_debit_lovelace, at,
          transaction.publication_id, transaction.target_id).changes;
      if (changes !== 1) throw new PublicationConflictError("publication_state_changed");
    }).immediate();
    return this.get(transaction.publication_id)!;
  }

  transaction(publicationId: string): AdvertTransaction | undefined {
    const row = this.db.prepare("SELECT * FROM advert_transactions WHERE publication_id = ?").get(publicationId) as TransactionRow | undefined;
    if (!row) return undefined;
    const { wallet_inputs_json: inputs, ...rest } = row;
    return { ...rest, wallet_inputs: JSON.parse(inputs) as WalletInput[] };
  }

  confirm(publicationId: string, at: number): void {
    this.db.prepare("UPDATE advert_transactions SET confirmed_at = ? WHERE publication_id = ? AND confirmed_at IS NULL").run(at, publicationId);
  }

  /**
   * Boot recovery. An interrupted image build left no transaction. A publish without
   * a journaled transaction never broadcast. A journaled, unconfirmed transaction has
   * an unknown outcome: it is read from the chain later, never signed again.
   */
  recover(at: number): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE publications SET phase = 'failed', updated_at = ?,
        error = 'The publisher stopped during runtime image construction. No transaction was created; prepare again.'
        WHERE phase = 'preparing'`).run(at);
      this.db.prepare(`UPDATE publications SET phase = 'prepared', updated_at = ?,
        error = 'The publisher stopped before signing an advert transaction. Nothing was broadcast.'
        WHERE phase = 'publishing' AND tx_hash IS NULL`).run(at);
      this.db.prepare(`UPDATE publications SET phase = 'confirmation_pending', updated_at = ?,
        error = 'The publisher restarted while its advert transaction was unconfirmed. Refresh to read the chain outcome.'
        WHERE phase = 'publishing' AND id IN (SELECT publication_id FROM advert_transactions WHERE confirmed_at IS NULL)`).run(at);
    }).immediate();
  }

  close(): void {
    this.db.close();
  }

  private params(record: NewPublication, at: number): Record<string, unknown> {
    const { terms, artifact, ...rest } = record;
    return { ...rest, terms_json: JSON.stringify(terms), artifact_json: JSON.stringify(artifact), at };
  }
}
