// The members `revocationBounds` and `escrowBound` of GET /policy (Part 2 Section 8.4).
//
// `revocationBounds` gives, for each way to cut the authority of an agent (a path), how long each
// surface needs to apply the cut. A cell holds the bound as text and as a number of seconds with its
// formula. A formula is a text over the names in `terms`, and `evaluateFormula` computes the number
// from that text, so the text and the number cannot differ. The text of a cell takes its numbers from
// the same terms. The terms come from the settings in force (RenderConfig, the status-list settings of
// the M4 services) and from the fixed values of the services (the confirmations, the lives of tokens,
// credentials and SVIDs). A planning value is neither a setting nor a guarantee: `terms` says so.
// Nothing here is measured while the gateway runs.
//
// The matrix of paths and surfaces comes from the code of the resolver, the status lists, the token
// service, the credential, the SPIFFE service, the scan, the indexer and the contracts.

import { MAX_TOKEN_LIFETIME_S } from "../m4/context.js";
import { CREDENTIAL_VALIDITY_MS } from "../m4/credential.js";
import { X509_SVID_LIFETIME_MS } from "../m4/spiffe.js";
import { DEFAULT_BACKGROUND_REFRESH_MS, DEFAULT_FOLLOW_MS, REFRESH_TICK_MS } from "../m4/status-lists.js";
import { CONFIRMATION_DEPTH } from "../resolve/settings.js";
import type { RenderConfig } from "./config.js";

// ── Planning values: not settings, not guarantees ──

/** The time of one follow step of the status lists while no full build runs (a step makes 5 requests to the ledger source). */
const STEP_SECONDS = 1;
/** The time of one follow step while a full build runs: the build and the step share one request limit, so the step waits. */
const STEP_SECONDS_DURING_BUILD = 6;
/** The longest full build of the status lists that was measured on the live gateway. A build reads every record, so its time grows with the number of records. */
const BUILD_SECONDS = 474;
/** The mean time between two blocks and the time that 9 of 10 blocks do not exceed, from samples of blocks of the Vector mainnet. */
const BLOCK_SECONDS_MEAN = 3.88;
const BLOCK_SECONDS_P90 = 8;
/** An X.509-SVID starts this long before its issue (BACKDATE_MS in m4/spiffe.ts), and its life counts from its start. */
const X509_SVID_BACKDATE_SECONDS = 60;
/**
 * The defaults of the indexer: DEFAULT_REFRESH_MS, TICK_MS and SETTLE_MS in indexer/src/identity/refresher.ts, and
 * IDENTITY_RESULT_MAX_AGE_MS in indexer/src/listing/rule.ts. The gateway cannot read the settings of the indexer.
 */
const INDEXER = { rereadSeconds: 60, tickSeconds: 5, settleSeconds: 20, answerMaxSeconds: 600 } as const;

// ── Types ──

export const SURFACES = [
  "contracts",
  "resolver",
  "statusLists",
  "introspection",
  "accessTokenLocal",
  "credential",
  "x509Svid",
  "jwtSvid",
  "catalogs",
  "marketplaceListing",
] as const;
export type Surface = (typeof SURFACES)[number];

export const PATHS = ["controllerSuspend", "partySuspend", "holdLift", "revoke", "retire", "keyRemoval", "undelegate", "module1Hold"] as const;
export type Path = (typeof PATHS)[number];

export type Effect = "applies" | "partial" | "none" | "notOffered";

export interface BoundCell {
  readonly effect: Effect;
  /** The bound as text. */
  readonly bound: string;
  /** The longest time in seconds, or null when the path does not touch the surface or when no setting fixes a term. */
  readonly seconds: number | null;
  /** How `seconds` follows from the terms. Null when `seconds` is 0 or null without a formula. */
  readonly formula: string | null;
}

export type TermKind = "setting" | "limit" | "planning value" | "indexer default" | "not fixed";

export interface Term {
  /** Null for a term that no setting fixes. */
  readonly value: number | null;
  readonly kind: TermKind;
  readonly meaning: string;
}

export interface PathBounds {
  readonly description: string;
  readonly startEvent: string;
  readonly surfaces: Readonly<Record<Surface, BoundCell>>;
}

export interface RevocationBounds {
  readonly about: string;
  readonly startEvent: string;
  readonly assumptions: readonly string[];
  readonly notCounted: readonly string[];
  readonly computed: string;
  readonly effects: Readonly<Record<Effect, string>>;
  readonly terms: Readonly<Record<string, Term>>;
  readonly surfaces: Readonly<Record<Surface, string>>;
  readonly paths: Readonly<Record<Path, PathBounds>>;
}

type Terms = Readonly<Record<string, Term>>;
type Cells = Record<Surface, BoundCell>;

// ── Formulas ──

/**
 * The number of a formula: names of terms, whole or decimal numbers, `+ - * /` and parentheses. A term
 * without a value gives null (no setting fixes it). A name that no term has is an error in the code.
 * `rounding` "up" gives a bound (whole seconds, not less than the exact value). "nearest" gives a
 * typical value.
 */
