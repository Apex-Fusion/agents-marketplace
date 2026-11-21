// Table test of scripts/ci/gate.mjs. Run: node --test scripts/ci/
import assert from "node:assert/strict";
import { test } from "node:test";
import { JOBS, decide, linesNotice, summaryText } from "./gate.mjs";

const RESULTS = ["success", "failure", "cancelled", "skipped", ""];

/** The legal state of one job: the pairs (flag value, result) that the gate accepts. Written as a table, apart from decide(). */
const ACCEPTED = {
  typecheck: [["true", "success"], ["false", "success"], ["false", "skipped"]],
  vitest: [["all", "success"], ["selected", "success"], ["none", "success"], ["none", "skipped"]],
  "aiken-eval": [["true", "success"], ["false", "success"], ["false", "skipped"]],
  "aiken-check": [["true", "success"], ["false", "success"], ["false", "skipped"]],
  "legacy-contract": [["true", "success"], ["false", "success"], ["false", "skipped"]],
};

const FLAG_VALUES = { typecheck: ["true", "false"], vitest: ["none", "all", "selected"], "aiken-eval": ["true", "false"], "aiken-check": ["true", "false"], "legacy-contract": ["true", "false"] };

const envFor = (changes, states) => {
  const env = { RESULT_CHANGES: changes };
  for (const { job, result, flag } of JOBS) {
    env[flag] = states[job][0];
    env[result] = states[job][1];
  }
  return env;
};

/** Every combination of (flag value, result) for one job. */
const statesOf = (job) => FLAG_VALUES[job].flatMap((flag) => RESULTS.map((result) => [flag, result]));

test("JOBS names the five jobs of the workflow", () => {
  assert.deepEqual(JOBS.map((job) => job.job), ["typecheck", "vitest", "aiken-eval", "aiken-check", "legacy-contract"]);
});

test("every result of every job with every flag value: the gate passes only for accepted pairs (and a green `changes`)", () => {
  const jobs = JOBS.map((job) => job.job);
  let combinations = 0;
  let passed = 0;
  const walk = (index, states) => {
    if (index === jobs.length) {
      for (const changes of RESULTS) {
        const expected = changes === "success" && jobs.every((job) => ACCEPTED[job].some(([flag, result]) => flag === states[job][0] && result === states[job][1]));
        const verdict = decide(envFor(changes, states));
        assert.equal(verdict.ok, expected, `changes=${changes} states=${JSON.stringify(states)}`);
        assert.equal(verdict.problems.length === 0, expected);
        combinations += 1;
        if (verdict.ok) passed += 1;
      }
      return;
    }
    for (const state of statesOf(jobs[index])) walk(index + 1, { ...states, [jobs[index]]: state });
  };
  walk(0, {});
  // 5 results of `changes` times the product of the states of the jobs: (2*5)^4 * (3*5) = 150,000 times 5.
  assert.equal(combinations, 5 * 10 ** 4 * 15);
  // Accepted: changes success; 3 pairs for each of the 4 two-valued jobs; 4 pairs for vitest.
  assert.equal(passed, 3 ** 4 * 4);
});

test("the cases that the design names", () => {
  const green = { typecheck: ["true", "success"], vitest: ["selected", "success"], "aiken-eval": ["false", "skipped"], "aiken-check": ["false", "skipped"], "legacy-contract": ["false", "skipped"] };
  assert.equal(decide(envFor("success", green)).ok, true);
  // A skipped job that had to run: GitHub counts it as passed, the gate does not.
  assert.equal(decide(envFor("success", { ...green, "aiken-check": ["true", "skipped"] })).ok, false);
  // A cancelled run.
  assert.equal(decide(envFor("success", { ...green, vitest: ["selected", "cancelled"] })).ok, false);
  // A job that failed although its flag was off.
  assert.equal(decide(envFor("success", { ...green, "legacy-contract": ["false", "failure"] })).ok, false);
  // `changes` failed: the flags are empty.
  assert.equal(decide({ RESULT_CHANGES: "failure" }).ok, false);
  assert.equal(decide({}).ok, false);
  // A flag with a value that the gate does not know.
  assert.equal(decide({ ...envFor("success", green), FLAG_VITEST: "some" }).ok, false);
  // Docs only: all flags off, all jobs skipped.
  const docs = { typecheck: ["false", "skipped"], vitest: ["none", "skipped"], "aiken-eval": ["false", "skipped"], "aiken-check": ["false", "skipped"], "legacy-contract": ["false", "skipped"] };
  assert.equal(decide(envFor("success", docs)).ok, true);
});

test("the problems name the job and the result", () => {
  const verdict = decide({
    RESULT_CHANGES: "success", FLAG_TYPECHECK: "true", RESULT_TYPECHECK: "failure", FLAG_VITEST: "none", RESULT_VITEST: "skipped",
    FLAG_AIKEN_EVAL: "false", RESULT_AIKEN_EVAL: "skipped", FLAG_AIKEN_CHECK: "true", RESULT_AIKEN_CHECK: "skipped",
    FLAG_LEGACY_CONTRACT: "false", RESULT_LEGACY_CONTRACT: "skipped",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems.length, 2);
  assert.match(verdict.problems[0], /^typecheck: it had to run .* "failure"/);
  assert.match(verdict.problems[1], /^aiken-check: it had to run .* "skipped"/);
  assert.match(summaryText(verdict, ""), /### Gate: FAILED/);
});

test("the notice about test lines and source lines", () => {
  assert.match(linesNotice({ TEST_LINES: "300", SOURCE_LINES: "100" }), /Test lines are more than source lines: the text of the pull request must give the reason\./);
  assert.doesNotMatch(linesNotice({ TEST_LINES: "100", SOURCE_LINES: "100" }), /must give the reason/);
  assert.doesNotMatch(linesNotice({ TEST_LINES: "0", SOURCE_LINES: "0" }), /must give the reason/);
  assert.equal(linesNotice({}), "");
  assert.equal(linesNotice({ TEST_LINES: "", SOURCE_LINES: "" }), "");
  assert.equal(linesNotice({ TEST_LINES: "x", SOURCE_LINES: "1" }), "");
  // The notice never fails the gate.
  const ok = decide(envFor("success", { typecheck: ["false", "skipped"], vitest: ["none", "skipped"], "aiken-eval": ["false", "skipped"], "aiken-check": ["false", "skipped"], "legacy-contract": ["false", "skipped"] }));
  assert.equal(ok.ok, true);
});
