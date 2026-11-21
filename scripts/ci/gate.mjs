#!/usr/bin/env node
/**
 * scripts/ci/gate.mjs: decide the result of the required check `gate` of the workflow `CI`.
 *
 * It needs Node 20 and no packages. The job `gate` runs it with `if: always()` after all other jobs, because GitHub counts a
 * skipped required job as passed. The rules:
 *   - The job `changes` must be "success". Without it no flag can be trusted.
 *   - A job whose flag is on must be "success". "skipped", "failure" and "cancelled" fail the gate.
 *   - A job whose flag is off must be "skipped" or "success".
 *
 * Environment (the `result` of each job and the outputs of the job `changes`):
 *   RESULT_CHANGES, RESULT_TYPECHECK, RESULT_VITEST, RESULT_AIKEN_EVAL, RESULT_AIKEN_CHECK, RESULT_LEGACY_CONTRACT
 *   FLAG_TYPECHECK ("true"/"false"), FLAG_VITEST ("none"/"all"/"selected"), FLAG_AIKEN_EVAL, FLAG_AIKEN_CHECK, FLAG_LEGACY_CONTRACT
 *   TEST_LINES, SOURCE_LINES (lines that the change adds); EVENT_NAME
 *
 * A new job that is not in JOBS (and in the `needs` list of the job `gate`) blocks nothing. Add it to both.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The jobs that the flags of `changes` switch on and off. `values` are the legal flag values; `on` are the values that run the job. */
export const JOBS = [
  { job: "typecheck", result: "RESULT_TYPECHECK", flag: "FLAG_TYPECHECK", values: ["true", "false"], on: ["true"] },
  { job: "vitest", result: "RESULT_VITEST", flag: "FLAG_VITEST", values: ["none", "all", "selected"], on: ["all", "selected"] },
  { job: "aiken-eval", result: "RESULT_AIKEN_EVAL", flag: "FLAG_AIKEN_EVAL", values: ["true", "false"], on: ["true"] },
  { job: "aiken-check", result: "RESULT_AIKEN_CHECK", flag: "FLAG_AIKEN_CHECK", values: ["true", "false"], on: ["true"] },
  { job: "legacy-contract", result: "RESULT_LEGACY_CONTRACT", flag: "FLAG_LEGACY_CONTRACT", values: ["true", "false"], on: ["true"] },
];

/** The verdict for the env: { ok, rows: [{ job, flag, result, verdict }], problems: [] }. */
export function decide(env) {
  const rows = [];
  const problems = [];
  const changes = env.RESULT_CHANGES ?? "";
  rows.push({ job: "changes", flag: "always", result: changes || "(none)", verdict: changes === "success" ? "ok" : "FAIL" });
  if (changes !== "success") {
    problems.push(`the job "changes" is "${changes || "(none)"}", not "success": no flag can be trusted`);
    return { ok: false, rows, problems };
  }
  for (const { job, result, flag, values, on } of JOBS) {
    const flagValue = env[flag] ?? "";
    const resultValue = env[result] ?? "";
    let verdict = "ok";
    if (!values.includes(flagValue)) {
      verdict = "FAIL";
      problems.push(`${job}: the flag ${flag} is "${flagValue}", expected one of ${values.join(", ")}`);
    } else if (on.includes(flagValue)) {
      if (resultValue !== "success") {
        verdict = "FAIL";
        problems.push(`${job}: it had to run (flag ${flagValue}) and its result is "${resultValue || "(none)"}"`);
      }
    } else if (resultValue !== "success" && resultValue !== "skipped") {
      verdict = "FAIL";
      problems.push(`${job}: it did not have to run (flag ${flagValue}) and its result is "${resultValue || "(none)"}"`);
    }
    rows.push({ job, flag: flagValue, result: resultValue || "(none)", verdict });
  }
  return { ok: problems.length === 0, rows, problems };
}

/** The notice about test lines against source lines, or "" when there is nothing to say. */
export function linesNotice(env) {
  if (!/^\d+$/.test(env.TEST_LINES ?? "") || !/^\d+$/.test(env.SOURCE_LINES ?? "")) return "";
  const test = Number(env.TEST_LINES);
  const source = Number(env.SOURCE_LINES);
  const text = `This change adds ${test} lines of test code and ${source} lines of source code.`;
  if (test > source) return `${text} Test lines are more than source lines: the text of the pull request must give the reason.`;
  return text;
}

export function summaryText(verdict, notice) {
  const out = [
    `### Gate: ${verdict.ok ? "passed" : "FAILED"}`,
    "",
    "| Job | Flag | Result | Verdict |",
    "|---|---|---|---|",
    ...verdict.rows.map((row) => `| ${row.job} | ${row.flag} | ${row.result} | ${row.verdict} |`),
  ];
  if (verdict.problems.length > 0) out.push("", ...verdict.problems.map((problem) => `- ${problem}`));
  if (notice !== "") out.push("", `**Notice.** ${notice}`);
  return `${out.join("\n")}\n`;
}

function main() {
  const verdict = decide(process.env);
  const notice = linesNotice(process.env);
  const text = summaryText(verdict, notice);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (notice.includes("must give the reason")) console.log(`::notice title=Test lines are more than source lines::${notice}`);
  for (const problem of verdict.problems) console.log(`::error::${problem}`);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
