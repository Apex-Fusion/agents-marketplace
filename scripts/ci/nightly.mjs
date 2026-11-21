#!/usr/bin/env node
/**
 * scripts/ci/nightly.mjs: the plan and the report of .github/workflows/nightly.yml.
 *
 *   node scripts/ci/nightly.mjs plan     writes the outputs `skip` and `seed` to $GITHUB_OUTPUT.
 *   node scripts/ci/nightly.mjs report   opens, updates or closes the issue with the label `nightly-failure`.
 *
 * It needs Node 20 and no packages. The runners have no `gh`, so it calls the REST API with fetch and $GITHUB_TOKEN.
 *
 * plan:   `skip` is "true" for a scheduled run when the head of the branch already has a successful nightly run. A run that
 *         someone starts by hand never skips. `seed` is a new random 32-bit number for the Aiken property tests.
 * report: env NEEDS holds toJSON(needs) of the job `report`. One failed or cancelled job opens the issue (or updates the open one,
 *         with a comment). A run in which every job that ran passed closes the open issue with a comment. A run in which no job ran
 *         (plan said skip) does nothing.
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_EVENT_NAME,
 * GITHUB_OUTPUT; for `report` also NEEDS, SEED and ASSIGNEE (default dcejtlin-apex).
 */
import { randomInt } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const LABEL = "nightly-failure";
export const TITLE = "Nightly test run is red";
const WORKFLOW_FILE = "nightly.yml";

/**
 * The verdict of the jobs: { failed: [names], passed: [names], skipped: [names] }. The job `plan` counts only when it did not
 * succeed: all other jobs are skipped then, and a silent night must not look green.
 */
export function judge(needs) {
  const verdict = { failed: [], passed: [], skipped: [] };
  for (const [name, job] of Object.entries(needs)) {
    const result = job?.result;
    if (name === "plan" && result === "success") continue;
    if (result === "success") verdict.passed.push(name);
    else if (result === "skipped") verdict.skipped.push(name);
    else verdict.failed.push(name); // failure, cancelled, or a result that nobody knows
  }
  return verdict;
}

/** What `report` does: "open-or-update", "close" or "nothing". */
export function decideAction(needs) {
  const { failed, passed } = judge(needs);
  if (failed.length > 0) return "open-or-update";
  return passed.length > 0 ? "close" : "nothing";
}

export function issueBody({ runUrl, sha, serverUrl, repository, failedJobs, seed, now }) {
  const lines = [
    "The nightly test run failed.",
    "",
    `- Run: ${runUrl}`,
    `- Commit: [\`${sha.slice(0, 10)}\`](${serverUrl}/${repository}/commit/${sha})`,
    "- Failed jobs:",
    ...(failedJobs.length > 0 ? failedJobs.map((job) => `  - ${job.url ? `[${job.name}](${job.url})` : job.name}`) : ["  - (none named)"]),
    `- Seed of the Aiken property tests: \`${seed || "(none)"}\`. To repeat one shard: \`scripts/aiken-check --shard N --of 4 --seed ${seed || "<seed>"} --max-success 100\`.`,
    `- Updated: ${now}`,
    "",
    "The next green nightly run closes this issue. A red nightly run does not stop a deploy.",
  ];
  return `${lines.join("\n")}\n`;
}

/** The GitHub REST client: api(method, path, body) -> parsed JSON, or null for 204 and (with `allow404`) 404. */
export function makeApi(env, fetchImpl = fetch) {
  const base = env.GITHUB_API_URL ?? "https://api.github.com";
  return async (method, path, body, { allow404 = false } = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "agents-marketplace-nightly",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404 && allow404) return null;
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response.status === 204 ? null : response.json();
  };
}

