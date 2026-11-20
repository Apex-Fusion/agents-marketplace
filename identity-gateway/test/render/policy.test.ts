// GET /policy: the bound of each revocation path at each surface (`revocationBounds`), the escrow bound
// (`escrowBound`), and the members that were there before and must not change.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Detection } from "../../src/fetch/detect.js";
import { DAY_MS, FIRST_RETRY_MS, recheckDelayMs } from "../../src/fetch/scheduler.js";
import type { M4Settings } from "../../src/m4/context.js";
import { MAX_TOKEN_LIFETIME_S } from "../../src/m4/context.js";
import { CREDENTIAL_VALIDITY_MS } from "../../src/m4/credential.js";
import { X509_SVID_LIFETIME_MS } from "../../src/m4/spiffe.js";
import { DEFAULT_BACKGROUND_REFRESH_MS, DEFAULT_FOLLOW_MS } from "../../src/m4/status-lists.js";
import type { RenderConfig } from "../../src/render/config.js";
import { renderJson } from "../../src/render/json.js";
import { policyDocument } from "../../src/render/policy.js";
import { ESCROW_BOUND, PATHS, SURFACES, evaluateFormula, revocationBounds, type BoundCell, type Effect, type Path, type RevocationBounds, type Surface, type Term } from "../../src/render/policy-bounds.js";
import { CONFIRMATION_DEPTH, registryOf } from "../../src/resolve/settings.js";

const BASE = "https://id.vector.apexfusion.org";
const M4: M4Settings = {
  baseUrl: BASE,
  gatewayId: "00".repeat(32),
  trustDomain: "id.vector.apexfusion.org",
  delegation: registryOf("bdc16990b844a8860f28c51bb0e6a469c84bebcd57db699ce204785a"),
  statusListRefreshMs: 60_000,
};
/** The live gateway: the M4 services with their default intervals, the background jobs with a scan every 600 s. */
const PRODUCTION: RenderConfig = { baseUrl: BASE, accessLogRetention: "7 days", fetchJobs: true, scanIntervalMs: 600_000, m4: M4 };
const withM4 = (settings: Partial<M4Settings>): RenderConfig => ({ ...PRODUCTION, m4: { ...M4, ...settings } });

const cellOf = (bounds: RevocationBounds, path: Path, surface: Surface): BoundCell => bounds.paths[path].surfaces[surface];
const allCells = (bounds: RevocationBounds): Array<{ path: Path; surface: Surface; cell: BoundCell }> =>
  PATHS.flatMap((path) => SURFACES.map((surface) => ({ path, surface, cell: cellOf(bounds, path, surface) })));
const M4_SURFACES: readonly Surface[] = ["statusLists", "introspection", "accessTokenLocal", "credential", "x509Svid", "jwtSvid"];

/** Every string of a value, with its path. */
function strings(value: unknown, path: string[] = []): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path: path.join("."), text: value }];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, [...path, String(i)]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => strings(item, [...path, key]));
  return [];
}

/** The number of a formula, computed again here with `Function`, so that the test does not use the code that it checks. */
function compute(formula: string, terms: Readonly<Record<string, Term>>): number | null {
  expect(formula).toMatch(/^[A-Za-z0-9 +*/().-]+$/);
  const names = formula.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  for (const name of names) expect(terms[name], `the formula "${formula}" names the term ${name}`).toBeDefined();
  if (names.some((name) => terms[name]!.value === null)) return null;
  const expression = formula.replace(/[A-Za-z][A-Za-z0-9]*/g, (name) => `(${terms[name]!.value})`);
  return Math.ceil(Number(new Function(`"use strict"; return (${expression});`)()) - 1e-9);
}

// ── The members that were there before ──

/** The body of the live gateway before this member existed: other readers use these members, so each keeps its text and its value. */
const OLD = {
  accessLogRetention: "7 days",
  confirmationRule:
    "Everything that the gateway issues uses the view without resolution options. A change that reduces what a record allows takes effect at once. Other changes take effect when their transaction has 30 confirmations. A revocation or retirement shows as Suspended (deactivationPending) until it has 30 confirmations.",
  fetchRules:
    "The gateway detects protocols and verifies domains in background jobs. It never fetches during a request. It fetches only https URLs whose host resolves to public unicast addresses. It checks the addresses for each connection and each redirect. It does not follow a redirect to another host. Each fetch is limited to 1048576 bytes (1 MiB) and 10 seconds. It makes at most one fetch to a host each 60 seconds. It checks each Active agent again every day and after each change of its record.",
  listingRule:
    "The catalogs (/.well-known/ai-catalog.json and /.well-known/ard.json) and the MCP subregistry (/v0/servers) list an agent only when all of these conditions are true. The agent is independent: it is not a subagent. Its effective status without resolution options is Active. Its endpoint is reachable: the last protocol detection of the current endpoint succeeded. The catalogs show an A2A agent through its agent card and an MCP agent through its server card.",
  requestLog: "The gateway writes no request log. It logs errors without the requested DID.",
  limits: { confirmations: 30, fetchIntervalPerHostSeconds: 60, fetchMaxBytes: 1_048_576, fetchTimeoutSeconds: 10, maxRedirects: 5, recheckSeconds: 86_400 },
};

/** The rule that repeats a check after a check that found no protocol (the catalog fix) is stated in `fetchRules` and in `limits`. */
const RETRY_SENTENCE = " After a check that found no protocol, it checks again after 10 minutes, then after twice as long each time, but never later than a day after the last check.";
const CURRENT = { ...OLD, fetchRules: OLD.fetchRules + RETRY_SENTENCE, limits: { ...OLD.limits, firstRetrySeconds: 600 } };

