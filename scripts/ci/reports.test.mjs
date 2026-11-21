// Tests of the pure functions of scripts/ci/vitest-run.mjs and scripts/ci/tsc-report.mjs. Run: node --test scripts/ci/
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe as describeErrors, parseErrors, summaryText as tscSummary } from "./tsc-report.mjs";
import { buildCommand, checkRun, parseReport, slowest, summaryText } from "./vitest-run.mjs";

test("buildCommand: all runs `pnpm test`, selected runs the listed files and excludes the others", () => {
  const [program, args] = buildCommand("all", [], [], "/tmp/r.json");
  assert.equal(program, "pnpm");
  assert.deepEqual(args, ["test", "--reporter=default", "--reporter=json", "--outputFile.json=/tmp/r.json"]);
  const [, selected] = buildCommand("selected", ["a.test.ts", "b/c.test.ts"], ["x/a.test.ts"], "/tmp/r.json");
  assert.deepEqual(selected, [
    "exec", "vitest", "run", "a.test.ts", "b/c.test.ts", "--exclude", "x/a.test.ts", "--reporter=default", "--reporter=json", "--outputFile.json=/tmp/r.json",
  ]);
  assert.throws(() => buildCommand("none", [], [], "/tmp/r.json"), /VITEST_MODE/);
});

test("parseReport: relative paths, durations and test counts", () => {
  const files = parseReport(
    { testResults: [{ name: "/repo/tests/unit/a.test.ts", startTime: 1000, endTime: 1250.4, status: "passed", assertionResults: [{}, {}] }] },
    "/repo",
  );
  assert.deepEqual(files, [{ path: "tests/unit/a.test.ts", ms: 250, tests: 2, status: "passed" }]);
  assert.deepEqual(parseReport({}, "/repo"), []);
});

test("checkRun: a run with no file fails; a selected run must run exactly the listed files", () => {
  const ran = (...paths) => paths.map((path) => ({ path, ms: 1, tests: 1, status: "passed" }));
  assert.deepEqual(checkRun("all", [], ran("a.test.ts")), []);
  assert.match(checkRun("all", [], [])[0], /ran no test file/);
  assert.deepEqual(checkRun("selected", ["a.test.ts", "b.test.ts"], ran("b.test.ts", "a.test.ts")), []);
  assert.match(checkRun("selected", ["a.test.ts"], [])[0], /ran no test file/);
  const missing = checkRun("selected", ["a.test.ts", "b.test.ts"], ran("a.test.ts"));
  assert.equal(missing.length, 1);
  assert.match(missing[0], /selected but not run \(1\): b\.test\.ts/);
  const extra = checkRun("selected", ["gateway/test/http.test.ts"], ran("gateway/test/http.test.ts", "identity-gateway/test/http.test.ts"));
  assert.equal(extra.length, 1);
  assert.match(extra[0], /run but not selected \(1\): identity-gateway\/test\/http\.test\.ts/);
});

test("slowest: the 10 slowest files, longest first", () => {
  const files = Array.from({ length: 15 }, (_, index) => ({ path: `f${index}.test.ts`, ms: index * 10, tests: 1, status: "passed" }));
  const top = slowest(files);
  assert.equal(top.length, 10);
  assert.equal(top[0].path, "f14.test.ts");
  assert.equal(top[9].path, "f5.test.ts");
  assert.match(summaryText("all", { numPassedTests: 3, numFailedTests: 0, numPendingTests: 1 }, files, []), /\| `f14\.test\.ts` \| 140 \| 1 \|/);
});

test("parseErrors and describe: count the errors of `tsc --pretty false`", () => {
  const output = [
    "tests/unit/a.test.ts(1,2): error TS2322: Type 'a' is not assignable to type 'b'.",
    "tests/unit/a.test.ts(5,1): error TS2322: Type 'c' is not assignable to type 'd'.",
    "tests/unit/b.test.ts(7,3): error TS2307: Cannot find module 'x'.",
    "  The detail line of an error.",
    "Found 3 errors in 2 files.",
  ].join("\n");
  const errors = parseErrors(output);
  assert.equal(errors.length, 3);
  assert.deepEqual(describeErrors(errors), { count: 3, files: 2, top: ["TS2322 x2", "TS2307 x1"] });
  assert.deepEqual(describeErrors([]), { count: 0, files: 0, top: [] });
  assert.match(tscSummary([{ config: "tests/tsconfig.json", failed: false, count: 3, files: 2, top: ["TS2322 x2"] }]), /\| `tests\/tsconfig\.json` \| 3 \| 2 \| TS2322 x2 \|/);
  assert.match(tscSummary([{ config: "x.json", failed: true, count: 0, files: 0, top: [] }]), /tsc did not run/);
});