export function evaluateFormula(formula: string, terms: Terms, rounding: "up" | "nearest" = "up"): number | null {
  const tokens = formula.match(/[A-Za-z][A-Za-z0-9]*|\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  if (tokens.join("") !== formula.replace(/\s+/g, "")) throw new Error(`the formula "${formula}" has a character that it may not have`);
  let at = 0;
  let unknown = false;
  const next = (): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`the formula "${formula}" ends too early`);
    return token;
  };
  const factor = (): number => {
    const token = next();
    if (token === "(") {
      const inner = sum();
      if (next() !== ")") throw new Error(`the formula "${formula}" has a parenthesis that does not close`);
      return inner;
    }
    if (/^\d/.test(token)) return Number(token);
    if (/^[A-Za-z]/.test(token)) {
      const term = terms[token];
      if (term === undefined) throw new Error(`the formula "${formula}" names the term ${token}, which does not exist`);
      if (term.value === null) {
        unknown = true;
        return 0;
      }
      return term.value;
    }
    throw new Error(`the formula "${formula}" has "${token}" where a value belongs`);
  };
  const product = (): number => {
    let value = factor();
    while (tokens[at] === "*" || tokens[at] === "/") value = next() === "*" ? value * factor() : value / factor();
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[at] === "+" || tokens[at] === "-") value = next() === "+" ? value + product() : value - product();
    return value;
  };
  const value = sum();
  if (at !== tokens.length) throw new Error(`the formula "${formula}" has "${tokens[at]}" after its end`);
  if (unknown) return null;
  // The epsilon keeps a sum of decimals that is a whole number in exact arithmetic from rounding up to the next second.
  return rounding === "up" ? Math.ceil(value - 1e-9) : Math.round(value);
}

/** The formulas that more than one cell uses. */
const F = {
  /** The time that the resolver needs to show a change that does not reduce what a record allows (a planning value). */
  confirmations: "confirmations * blockSecondsP90",
  confirmationsTypical: "confirmations * blockSecondsMean",
  /** A change shows in a list: the next follow step after the block, while a full build runs. */
  set: "followSeconds + stepSecondsDuringBuild",
  setIdle: "followSeconds + stepSeconds",
  setTypical: "followSeconds / 2 + stepSeconds",
  /** A change that needs the confirmations shows in a list. */
  final: "confirmations * blockSecondsP90 + followSeconds + stepSecondsDuringBuild",
  finalTypical: "confirmations * blockSecondsMean + followSeconds / 2 + stepSeconds",
  /** A hold ends by time: the first block with a block time at or after its end time, then a step. */
  endByTime: "blockSecondsP90 + followSeconds + stepSecondsDuringBuild",
  /** The same without follow steps: two full builds, the build interval and one tick of the timer. */
  build: "2 * buildSeconds + buildIntervalSeconds + timerTickSeconds",
  buildFinal: "confirmations * blockSecondsP90 + 2 * buildSeconds + buildIntervalSeconds + timerTickSeconds",
  /** The records no longer fit the lists: the repair build follows the next step and lasts one build (no build runs), or it follows the running build and the next step and lasts one more build. */
  repairIdle: "followSeconds + stepSeconds + buildSeconds",
  repairBusy: "2 * buildSeconds + followSeconds + stepSecondsDuringBuild",
  /** A failed repair build adds its own run time (at most one full build) and then one refresh interval before the next try. */
  repairFailed: "buildSeconds + refreshSeconds",
  /** The catalogs: two scans and the scan interval. */
  scan: "2 * scanSeconds + scanIntervalSeconds",
  scanFinal: "confirmations * blockSecondsP90 + 2 * scanSeconds + scanIntervalSeconds",
  /** The marketplace listing after a lift: the resolver, then the next re-read of the indexer. */
  listingFinal: "confirmations * blockSecondsP90 + indexerRereadSeconds + indexerTickSeconds",
} as const;

// ── Terms ──

