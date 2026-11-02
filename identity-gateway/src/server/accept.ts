// Content negotiation of the HTTPS binding (Part 1 Section 7.4). The Accept header is read as
// RFC 9110 specifies (https://www.rfc-editor.org/rfc/rfc9110#section-12.5.1): media ranges with
// parameters and weights, where the most specific range that matches a media type gives the weight of
// that type. As Part 1 Section 7.4 says, ranges with q=0 and ranges with a malformed weight are
// ignored, and only the parameters q and profile count.
//
// The resolver sends one media type for each representation: application/did-resolution for the
// result and application/did for the document. Wildcard ranges (*/*, application/*) weigh these two
// types only, so a more specific range for one of them overrides them. The other names of the Part 1
// table select their representation when a range names them exactly. The weight of a representation
// is the highest of these; the higher weight wins, and on a tie the resolution result wins.

export type Representation = "result" | "document";

export const RESOLUTION_MEDIA_TYPE = "application/did-resolution";
const RESOLUTION_PROFILE = "https://w3id.org/did-resolution";

interface MediaType {
  readonly type: string;
  readonly subtype: string;
}

/** The media type that each representation is sent as, and its other names (Part 1 Section 7.4 table). */
const REPRESENTATIONS: ReadonlyArray<{ readonly representation: Representation; readonly sent: MediaType; readonly names: readonly string[] }> = [
  { representation: "result", sent: { type: "application", subtype: "did-resolution" }, names: [`application/ld+json;profile=${RESOLUTION_PROFILE}`] },
  {
    representation: "document",
    sent: { type: "application", subtype: "did" },
    names: ["application/did+json", "application/did+ld+json", "application/ld+json", "application/json"],
  },
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

/** How specifically a range matches a sent media type: 2 exact, 1 `type/*`, 0 `*\/*`; -1 no match. */
function specificity(range: MediaRange, sent: MediaType): number {
  if (range.type === "*") return range.subtype === "*" ? 0 : -1;
  if (range.type !== sent.type) return -1;
  if (range.subtype === "*") return 1;
  return range.subtype === sent.subtype ? 2 : -1;
}

/** A range that names another name of a representation exactly. application/ld+json names the result only with the resolution profile, and the document only without a profile. */
function names(range: MediaRange, name: string): boolean {
  const [typeAndSubtype, profile] = name.split(";profile=");
  if (`${range.type}/${range.subtype}` !== typeAndSubtype) return false;
  return profile === undefined ? range.profiles === null : (range.profiles?.includes(profile) ?? false);
}

/** The representation for an Accept header, or null when no supported media range is acceptable. */
export function negotiate(accept: string | undefined): Representation | null {
  if (accept === undefined || accept.trim() === "") return "result";
  const ranges = split(accept, ",")
    .map((text) => parseRange(text.trim()))
    .filter((range): range is MediaRange => range !== null && range.q > 0);
  const weight: Record<Representation, number> = { result: 0, document: 0 };
  for (const { representation, sent, names: others } of REPRESENTATIONS) {
    // The sent type: the weight of its most specific range (the highest weight among equally specific ones).
    let best = -1;
    let q = 0;
    for (const range of ranges) {
      const s = specificity(range, sent);
      if (s > best) [best, q] = [s, range.q];
      else if (s === best && s >= 0) q = Math.max(q, range.q);
    }
    for (const range of ranges) if (others.some((name) => names(range, name))) q = Math.max(q, range.q);
    weight[representation] = q;
  }
  if (weight.result === 0 && weight.document === 0) return null;
  return weight.document > weight.result ? "document" : "result";
}