describe("the members that were there before", () => {
  test.each([
    ["without the M4 services", { ...PRODUCTION, m4: null }],
    ["without the M4 field", { ...PRODUCTION, m4: undefined }],
    ["with the M4 services", PRODUCTION],
    ["with the status lists that do not follow the chain", withM4({ statusListFollowMs: 0 })],
    ["with the background jobs off", { ...PRODUCTION, fetchJobs: false }],
  ])("%s: the six members have the text and value of the live body, with the new rule of the repeat of a check; only two members are new", (_name, config) => {
    const { revocationBounds: bounds, escrowBound, ...rest } = policyDocument(config);
    expect(rest).toEqual(CURRENT);
    expect(bounds).toBeDefined();
    expect(escrowBound).toBeDefined();
    expect(Object.keys(policyDocument(config)).sort()).toEqual([...Object.keys(CURRENT), "escrowBound", "revocationBounds"].sort());
    // The other four members are the members of the live body, letter for letter.
    const { fetchRules: _fetchRules, limits: _limits, ...others } = rest;
    const { fetchRules: _oldFetchRules, limits: _oldLimits, ...oldOthers } = OLD;
    expect(others).toEqual(oldOthers);
  });

  test("fetchRules keeps the whole old text and adds one sentence; limits keep their six numbers and add firstRetrySeconds", () => {
    const { fetchRules, limits } = policyDocument(PRODUCTION) as { fetchRules: string; limits: Record<string, number> };
    expect(fetchRules.startsWith(OLD.fetchRules)).toBe(true);
    expect(fetchRules.slice(OLD.fetchRules.length)).toBe(RETRY_SENTENCE);
    expect(fetchRules).toContain("It checks each Active agent again every day and after each change of its record. After a check that found no protocol,");
    expect(limits).toEqual({ ...OLD.limits, firstRetrySeconds: FIRST_RETRY_MS / 1000 });
    expect(limits.firstRetrySeconds).toBe(600);
  });

  test("the sentence states the rule of the scheduler: 10 minutes after the first check that found no protocol, twice as long after each next one, never more than a day", () => {
    const none: Detection = { endpoint: "https://agent.example.org", checkedAt: 0, protocol: null, failure: "no check succeeded", fetched: null, a2a: null, mcpVersions: [] };
    const minutes = Array.from({ length: 12 }, (_, i) => recheckDelayMs({ detection: none, failedChecks: i + 1 }, DAY_MS) / 60_000);
    expect(minutes).toEqual([10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440, 1440, 1440]);
    expect(FIRST_RETRY_MS / 60_000).toBe(minutes[0]);
    expect(DAY_MS / 60_000).toBe(Math.max(...minutes));
    expect(RETRY_SENTENCE).toContain(`after ${minutes[0]} minutes`);
  });

  test("the served body is JSON in JCS member order", () => {
    const body = renderJson(policyDocument(PRODUCTION));
    expect(JSON.parse(body)).toEqual(JSON.parse(JSON.stringify(policyDocument(PRODUCTION))));
    expect(Object.keys(JSON.parse(body) as object)).toEqual([...Object.keys(JSON.parse(body) as object)].sort());
  });
});

// ── The escrow bound ──

describe("escrowBound", () => {
  test("the bound as an ordered list of sentences, as it is decided", () => {
    expect(policyDocument(PRODUCTION).escrowBound).toEqual({
      about: "What an open escrow does when a delegation or an identity ends.",
      sentences: [
        "Cutting a delegation (`Undelegate`) stops new vault payments under it, and under every delegation below it, from the block that carries the cut.",
        "An escrow that a vault paid before the cut runs by the escrow rules. These rules read neither the delegation nor the buyer's identity.",
        "The supplier can Claim and Submit until `deliver_by`. A vault payment sets `deliver_by` at most 7 days after the end of its own validity range. The hosted builders use the advert's processing window plus 3 minutes, at most 24 hours and 3 minutes.",
        "The delegate key can Accept until 10 minutes after Submit. From that time on, the supplier can Release. Release has no end time, and it also gives the supplier the buyer bond.",
        "When an escrow is not submitted by `deliver_by`, anybody can return all of it to the vault from `deliver_by` on. The refund goes to the vault as a `Returned` output, and only the vault owner can take it (vault Close).",
        "So the outcome of each escrow is fixed at most 10 minutes after its `deliver_by`. One exception: when the supplier's record is later revoked with an invalid-from time at or before the Submit, anybody can return the escrow to the vault (`RefundRevoked`) while the escrow is still unspent. The first transaction that spends the escrow wins.",
        "A revoked or suspended buyer agent does not stop an Accept. A refusal would not protect the principal: 10 minutes after Submit the supplier can Release and also take the buyer bond.",
        "In the same way, a supplier that is revoked after Submit can still Release. When its revocation has an invalid-from time at or before the Submit, anybody can also return the escrow to the vault (`RefundRevoked`). The first transaction that spends the escrow wins.",
        "This is a deliberate choice: escrows that were paid before a cut run to their end. A policy that stops all work in flight when a root delegation is replaced works differently.",
      ],
    });
    expect(ESCROW_BOUND).toHaveLength(9);
  });

  test("the text does not depend on the settings", () => {
    const expected = policyDocument(PRODUCTION).escrowBound;
    expect(policyDocument({ ...PRODUCTION, m4: null }).escrowBound).toEqual(expected);
    expect(policyDocument(withM4({ statusListFollowMs: 30_000 })).escrowBound).toEqual(expected);
  });
});

// ── The shape ──