function termsOf(config: RenderConfig): Record<string, Term> {
  const m4 = config.m4 ?? null;
  const seconds = (ms: number | undefined): number | null => (m4 === null || ms === undefined ? null : ms / 1000);
  const x509Seconds = X509_SVID_LIFETIME_MS / 1000 - X509_SVID_BACKDATE_SECONDS;
  return {
    followSeconds: {
      value: seconds(m4?.statusListFollowMs ?? DEFAULT_FOLLOW_MS),
      kind: "setting",
      meaning: "How often the gateway reads the changes of the chain into the status lists (STATUS_LIST_FOLLOW_SECONDS). The value 0 means never.",
    },
    stepSeconds: {
      value: STEP_SECONDS,
      kind: "planning value",
      meaning: "The time of one follow step while no full build runs. A step makes 5 requests to the ledger source, and 3 more for each record that it reads again.",
    },
    stepSecondsDuringBuild: {
      value: STEP_SECONDS_DURING_BUILD,
      kind: "planning value",
      meaning: "The time of one follow step while a full build runs. The build and the step share one request limit, so the step waits.",
    },
    listCacheSeconds: {
      value: seconds(m4?.statusListRefreshMs),
      kind: "setting",
      meaning: "How long a reader can keep a status list: the max-age and the ttl of each list (STATUS_LIST_REFRESH_SECONDS, the same setting as refreshSeconds).",
    },
    refreshSeconds: {
      value: seconds(m4?.statusListRefreshMs),
      kind: "setting",
      meaning: "The least time between the starts of two full builds of the status lists, also after a failed build (STATUS_LIST_REFRESH_SECONDS).",
    },
    buildIntervalSeconds: {
      value: seconds(m4?.statusListBackgroundRefreshMs ?? DEFAULT_BACKGROUND_REFRESH_MS),
      kind: "setting",
      meaning: "How long the timer waits after a full build of the status lists before it starts the next one (STATUS_LIST_BACKGROUND_REFRESH_SECONDS).",
    },
    timerTickSeconds: {
      value: m4 === null ? null : REFRESH_TICK_MS / 1000,
      kind: "limit",
      meaning: "How often the timer checks the age of the status lists.",
    },
    buildSeconds: {
      value: m4 === null ? null : BUILD_SECONDS,
      kind: "planning value",
      meaning: `The time of one full build of the status lists: ${BUILD_SECONDS} s is the longest live build that was measured. A full build reads every record, so its time grows with the number of records. The formulas use it when the follow interval is 0 and when the lists must be repaired.`,
    },
    confirmations: {
      value: CONFIRMATION_DEPTH,
      kind: "limit",
      meaning: "The blocks that must follow the block of a change before the resolver shows a change that does not reduce what a record allows.",
    },
    blockSecondsMean: { value: BLOCK_SECONDS_MEAN, kind: "planning value", meaning: "The mean time between two blocks, from a sample of blocks of the Vector mainnet." },
    blockSecondsP90: {
      value: BLOCK_SECONDS_P90,
      kind: "planning value",
      meaning: "The time between two blocks that 9 of 10 blocks do not exceed, from the same sample. No rule fixes the time of a block, so a bound that uses it is a planning value.",
    },
    tokenSeconds: { value: m4 === null ? null : MAX_TOKEN_LIFETIME_S, kind: "limit", meaning: "The life of an access token, counted from the issue." },
    jwtSvidSeconds: { value: m4 === null ? null : MAX_TOKEN_LIFETIME_S, kind: "limit", meaning: "The life of a JWT-SVID, counted from the issue." },
    credentialSeconds: { value: m4 === null ? null : CREDENTIAL_VALIDITY_MS / 1000, kind: "limit", meaning: "The life of an identity credential, counted from the issue." },
    x509SvidSeconds: {
      value: m4 === null ? null : x509Seconds,
      kind: "limit",
      meaning: `The time from the issue to the end of an X.509-SVID. The certificate lasts ${X509_SVID_LIFETIME_MS / 1000} s from its start time, and its start time is ${X509_SVID_BACKDATE_SECONDS} s before the issue.`,
    },
    scanIntervalSeconds: {
      value: config.fetchJobs ? config.scanIntervalMs / 1000 : null,
      kind: "setting",
      meaning: "How long the background scan waits after a scan before it starts the next one (FETCH_SCAN_INTERVAL_S).",
    },
    scanSeconds: {
      value: null,
      kind: "not fixed",
      meaning: "The time of one background scan. A scan reads every record. It takes minutes and grows with the number of records. No setting fixes it.",
    },
    indexerRereadSeconds: {
      value: INDEXER.rereadSeconds,
      kind: "indexer default",
      meaning: "How often the indexer asks the gateway again about each agent that has an advert. The gateway cannot read the settings of the indexer.",
    },
    indexerTickSeconds: { value: INDEXER.tickSeconds, kind: "indexer default", meaning: "How often the indexer checks which agents are due for a new question." },
    indexerSettleSeconds: {
      value: INDEXER.settleSeconds,
      kind: "indexer default",
      meaning: "How long the indexer waits after a change of a record before it asks the gateway about the agent.",
    },
    indexerAnswerMaxSeconds: {
      value: INDEXER.answerMaxSeconds,
      kind: "indexer default",
      meaning: "How long the indexer keeps the last answer of the gateway when the gateway does not answer. After that time, it hides the adverts of the agent.",
    },
  };
}

/** The terms that exist only when the M4 services run, and the terms that exist only when the background scan runs. */
const M4_TERMS: readonly string[] = [
  "followSeconds",
  "stepSeconds",
  "stepSecondsDuringBuild",
  "listCacheSeconds",
  "refreshSeconds",
  "buildIntervalSeconds",
  "timerTickSeconds",
  "buildSeconds",
  "tokenSeconds",
  "jwtSvidSeconds",
  "credentialSeconds",
  "x509SvidSeconds",
];
const SCAN_TERMS: readonly string[] = ["scanIntervalSeconds", "scanSeconds"];

// ── Text helpers ──

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Seconds as text, with the minutes or hours when they are whole and the time is long. */
function span(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds} s (${plural(seconds / 3600, "hour")})`;
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds} s (${plural(seconds / 60, "minute")})`;
  return `${seconds} s`;
}

interface Ctx {
  readonly terms: Terms;
  /** The M4 services run. */
  readonly m4: boolean;
  /** The status lists follow the chain: the follow interval is more than 0. */
  readonly follow: boolean;
  /** The gateway issues delegation tokens. */
  readonly delegation: boolean;
  /** The background scan runs. */
  readonly jobs: boolean;
  /** The value of a term. A term without a value is an error in the code. */
  n(name: string): number;
  /** A bound: the formula rounded up. */
  up(formula: string): number | null;
  /** A typical value: the formula rounded to the nearest second. */
  near(formula: string): number;
}

interface Calc {
  readonly seconds: number | null;
  readonly formula: string | null;
}

const AT_ONCE: Calc = { seconds: 0, formula: null };
const NO_NUMBER: Calc = { seconds: null, formula: null };
const by = (c: Ctx, formula: string): Calc => ({ seconds: c.up(formula), formula });

const cell = (effect: Effect, bound: string, calc: Calc): BoundCell => ({ effect, bound, seconds: calc.seconds, formula: calc.formula });

/** The cell of a surface that this gateway does not run. */
const notOffered = (bound: string): BoundCell => cell("notOffered", bound, NO_NUMBER);
const NO_M4 = "This gateway does not run the M4 services (no key files are configured). It has no status lists, no token service, no credentials and no SVIDs.";
const NO_JOBS = "The background jobs are off (FETCH_JOBS). The gateway lists no agent in the catalogs.";

/** Makes the cell of an M4 surface, or says that the gateway does not run it. The cell is made only when the services run. */
const m4Cell = (c: Ctx, make: () => BoundCell): BoundCell => (c.m4 ? make() : notOffered(NO_M4));

// ── The cells of a path ──

