// Content negotiation of the HTTPS binding (Part 1 Section 7.4). The Accept header is read as
// RFC 9110 specifies: media ranges with parameters and weights. Ranges with q=0, and ranges with a
// malformed weight, are ignored. The representation with the highest q wins; on a tie, the
// resolution result wins.

export type Representation = "result" | "document";

export const RESOLUTION_MEDIA_TYPE = "application/did-resolution";
const RESOLUTION_PROFILE = "https://w3id.org/did-resolution";

/** The media types offered, with the representation each one selects. */
const OFFERED: ReadonlyArray<{ type: string; profile?: string; representation: Representation }> = [
  { type: RESOLUTION_MEDIA_TYPE, representation: "result" },
  { type: "application/ld+json", profile: RESOLUTION_PROFILE, representation: "result" },
  { type: "application/did", representation: "document" },
  { type: "application/did+json", representation: "document" },
  { type: "application/did+ld+json", representation: "document" },
  { type: "application/ld+json", representation: "document" },
  { type: "application/json", representation: "document" },
];

const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** Splits on `separator` outside double-quoted strings. */
function split(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quoted) {
      current += c + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === separator && !quoted) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts;
}

interface MediaRange {
  readonly type: string;
  readonly subtype: string;
  readonly profiles: readonly string[] | null;
  readonly q: number;
}

function parseRange(text: string): MediaRange | null {
  const [mediaType = "", ...params] = split(text, ";").map((s) => s.trim());
  const m = /^([a-z0-9!#$%&'*+.^_`|~-]+)\/([a-z0-9!#$%&'*+.^_`|~-]+)$/i.exec(mediaType);
  if (!m) return null;
  let q = 1;
  let profiles: string[] | null = null;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq < 0) continue;
    const name = param.slice(0, eq).trim().toLowerCase();
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    if (name === "q") {
      if (!QVALUE.test(value)) return null;
      q = Number(value);
    } else if (name === "profile") profiles = value.split(/\s+/).filter(Boolean);
  }
  return { type: m[1]!.toLowerCase(), subtype: m[2]!.toLowerCase(), profiles, q };
}

function matches(range: MediaRange, offered: (typeof OFFERED)[number]): boolean {
  const [type, subtype] = offered.type.split("/");
  if (range.type === "*") return range.subtype === "*";
  if (range.type !== type) return false;
  if (range.subtype === "*") return true;
  if (range.subtype !== subtype) return false;
  // application/ld+json: the resolution profile selects the result, no profile the document.
  if (offered.type === "application/ld+json") {
    return offered.profile ? (range.profiles?.includes(offered.profile) ?? false) : range.profiles === null;
  }
  return true;
}

/** The representation for an Accept header, or null when no supported media range is acceptable. */
export function negotiate(accept: string | undefined): Representation | null {
  if (accept === undefined || accept.trim() === "") return "result";
  const best: Record<Representation, number> = { result: 0, document: 0 };
  for (const text of split(accept, ",")) {
    const range = parseRange(text.trim());
    if (!range || range.q === 0) continue;
    for (const offered of OFFERED) {
      if (matches(range, offered)) best[offered.representation] = Math.max(best[offered.representation], range.q);
    }
  }
  if (best.result === 0 && best.document === 0) return null;
  return best.document > best.result ? "document" : "result";
}