describe("revocationBounds: the shape", () => {
  const bounds = revocationBounds(PRODUCTION);

  test("eight paths and ten surfaces, with these names", () => {
    expect([...PATHS].sort()).toEqual(["controllerSuspend", "holdLift", "keyRemoval", "module1Hold", "partySuspend", "retire", "revoke", "undelegate"]);
    expect([...SURFACES].sort()).toEqual(["accessTokenLocal", "catalogs", "contracts", "credential", "introspection", "jwtSvid", "marketplaceListing", "resolver", "statusLists", "x509Svid"]);
    expect(Object.keys(bounds.paths).sort()).toEqual([...PATHS].sort());
    expect(Object.keys(bounds.surfaces).sort()).toEqual([...SURFACES].sort());
    expect(Object.keys(bounds).sort()).toEqual(["about", "assumptions", "computed", "effects", "notCounted", "paths", "startEvent", "surfaces", "terms"]);
    expect(Object.keys(bounds.effects).sort()).toEqual(["applies", "none", "notOffered", "partial"]);
  });

  test("each path names its start event, and each path holds a cell for each surface", () => {
    for (const path of PATHS) {
      const entry = bounds.paths[path];
      expect(Object.keys(entry).sort()).toEqual(["description", "startEvent", "surfaces"]);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(entry.startEvent).toMatch(/^The block that carries /);
      expect(Object.keys(entry.surfaces).sort()).toEqual([...SURFACES].sort());
    }
  });

  test("each cell has an effect, a text, a number or null, and a formula or null", () => {
    const effects: readonly Effect[] = ["applies", "partial", "none", "notOffered"];
    for (const { path, surface, cell } of allCells(bounds)) {
      const where = `${path}/${surface}`;
      expect(Object.keys(cell).sort(), where).toEqual(["bound", "effect", "formula", "seconds"]);
      expect(effects, where).toContain(cell.effect);
      expect(cell.bound.length, where).toBeGreaterThan(20);
      expect(cell.seconds === null || (Number.isInteger(cell.seconds) && cell.seconds >= 0), where).toBe(true);
      expect(cell.formula === null || typeof cell.formula === "string", where).toBe(true);
      if (cell.formula === null) expect(cell.seconds === null || cell.seconds === 0, where).toBe(true);
    }
  });

  test("the start event, the assumptions and what is not counted are stated", () => {
    expect(bounds.startEvent).toContain("the block that carries the change is at the tip of the ledger source");
    expect(bounds.startEvent).toContain("The contracts count from the block itself.");
    expect(bounds.startEvent).toContain("follower of the indexer");
    expect(bounds.notCounted).toContain("The cache of a reader. A reader can keep a status list for 60 s (the max-age of the list), so it can see a change that much later.");
    expect(bounds.notCounted.join(" ")).toContain("submit of a transaction");
    expect(bounds.notCounted.join(" ")).toContain("lag of the ledger source");
    expect(bounds.assumptions.join(" ")).toContain("ledger source answers each request");
    expect(bounds.computed).toContain("A number that the text marks as computed is the result of the formula in the same cell or in the same sentence.");
    expect(bounds.computed).toContain("Nobody measures a computed number while the gateway runs.");
  });
});

// ── The numbers with the default settings ──

const HOLD: Record<Surface, [Effect, number | null]> = {
  contracts: ["applies", 0],
  resolver: ["applies", 0],
  statusLists: ["applies", 16],
  introspection: ["applies", 0],
  accessTokenLocal: ["partial", 300],
  credential: ["partial", 86_400],
  x509Svid: ["none", 3540],
  jwtSvid: ["partial", 300],
  catalogs: ["applies", null],
  marketplaceListing: ["applies", 0],
};
const ENDING: Record<Surface, [Effect, number | null]> = { ...HOLD };
const EXPECTED: Record<Path, Record<Surface, [Effect, number | null]>> = {
  controllerSuspend: HOLD,
  partySuspend: HOLD,
  module1Hold: HOLD,
  holdLift: {
    contracts: ["applies", 0],
    resolver: ["applies", 240],
    statusLists: ["applies", 256],
    introspection: ["partial", 240],
    accessTokenLocal: ["none", null],
    credential: ["applies", 256],
    x509Svid: ["applies", 240],
    jwtSvid: ["partial", 240],
    catalogs: ["applies", null],
    marketplaceListing: ["applies", 305],
  },
  revoke: ENDING,
  retire: ENDING,
  keyRemoval: {
    contracts: ["applies", 0],
    resolver: ["applies", 0],
    statusLists: ["none", null],
    introspection: ["partial", 300],
    accessTokenLocal: ["none", 300],
    credential: ["none", 86_400],
    x509Svid: ["none", 3540],
    jwtSvid: ["none", 300],
    catalogs: ["none", null],
    marketplaceListing: ["applies", 0],
  },
  undelegate: {
    contracts: ["partial", 0],
    resolver: ["none", null],
    statusLists: ["none", null],
    introspection: ["applies", 0],
    accessTokenLocal: ["none", 300],
    credential: ["none", null],
    x509Svid: ["none", null],
    jwtSvid: ["none", null],
    catalogs: ["none", null],
    marketplaceListing: ["none", null],
  },
};