/** What the status lists show of a hold: the suspension bit. */
function listsHold(c: Ctx): BoundCell {
  if (!c.follow) {
    return cell(
      "applies",
      "The lists do not follow the chain, because the follow interval is 0. Only a full build changes a list. The suspension bit is set by the first full build that starts after the block. " +
        `The bound is ${c.up(F.build)} s (computed: 2 * buildSeconds + ${c.n("buildIntervalSeconds") + c.n("timerTickSeconds")} s). ` +
        `The time of one full build, buildSeconds, is ${c.n("buildSeconds")} s: the longest build that was measured.`,
      by(c, F.build),
    );
  }
  return cell(
    "applies",
    `The suspension bit is set within ${c.up(F.set)} s (computed: the follow interval plus the time of one step while a full build runs). ` +
      `When no full build runs, it is ${c.up(F.setIdle)} s (computed). Typically ${c.near(F.setTypical)} s (computed).`,
    by(c, F.set),
  );
}

/** What the status lists show of the lift of a hold: the suspension bit clears. */
function listsLift(c: Ctx): BoundCell {
  if (!c.follow) {
    return cell(
      "applies",
      "Only a full build changes the lists, because the follow interval is 0. " +
        `The suspension bit clears in the first full build that starts after the lift has ${plural(c.n("confirmations"), "confirmation")}. ` +
        `The bound is ${c.up(F.buildFinal)} s (computed: ${c.up(F.confirmations)} s for the confirmations plus 2 * buildSeconds + ${c.n("buildIntervalSeconds") + c.n("timerTickSeconds")} s). ` +
        `The time of one full build, buildSeconds, is ${c.n("buildSeconds")} s: the longest build that was measured. ` +
        "A hold that ends by time clears in the first full build that reads a tip at or after its end time.",
      by(c, F.buildFinal),
    );
  }
  return cell(
    "applies",
    "The suspension bit clears when a follow step reads a tip that shows the lift. " +
      `The resolver shows the lift after ${plural(c.n("confirmations"), "confirmation")}, so the bound is ${c.up(F.final)} s (computed). ` +
      `Typically ${c.near(F.finalTypical)} s (computed). A hold that ends by time clears at most ${c.up(F.endByTime)} s after its end time (computed).`,
    by(c, F.final),
  );
}

/** What the status lists show of a revocation or a retirement. The number is the time of the suspension bit. */
function listsEnd(c: Ctx): BoundCell {
  if (!c.follow) {
    return cell(
      "applies",
      "Only a full build changes the lists, because the follow interval is 0. The suspension bit is set by the first full build that starts after the block. " +
        `The revocation bit is set, and the suspension bit is cleared, by the first full build that starts after the ${plural(c.n("confirmations"), "confirmation")}. ` +
        `The bound for the suspension bit is ${c.up(F.build)} s (computed: 2 * buildSeconds + ${c.n("buildIntervalSeconds") + c.n("timerTickSeconds")} s). ` +
        `The revocation bit needs ${c.up(F.confirmations)} s more for the confirmations: ${c.up(F.buildFinal)} s in all (computed). ` +
        `The time of one full build, buildSeconds, is ${c.n("buildSeconds")} s: the longest build that was measured.`,
      by(c, F.build),
    );
  }
  return cell(
    "applies",
    `The suspension bit is set within ${c.up(F.set)} s, as for a hold (computed). ` +
      `After ${plural(c.n("confirmations"), "confirmation")} the revocation bit is set and the suspension bit is cleared. ` +
      `That takes at most ${c.up(F.final)} s and typically ${c.near(F.finalTypical)} s (both computed). A verifier that reads only the revocation purpose sees the change at that time.`,
    by(c, F.set),
  );
}

/** The catalogs after a change that the scan reads: a hold, the end of a record, or the lift of a hold. */
function catalogsAfter(c: Ctx, kind: "hold" | "end" | "lift"): BoundCell {
  if (!c.jobs) return notOffered(NO_JOBS);
  const scan = `2 * scanSeconds + ${c.n("scanIntervalSeconds")} s (computed)`;
  const unfixed = "A scan takes minutes, and no setting fixes its time.";
  if (kind === "lift") {
    return cell(
      "applies",
      `The agent shows again at the end of the first scan that starts after the lift has ${plural(c.n("confirmations"), "confirmation")}. ` +
        `The bound is ${c.up(F.confirmations)} s for the confirmations plus ${scan}. ${unfixed} The per-agent cards, did.json and jwks.json follow the resolver.`,
      by(c, F.scanFinal),
    );
  }
  return cell(
    "applies",
    `The agent leaves the catalogs at the end of the first scan that starts after the block. The bound is ${scan}. ${unfixed} ` +
      (kind === "hold"
        ? "The per-agent cards, did.json and jwks.json read the live view and answer 404 at once."
        : "The per-agent cards, did.json and jwks.json read the live view and refuse the agent at once: HTTP 404, then HTTP 410 after the confirmations."),
    by(c, F.scan),
  );
}

/** The token service and the local check of an access token after a change of the status of the agent. */
function tokenCells(c: Ctx): Pick<Cells, "introspection" | "accessTokenLocal"> {
  return {
    introspection: m4Cell(c, () =>
      cell(
        "applies",
        "At once. On each call the gateway reads from the ledger source the status of each agent of the token. For a delegation token, it also reads the delegation chain. " +
          "A new token is refused. An existing token is inactive on the next call.",
        AT_ONCE,
      ),
    ),
    accessTokenLocal: m4Cell(c, () =>
      cell(
        "partial",
        "A verifier that checks only the signature and the exp claim accepts the token until it expires. " +
          `That is at most ${span(c.n("tokenSeconds"))} after the issue. ` +
          "A verifier that also reads the status-list entry of the token sees the change within the bound of statusLists, plus its own cache.",
        by(c, "tokenSeconds"),
      ),
    ),
  };
}

