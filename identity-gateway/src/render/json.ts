// JSON bodies of the renderings: JCS (RFC 8785) member order, so that a body is the same for the same
// input. A bigint is written as an integer of any size (the ERC-8004 agentId is a 256-bit integer);
// JSON allows it (RFC 8259 Section 6), although I-JSON readers lose precision above 2^53.

import { canonicalize } from "../resolve/jcs.js";

export function renderJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(renderJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${canonicalize(k)}:${renderJson(v)}`).join(",")}}`;
  }
  return canonicalize(value);
}