describe("revocationBounds: the numbers with the default settings", () => {
  const bounds = revocationBounds(PRODUCTION);

  test.each(PATHS.map((path) => [path]))("%s: effect and seconds of each surface", (path) => {
    for (const surface of SURFACES) {
      const cell = cellOf(bounds, path, surface);
      expect([cell.effect, cell.seconds], `${path}/${surface}`).toEqual(EXPECTED[path][surface]);
    }
  });

  test("the formulas of the main cells", () => {
    const formula = (path: Path, surface: Surface): string | null => cellOf(bounds, path, surface).formula;
    expect(formula("controllerSuspend", "statusLists")).toBe("followSeconds + stepSecondsDuringBuild");
    expect(formula("holdLift", "statusLists")).toBe("confirmations * blockSecondsP90 + followSeconds + stepSecondsDuringBuild");
    expect(formula("holdLift", "resolver")).toBe("confirmations * blockSecondsP90");
    expect(formula("revoke", "statusLists")).toBe("followSeconds + stepSecondsDuringBuild");
    expect(formula("controllerSuspend", "catalogs")).toBe("2 * scanSeconds + scanIntervalSeconds");
    expect(formula("holdLift", "marketplaceListing")).toBe("confirmations * blockSecondsP90 + indexerRereadSeconds + indexerTickSeconds");
    expect(formula("controllerSuspend", "accessTokenLocal")).toBe("tokenSeconds");
    expect(formula("controllerSuspend", "contracts")).toBeNull();
    expect(formula("controllerSuspend", "resolver")).toBeNull();
  });

  test("the typical values and the other numbers in the text", () => {
    const text = (path: Path, surface: Surface): string => cellOf(bounds, path, surface).bound;
    expect(text("controllerSuspend", "statusLists")).toContain("within 16 s (computed");
    expect(text("controllerSuspend", "statusLists")).toContain("When no full build runs, it is 11 s (computed).");
    expect(text("controllerSuspend", "statusLists")).toContain("Typically 6 s (computed).");
    expect(text("holdLift", "statusLists")).toContain("the bound is 256 s (computed)");
    expect(text("holdLift", "statusLists")).toContain("Typically 122 s (computed)");
    expect(text("holdLift", "statusLists")).toContain("clears at most 24 s after its end time (computed)");
    expect(text("holdLift", "resolver")).toContain("waits for 30 confirmations: typically 116 s, at most 240 s (both computed from the block interval)");
    expect(text("revoke", "resolver")).toContain("After 30 confirmations it shows Revoked, answers HTTP 410 and gives no DID document.");
    expect(text("revoke", "resolver")).toContain("typically 116 s and at most 240 s (both computed");
    expect(text("retire", "resolver")).toContain("it shows Retired");
    expect(text("revoke", "statusLists")).toContain("The suspension bit is set within 16 s, as for a hold (computed).");
    expect(text("revoke", "statusLists")).toContain("at most 256 s and typically 122 s (both computed)");
    expect(text("controllerSuspend", "accessTokenLocal")).toContain("at most 300 s (5 minutes) after the issue");
    expect(text("controllerSuspend", "credential")).toContain("at most 86400 s (24 hours) after the issue");
    expect(text("controllerSuspend", "x509Svid")).toContain("at most 3540 s (59 minutes) after the issue");
    expect(text("controllerSuspend", "jwtSvid")).toContain("at most 300 s (5 minutes) after the issue");
    expect(text("controllerSuspend", "catalogs")).toContain("The bound is 2 * scanSeconds + 600 s (computed).");
    expect(text("holdLift", "catalogs")).toContain("The bound is 240 s for the confirmations plus 2 * scanSeconds + 600 s (computed).");
    expect(text("controllerSuspend", "catalogs")).toContain("did.json and jwks.json read the live view and answer 404 at once");
    expect(text("revoke", "catalogs")).toContain("refuse the agent at once: HTTP 404, then HTTP 410 after the confirmations");
    expect(text("holdLift", "catalogs")).toContain("The agent shows again at the end of the first scan that starts after the lift has 30 confirmations.");
    expect(text("holdLift", "catalogs")).toContain("follow the resolver");
    expect(text("controllerSuspend", "marketplaceListing")).toContain("The indexer asks the gateway again after 20 s, then every 60 s.");
    expect(text("holdLift", "marketplaceListing")).toContain("follows within 65 s");
  });

  test("the three holds have the same cells, and revoke and retire differ only in their words", () => {
    expect(bounds.paths.partySuspend.surfaces).toEqual(bounds.paths.controllerSuspend.surfaces);
    expect(bounds.paths.module1Hold.surfaces).toEqual(bounds.paths.controllerSuspend.surfaces);
    for (const surface of SURFACES) {
      const revoke = cellOf(bounds, "revoke", surface);
      const retire = cellOf(bounds, "retire", surface);
      expect([retire.effect, retire.seconds, retire.formula], surface).toEqual([revoke.effect, revoke.seconds, revoke.formula]);
    }
    expect(cellOf(bounds, "retire", "contracts").bound).toContain("A Retire never returns a Submitted escrow.");
    expect(cellOf(bounds, "revoke", "contracts").bound).toContain("only while the escrow is unspent");
  });

  test("a cut and a key removal set no status-list bit: no effect, no number", () => {
    for (const path of ["undelegate", "keyRemoval"] as const) {
      expect(cellOf(bounds, path, "statusLists"), path).toMatchObject({ effect: "none", seconds: null, formula: null });
    }
    expect(cellOf(bounds, "undelegate", "statusLists").bound).toContain("sets no bit");
    expect(cellOf(bounds, "keyRemoval", "statusLists").bound).toContain("no bit changes");
  });

  test("the contracts count from the block and the cells of the contracts name the escrow bound", () => {
    for (const path of PATHS) expect(cellOf(bounds, path, "contracts").seconds, path).toBe(0);
    for (const path of ["controllerSuspend", "partySuspend", "module1Hold", "revoke", "retire", "keyRemoval", "undelegate"] as const) {
      expect(cellOf(bounds, path, "contracts").bound, path).toContain("escrowBound");
    }
    expect(cellOf(bounds, "undelegate", "contracts").bound).toContain("Claim and Submit read no delegation.");
    expect(cellOf(bounds, "keyRemoval", "contracts").bound).toContain("a key that was removed can still sign them");
  });
});

// ── The numbers follow the settings ──