/** The X.509-SVID, the JWT-SVID and the credential after a change of the status of the agent that ends or suspends it. */
function artifactCells(c: Ctx, credentialRefusal: string, credentialStatus: string): Pick<Cells, "credential" | "x509Svid" | "jwtSvid"> {
  return {
    credential: m4Cell(c, () =>
      cell(
        "partial",
        `${credentialRefusal} A credential that was issued before stays valid until validUntil. That is at most ${span(c.n("credentialSeconds"))} after the issue. ${credentialStatus}`,
        by(c, "credentialSeconds"),
      ),
    ),
    x509Svid: m4Cell(c, () =>
      cell(
        "none",
        "No effect on an X.509-SVID that was issued before. It has no revocation information (noRevAvail), so it stays valid until it ends. " +
          `That is at most ${span(c.n("x509SvidSeconds"))} after the issue. A new X.509-SVID is refused at once (HTTP 403).`,
        by(c, "x509SvidSeconds"),
      ),
    ),
    jwtSvid: m4Cell(c, () =>
      cell(
        "partial",
        "A new JWT-SVID is refused at once (HTTP 403). The gateway knows each JWT-SVID that it issued: an introspection answers inactive on the next call. " +
          "A verifier that checks only the signature and the exp claim accepts the JWT-SVID until it ends. " +
          `That is at most ${span(c.n("jwtSvidSeconds"))} after the issue.`,
        by(c, "jwtSvidSeconds"),
      ),
    ),
  };
}

/** What the indexer does after a change of the record that its follower sees. */
const LISTING_HIDDEN = "Hidden at once. The follower of the indexer sees the block and marks the last answer of the gateway as old. The listing rule then refuses the advert.";

/** Suspend by the controller or by a party, and the hold of Module-1: the same cells. */
function holdSet(c: Ctx): Cells {
  return {
    contracts: cell(
      "applies",
      "From the block that carries the hold. Claim and Submit refuse a supplier that is not Active. " +
        "Vault Pay and the use of a delegation refuse a delegate agent or a delegator agent that is not Active. " +
        "No confirmations are needed. For an escrow in flight, see escrowBound.",
      AT_ONCE,
    ),
    resolver: cell("applies", "At once. The next resolution shows the effective status Suspended. The DID document and the keys stay.", AT_ONCE),
    statusLists: m4Cell(c, () => listsHold(c)),
    ...tokenCells(c),
    ...artifactCells(
      c,
      "A new credential is refused at once (HTTP 409).",
      "A verifier that reads the two status entries of the credential sees the change within the bound of statusLists, plus its own cache.",
    ),
    catalogs: catalogsAfter(c, "hold"),
    marketplaceListing: cell(
      "applies",
      `${LISTING_HIDDEN} The indexer asks the gateway again after ${c.n("indexerSettleSeconds")} s, then every ${c.n("indexerRereadSeconds")} s. An answer other than Active keeps the advert hidden.`,
      AT_ONCE,
    ),
  };
}

/** The lift of a hold by its author, or the end of a hold at its end time. */
function holdLift(c: Ctx): Cells {
  const confirmations = plural(c.n("confirmations"), "confirmation");
  const now = c.up(F.confirmations);
  return {
    contracts: cell(
      "applies",
      "From the block that carries the Unsuspend, when no other hold is in force. " +
        "A hold also ends for a transaction whose validity range starts at or after the end time of the hold. No confirmations are needed.",
      AT_ONCE,
    ),
    resolver: cell(
      "applies",
      `A lift does not reduce what a record allows. So it waits for ${confirmations}: typically ${c.near(F.confirmationsTypical)} s, at most ${now} s (both computed from the block interval). ` +
        "A hold that ends by time ends when the tip has a block time at or after its end time. That needs no confirmations.",
      by(c, F.confirmations),
    ),
    statusLists: m4Cell(c, () => listsLift(c)),
    introspection: m4Cell(c, () =>
      cell(
        "partial",
        `A new token can be issued when the resolver shows the agent Active: at most ${now} s (computed). A token that the hold revoked stays inactive for good.`,
        by(c, F.confirmations),
      ),
    ),
    accessTokenLocal: m4Cell(c, () =>
      cell("none", "No effect. A token that the hold revoked does not become valid again. A new token needs the lift in the resolver.", NO_NUMBER),
    ),
    credential: m4Cell(c, () => {
      const listLift = by(c, c.follow ? F.final : F.buildFinal);
      return cell(
        "applies",
        "A new credential can be issued when the resolver shows the agent Active. " +
          `The suspension entry of an issued credential clears within ${listLift.seconds} s (computed; the bound of statusLists), plus the cache of the verifier.`,
        listLift,
      );
    }),
    x509Svid: m4Cell(c, () =>
      cell(
        "applies",
        `A new X.509-SVID can be issued when the resolver shows the agent Active: at most ${now} s (computed). A hold never revoked an X.509-SVID that was issued before.`,
        by(c, F.confirmations),
      ),
    ),
    jwtSvid: m4Cell(c, () =>
      cell(
        "partial",
        `A new JWT-SVID can be issued when the resolver shows the agent Active: at most ${now} s (computed). A JWT-SVID that the hold revoked stays inactive for good.`,
        by(c, F.confirmations),
      ),
    ),
    catalogs: catalogsAfter(c, "lift"),
    marketplaceListing: cell(
      "applies",
      "The advert stays hidden until the gateway answers Active. " +
        `The lift shows in the resolver after at most ${now} s (computed). The next re-read of the indexer follows within ${c.n("indexerRereadSeconds") + c.n("indexerTickSeconds")} s. ` +
        "A hold that ends by time shows in the next re-read after the tip passes its end time.",
      by(c, F.listingFinal),
    ),
  };
}