export async function plan(env, api) {
  const repository = env.GITHUB_REPOSITORY;
  let skip = false;
  if (env.GITHUB_EVENT_NAME === "schedule") {
    const runs = await api("GET", `/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${env.GITHUB_SHA}&status=success&per_page=1`);
    skip = (runs?.total_count ?? 0) > 0;
  }
  const seed = randomInt(1, 2 ** 32);
  return { skip, seed };
}

async function ensureLabel(repository, api) {
  const found = await api("GET", `/repos/${repository}/labels/${LABEL}`, undefined, { allow404: true });
  if (found === null) {
    await api("POST", `/repos/${repository}/labels`, { name: LABEL, color: "b60205", description: "The nightly test run failed. Closed by the next green run." });
  }
}

async function openIssues(repository, api) {
  const issues = await api("GET", `/repos/${repository}/issues?labels=${LABEL}&state=open&per_page=100`);
  return (issues ?? []).filter((issue) => issue.pull_request === undefined).sort((a, b) => a.number - b.number);
}

/** The failed jobs of the run with their page: [{ name, url }]. A failure of the jobs call gives the names only. */
async function failedJobDetails(repository, runId, names, api) {
  try {
    const data = await api("GET", `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`);
    const jobs = (data?.jobs ?? []).filter((job) => job.conclusion === "failure" || job.conclusion === "cancelled");
    if (jobs.length > 0) return jobs.map((job) => ({ name: job.name, url: job.html_url }));
  } catch {
    // Fall through: the names of the jobs are enough.
  }
  return names.map((name) => ({ name, url: undefined }));
}

export async function report(env, api, now = new Date().toISOString()) {
  const repository = env.GITHUB_REPOSITORY;
  const needs = JSON.parse(env.NEEDS ?? "{}");
  const action = needs.plan?.outputs?.skip === "true" ? "nothing" : decideAction(needs);
  const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`;
  const serverUrl = env.GITHUB_SERVER_URL ?? "https://github.com";
  const assignee = env.ASSIGNEE || "dcejtlin-apex";
  if (action === "nothing") return { action };

  const open = await openIssues(repository, api);
  if (action === "close") {
    for (const issue of open) {
      await api("POST", `/repos/${repository}/issues/${issue.number}/comments`, { body: `The nightly run passed: ${runUrl} (commit ${env.GITHUB_SHA}). This issue closes.` });
      await api("PATCH", `/repos/${repository}/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
    }
    return { action, closed: open.map((issue) => issue.number) };
  }

  const failedJobs = await failedJobDetails(repository, env.GITHUB_RUN_ID, judge(needs).failed, api);
  const body = issueBody({ runUrl, sha: env.GITHUB_SHA, serverUrl, repository, failedJobs, seed: env.SEED, now });
  if (open.length > 0) {
    const issue = open[0];
    await api("PATCH", `/repos/${repository}/issues/${issue.number}`, { body, assignees: [assignee] });
    await api("POST", `/repos/${repository}/issues/${issue.number}/comments`, {
      body: `The nightly run failed again: ${runUrl}\nFailed jobs: ${failedJobs.map((job) => job.name).join(", ")}. Seed: \`${env.SEED || "(none)"}\`.`,
    });
    return { action, updated: issue.number };
  }
  await ensureLabel(repository, api);
  const created = await api("POST", `/repos/${repository}/issues`, { title: TITLE, body, labels: [LABEL], assignees: [assignee] });
  return { action, created: created?.number };
}

async function main() {
  const command = process.argv[2];
  const api = makeApi(process.env);
  if (command === "plan") {
    const { skip, seed } = await plan(process.env, api);
    console.log(`nightly plan: skip=${skip} seed=${seed}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\nseed=${seed}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, skip ? "The head of the branch has a green nightly run: all jobs are skipped.\n" : `Seed of the Aiken property tests: \`${seed}\`.\n`);
    }
  } else if (command === "report") {
    const result = await report(process.env, api);
    console.log(`nightly report: ${JSON.stringify(result)}`);
  } else {
    console.error("usage: node scripts/ci/nightly.mjs plan|report");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
