/**
 * Durable Paper2Agent publisher state: publication records, the append-only
 * advert transaction journal, the append-only advert retirement journal and the
 * slot record registrations. SQLite only: an open, schema, or write failure is
 * fatal and never falls back to memory.
 *
 * A publication's adverts have generations. Generation 1 is the publish advert;
 * a re-advertisement (Part 2 §9.6: the identity-layout advert of a slot that is
 * already published) is the next generation. An advert ends once: "expired"
 * (it never confirmed and cannot) or "retired" (its output was spent).
 *
 * Schema triggers keep the money invariants even if service code is wrong: a
 * journaled transaction never changes or disappears, a publication with a signed
 * transaction never returns to a publishable phase, one wallet slot holds at
 * most one publication that is unfinished or has signed a transaction, a slot
 * has at most one live advert per layout, and a submitted slot registration
 * never changes.
 *
 * Opening a database of the earlier layout (one advert per publication and per
 * slot) migrates its advert journal in place: every row stays, as generation 1.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { decodeAnyAdvertDatum } from "@marketplace/shared/cbor";
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
  /** The publish advert (generation 1). */
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

/** The advert datum layout (Part 2 §9.6): legacy (13 fields) or identity (14 fields, with agent_id). */
export type AdvertLayout = "legacy" | "identity";

/** Why an advert ended: it never confirmed and cannot, or its output was spent. */
export type AdvertEnd = "expired" | "retired";

/** A signed advert transaction, journaled before broadcast. */
export interface AdvertTransaction {
  publication_id: string;
  /** 1: the publish advert. Each re-advertisement of the publication takes the next generation. */
  generation: number;
  layout: AdvertLayout;
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
  /** Set once by the switch: the slot's supplier serves this advert from then on. */
  switched_at: number | null;
  /** Set once, with end_reason. */
  ended_at: number | null;
  end_reason: AdvertEnd | null;
}

/** A signed advert transaction as the service checked it; the store assigns the generation. */
export type SignedAdvert = Omit<AdvertTransaction, "generation" | "confirmed_at" | "switched_at" | "ended_at" | "end_reason">;

/**
 * One signed RetireAdvert transaction of a journaled advert, journaled before
 * broadcast. Every attempt spends the same advert output, so at most one confirms.
 */
export interface AdvertRetirement {
  tx_hash: string;
  publication_id: string;
  generation: number;
  tx_cbor: string;
  /** Wallet inputs other than the advert output, with their values before broadcast. */
  wallet_inputs: WalletInput[];
  fee_lovelace: string;
  /** Negative when the returned advert deposit exceeds the fee. */
  wallet_debit_lovelace: string;
  max_debit_lovelace: string;
  valid_until_slot: number | null;
  signed_at: number;
  confirmed_at: number | null;
}

/**
 * The Register transaction of a slot key's identity record (Part 2 §9.2).
 * The publisher stores it signed by the slot key; the controller signs it
 * offline; the fully signed bytes are journaled before broadcast.
 */
export interface SlotRegistration {
  target_id: string;
  supplier_pkh: string;
  agent_id: string;
  tx_hash: string;
  tx_cbor: string;
  required_signers: string[];
  /** The Register window's upper bound: nobody can submit after it. */
  valid_until_ms: number;
  created_at: number;
  /** Set when the fully signed transaction is journaled for broadcast. */
  submitted_at: number | null;
}

/** A guarded write found another publication in the slot, an unexpected phase, or a live advert of the same layout. */
export class PublicationConflictError extends Error {}

