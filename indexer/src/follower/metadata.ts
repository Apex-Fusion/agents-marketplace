/**
 * indexer/src/follower/metadata.ts — Ogmios v6 transaction metadata → Metadatum.
 *
 * Ogmios v6 sends `tx.metadata = { hash, labels: { "<label>": { json?, cbor? } } }`
 * (server/src/Ogmios/Data/Json/Shelley.hs, `encodeMetadata`, v6.14.0):
 *   - Without `--metadata-detailed-schema`, `json` is the value as plain JSON:
 *     an integer is a number, a text is a string, a list is an array and a map
 *     is an object (an integer key becomes its decimal text).
 *   - A value with a byte string, or a map with a key that is not an integer
 *     or a text, has no plain JSON form. Ogmios then sends `cbor` (base16) and
 *     no `json`. With `--include-metadata-cbor` it always sends `cbor`.
 *
 * The converter prefers `cbor`, because it holds the exact value. From `json`,
 * each string is a text and each object key is a text key; a number that is
 * not a safe integer lost its precision in JSON.parse, so its label is left
 * out. A label that does not convert is logged and left out: the converter
 * never throws.
 */

import { readCbor, type CborItem } from "@marketplace/shared";
import type { Metadatum } from "./types.js";

/** Nesting limit of a JSON value (the CBOR reader has its own limit). */
const MAX_DEPTH = 256;
const HEX_RE = /^(?:[0-9a-f]{2})*$/;
const LABEL_RE = /^(?:0|[1-9][0-9]*)$/;

function fromJson(value: unknown, depth: number): Metadatum | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return { kind: "text", value };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { kind: "int", value: BigInt(value) } : null;
  if (Array.isArray(value)) {
    const items: Metadatum[] = [];
    for (const item of value) {
      const converted = fromJson(item, depth + 1);
      if (!converted) return null;
      items.push(converted);
    }
    return { kind: "list", items };
  }
  if (typeof value === "object" && value !== null) {
    const entries: Array<[Metadatum, Metadatum]> = [];
    for (const [key, item] of Object.entries(value)) {
      const converted = fromJson(item, depth + 1);
      if (!converted) return null;
      entries.push([{ kind: "text", value: key }, converted]);
    }
    return { kind: "map", entries };
  }
  return null;
}

/** A metadatum from Ogmios `json`; null when the value is not metadata or lost precision. */
export function metadatumFromJson(value: unknown): Metadatum | null {
  return fromJson(value, 0);
}

function bigNumber(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function fromCbor(item: CborItem): Metadatum | null {
  switch (item.kind) {
    case "uint":
    case "nint":
      return { kind: "int", value: item.value };
    case "bytes":
      return { kind: "bytes", hex: Buffer.from(item.value).toString("hex") };
    case "text":
      return { kind: "text", value: item.value };
    case "array": {
      const items: Metadatum[] = [];
      for (const child of item.items) {
        const converted = fromCbor(child);
        if (!converted) return null;
        items.push(converted);
      }
      return { kind: "list", items };
    }
    case "map": {
      const entries: Array<[Metadatum, Metadatum]> = [];
      for (const [key, child] of item.entries) {
        const k = fromCbor(key);
        const v = fromCbor(child);
        if (!k || !v) return null;
        entries.push([k, v]);
      }
      return { kind: "map", entries };
    }
    case "tag":
      // Big integers (RFC 8949 §3.4.3): tag 2 is n, tag 3 is -1 - n.
      if ((item.tag === 2n || item.tag === 3n) && item.item.kind === "bytes") {
        const n = bigNumber(item.item.value);
        return { kind: "int", value: item.tag === 2n ? n : -1n - n };
      }
      return null;
    default:
      return null;
  }
}

/** A metadatum from Ogmios `cbor` (base16); null when it is not exactly one metadatum. */
export function metadatumFromCbor(hex: string): Metadatum | null {
  const lower = hex.toLowerCase();
  if (!HEX_RE.test(lower)) return null;
  try {
    return fromCbor(readCbor(Uint8Array.from(Buffer.from(lower, "hex"))));
  } catch {
    return null;
  }
}

/** One label value of Ogmios `metadata.labels`: `{ cbor }` first, then `{ json }`. */
export function metadatumFromOgmios(entry: unknown): Metadatum | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { cbor, json } = entry as { cbor?: unknown; json?: unknown };
  if (typeof cbor === "string") {
    const converted = metadatumFromCbor(cbor);
    if (converted) return converted;
  }
  return json === undefined ? null : metadatumFromJson(json);
}

/** The metadata of an Ogmios v6 transaction by label; undefined when it has none. */
export function metadataFromOgmios(raw: unknown, txId: string): Record<string, Metadatum> | undefined {
  const labels = (raw as { labels?: unknown } | null | undefined)?.labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return undefined;
  const out: Record<string, Metadatum> = {};
  for (const [label, entry] of Object.entries(labels)) {
    const value = LABEL_RE.test(label) ? metadatumFromOgmios(entry) : null;
    if (value) out[label] = value;
    else console.warn(`[ogmiosBlock] tx ${txId}: metadata label ${label} is not transaction metadata; left out`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
