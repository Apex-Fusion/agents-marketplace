/**
 * indexer/src/documents/document.ts — documents on chain (jury SPEC §10.1, §10.2).
 *
 * A transaction carries at most one document, as metadata under label 22084:
 *
 *   { "v": 1, "t": <document type>, "m": <media type>, "d": [<text chunk>, ...] }
 *
 * The document is the concatenation of the UTF-8 bytes of the chunks, and its
 * hash is blake2b-256 of those bytes. Reader rules (§10.1): the value is a
 * document only when `v` is the integer 1, `t`, `m` and every chunk are texts,
 * no chunk is longer than 64 bytes, and no chunk, `t` or `m` starts with "0x"
 * (some chain indexers show byte strings as 0x… text). Other keys of the map
 * are ignored. §10.1 is silent about a key that occurs twice. The reference
 * reader (vector_jury documents.py) reads the map into a dictionary, so the
 * last value of a key counts. This reader does the same: both read the same
 * document bytes.
 *
 * URI of a document: `vector-tx:` followed by the unpadded base64url of the
 * 32-byte transaction id (43 characters).
 */

import { blake2b256Hex } from "@marketplace/shared";
import type { Metadatum } from "../follower/types.js";

export const DOCUMENT_LABEL = "22084";
export const VECTOR_TX_PREFIX = "vector-tx:";

const MAX_CHUNK_BYTES = 64;
const TX_ID_RE = /^[0-9a-f]{64}$/;
const BASE64URL_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedDocument {
  /** `t`: the document type, for example "juror-record". */
  type: string;
  /** `m`: the media type, for example "application/json". */
  mediaType: string;
  /** The joined chunks: the exact document bytes. */
  bytes: Uint8Array;
  /** blake2b-256 of `bytes` (64 lowercase hex). */
  hash: string;
}

export type DocumentParse = { ok: true; document: ParsedDocument } | { ok: false; reason: string };

const textEncoder = new TextEncoder();

/** The document in a label 22084 value, or the reason why the value is not one. */
export function parseDocument(value: Metadatum): DocumentParse {
  if (value.kind !== "map") return { ok: false, reason: "the value is not a map" };
  // A key that occurs twice: the last value counts (Map.set replaces the earlier value).
  const fields = new Map<string, Metadatum>();
  for (const [key, item] of value.entries) {
    if (key.kind === "text") fields.set(key.value, item);
  }
  const v = fields.get("v");
  if (v?.kind !== "int" || v.value !== 1n) return { ok: false, reason: "v is not 1" };
  const t = fields.get("t");
  if (t?.kind !== "text" || t.value.startsWith("0x")) return { ok: false, reason: 't is not a text or starts with "0x"' };
  const m = fields.get("m");
  if (m?.kind !== "text" || m.value.startsWith("0x")) return { ok: false, reason: 'm is not a text or starts with "0x"' };
  const d = fields.get("d");
  if (d?.kind !== "list") return { ok: false, reason: "d is not a list" };

  const chunks: Uint8Array[] = [];
  let length = 0;
  for (const [i, chunk] of d.items.entries()) {
    if (chunk.kind !== "text") return { ok: false, reason: `chunk ${i} is not a text` };
    if (chunk.value.startsWith("0x")) return { ok: false, reason: `chunk ${i} starts with "0x"` };
    const bytes = textEncoder.encode(chunk.value);
    if (bytes.length > MAX_CHUNK_BYTES) return { ok: false, reason: `chunk ${i} is longer than ${MAX_CHUNK_BYTES} bytes` };
    chunks.push(bytes);
    length += bytes.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, document: { type: t.value, mediaType: m.value, bytes, hash: blake2b256Hex(bytes) } };
}

/** `vector-tx:` URI of a transaction id (64 hex). */
export function vectorTxUri(txId: string): string {
  if (!TX_ID_RE.test(txId)) throw new Error("vectorTxUri: the transaction id must be 64 lowercase hexadecimal characters");
  return VECTOR_TX_PREFIX + Buffer.from(txId, "hex").toString("base64url");
}

/** The transaction id (64 lowercase hex) of a `vector-tx:` URI; null for any other text. */
export function txIdFromVectorTxUri(uri: string): string | null {
  if (!uri.startsWith(VECTOR_TX_PREFIX)) return null;
  const encoded = uri.slice(VECTOR_TX_PREFIX.length);
  if (!BASE64URL_ID_RE.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64url");
  // The last character carries 2 unused bits; a canonical URI has them at zero.
  if (bytes.length !== 32 || bytes.toString("base64url") !== encoded) return null;
  return bytes.toString("hex");
}

/** A captured document, as the views show it (no bytes). */
export interface DocumentRef {
  tx: string;
  type: string;
  media_type: string;
  /** blake2b-256 of the document bytes. */
  hash: string;
  size: number;
  /** `hash` equals the hash on chain that names the document. */
  matches: boolean;
}

/** A captured document (a documents row, with or without its bytes) and the hash on chain that names it. */
export function documentRef(
  doc: { tx_hash: string; type: string; media_type: string; hash: string; size?: number; bytes?: Uint8Array },
  expectedHash: string | null,
): DocumentRef {
  return {
    tx: doc.tx_hash,
    type: doc.type,
    media_type: doc.media_type,
    hash: doc.hash,
    size: doc.size ?? doc.bytes?.length ?? 0,
    matches: expectedHash !== null && doc.hash === expectedHash.toLowerCase(),
  };
}

/** A `vector-tx:` URI on chain and the document that the indexer captured from its transaction. */
export interface VectorTxDocument {
  uri: string;
  /** The transaction id in the URI; null when the URI does not decode. */
  tx: string | null;
  /** null: the transaction carries no document, or the indexer has not seen it. */
  captured: DocumentRef | null;
}
