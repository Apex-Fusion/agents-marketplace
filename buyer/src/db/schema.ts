/**
 * buyer/src/db/schema.ts — schema for the buyer-app's response archive.
 *
 * Persists every completed lifecycle (chat or TTS) so the buyer has an
 * off-chain audit trail to pair with the on-chain receipt commitment.
 *
 * The actual artefacts (the assistant message JSON for chat, the audio
 * bytes for TTS, the request envelope) live as files under ARCHIVE_DIR;
 * this DB only stores metadata + the receipt.
 *
 * Verification flow per record (for disputes):
 *   1. Read response file → bytes B
 *   2. Confirm sha256(B-or-canonical(B)) === receipt.response_hash
 *   3. Verify Ed25519(receipt_json, supplier_pkh.pubkey) === receipt_signature
 *   4. Confirm receipt's escrow_ref's Submit tx on chain commits to
 *      sha256(canonical(receipt_json))
 *
 * If all four match, the record is genuine and immutable. If any disagrees,
 * either the buyer or supplier is lying about what was delivered.
 */

export const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS responses (
    -- "<txhash>#<index>" of the original PostEscrow output. Same key the
    -- on-chain lifecycle and the indexer use, so cross-referencing is trivial.
    escrow_ref TEXT PRIMARY KEY,

    posted_at INTEGER NOT NULL,                -- POSIX ms (escrow datum)
    completed_at INTEGER NOT NULL,             -- POSIX ms (server.ts persist time)
    capability_id TEXT NOT NULL,               -- "llm.text.generate.v1" | "audio.synthesize.piper.v1"
    supplier_pkh TEXT NOT NULL,                -- 28-byte hex
    model TEXT NOT NULL,                       -- as advertised on chain
    payment_lovelace TEXT NOT NULL,            -- string-encoded bigint

    -- Filesystem references — relative to ARCHIVE_DIR/<escrow_ref_safe>/.
    -- escrow_ref_safe replaces "#" with "_" so the dir name is a single
    -- valid path segment.
    request_filename TEXT NOT NULL,            -- e.g. "request.json"
    response_filename TEXT NOT NULL,           -- e.g. "response.txt" or "response.mp3"
    response_content_type TEXT NOT NULL,       -- "text/plain" | "audio/mpeg" | …
    response_byte_length INTEGER NOT NULL,

    -- The canonical receipt + signature, exactly as delivered by the supplier.
    -- receipt_json is the JSON-stringified canonical form (same bytes the
    -- supplier hashed to produce the result_receipt_hash committed on chain).
    receipt_json TEXT NOT NULL,
    receipt_signature TEXT NOT NULL            -- 128-char Ed25519 hex
  );

  CREATE INDEX IF NOT EXISTS idx_responses_completed ON responses(completed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_responses_capability ON responses(capability_id);
  CREATE INDEX IF NOT EXISTS idx_responses_supplier ON responses(supplier_pkh);
`;