/** The advert journal table; the migration builds it under another name first. */
function advertTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  publication_id TEXT NOT NULL REFERENCES publications (id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  layout TEXT NOT NULL CHECK (layout IN ('legacy', 'identity')),
  target_id TEXT NOT NULL,
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
  confirmed_at INTEGER,
  switched_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT CHECK (end_reason IN ('expired', 'retired')),
  PRIMARY KEY (publication_id, generation),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (switched_at IS NULL OR confirmed_at IS NOT NULL)
) WITHOUT ROWID;`;
}

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
${advertTable("advert_transactions")}
CREATE UNIQUE INDEX IF NOT EXISTS advert_transactions_one_live_per_layout ON advert_transactions (target_id, layout)
  WHERE ended_at IS NULL;
CREATE TRIGGER IF NOT EXISTS advert_transactions_append_only BEFORE DELETE ON advert_transactions
BEGIN SELECT RAISE(ABORT, 'the advert transaction journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS advert_transactions_in_slot BEFORE INSERT ON advert_transactions
WHEN NEW.target_id IS NOT (SELECT target_id FROM publications WHERE id = NEW.publication_id)
BEGIN SELECT RAISE(ABORT, 'an advert transaction belongs to the slot of its publication'); END;
CREATE TRIGGER IF NOT EXISTS advert_transactions_immutable BEFORE UPDATE ON advert_transactions
WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.generation IS NOT OLD.generation OR NEW.layout IS NOT OLD.layout
  OR NEW.target_id IS NOT OLD.target_id OR NEW.tx_hash IS NOT OLD.tx_hash
  OR NEW.tx_cbor IS NOT OLD.tx_cbor OR NEW.advert_ref IS NOT OLD.advert_ref OR NEW.advert_address IS NOT OLD.advert_address
  OR NEW.advert_datum_hex IS NOT OLD.advert_datum_hex OR NEW.wallet_inputs_json IS NOT OLD.wallet_inputs_json
  OR NEW.fee_lovelace IS NOT OLD.fee_lovelace OR NEW.wallet_debit_lovelace IS NOT OLD.wallet_debit_lovelace
  OR NEW.max_debit_lovelace IS NOT OLD.max_debit_lovelace OR NEW.valid_until_slot IS NOT OLD.valid_until_slot
  OR NEW.signed_at IS NOT OLD.signed_at OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
  OR (OLD.switched_at IS NOT NULL AND NEW.switched_at IS NOT OLD.switched_at)
  OR (OLD.ended_at IS NOT NULL AND (NEW.ended_at IS NOT OLD.ended_at OR NEW.end_reason IS NOT OLD.end_reason))
BEGIN SELECT RAISE(ABORT, 'a journaled advert transaction is immutable'); END;
CREATE TABLE IF NOT EXISTS advert_retirements (
  tx_hash TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  tx_cbor TEXT NOT NULL,
  wallet_inputs_json TEXT NOT NULL,
  fee_lovelace TEXT NOT NULL,
  wallet_debit_lovelace TEXT NOT NULL,
  max_debit_lovelace TEXT NOT NULL,
  valid_until_slot INTEGER,
  signed_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  FOREIGN KEY (publication_id, generation) REFERENCES advert_transactions (publication_id, generation)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS advert_retirements_append_only BEFORE DELETE ON advert_retirements
BEGIN SELECT RAISE(ABORT, 'the advert retirement journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS advert_retirements_live_advert BEFORE INSERT ON advert_retirements
WHEN (SELECT ended_at FROM advert_transactions WHERE publication_id = NEW.publication_id AND generation = NEW.generation) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'an ended advert is not retired again'); END;
CREATE TRIGGER IF NOT EXISTS advert_retirements_immutable BEFORE UPDATE ON advert_retirements
WHEN NEW.tx_hash IS NOT OLD.tx_hash OR NEW.publication_id IS NOT OLD.publication_id OR NEW.generation IS NOT OLD.generation
  OR NEW.tx_cbor IS NOT OLD.tx_cbor OR NEW.wallet_inputs_json IS NOT OLD.wallet_inputs_json
  OR NEW.fee_lovelace IS NOT OLD.fee_lovelace OR NEW.wallet_debit_lovelace IS NOT OLD.wallet_debit_lovelace
  OR NEW.max_debit_lovelace IS NOT OLD.max_debit_lovelace OR NEW.valid_until_slot IS NOT OLD.valid_until_slot
  OR NEW.signed_at IS NOT OLD.signed_at OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
BEGIN SELECT RAISE(ABORT, 'a journaled advert retirement is immutable'); END;
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
CREATE TABLE IF NOT EXISTS slot_records (
  target_id TEXT PRIMARY KEY,
  supplier_pkh TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  tx_cbor TEXT NOT NULL,
  required_signers_json TEXT NOT NULL,
  valid_until_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS slot_records_submitted_immutable BEFORE UPDATE ON slot_records
WHEN OLD.submitted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a submitted slot registration is immutable'); END;
`;

const ADVERT_COLUMNS = "publication_id, generation, layout, target_id, tx_hash, tx_cbor, advert_ref, advert_address, " +
  "advert_datum_hex, wallet_inputs_json, fee_lovelace, wallet_debit_lovelace, max_debit_lovelace, valid_until_slot, signed_at, " +
  "confirmed_at, switched_at, ended_at, end_reason";