describe("revocationBounds: the numbers follow the settings", () => {
  const base = revocationBounds(PRODUCTION);
  const uses = (cell: BoundCell, name: string): boolean => (cell.formula ?? "").split(/[^A-Za-z0-9]+/).includes(name);

  test("the follow interval changes the cells that use it, and no other cell", () => {
    const slow = revocationBounds(withM4({ statusListFollowMs: 30_000 }));
    expect(slow.terms.followSeconds).toMatchObject({ value: 30, kind: "setting" });
    expect(cellOf(slow, "controllerSuspend", "statusLists")).toMatchObject({ seconds: 36 });
    expect(cellOf(slow, "controllerSuspend", "statusLists").bound).toContain("within 36 s (computed");
    expect(cellOf(slow, "controllerSuspend", "statusLists").bound).toContain("it is 31 s (computed)");
    expect(cellOf(slow, "controllerSuspend", "statusLists").bound).toContain("Typically 16 s (computed).");
    expect(cellOf(slow, "revoke", "statusLists")).toMatchObject({ seconds: 36 });
    expect(cellOf(slow, "holdLift", "statusLists")).toMatchObject({ seconds: 276 });
    expect(cellOf(slow, "holdLift", "credential")).toMatchObject({ seconds: 276 });
    expect(cellOf(slow, "holdLift", "credential").bound).toContain("within 276 s (computed");
    for (const { path, surface, cell } of allCells(base)) {
      if (uses(cell, "followSeconds")) continue;
      expect(cellOf(slow, path, surface), `${path}/${surface}`).toEqual(cell);
    }
  });

  test("a follow interval of 0 leaves the lists to the full build: two builds, the build interval and one tick; the text says why", () => {
    const off = revocationBounds(withM4({ statusListFollowMs: 0 }));
    expect(off.terms.followSeconds).toMatchObject({ value: 0 });
    // 2 * 474 s + 600 s + 10 s
    for (const path of ["controllerSuspend", "partySuspend", "module1Hold"] as const) {
      const cell = cellOf(off, path, "statusLists");
      expect(cell, path).toMatchObject({ effect: "applies", seconds: 1558, formula: "2 * buildSeconds + buildIntervalSeconds + timerTickSeconds" });
      expect(cell.bound).toContain("because the follow interval is 0");
      expect(cell.bound).toContain("The bound is 1558 s (computed: 2 * buildSeconds + 610 s).");
      expect(cell.bound).toContain("The time of one full build, buildSeconds, is 474 s: the longest build that was measured.");
    }
    for (const path of ["revoke", "retire"] as const) {
      const cell = cellOf(off, path, "statusLists");
      expect(cell, path).toMatchObject({ effect: "applies", seconds: 1558, formula: "2 * buildSeconds + buildIntervalSeconds + timerTickSeconds" });
      expect(cell.bound).toContain("The bound for the suspension bit is 1558 s (computed: 2 * buildSeconds + 610 s).");
      expect(cell.bound).toContain("The revocation bit needs 240 s more for the confirmations: 1798 s in all (computed).");
    }
    expect(cellOf(off, "holdLift", "statusLists")).toMatchObject({ seconds: 1798, formula: "confirmations * blockSecondsP90 + 2 * buildSeconds + buildIntervalSeconds + timerTickSeconds" });
    expect(cellOf(off, "holdLift", "statusLists").bound).toContain("The bound is 1798 s (computed: 240 s for the confirmations plus 2 * buildSeconds + 610 s).");
    expect(cellOf(off, "holdLift", "credential").seconds).toBe(1798);
    expect(cellOf(off, "holdLift", "credential").bound).toContain("clears within 1798 s (computed; the bound of statusLists)");
    // The resolver does not depend on the lists.
    expect(cellOf(off, "holdLift", "resolver")).toEqual(cellOf(base, "holdLift", "resolver"));
    expect(cellOf(off, "controllerSuspend", "introspection")).toEqual(cellOf(base, "controllerSuspend", "introspection"));
  });

  test("the build interval is a term and shows in the bound when the lists do not follow the chain", () => {
    const off = revocationBounds(withM4({ statusListFollowMs: 0, statusListBackgroundRefreshMs: 1_800_000 }));
    expect(off.terms.buildIntervalSeconds).toMatchObject({ value: 1800, kind: "setting" });
    // 2 * 474 s + 1800 s + 10 s
    expect(cellOf(off, "controllerSuspend", "statusLists")).toMatchObject({ seconds: 2758 });
    expect(cellOf(off, "controllerSuspend", "statusLists").bound).toContain("The bound is 2758 s (computed: 2 * buildSeconds + 1810 s).");
    expect(revocationBounds(withM4({ statusListBackgroundRefreshMs: 1_800_000 })).terms.buildIntervalSeconds.value).toBe(1800);
  });

  test("one setting gives the reader cache and the refresh interval, as two terms: it changes notCounted, the repair entry and the two terms, and no cell", () => {
    const cached = revocationBounds(withM4({ statusListRefreshMs: 120_000 }));
    expect(cached.terms.listCacheSeconds).toMatchObject({ value: 120, kind: "setting" });
    expect(cached.terms.refreshSeconds).toMatchObject({ value: 120, kind: "setting" });
    expect(cached.notCounted).toContain("The cache of a reader. A reader can keep a status list for 120 s (the max-age of the list), so it can see a change that much later.");
    expect(cached.assumptions.join(" ")).toContain("Each failed build adds at most buildSeconds + refreshSeconds = 594 s (computed): its run time and one refresh interval.");
    expect(cached.paths).toEqual(base.paths);
    const { terms: cachedTerms, notCounted: cachedNotCounted, assumptions: cachedAssumptions, ...cachedRest } = cached;
    const { terms: baseTerms, notCounted: baseNotCounted, assumptions: baseAssumptions, ...baseRest } = base;
    expect(cachedRest).toEqual(baseRest);
    expect(cachedAssumptions.join(" ").replace("refreshSeconds = 594 s", "refreshSeconds = 534 s")).toBe(baseAssumptions.join(" "));
    expect(cachedNotCounted).toHaveLength(baseNotCounted.length);
    expect({ ...cachedTerms, listCacheSeconds: baseTerms.listCacheSeconds, refreshSeconds: baseTerms.refreshSeconds }).toEqual(baseTerms);
  });

  test("the scan interval changes the catalogs and the term", () => {
    const slow = revocationBounds({ ...PRODUCTION, scanIntervalMs: 900_000 });
    expect(slow.terms.scanIntervalSeconds).toMatchObject({ value: 900, kind: "setting" });
    expect(cellOf(slow, "revoke", "catalogs").bound).toContain("The bound is 2 * scanSeconds + 900 s (computed).");
    expect(cellOf(slow, "holdLift", "catalogs").bound).toContain("plus 2 * scanSeconds + 900 s (computed)");
    for (const { path, surface, cell } of allCells(base)) {
      if (surface === "catalogs" && cell.effect === "applies") continue;
      expect(cellOf(slow, path, surface), `${path}/${surface}`).toEqual(cell);
    }
  });

  test("the limits are the values that the services use", () => {
    const { terms } = base;
    expect(terms.confirmations).toMatchObject({ value: CONFIRMATION_DEPTH, kind: "limit" });
    expect(terms.tokenSeconds).toMatchObject({ value: MAX_TOKEN_LIFETIME_S, kind: "limit" });
    expect(terms.jwtSvidSeconds).toMatchObject({ value: MAX_TOKEN_LIFETIME_S, kind: "limit" });
    expect(terms.credentialSeconds).toMatchObject({ value: CREDENTIAL_VALIDITY_MS / 1000, kind: "limit" });
    expect(terms.x509SvidSeconds).toMatchObject({ value: X509_SVID_LIFETIME_MS / 1000 - 60, kind: "limit" });
    expect(terms.followSeconds.value).toBe(DEFAULT_FOLLOW_MS / 1000);
    expect(terms.buildIntervalSeconds.value).toBe(DEFAULT_BACKGROUND_REFRESH_MS / 1000);
    expect(terms.timerTickSeconds.value).toBe(10);
    expect(terms.listCacheSeconds.value).toBe(60);
    expect(terms.refreshSeconds.value).toBe(60);
    expect(terms.refreshSeconds.meaning).toContain("starts of two full builds");
    expect(terms.listCacheSeconds.meaning).toContain("max-age");
  });

  test("the planning values, the unfixed times and the defaults of the indexer are marked as such", () => {
    const { terms } = base;
    for (const name of ["stepSeconds", "stepSecondsDuringBuild", "buildSeconds", "blockSecondsMean", "blockSecondsP90"]) expect(terms[name]!.kind, name).toBe("planning value");
    expect(terms.buildSeconds!.value).toBe(474);
    expect(terms.buildSeconds!.meaning).toContain("474 s is the longest live build that was measured");
    expect(terms.scanSeconds).toMatchObject({ kind: "not fixed", value: null });
    for (const name of ["indexerRereadSeconds", "indexerTickSeconds", "indexerSettleSeconds", "indexerAnswerMaxSeconds"]) expect(terms[name]!.kind, name).toBe("indexer default");
    expect([terms.indexerRereadSeconds!.value, terms.indexerTickSeconds!.value, terms.indexerSettleSeconds!.value, terms.indexerAnswerMaxSeconds!.value]).toEqual([60, 5, 20, 600]);
    expect(base.surfaces.marketplaceListing).toContain("These numbers are the defaults of the indexer.");
  });
});

