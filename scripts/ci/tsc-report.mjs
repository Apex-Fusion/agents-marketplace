#!/usr/bin/env node
/**
 * scripts/ci/tsc-report.mjs: type-check test files in report-only mode.
 *
 *   node scripts/ci/tsc-report.mjs <tsconfig>...
 *
 * It needs Node 20. It runs `pnpm exec tsc --noEmit -p <tsconfig>` for each config from the repository root (the configs run at the
 * same time), counts the errors, prints the first errors and writes one table to the job summary ($GITHUB_STEP_SUMMARY). The exit status is 1 when any config
 * has an error or cannot run. The job `typecheck` of .github/workflows/ci.yml sets `continue-on-error: true` on this step until
 * phase 4 of docs/TEST-REVISION.md fixed the errors. Then the step becomes blocking.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";

const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/** The errors of the output of `tsc --pretty false`: the lines `file(line,col): error TSnnnn: text`. */
export function parseErrors(output) {
  const errors = [];
  for (const line of output.split("\n")) {
    const match = ERROR_LINE.exec(line);
    if (match !== null) errors.push({ file: match[1], code: match[4], line });
  }
  return errors;
}

/** One table row: errors, files with errors and the most frequent codes. */
export function describe(errors) {
  const files = new Set(errors.map((error) => error.file));
  const codes = new Map();
  for (const error of errors) codes.set(error.code, (codes.get(error.code) ?? 0) + 1);
  const top = [...codes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([code, count]) => `${code} x${count}`);
  return { count: errors.length, files: files.size, top };
}

export function summaryText(rows) {
  const out = [
    "### Type check of test files (report only)",
    "",
    "| Config | Errors | Files with errors | Most frequent |",
    "|---|---:|---:|---|",
    ...rows.map((row) => `| \`${row.config}\` | ${row.failed ? "tsc did not run" : row.count} | ${row.failed ? "" : row.files} | ${row.top.join(", ")} |`),
    "",
    "The errors do not fail the job yet. Phase 4 of docs/TEST-REVISION.md fixes them and makes this step blocking.",
  ];
  return `${out.join("\n")}\n`;
}

/** Run `pnpm exec tsc` for one config: { output, failed }. A non-zero status with no parsed error means that tsc could not run. */
function runTsc(config) {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "tsc", "--noEmit", "--pretty", "false", "-p", config], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ output: String(error), status: 1 }));
    child.on("close", (status) => resolve({ output, status }));
  });
}

async function main() {
  const configs = process.argv.slice(2);
  if (configs.length === 0) {
    console.error("usage: node scripts/ci/tsc-report.mjs <tsconfig>...");
    process.exit(2);
  }
  // The configs run at the same time, at most one for each CPU, so that the step takes the time of the slowest config.
  const rows = new Array(configs.length);
  const outputs = new Array(configs.length);
  let next = 0;
  const worker = async () => {
    while (next < configs.length) {
      const index = next++;
      const { output, status } = await runTsc(configs[index]);
      const errors = parseErrors(output);
      outputs[index] = { output, errors };
      rows[index] = { config: configs[index], failed: status !== 0 && errors.length === 0, ...describe(errors) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(configs.length, Math.max(1, availableParallelism())) }, worker));
  rows.forEach((row, index) => {
    const { output, errors } = outputs[index];
    console.log(`::group::${row.config}: ${row.failed ? "tsc did not run" : `${errors.length} error(s)`}`);
    if (row.failed) console.log(output.split("\n").slice(0, 30).join("\n"));
    else for (const error of errors.slice(0, 40)) console.log(error.line);
    console.log("::endgroup::");
  });
  const text = summaryText(rows);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.exit(rows.some((row) => row.failed || row.count > 0) ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
