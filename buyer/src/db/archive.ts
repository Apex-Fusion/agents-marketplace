/**
 * buyer/src/db/archive.ts — response archive (SQLite metadata + filesystem
 * artefacts).
 *
 * Open one Archive instance at boot, persist every completed lifecycle, and
 * expose read APIs for the SPA's history page + dispute-verification flows.
 *
 * Storage layout under ARCHIVE_DIR (typically a host-bind-mounted dir):
 *
 *   archive.db                                       — SQLite metadata index
 *   <txhash>_<index>/request.json                    — what the buyer sent
 *   <txhash>_<index>/response.{txt,mp3,wav,...}      — what the supplier returned
 *
 * The "#" in the escrow ref is replaced with "_" so the directory name is a
 * single valid path segment on every filesystem.
 *
 * This module is intentionally synchronous (better-sqlite3 + fs.writeFileSync)
 * because the volume is low (≤ 1 record per chat/TTS request, ~100KB worst
 * case for audio) and the simplicity is worth more than async overhead.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import Database from "better-sqlite3";
import type { Database as BetterDatabase } from "better-sqlite3";
import { CREATE_TABLES_SQL } from "./schema.js";

/** Convert "<txhash>#<index>" to a safe directory name. */
function escrowRefToDir(escrow_ref: string): string {
  return escrow_ref.replace("#", "_");
}

/** Pick a sensible file extension for a response based on content type. */
function extFromContentType(ct: string): string {
  if (ct.startsWith("audio/mpeg")) return "mp3";
  if (ct.startsWith("audio/wav") || ct.startsWith("audio/wave") || ct.startsWith("audio/x-wav")) return "wav";
  if (ct.startsWith("audio/opus") || ct.startsWith("audio/ogg")) return "opus";
  if (ct.startsWith("audio/aac")) return "aac";
  if (ct.startsWith("audio/flac")) return "flac";
  if (ct.startsWith("audio/")) return ct.slice("audio/".length).split(";")[0] || "bin";
  if (ct.startsWith("application/json")) return "json";
  if (ct.startsWith("text/plain")) return "txt";
  return "bin";
}

export interface ArchiveRow {
  escrow_ref: string;
  posted_at: number;
  completed_at: number;
  capability_id: string;
  supplier_pkh: string;
  model: string;
  payment_lovelace: string;
  request_filename: string;
  response_filename: string;
  response_content_type: string;
  response_byte_length: number;
  receipt_json: string;
  receipt_signature: string;
}

export interface PersistChatParams {
  escrow_ref: string;
  posted_at: number;
  capability_id: string;
  supplier_pkh: string;
  model: string;
  payment_lovelace: string;
  /** The full messages[] array, pre-canonicalisation. */
  request_messages: unknown;
  /** The assistant message object — `{role:"assistant", content:"..."}` —
   * canonicalised by canonical(...) on the supplier side, so the bytes
   * stored here MUST match exactly what was hashed for the receipt. */
  response_canonical: string;
  receipt: Record<string, unknown>;
  receipt_signature: string;
}

export interface PersistTtsParams {
  escrow_ref: string;
  posted_at: number;
  capability_id: string;
  supplier_pkh: string;
  model: string;
  payment_lovelace: string;
  /** The TTS request envelope `{text, voice, format, speed}`. */
  request_envelope: unknown;
  /** Raw audio bytes — exactly the same buffer the supplier hashed. */
  response_audio: Uint8Array;
  /** From the upstream Piper response, e.g. "audio/mpeg". */
  response_content_type: string;
  receipt: Record<string, unknown>;
  receipt_signature: string;
}

export class ResponseArchive {
  private readonly db: BetterDatabase;
  private readonly archiveDir: string;
  private readonly insertStmt;
  private readonly listStmt;
  private readonly getStmt;