// ── The lists freeze when the records no longer fit them ──

describe("revocationBounds: the repair of the lists when the records no longer fit them", () => {
  const FREEZE = "followSeconds + stepSeconds + buildSeconds";
  const FREEZE_BUSY = "2 * buildSeconds + followSeconds + stepSecondsDuringBuild";
  const FAILED = "buildSeconds + refreshSeconds";
  const entry = (bounds: RevocationBounds): string | undefined => bounds.assumptions.find((text) => text.startsWith("If the records no longer fit the lists"));

  test("with the default settings: one entry in the assumptions, with both formulas, their numbers and the failed builds", () => {
    const bounds = revocationBounds(PRODUCTION);
    expect(bounds.assumptions).toHaveLength(5);
    expect(entry(bounds)).toBe(
      "If the records no longer fit the lists, the lists stay valid but frozen until a repair build ends. " +
        "A rollback deeper than 30 blocks, or a bad answer of the ledger source, can cause this. " +
        "The freeze lasts at most followSeconds + stepSeconds + buildSeconds = 485 s (computed) when no full build runs. " +
        "It lasts at most 2 * buildSeconds + followSeconds + stepSecondsDuringBuild = 964 s (computed) when a full build already runs. " +
        "Each failed build adds at most buildSeconds + refreshSeconds = 534 s (computed): its run time and one refresh interval. " +
        "The time of one full build, buildSeconds, is measured: 474 s is the longest live build.",
    );
    // It follows the entry about the errors of a run.
    expect(bounds.assumptions[2]).toContain("ends without an error");
    expect(bounds.assumptions[3]).toBe(entry(bounds));
  });

  test.each([
    ["the default settings", PRODUCTION, 485, 964, 60, 534],
    ["a follow interval of 30 s", withM4({ statusListFollowMs: 30_000 }), 505, 984, 60, 534],
    ["a follow interval of 20 s and a refresh interval of 5 s", withM4({ statusListFollowMs: 20_000, statusListRefreshMs: 5_000 }), 495, 974, 5, 479],
    ["the longest follow interval", withM4({ statusListFollowMs: 300_000 }), 775, 1254, 60, 534],
    ["a refresh interval of 120 s", withM4({ statusListRefreshMs: 120_000 }), 485, 964, 120, 594],
  ])("the numbers follow the follow interval and the refresh interval: %s", (_name, config, idle, busy, refresh, failed) => {
    const bounds = revocationBounds(config);
    const text = entry(bounds)!;
    expect(text).toContain(`${FREEZE} = ${idle} s (computed) when no full build runs.`);
    expect(text).toContain(`${FREEZE_BUSY} = ${busy} s (computed) when a full build already runs.`);
    expect(text).toContain(`Each failed build adds at most ${FAILED} = ${failed} s (computed): its run time and one refresh interval.`);
    // The refresh interval, not the reader cache, is named, although one setting gives both numbers.
    expect(text).not.toContain("listCacheSeconds");
    // The numbers again, from the terms, with the evaluator of this test.
    expect(compute(FREEZE, bounds.terms)).toBe(idle);
    expect(compute(FREEZE_BUSY, bounds.terms)).toBe(busy);
    expect(compute(FAILED, bounds.terms)).toBe(failed);
    expect(bounds.terms.refreshSeconds!.value).toBe(refresh);
    expect(bounds.terms.listCacheSeconds!.value).toBe(refresh);
    expect(bounds.terms.followSeconds!.value).toBe((config.m4?.statusListFollowMs ?? 10_000) / 1000);
  });

  test("the sums are computed and the build time is measured; no other setting changes the entry", () => {
    const text = entry(revocationBounds(PRODUCTION))!;
    expect(text.match(/\(computed\)/g)).toHaveLength(3);
    expect(text).toContain("buildSeconds, is measured: 474 s is the longest live build.");
    for (const config of [{ ...PRODUCTION, scanIntervalMs: 900_000 }, { ...PRODUCTION, fetchJobs: false }, withM4({ delegation: null }), withM4({ statusListBackgroundRefreshMs: 1_800_000 })]) {
      expect(entry(revocationBounds(config))).toBe(text);
    }
  });

  test("no entry without the M4 services, and none when the lists do not follow the chain: only a follow step finds that the records do not fit", () => {
    for (const config of [{ ...PRODUCTION, m4: null }, { ...PRODUCTION, m4: undefined }, withM4({ statusListFollowMs: 0 })]) {
      const bounds = revocationBounds(config);
      expect(entry(bounds)).toBeUndefined();
      expect(bounds.assumptions).toHaveLength(4);
    }
  });
});