/** Revoke and retire: the same cells with the word of the final status. */
function ending(c: Ctx, kind: "revoke" | "retire"): Cells {
  const revoke = kind === "revoke";
  const word = revoke ? "revoked" : "retired";
  const confirmations = plural(c.n("confirmations"), "confirmation");
  return {
    contracts: cell(
      "applies",
      `From the block that carries the ${revoke ? "Revoke" : "Retire"}. Claim and Submit refuse a supplier that is ${word}. ` +
        `Vault Pay and the use of a delegation refuse a delegate agent or a delegator agent that is ${word}. ` +
        `Anybody can return an Open or Claimed escrow of a ${word} supplier (RefundRevoked). ` +
        (revoke
          ? "A Submitted escrow returns only when the Revoke has an invalid-from time at or before the Submit, and only while the escrow is unspent. "
          : "A Retire never returns a Submitted escrow. ") +
        "See escrowBound.",
      AT_ONCE,
    ),
    resolver: cell(
      "applies",
      "At once. The next resolution shows the effective status Suspended with the reason deactivationPending. " +
        `After ${confirmations} it shows ${revoke ? "Revoked" : "Retired"}, answers HTTP 410 and gives no DID document. ` +
        `That takes typically ${c.near(F.confirmationsTypical)} s and at most ${c.up(F.confirmations)} s (both computed from the block interval).`,
      AT_ONCE,
    ),
    statusLists: m4Cell(c, () => listsEnd(c)),
    ...tokenCells(c),
    ...artifactCells(
      c,
      `A new credential is refused: with HTTP 409 while the end is pending, and with HTTP 410 after ${confirmations}.`,
      "A verifier that reads the two status entries sees the suspension entry first and the revocation entry later. Both follow the bounds of statusLists, plus the cache of the verifier.",
    ),
    catalogs: catalogsAfter(c, "end"),
    marketplaceListing: cell(
      "applies",
      `${LISTING_HIDDEN} After ${confirmations} the gateway answers 410, and the advert stays hidden for good.`,
      AT_ONCE,
    ),
  };
}

/** The controller removes a key from the record. */
function keyRemoval(c: Ctx): Cells {
  return {
    contracts: cell(
      "applies",
      "From the block that carries the Update. Claim and Submit need the supplier key to be a listed key with the transaction purpose. " +
        "The use of a delegation, and so vault Pay, needs the delegate key of each link to be a listed key with the delegation purpose. " +
        "Accept and Release check the signature only: a key that was removed can still sign them. For an escrow in flight, see escrowBound.",
      AT_ONCE,
    ),
    resolver: cell(
      "applies",
      `At once. A key that the record no longer lists leaves the view at the next resolution. A new key waits for ${plural(c.n("confirmations"), "confirmation")}.`,
      AT_ONCE,
    ),
    statusLists: m4Cell(c, () => cell("none", "No effect. The effective status does not change, so no bit changes.", NO_NUMBER)),
    introspection: m4Cell(c, () =>
      cell(
        "partial",
        "A new token that needs the removed key is refused at once. A delegation token whose delegation names the removed key as delegate key is inactive on the next call. " +
          "The check reads no key for a plain token. " +
          `So a plain token that was issued before stays active until it expires, at most ${span(c.n("tokenSeconds"))} after the issue.`,
        by(c, "tokenSeconds"),
      ),
    ),
    accessTokenLocal: m4Cell(c, () =>
      cell(
        "none",
        `No effect. The token stays valid until it expires: at most ${span(c.n("tokenSeconds"))} after the issue. A key removal sets no status-list bit.`,
        by(c, "tokenSeconds"),
      ),
    ),
    credential: m4Cell(c, () =>
      cell(
        "none",
        `No effect. The credential names no key. It stays valid until validUntil: at most ${span(c.n("credentialSeconds"))} after the issue.`,
        by(c, "credentialSeconds"),
      ),
    ),
    x509Svid: m4Cell(c, () =>
      cell(
        "none",
        `No effect on an X.509-SVID that was issued before. It stays valid until it ends, at most ${span(c.n("x509SvidSeconds"))} after the issue. A new request that is signed with the removed key is refused.`,
        by(c, "x509SvidSeconds"),
      ),
    ),
    jwtSvid: m4Cell(c, () =>
      cell(
        "none",
        `No effect on a JWT-SVID that was issued before. It stays valid until it ends, at most ${span(c.n("jwtSvidSeconds"))} after the issue. A new request that is signed with the removed key is refused.`,
        by(c, "jwtSvidSeconds"),
      ),
    ),
    catalogs: c.jobs
      ? cell("none", "No effect. The listing rule reads no key. The per-agent did.json and jwks.json drop the key at once.", NO_NUMBER)
      : notOffered(NO_JOBS),
    marketplaceListing: cell(
      "applies",
      "An advert that names the removed key as supplier key is hidden at once and stays hidden. Other adverts of the agent are hidden at once too. " +
        `They show again when the indexer asks the gateway again, ${c.n("indexerSettleSeconds")} s later.`,
      AT_ONCE,
    ),
  };
}