const ADVERT_VALUES = ADVERT_COLUMNS.split(", ").map((column) => `@${column}`).join(", ");

interface PublicationRow extends Omit<PublicationRecord, "terms" | "artifact"> {
  terms_json: string;
  artifact_json: string;
}

interface AdvertRow extends Omit<AdvertTransaction, "wallet_inputs"> {
  wallet_inputs_json: string;
}

interface RetirementRow extends Omit<AdvertRetirement, "wallet_inputs"> {
  wallet_inputs_json: string;
}

interface SlotRegistrationRow extends Omit<SlotRegistration, "required_signers"> {
  required_signers_json: string;
}

function publication(row: PublicationRow): PublicationRecord {
  const { terms_json: terms, artifact_json: artifact, ...rest } = row;
  return { ...rest, terms: JSON.parse(terms) as PaperPublishTerms, artifact: JSON.parse(artifact) as PaperPackageArtifact };
}

function advert(row: AdvertRow): AdvertTransaction {
  const { wallet_inputs_json: inputs, ...rest } = row;
  return { ...rest, wallet_inputs: JSON.parse(inputs) as WalletInput[] };
}

function retirement(row: RetirementRow): AdvertRetirement {
  const { wallet_inputs_json: inputs, ...rest } = row;
  return { ...rest, wallet_inputs: JSON.parse(inputs) as WalletInput[] };
}

/** The layout of a journaled advert datum; a datum that no strict decoder reads is legacy, as the shared builders read it. */
function advertLayout(datumHex: string): AdvertLayout {
  try {
    return decodeAnyAdvertDatum(datumHex).layout;
  } catch {
    return "legacy";
  }
}

/**
 * The earlier journal held one advert per publication (publication_id primary
 * key) and per slot (target_id unique). Rebuild it as generation 1 of each
 * publication in one transaction: every row and its signed bytes stay. The
 * advert of a failed signed publication expired (only that failure follows a
 * signature), so it ends as "expired".
 */