// ── Each number is the result of its formula ──

describe("revocationBounds: seconds is the result of the formula", () => {
  test.each([
    ["the live gateway", PRODUCTION],
    ["a slow follow interval", withM4({ statusListFollowMs: 120_000 })],
    ["the longest follow interval and other cache and build intervals", withM4({ statusListFollowMs: 300_000, statusListRefreshMs: 5000, statusListBackgroundRefreshMs: 2_700_000 })],
    ["lists that do not follow the chain", withM4({ statusListFollowMs: 0 })],
    ["no delegation contract", withM4({ delegation: null })],
    ["a long scan interval", { ...PRODUCTION, scanIntervalMs: 86_400_000 }],
    ["no background jobs", { ...PRODUCTION, fetchJobs: false }],
    ["no M4 services", { ...PRODUCTION, m4: null }],
  ])("%s", (_name, config) => {
    const bounds = revocationBounds(config);
    for (const { path, surface, cell } of allCells(bounds)) {
      const where = `${path}/${surface}`;
      if (cell.formula === null) continue;
      expect(cell.seconds, where).toBe(compute(cell.formula, bounds.terms));
    }
  });

  test("a cell that uses a planning value, a setting or a default of the indexer says that its number is computed", () => {
    for (const config of [PRODUCTION, withM4({ statusListFollowMs: 0 })]) {
      const bounds = revocationBounds(config);
      for (const { path, surface, cell } of allCells(bounds)) {
        if (cell.formula === null || cell.seconds === null) continue;
        const names = cell.formula.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
        if (names.every((name) => bounds.terms[name]!.kind === "limit")) continue;
        expect(cell.bound, `${path}/${surface}`).toContain("computed");
      }
    }
  });
});

// ── The services that the gateway does not run ──

describe("revocationBounds: a service that this gateway does not run", () => {
  const base = revocationBounds(PRODUCTION);

  test.each([
    ["m4 is null", { ...PRODUCTION, m4: null }],
    ["m4 is missing", { ...PRODUCTION, m4: undefined }],
  ])("%s: the six M4 surfaces say so in every path, and the other surfaces keep their cells", (_name, config) => {
    const off = revocationBounds(config);
    for (const { path, surface, cell } of allCells(off)) {
      if (M4_SURFACES.includes(surface)) {
        expect(cell, `${path}/${surface}`).toMatchObject({ effect: "notOffered", seconds: null, formula: null });
        expect(cell.bound).toContain("This gateway does not run the M4 services");
      } else {
        expect(cell, `${path}/${surface}`).toEqual(cellOf(base, path, surface));
      }
    }
    for (const name of ["followSeconds", "stepSeconds", "listCacheSeconds", "refreshSeconds", "buildIntervalSeconds", "tokenSeconds", "jwtSvidSeconds", "credentialSeconds", "x509SvidSeconds", "timerTickSeconds", "buildSeconds"]) {
      expect(off.terms[name], name).toBeUndefined();
    }
    expect(off.notCounted.join(" ")).not.toContain("max-age");
    expect(off.terms.confirmations).toBeDefined();
  });

  test("no background jobs: the catalogs say so and the scan terms are gone", () => {
    const off = revocationBounds({ ...PRODUCTION, fetchJobs: false });
    for (const path of PATHS) {
      expect(cellOf(off, path, "catalogs"), path).toMatchObject({ effect: "notOffered", seconds: null, formula: null });
      expect(cellOf(off, path, "catalogs").bound).toContain("The background jobs are off");
    }
    expect(off.terms.scanIntervalSeconds).toBeUndefined();
    expect(off.terms.scanSeconds).toBeUndefined();
    for (const { path, surface, cell } of allCells(off)) {
      if (surface !== "catalogs") expect(cell, `${path}/${surface}`).toEqual(cellOf(base, path, surface));
    }
  });

  test("no delegation contract: a cut changes nothing in the token service", () => {
    const off = revocationBounds(withM4({ delegation: null }));
    for (const surface of ["introspection", "accessTokenLocal"] as const) {
      expect(cellOf(off, "undelegate", surface), surface).toMatchObject({ effect: "none", seconds: null, formula: null });
      expect(cellOf(off, "undelegate", surface).bound).toContain("no delegation contract");
    }
    for (const { path, surface, cell } of allCells(off)) {
      if (path === "undelegate" && (surface === "introspection" || surface === "accessTokenLocal")) continue;
      expect(cell, `${path}/${surface}`).toEqual(cellOf(base, path, surface));
    }
  });
});

// ── Public text ──