/** A delegator cuts a delegation. */
function undelegate(c: Ctx): Cells {
  const noDelegation = "This gateway has no delegation contract. It issues no delegation token, so a cut changes nothing here.";
  return {
    contracts: cell(
      "partial",
      "From the block that carries the Undelegate, vault Pay and the use of a delegation refuse the cut delegation and every delegation below it. Claim and Submit read no delegation. " +
        "An escrow that a vault paid before the cut runs on: see escrowBound.",
      AT_ONCE,
    ),
    resolver: cell("none", "No effect. The cut changes no identity record.", NO_NUMBER),
    statusLists: m4Cell(c, () => cell("none", "No effect. A cut sets no bit in any list. It shows in the introspection of a delegation token only.", NO_NUMBER)),
    introspection: m4Cell(c, () =>
      c.delegation
        ? cell(
            "applies",
            "At once. A new delegation token under the cut delegation is refused. An existing delegation token under it, or under a delegation below it, is inactive on the next call. " +
              "A token without a delegation is not affected.",
            AT_ONCE,
          )
        : cell("none", noDelegation, NO_NUMBER),
    ),
    accessTokenLocal: m4Cell(c, () =>
      c.delegation
        ? cell(
            "none",
            "No effect. A delegation token names the cut delegation, but a verifier that checks the token alone cannot see the cut. " +
              `The token stays valid until it expires: at most ${span(c.n("tokenSeconds"))} after the issue, and never after the end of the delegation. ` +
              "The status-list entry of the token is the entry of the agent, and a cut sets no bit.",
            by(c, "tokenSeconds"),
          )
        : cell("none", noDelegation, NO_NUMBER),
    ),
    credential: m4Cell(c, () => cell("none", "No effect. A credential holds no delegation.", NO_NUMBER)),
    x509Svid: m4Cell(c, () => cell("none", "No effect. An X.509-SVID holds no delegation.", NO_NUMBER)),
    jwtSvid: m4Cell(c, () => cell("none", "No effect. A JWT-SVID holds no delegation.", NO_NUMBER)),
    catalogs: c.jobs ? cell("none", "No effect. The listing rule reads no delegation.", NO_NUMBER) : notOffered(NO_JOBS),
    marketplaceListing: cell("none", "No effect. The listing reads the record of the supplier, not the delegations of a buyer.", NO_NUMBER),
  };
}

// ── The member ──

const PATH_TEXT: Readonly<Record<Path, { readonly description: string; readonly startEvent: string }>> = {
  controllerSuspend: {
    description: "The controller of the record sets its own hold with Suspend. A hold has an end time.",
    startEvent: "The block that carries the Suspend transaction.",
  },
  partySuspend: {
    description: "A party that has the suspend right sets its own hold with Suspend. A hold has an end time.",
    startEvent: "The block that carries the Suspend transaction.",
  },
  holdLift: {
    description:
      "An author lifts its own hold early with Unsuspend, or a hold ends at its end time. The agent is Active again only when no other hold is in force. A hold of Module-1 has no early lift.",
    startEvent: "The block that carries the Unsuspend transaction. For a hold that ends by time: the end time of the hold.",
  },
  revoke: {
    description: "The controller, or a party that has the revoke right, revokes the identity. Module-1 can revoke by verdict. A revocation is final. It can carry an invalid-from time.",
    startEvent: "The block that carries the Revoke transaction.",
  },
  retire: {
    description: "The controller retires the identity. A retirement is final.",
    startEvent: "The block that carries the Retire transaction.",
  },
  keyRemoval: {
    description: "The controller removes a key from the record with Update.",
    startEvent: "The block that carries the Update transaction that removes the key.",
  },
  undelegate: {
    description: "A delegator cuts a delegation with Undelegate. The delegations below it stop too.",
    startEvent: "The block that carries the Undelegate transaction.",
  },
  module1Hold: {
    description: "A verdict of Module-1 sets a hold for a fixed time. Nobody lifts it early. It ends at its end time.",
    startEvent: "The block that carries the Module-1 verdict that sets the hold.",
  },
};