  constructor(archiveDir: string) {
    this.archiveDir = resolve(archiveDir);
    mkdirSync(this.archiveDir, { recursive: true });
    const dbPath = join(this.archiveDir, "archive.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CREATE_TABLES_SQL);

    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO responses (
        escrow_ref, posted_at, completed_at, capability_id, supplier_pkh,
        model, payment_lovelace, request_filename, response_filename,
        response_content_type, response_byte_length, receipt_json, receipt_signature
      ) VALUES (
        @escrow_ref, @posted_at, @completed_at, @capability_id, @supplier_pkh,
        @model, @payment_lovelace, @request_filename, @response_filename,
        @response_content_type, @response_byte_length, @receipt_json, @receipt_signature
      )
    `);

    this.listStmt = this.db.prepare(`
      SELECT * FROM responses
      ORDER BY completed_at DESC
      LIMIT @limit
    `);

    this.getStmt = this.db.prepare(`SELECT * FROM responses WHERE escrow_ref = @escrow_ref`);
  }

  /** Resolve the per-escrow artefact directory; create it if missing. */
  private artefactDir(escrow_ref: string): string {
    const dir = join(this.archiveDir, escrowRefToDir(escrow_ref));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Persist a completed chat lifecycle. Idempotent on escrow_ref. */
  persistChat(p: PersistChatParams): ArchiveRow {
    const dir = this.artefactDir(p.escrow_ref);
    const requestFilename = "request.json";
    const responseFilename = "response.json";

    writeFileSync(
      join(dir, requestFilename),
      JSON.stringify({ messages: p.request_messages }, null, 2),
      "utf8",
    );
    // Store the EXACT canonical bytes the supplier hashed for response_hash —
    // not pretty-printed JSON. This is what verification reads back.
    writeFileSync(join(dir, responseFilename), p.response_canonical, "utf8");

    const responseBytes = Buffer.byteLength(p.response_canonical, "utf8");
    const row: ArchiveRow = {
      escrow_ref: p.escrow_ref,
      posted_at: p.posted_at,
      completed_at: Date.now(),
      capability_id: p.capability_id,
      supplier_pkh: p.supplier_pkh,
      model: p.model,
      payment_lovelace: p.payment_lovelace,
      request_filename: requestFilename,
      response_filename: responseFilename,
      response_content_type: "application/json",
      response_byte_length: responseBytes,
      receipt_json: JSON.stringify(p.receipt),
      receipt_signature: p.receipt_signature,
    };
    this.insertStmt.run(row as unknown as Record<string, unknown>);
    return row;
  }

  /** Persist a completed TTS lifecycle. Idempotent on escrow_ref. */
  persistTts(p: PersistTtsParams): ArchiveRow {
    const dir = this.artefactDir(p.escrow_ref);
    const ext = extFromContentType(p.response_content_type);
    const requestFilename = "request.json";
    const responseFilename = `response.${ext}`;

    writeFileSync(
      join(dir, requestFilename),
      JSON.stringify(p.request_envelope, null, 2),
      "utf8",
    );
    writeFileSync(join(dir, responseFilename), p.response_audio);

    const row: ArchiveRow = {
      escrow_ref: p.escrow_ref,
      posted_at: p.posted_at,
      completed_at: Date.now(),
      capability_id: p.capability_id,
      supplier_pkh: p.supplier_pkh,
      model: p.model,
      payment_lovelace: p.payment_lovelace,
      request_filename: requestFilename,
      response_filename: responseFilename,
      response_content_type: p.response_content_type,
      response_byte_length: p.response_audio.byteLength,
      receipt_json: JSON.stringify(p.receipt),
      receipt_signature: p.receipt_signature,
    };
    this.insertStmt.run(row as unknown as Record<string, unknown>);
    return row;
  }

  /** Most recent first; bounded so the SPA's history page stays light. */
  list(limit = 100): ArchiveRow[] {
    return this.listStmt.all({ limit }) as ArchiveRow[];
  }

  /** Single-row lookup by canonical "<txhash>#<index>" key. */
  get(escrow_ref: string): ArchiveRow | null {
    return (this.getStmt.get({ escrow_ref }) as ArchiveRow | undefined) ?? null;
  }

  /** Read the request artefact bytes (always JSON, always small). */
  readRequest(escrow_ref: string): Buffer | null {
    const row = this.get(escrow_ref);
    if (!row) return null;
    const path = join(this.archiveDir, escrowRefToDir(escrow_ref), row.request_filename);
    return existsSync(path) ? readFileSync(path) : null;
  }

  /** Read the response artefact bytes (text for chat, audio for TTS). */
  readResponse(escrow_ref: string): { bytes: Buffer; contentType: string; filename: string } | null {
    const row = this.get(escrow_ref);
    if (!row) return null;
    const path = join(this.archiveDir, escrowRefToDir(escrow_ref), row.response_filename);
    if (!existsSync(path)) return null;
    return {
      bytes: readFileSync(path),
      contentType: row.response_content_type,
      filename: row.response_filename,
    };
  }

  close(): void {
    this.db.close();
  }
}
