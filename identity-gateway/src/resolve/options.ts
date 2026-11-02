// Resolution options (Part 1 Section 7.1 step 2). An option that is not in the table gives
// FEATURE_NOT_SUPPORTED. Then an invalid value, a repeated option, or both versionId and
// versionTime give INVALID_OPTIONS. The media type comes only from the Accept header.

import { ResolutionError } from "./errors.js";
import { parseVersionTime } from "./time.js";

export interface ResolutionOptions {
  readonly versionId: bigint | null;
  /** The requested time, POSIX milliseconds. */
  readonly versionTime: number | null;
  readonly expandRelativeUrls: boolean;
  /** No effect: a result depends only on the ledger tip. */
  readonly noCache: boolean;
}

/** Query parameters as name/value pairs (repeats allowed, for example URLSearchParams), or a plain record. */
export type ResolutionOptionsInput = Iterable<readonly [string, string]> | Readonly<Record<string, string>>;

export const NO_OPTIONS: ResolutionOptions = { versionId: null, versionTime: null, expandRelativeUrls: false, noCache: false };

const OPTION_NAMES: Record<string, true> = { versionId: true, versionTime: true, expandRelativeUrls: true, noCache: true };
const VERSION_ID = /^(?:0|[1-9][0-9]*)$/;

function flag(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ResolutionError("INVALID_OPTIONS", `Invalid options: ${name} must be true or false`);
}

export function parseResolutionOptions(input: ResolutionOptionsInput = {}): ResolutionOptions {
  const pairs: Array<readonly [string, string]> = Symbol.iterator in input ? [...input] : Object.entries(input);
  const unsupported = pairs.find(([name]) => !Object.hasOwn(OPTION_NAMES, name));
  if (unsupported) throw new ResolutionError("FEATURE_NOT_SUPPORTED", `Resolution option not supported: ${unsupported[0]}`);

  const values = new Map<string, string>();
  for (const [name, value] of pairs) {
    if (values.has(name)) throw new ResolutionError("INVALID_OPTIONS", `Invalid options: ${name} is repeated`);
    values.set(name, value);
  }
  const versionIdText = values.get("versionId");
  const versionTimeText = values.get("versionTime");
  if (versionIdText !== undefined && versionTimeText !== undefined) {
    throw new ResolutionError("INVALID_OPTIONS", "Invalid options: versionId and versionTime exclude each other");
  }
  if (versionIdText !== undefined && !VERSION_ID.test(versionIdText)) {
    throw new ResolutionError("INVALID_OPTIONS", "Invalid options: versionId is 0 or a decimal number without leading zeros");
  }
  const versionTime = versionTimeText === undefined ? null : parseVersionTime(versionTimeText);
  if (versionTimeText !== undefined && versionTime === null) {
    throw new ResolutionError("INVALID_OPTIONS", "Invalid options: versionTime is YYYY-MM-DDThh:mm:ssZ with a real date and time");
  }
  const expand = values.get("expandRelativeUrls");
  const noCache = values.get("noCache");
  return {
    versionId: versionIdText === undefined ? null : BigInt(versionIdText),
    versionTime,
    expandRelativeUrls: expand === undefined ? false : flag("expandRelativeUrls", expand),
    noCache: noCache === undefined ? false : flag("noCache", noCache),
  };
}
