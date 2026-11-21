#!/usr/bin/env node
/**
 * scripts/ci/vitest-run.mjs: run the vitest part of the workflow `CI` and check what ran.
 *
 * It needs Node 20 and no packages. It runs `pnpm`, so run it from the repository root after `pnpm install`.
 *
 * Environment:
 *   VITEST_MODE     "all" runs `pnpm test`. "selected" runs the files of VITEST_FILES.
 *   VITEST_FILES    the selected test files, one on each line.
 *   VITEST_EXCLUDE  test files to leave out, one on each line. The vitest filter is a substring match, so "gateway/test/a.test.ts"
 *                   also matches "identity-gateway/test/a.test.ts": the list names the files that must not run.
 *   VITEST_REPORT   path of the JSON report (default: $RUNNER_TEMP/vitest-result.json).
 *
 * The run fails when vitest fails, when it ran no file although the mode asked for tests, or (mode "selected") when the files
 * that ran are not the files of the list. It writes the 10 slowest test files to the job summary ($GITHUB_STEP_SUMMARY).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const lines = (text) => (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

/** The command that runs the tests: [program, arguments]. */
export function buildCommand(mode, files, exclude, reportPath) {
  const reporters = ["--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`];
  if (mode === "all") return ["pnpm", ["test", ...reporters]];
  if (mode === "selected") return ["pnpm", ["exec", "vitest", "run", ...files, ...exclude.flatMap((file) => ["--exclude", file]), ...reporters]];
  throw new Error(`VITEST_MODE must be "all" or "selected", not "${mode}"`);
}

/** The test files of a vitest JSON report: path (relative to `cwd`), duration in ms, test count and status. */
export function parseReport(report, cwd) {
  return (report.testResults ?? []).map((file) => ({
    path: relative(cwd, file.name).split("\\").join("/"),
    ms: Math.max(0, Math.round((file.endTime ?? 0) - (file.startTime ?? 0))),
    tests: (file.assertionResults ?? []).length,
    status: file.status,
  }));
}

/** The problems of one run: a list of messages, empty when the run is as expected. */
export function checkRun(mode, expected, ran) {
  const problems = [];
  if (ran.length === 0) problems.push(`vitest ran no test file (mode ${mode}${mode === "selected" ? `, ${expected.length} selected` : ""})`);
  if (mode === "selected") {
    const ranSet = new Set(ran.map((file) => file.path));
    const missing = expected.filter((file) => !ranSet.has(file));
    const extra = [...ranSet].filter((file) => !expected.includes(file));
    if (missing.length > 0) problems.push(`selected but not run (${missing.length}): ${missing.slice(0, 10).join(", ")}`);
    if (extra.length > 0) problems.push(`run but not selected (${extra.length}): ${extra.slice(0, 10).join(", ")}`);
  }
  return problems;
}

export function slowest(files, count = 10) {
  return [...files].sort((a, b) => b.ms - a.ms || a.path.localeCompare(b.path)).slice(0, count);
}

export function summaryText(mode, report, files, problems) {
  const out = [
    "### Vitest",
    "",
    `Mode: \`${mode}\`. Files run: ${files.length}. Tests: ${report.numPassedTests ?? 0} passed, ${report.numFailedTests ?? 0} failed, ${report.numPendingTests ?? 0} skipped.`,
    "",
    "The 10 slowest test files:",
    "",
    "| File | Time (ms) | Tests |",
    "|---|---:|---:|",
    ...slowest(files).map((file) => `| \`${file.path}\` | ${file.ms} | ${file.tests} |`),
  ];
  if (problems.length > 0) out.push("", ...problems.map((problem) => `- **${problem}**`));
  return `${out.join("\n")}\n`;
}

function main() {
  const mode = process.env.VITEST_MODE ?? "";
  const expected = lines(process.env.VITEST_FILES);
  const exclude = lines(process.env.VITEST_EXCLUDE);
  const reportPath = process.env.VITEST_REPORT ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "vitest-result.json");
  if (mode === "selected" && expected.length === 0) {
    console.error("VITEST_MODE is selected but VITEST_FILES is empty");
    process.exit(1);
  }
  const [program, args] = buildCommand(mode, expected, exclude, reportPath);
  rmSync(reportPath, { force: true });
  console.log(`$ ${program} ${args.join(" ")}`);
  const run = spawnSync(program, args, { stdio: "inherit", env: process.env });
  if (run.error) {
    console.error(`cannot run ${program}: ${run.error.message}`);
    process.exit(1);
  }
  let status = run.status ?? 1;
  if (!existsSync(reportPath)) {
    console.error(`vitest wrote no report to ${reportPath}`);
    process.exit(status === 0 ? 1 : status);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const files = parseReport(report, process.cwd());
  const problems = checkRun(mode, expected, files);
  const text = summaryText(mode, report, files, problems);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  for (const problem of problems) console.log(`::error::${problem}`);
  if (status === 0 && problems.length > 0) status = 1;
  process.exit(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