export function revocationBounds(config: RenderConfig): RevocationBounds {
  const m4 = config.m4 ?? null;
  const terms = termsOf(config);
  const c: Ctx = {
    terms,
    m4: m4 !== null,
    follow: (terms.followSeconds!.value ?? 0) > 0,
    delegation: m4 !== null && m4.delegation !== null,
    jobs: config.fetchJobs,
    n(name) {
      const value = terms[name]?.value;
      if (value === undefined || value === null) throw new Error(`the term ${name} has no value`);
      return value;
    },
    up: (formula) => evaluateFormula(formula, terms, "up"),
    near(formula) {
      const value = evaluateFormula(formula, terms, "nearest");
      if (value === null) throw new Error(`the formula "${formula}" has no value`);
      return value;
    },
  };
  const cells: Readonly<Record<Path, Cells>> = {
    controllerSuspend: holdSet(c),
    partySuspend: holdSet(c),
    holdLift: holdLift(c),
    revoke: ending(c, "revoke"),
    retire: ending(c, "retire"),
    keyRemoval: keyRemoval(c),
    undelegate: undelegate(c),
    module1Hold: holdSet(c),
  };
  const paths = Object.fromEntries(PATHS.map((path) => [path, { ...PATH_TEXT[path], surfaces: cells[path] }])) as Record<Path, PathBounds>;
  const listCache = c.m4 ? c.n("listCacheSeconds") : null;
  const shown = ([name]: [string, Term]): boolean => (c.m4 || !M4_TERMS.includes(name)) && (c.jobs || !SCAN_TERMS.includes(name));
  // The records no longer fit the lists: only lists that follow the chain can find this out.
  const repair =
    c.m4 && c.follow
      ? [
          "If the records no longer fit the lists, the lists stay valid but frozen until a repair build ends. " +
            `A rollback deeper than ${c.n("confirmations")} blocks, or a bad answer of the ledger source, can cause this. ` +
            `The freeze lasts at most ${F.repairIdle} = ${c.up(F.repairIdle)} s (computed) when no full build runs. ` +
            `It lasts at most ${F.repairBusy} = ${c.up(F.repairBusy)} s (computed) when a full build already runs. ` +
            `Each failed build adds at most ${F.repairFailed} = ${c.up(F.repairFailed)} s (computed): its run time and one refresh interval. ` +
            `The time of one full build, buildSeconds, is measured: ${c.n("buildSeconds")} s is the longest live build.`,
        ]
      : [];
  return {
    about:
      "For each way to cut the authority of an agent, this member gives the longest time that each surface needs to apply the cut. " +
      "The member paths holds the bounds. The member effects explains the values of effect. The member terms holds the numbers that the formulas use. " +
      "The member escrowBound of this page gives the bound for an open escrow.",
    startEvent:
      "A bound counts from the time when the block that carries the change is at the tip of the ledger source of the gateway (Koios). The contracts count from the block itself. " +
      "The marketplace listing counts from the time when the follower of the indexer processes the block. A path can name another start event.",
    assumptions: [
      "The ledger source answers each request and shows the newest block.",
      "The chain makes blocks at its usual rate. No rule fixes the time of a block, so a bound that counts confirmations is a planning value.",
      "Each follow step, build and scan ends without an error. After an error, the result of the last good run stays until the next run ends.",
      ...repair,
      "The indexer runs with its default settings.",
    ],
    notCounted: [
      "The time from the submit of a transaction to the block that carries it.",
      "The lag of the ledger source behind the newest block.",
      ...(listCache === null ? [] : [`The cache of a reader. A reader can keep a status list for ${listCache} s (the max-age of the list), so it can see a change that much later.`]),
      "The time that a reader needs to fetch and check an answer.",
      "The time that the follower of the indexer needs to read a block.",
      "A rollback of the chain. A change in a block can disappear when the chain rolls back.",
    ],
    computed:
      "A number that the text marks as computed is the result of the formula in the same cell or in the same sentence. The formula uses the settings in force and the planning values in terms. " +
      "Nobody measures a computed number while the gateway runs. A planning value is not a setting and not a guarantee.",
    effects: {
      applies: "Every reader of the surface sees the change within seconds.",
      partial:
        "Some readers or some artifacts see the change within a short time. For the others, an artifact stays valid until it ends. The text names both parts. seconds is the longest time.",
      none: "No reader sees the change. An artifact that exists stays valid until it ends. seconds is the longest remaining life, or null when the path does not touch the surface.",
      notOffered: "This gateway does not run the service.",
    },
    terms: Object.fromEntries(Object.entries(terms).filter(shown)),
    surfaces: {
      contracts: "The on-chain rules: Claim and Submit of an escrow, vault Pay and the use of a delegation. They read the records of the ledger itself.",
      resolver: "GET /1.0/identifiers/{did}.",
      statusLists:
        "The signed status lists: GET /status/tsl/{n} (Token Status List) and GET /status/bsl/{n} (Bitstring Status List). The iat of a list is the block time of the tip that its bits describe.",
      introspection: "The token service: POST /token (issue) and POST /introspect.",
      accessTokenLocal: "An access token of the gateway that a verifier checks without a call to the gateway.",
      credential: "The identity credential: GET /agents/{id}/credential.",
      x509Svid: "An X.509-SVID: POST /spiffe/x509-svid.",
      jwtSvid: "A JWT-SVID: POST /spiffe/jwt-svid.",
      catalogs:
        "The catalogs GET /.well-known/ai-catalog.json and GET /.well-known/ard.json, and the MCP subregistry GET /v0/servers. They list the agents of the last background scan. " +
        "The per-agent renderings (cards, did.json, jwks.json) read the live view and follow the resolver.",
      marketplaceListing:
        `The marketplace listing of the adverts of an agent. The indexer owns it, not the gateway. The indexer asks the gateway again about each agent every ${INDEXER.rereadSeconds} s (it checks every ${INDEXER.tickSeconds} s which agents are due). ` +
        `When the gateway does not answer, the last answer counts for at most ${INDEXER.answerMaxSeconds} s. These numbers are the defaults of the indexer.`,
    },
    paths,
  };
}

// ── The escrow bound ──

export const ESCROW_BOUND_ABOUT = "What an open escrow does when a delegation or an identity ends.";

/** The bound for an open escrow, in order. Each item is one numbered sentence group of the bound. */
export const ESCROW_BOUND: readonly string[] = [
  "Cutting a delegation (`Undelegate`) stops new vault payments under it, and under every delegation below it, from the block that carries the cut.",
  "An escrow that a vault paid before the cut runs by the escrow rules. These rules read neither the delegation nor the buyer's identity.",
  "The supplier can Claim and Submit until `deliver_by`. A vault payment sets `deliver_by` at most 7 days after the end of its own validity range. The hosted builders use the advert's processing window plus 3 minutes, at most 24 hours and 3 minutes.",
  "The delegate key can Accept until 10 minutes after Submit. From that time on, the supplier can Release. Release has no end time, and it also gives the supplier the buyer bond.",
  "When an escrow is not submitted by `deliver_by`, anybody can return all of it to the vault from `deliver_by` on. The refund goes to the vault as a `Returned` output, and only the vault owner can take it (vault Close).",
  "So the outcome of each escrow is fixed at most 10 minutes after its `deliver_by`. One exception: when the supplier's record is later revoked with an invalid-from time at or before the Submit, anybody can return the escrow to the vault (`RefundRevoked`) while the escrow is still unspent. The first transaction that spends the escrow wins.",
  "A revoked or suspended buyer agent does not stop an Accept. A refusal would not protect the principal: 10 minutes after Submit the supplier can Release and also take the buyer bond.",
  "In the same way, a supplier that is revoked after Submit can still Release. When its revocation has an invalid-from time at or before the Submit, anybody can also return the escrow to the vault (`RefundRevoked`). The first transaction that spends the escrow wins.",
  "This is a deliberate choice: escrows that were paid before a cut run to their end. A policy that stops all work in flight when a root delegation is replaced works differently.",
];