describe("revocationBounds: public text", () => {
  const configs: Array<[string, RenderConfig]> = [
    ["the live gateway", PRODUCTION],
    ["lists that do not follow the chain", withM4({ statusListFollowMs: 0 })],
    ["no M4 services", { ...PRODUCTION, m4: null }],
    ["no background jobs and no delegation contract", { ...withM4({ delegation: null }), fetchJobs: false }],
  ];

  test.each(configs)("%s: ASCII only, no unfinished text", (_name, config) => {
    const document = policyDocument(config);
    const text = [...strings(document.revocationBounds, ["revocationBounds"]), ...strings(document.escrowBound, ["escrowBound"])];
    expect(text.length).toBeGreaterThan(200);
    for (const { path, text: value } of text) {
      expect(value, path).toMatch(/^[\x20-\x7e]+$/);
    }
    for (const { path, text: value } of strings(document.revocationBounds, ["revocationBounds"]).filter((s) => /\.(bound|meaning)$/.test(s.path))) {
      expect(value, path).not.toMatch(/\b(null|undefined|NaN|Infinity)\b|\[object/);
    }
  });

  test.each(configs)("%s: a sentence has at most 25 words", (_name, config) => {
    for (const { path, text: value } of strings(revocationBounds(config), ["revocationBounds"])) {
      for (const sentence of value.split(/(?<=[.!?])\s+/)) {
        expect(sentence.split(/\s+/).length, `${path}: ${sentence}`).toBeLessThanOrEqual(25);
      }
    }
  });

  test("the status words of the plan do not appear: the table says nothing about what is live, deployed or planned", () => {
    const words = strings(revocationBounds(PRODUCTION)).map((s) => s.text).join(" ");
    expect(words).not.toMatch(/\b(planned|deployed|will be|soon|later release)\b/i);
  });
});

// ── The values of other packages that the text repeats ──

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The number in the first group of `pattern`, read from a source file of another package (underscores in the number are dropped). */
function constant(file: string, pattern: RegExp): number {
  const match = pattern.exec(readFileSync(resolve(REPOSITORY, file), "utf8"));
  if (match === null) throw new Error(`${file} has no constant that matches ${pattern}: update the text of /policy and this test`);
  return Number(match[1]!.replaceAll("_", ""));
}

describe("the values of other packages that /policy repeats", () => {
  const { terms } = revocationBounds(PRODUCTION);

  test("the defaults of the indexer: the re-read, the check, the wait after a change and the age limit of an answer", () => {
    const refresher = "indexer/src/identity/refresher.ts";
    expect(terms.indexerRereadSeconds!.value).toBe(constant(refresher, /export const DEFAULT_REFRESH_MS = ([\d_]+);/) / 1000);
    expect(terms.indexerTickSeconds!.value).toBe(constant(refresher, /\nconst TICK_MS = ([\d_]+);/) / 1000);
    expect(terms.indexerSettleSeconds!.value).toBe(constant(refresher, /export const SETTLE_MS = ([\d_]+);/) / 1000);
    expect(terms.indexerAnswerMaxSeconds!.value).toBe(constant("indexer/src/listing/rule.ts", /export const IDENTITY_RESULT_MAX_AGE_MS = ([\d_]+);/) / 1000);
  });

  test("the windows of the escrow bound: Accept for 10 minutes after Submit, and a vault payment sets deliver_by at most 7 days ahead", () => {
    expect(constant("contracts/identity-marketplace/lib/identity_marketplace/common.ak", /pub const accept_window_ms: Int = ([\d_]+)/)).toBe(10 * 60_000);
    expect(constant("contracts/identity-marketplace/lib/vector_identity.ak", /pub const days_7_ms: Int = ([\d_]+)/)).toBe(7 * 86_400_000);
    const text = ESCROW_BOUND.join(" ");
    expect(text).toContain("Accept until 10 minutes after Submit");
    expect(text).toContain("at most 7 days after the end of its own validity range");
  });
});

// ── The formulas ──

describe("evaluateFormula", () => {
  const terms: Record<string, Term> = {
    a: { value: 10, kind: "setting", meaning: "a" },
    b: { value: 3.88, kind: "planning value", meaning: "b" },
    unknown: { value: null, kind: "not fixed", meaning: "u" },
  };

  test("the order of operations, parentheses and decimals", () => {
    expect(evaluateFormula("a + 2 * 3", terms)).toBe(16);
    expect(evaluateFormula("(a + 2) * 3", terms)).toBe(36);
    expect(evaluateFormula("a / 2 + 1", terms)).toBe(6);
    expect(evaluateFormula("a - 4 - 3", terms)).toBe(3);
    expect(evaluateFormula("30 * b", terms, "nearest")).toBe(116);
    expect(evaluateFormula("30 * b", terms, "up")).toBe(117);
  });

  test("a whole number in exact arithmetic is not rounded up to the next second", () => {
    expect(evaluateFormula("30 * 8", terms)).toBe(240);
    expect(evaluateFormula("0.1 + 0.2 + 9.7", terms)).toBe(10);
  });

  test("a term without a value gives null, also inside a longer formula", () => {
    expect(evaluateFormula("unknown", terms)).toBeNull();
    expect(evaluateFormula("2 * unknown + a", terms)).toBeNull();
  });

  test("a formula with a name that does not exist, a character that it may not have or no end is an error", () => {
    expect(() => evaluateFormula("a + missing", terms)).toThrow(/missing/);
    expect(() => evaluateFormula("a + 2; 3", terms)).toThrow(/character/);
    expect(() => evaluateFormula("a +", terms)).toThrow(/ends too early/);
    expect(() => evaluateFormula("(a + 2", terms)).toThrow(/ends too early/);
    expect(() => evaluateFormula("(a + 2 3)", terms)).toThrow(/parenthesis/);
    expect(() => evaluateFormula("a b", terms)).toThrow(/after its end/);
    expect(() => evaluateFormula("* a", terms)).toThrow(/where a value belongs/);
  });
});