function migrateAdvertJournal(db: SqliteDatabase): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('advert_transactions')").all() as Array<{ name: string }>;
  if (columns.length === 0 || columns.some((column) => column.name === "generation")) return;
  // A table rebuild runs with foreign keys off, set outside the transaction (sqlite.org/lang_altertable.html#otheralter).
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(advertTable("advert_transactions_migrated"));
      const rows = db.prepare(`SELECT advert_transactions.*, publications.phase AS publication_phase,
        publications.updated_at AS publication_updated_at
        FROM advert_transactions LEFT JOIN publications ON publications.id = advert_transactions.publication_id`)
        .all() as Array<Omit<AdvertRow, "generation" | "layout" | "switched_at" | "ended_at" | "end_reason"> &
          { publication_phase: string | null; publication_updated_at: number | null }>;
      const insert = db.prepare(`INSERT INTO advert_transactions_migrated (${ADVERT_COLUMNS}) VALUES (${ADVERT_VALUES})`);
      for (const { publication_phase: phase, publication_updated_at: updatedAt, ...row } of rows) {
        const expired = phase === "failed";
        insert.run({ ...row, generation: 1, layout: advertLayout(row.advert_datum_hex), switched_at: null,
          ended_at: expired ? updatedAt ?? row.signed_at : null, end_reason: expired ? "expired" : null });
      }
      const copied = db.prepare("SELECT COUNT(*) AS count FROM advert_transactions_migrated").get() as { count: number };
      if (copied.count !== rows.length) throw new Error("the advert journal migration did not copy every row");
      // The old table's triggers go with it; SCHEMA creates the new ones.
      db.exec("DROP TABLE advert_transactions");
      db.exec("ALTER TABLE advert_transactions_migrated RENAME TO advert_transactions");
      // better-sqlite3 returns one row per violation of the PRAGMA.
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) throw new Error("the advert journal migration broke a foreign key");
    }).immediate();
  } finally {
    db.pragma("foreign_keys = ON");
  }
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
      migrateAdvertJournal(db);
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

  /** Durable before broadcast: the publish advert (generation 1), once per publication. */
  journal(transaction: SignedAdvert, at: number): PublicationRecord {
    this.db.transaction(() => {
      this.insertAdvert(transaction, 1);
      const changes = this.db.prepare(`UPDATE publications SET tx_hash = ?, advert_ref = ?, actual_debit_lovelace = ?, updated_at = ?
        WHERE id = ? AND target_id = ? AND phase = 'publishing' AND tx_hash IS NULL`)
        .run(transaction.tx_hash, transaction.advert_ref, transaction.wallet_debit_lovelace, at,
          transaction.publication_id, transaction.target_id).changes;
      if (changes !== 1) throw new PublicationConflictError("publication_state_changed");
    }).immediate();
    return this.get(transaction.publication_id)!;
  }

  /**
   * Durable before broadcast: a re-advertisement of a published publication as
   * its next generation. The slot keeps at most one live advert per layout.
   */
  journalReadvert(transaction: SignedAdvert): AdvertTransaction {
    let generation = 0;
    try {
      this.db.transaction(() => {
        const holder = this.db.prepare("SELECT target_id FROM publications WHERE id = ? AND phase = 'published' AND tx_hash IS NOT NULL")
          .get(transaction.publication_id) as { target_id: string } | undefined;
        if (holder?.target_id !== transaction.target_id) throw new PublicationConflictError("publication_state_changed");
        // One row: the generation after the publication's newest advert.
        const next = this.db.prepare("SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM advert_transactions WHERE publication_id = ?")
          .get(transaction.publication_id) as { generation: number };
        generation = next.generation;
        this.insertAdvert(transaction, generation);
      }).immediate();
    } catch (error) {
      if (error instanceof Database.SqliteError && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new PublicationConflictError("advert_layout_live");
      }
      throw error;
    }
    return this.advert(transaction.publication_id, generation)!;
  }

  advert(publicationId: string, generation: number): AdvertTransaction | undefined {
    const row = this.db.prepare("SELECT * FROM advert_transactions WHERE publication_id = ? AND generation = ?")
      .get(publicationId, generation) as AdvertRow | undefined;
    return row && advert(row);
  }

  /** The publish advert (generation 1). */
  publishAdvert(publicationId: string): AdvertTransaction | undefined {
    return this.advert(publicationId, 1);
  }

  /** Every advert of a publication, oldest generation first. */
  adverts(publicationId: string): AdvertTransaction[] {
    return (this.db.prepare("SELECT * FROM advert_transactions WHERE publication_id = ? ORDER BY generation")
      .all(publicationId) as AdvertRow[]).map(advert);
  }

  confirmAdvert(publicationId: string, generation: number, at: number): void {
    this.db.prepare("UPDATE advert_transactions SET confirmed_at = ? WHERE publication_id = ? AND generation = ? AND confirmed_at IS NULL")
      .run(at, publicationId, generation);
  }

  /** The switch, set once: the slot's supplier serves this confirmed, live advert from now on. */
  switchAdvert(publicationId: string, generation: number, at: number): void {
    const changes = this.db.prepare(`UPDATE advert_transactions SET switched_at = ?
      WHERE publication_id = ? AND generation = ? AND confirmed_at IS NOT NULL AND ended_at IS NULL AND switched_at IS NULL`)
      .run(at, publicationId, generation).changes;
    if (changes !== 1 && this.advert(publicationId, generation)?.switched_at == null) {
      throw new PublicationConflictError("advert_state_changed");
    }
  }

  /** The advert transaction never confirmed and cannot: its wallet inputs stayed unspent past its validity. */
  expireAdvert(publicationId: string, generation: number, at: number): void {
    this.db.prepare(`UPDATE advert_transactions SET ended_at = ?, end_reason = 'expired'
      WHERE publication_id = ? AND generation = ? AND confirmed_at IS NULL AND ended_at IS NULL`).run(at, publicationId, generation);
  }

  /** Durable before broadcast: one RetireAdvert attempt of a live advert. */
  journalRetirement(attempt: Omit<AdvertRetirement, "confirmed_at">): AdvertRetirement {
    const { wallet_inputs: inputs, ...columns } = attempt;
    this.db.prepare(`INSERT INTO advert_retirements (tx_hash, publication_id, generation, tx_cbor, wallet_inputs_json, fee_lovelace,
      wallet_debit_lovelace, max_debit_lovelace, valid_until_slot, signed_at, confirmed_at)
      VALUES (@tx_hash, @publication_id, @generation, @tx_cbor, @wallet_inputs_json, @fee_lovelace, @wallet_debit_lovelace,
      @max_debit_lovelace, @valid_until_slot, @signed_at, NULL)`).run({ ...columns, wallet_inputs_json: JSON.stringify(inputs) });
    return this.retirements(attempt.publication_id, attempt.generation).find((row) => row.tx_hash === attempt.tx_hash)!;
  }

  /** The RetireAdvert attempts of an advert, oldest first. */
  retirements(publicationId: string, generation: number): AdvertRetirement[] {
    return (this.db.prepare("SELECT * FROM advert_retirements WHERE publication_id = ? AND generation = ? ORDER BY signed_at, tx_hash")
      .all(publicationId, generation) as RetirementRow[]).map(retirement);
  }

  /**
   * The advert output is spent: the advert is retired. `txHash` names the
   * journaled attempt that confirmed, or null when the chain shows no such attempt.
   */
  retireAdvert(publicationId: string, generation: number, txHash: string | null, at: number): void {
    this.db.transaction(() => {
      if (txHash !== null) {
        this.db.prepare(`UPDATE advert_retirements SET confirmed_at = ?
          WHERE tx_hash = ? AND publication_id = ? AND generation = ? AND confirmed_at IS NULL`).run(at, txHash, publicationId, generation);
      }
      this.db.prepare(`UPDATE advert_transactions SET ended_at = ?, end_reason = 'retired'
        WHERE publication_id = ? AND generation = ? AND ended_at IS NULL`).run(at, publicationId, generation);
    }).immediate();
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
        WHERE phase = 'publishing' AND id IN (SELECT publication_id FROM advert_transactions
          WHERE generation = 1 AND confirmed_at IS NULL)`).run(at);
    }).immediate();
  }

  slotRegistration(targetId: string): SlotRegistration | undefined {
    const row = this.db.prepare("SELECT * FROM slot_records WHERE target_id = ?").get(targetId) as SlotRegistrationRow | undefined;
    if (!row) return undefined;
    const { required_signers_json: signers, ...rest } = row;
    return { ...rest, required_signers: JSON.parse(signers) as string[] };
  }

  /**
   * Store a built registration. It replaces an unsubmitted one; it replaces a
   * submitted one only when the caller proved that one expired unconfirmed.
   */
  saveSlotRegistration(registration: Omit<SlotRegistration, "submitted_at">, replaceSubmitted: boolean): SlotRegistration {
    const { required_signers: signers, ...columns } = registration;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM slot_records WHERE target_id = ? AND (submitted_at IS NULL OR ?)")
        .run(registration.target_id, replaceSubmitted ? 1 : 0);
      this.db.prepare(`INSERT INTO slot_records (target_id, supplier_pkh, agent_id, tx_hash, tx_cbor, required_signers_json,
        valid_until_ms, created_at, submitted_at)
        VALUES (@target_id, @supplier_pkh, @agent_id, @tx_hash, @tx_cbor, @required_signers_json, @valid_until_ms, @created_at, NULL)`)
        .run({ ...columns, required_signers_json: JSON.stringify(signers) });
    }).immediate();
    return this.slotRegistration(registration.target_id)!;
  }

  /** Durable before broadcast: the fully signed registration, once. */
  submitSlotRegistration(targetId: string, txCbor: string, at: number): SlotRegistration {
    const changes = this.db.prepare("UPDATE slot_records SET tx_cbor = ?, submitted_at = ? WHERE target_id = ? AND submitted_at IS NULL")
      .run(txCbor, at, targetId).changes;
    if (changes !== 1) throw new PublicationConflictError("slot_registration_state_changed");
    return this.slotRegistration(targetId)!;
  }

  close(): void {
    this.db.close();
  }

  private insertAdvert(transaction: SignedAdvert, generation: number): void {
    const { wallet_inputs: inputs, ...columns } = transaction;
    this.db.prepare(`INSERT INTO advert_transactions (${ADVERT_COLUMNS}) VALUES (${ADVERT_VALUES})`).run({
      ...columns, generation, wallet_inputs_json: JSON.stringify(inputs), confirmed_at: null, switched_at: null, ended_at: null,
      end_reason: null,
    });
  }

  private params(record: NewPublication, at: number): Record<string, unknown> {
    const { terms, artifact, ...rest } = record;
    return { ...rest, terms_json: JSON.stringify(terms), artifact_json: JSON.stringify(artifact), at };
  }
}
