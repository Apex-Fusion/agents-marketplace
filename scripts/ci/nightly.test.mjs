// Tests of scripts/ci/nightly.mjs with a fake GitHub API. Run: node --test scripts/ci/
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { LABEL, TITLE, decideAction, issueBody, judge, makeApi, plan, report } from "./nightly.mjs";

const ENV = {
  GITHUB_REPOSITORY: "Apex-Fusion/agents-marketplace", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "777", GITHUB_SHA: "a".repeat(40),
  GITHUB_EVENT_NAME: "schedule", SEED: "358316146",
};

/** A fake API: `state` holds the open issues, the labels and the jobs of the run; `calls` records each call. */
function fakeApi(state) {
  const calls = [];
  const api = async (method, path, body, options = {}) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/repos/Apex-Fusion/agents-marketplace/issues?")) return state.issues ?? [];
    if (method === "GET" && path.includes("/labels/")) return state.labelExists ? { name: LABEL } : options.allow404 ? null : (() => { throw new Error("404"); })();
    if (method === "GET" && path.includes("/actions/runs/777/jobs")) {
      if (state.jobsFail) throw new Error("jobs call failed");
      return { jobs: state.jobs ?? [] };
    }
    if (method === "GET" && path.includes("/actions/workflows/nightly.yml/runs")) return { total_count: state.greenRuns ?? 0 };
    if (method === "POST" && path.endsWith("/issues")) return { number: 42 };
    return null;
  };
  return { api, calls };
}
const needs = (results, skip = "false") => ({ plan: { result: "success", outputs: { skip, seed: "1" } }, ...Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { result }])) });

test("judge and decideAction: one failed or cancelled job opens the issue; only green jobs close it; skipped jobs say nothing", () => {
  assert.deepEqual(judge(needs({ vitest: "success", aiken: "failure", types: "skipped" })), { failed: ["aiken"], passed: ["vitest"], skipped: ["types"] });
  assert.equal(decideAction(needs({ vitest: "success", aiken: "failure" })), "open-or-update");
  assert.equal(decideAction(needs({ vitest: "cancelled" })), "open-or-update");
  assert.equal(decideAction(needs({ vitest: "success", aiken: "success", types: "skipped" })), "close");
  assert.equal(decideAction(needs({ vitest: "skipped", aiken: "skipped" })), "nothing");
  assert.equal(decideAction({}), "nothing");
  // A failed plan skips every other job: that is red, not silent.
  assert.equal(decideAction({ plan: { result: "failure" }, vitest: { result: "skipped" } }), "open-or-update");
  assert.deepEqual(judge({ plan: { result: "failure" }, vitest: { result: "skipped" } }).failed, ["plan"]);
});

test("plan: a scheduled run skips when the head has a green run; a manual run never skips; the seed is a 32-bit number", async () => {
  const green = fakeApi({ greenRuns: 1 });
  const planGreen = await plan(ENV, green.api);
  assert.equal(planGreen.skip, true);
  assert.match(green.calls[0].path, /\/actions\/workflows\/nightly\.yml\/runs\?head_sha=a{40}&status=success/);
  const none = await plan(ENV, fakeApi({ greenRuns: 0 }).api);
  assert.equal(none.skip, false);
  const manual = fakeApi({ greenRuns: 5 });
  const planManual = await plan({ ...ENV, GITHUB_EVENT_NAME: "workflow_dispatch" }, manual.api);
  assert.equal(planManual.skip, false);
  assert.equal(manual.calls.length, 0);
  for (const { seed } of [planGreen, none, planManual]) assert.ok(Number.isInteger(seed) && seed >= 1 && seed < 2 ** 32);
});

test("report: a red run with no open issue makes the label and ONE issue with the run, the commit, the failed jobs and the seed", async () => {
  const { api, calls } = fakeApi({ jobs: [{ name: "aiken check (shard 2 of 4)", conclusion: "failure", html_url: "https://github.com/x/jobs/9" }, { name: "vitest", conclusion: "success", html_url: "u" }] });
  const result = await report({ ...ENV, NEEDS: JSON.stringify(needs({ vitest: "success", "aiken-check": "failure" })) }, api, "2026-11-22T02:40:00.000Z");
  assert.deepEqual(result, { action: "open-or-update", created: 42 });
  const label = calls.find((call) => call.method === "POST" && call.path.endsWith("/labels"));
  assert.equal(label.body.name, LABEL);
  const issues = calls.filter((call) => call.method === "POST" && call.path.endsWith("/issues"));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].body.title, TITLE);
  assert.deepEqual(issues[0].body.labels, [LABEL]);
  assert.deepEqual(issues[0].body.assignees, ["dcejtlin-apex"]);
  assert.match(issues[0].body.body, /actions\/runs\/777/);
  assert.match(issues[0].body.body, /a{10}/);
  assert.match(issues[0].body.body, /\[aiken check \(shard 2 of 4\)\]\(https:\/\/github\.com\/x\/jobs\/9\)/);
  assert.match(issues[0].body.body, /`358316146`/);
  assert.ok(!issues[0].body.body.includes("vitest"));
});

test("report: the label is not made again when it exists, and a failed jobs call still names the failed jobs", async () => {
  const { api, calls } = fakeApi({ labelExists: true, jobsFail: true });
  await report({ ...ENV, NEEDS: JSON.stringify(needs({ vitest: "failure" })) }, api);
  assert.equal(calls.filter((call) => call.path.endsWith("/labels")).length, 0);
  const issue = calls.find((call) => call.method === "POST" && call.path.endsWith("/issues"));
  assert.match(issue.body.body, /- vitest/);
});

test("report: a red run with an open issue updates it and adds a comment; it opens no second issue", async () => {
  const { api, calls } = fakeApi({ issues: [{ number: 12 }, { number: 30 }, { number: 31, pull_request: {} }], jobs: [{ name: "vitest", conclusion: "failure", html_url: "u" }] });
  const result = await report({ ...ENV, NEEDS: JSON.stringify(needs({ vitest: "failure" })) }, api);
  assert.deepEqual(result, { action: "open-or-update", updated: 12 });
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/issues")).length, 0);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.path, "/repos/Apex-Fusion/agents-marketplace/issues/12");
  assert.deepEqual(patch.body.assignees, ["dcejtlin-apex"]);
  const comment = calls.find((call) => call.method === "POST");
  assert.equal(comment.path, "/repos/Apex-Fusion/agents-marketplace/issues/12/comments");
  assert.match(comment.body.body, /failed again/);
});

test("report: a green run closes each open issue with a comment; with no open issue it changes nothing", async () => {
  const open = fakeApi({ issues: [{ number: 12 }, { number: 13 }] });
  const result = await report({ ...ENV, NEEDS: JSON.stringify(needs({ vitest: "success", "aiken-check": "success", types: "skipped" })) }, open.api);
  assert.deepEqual(result, { action: "close", closed: [12, 13] });
  const closes = open.calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(closes.map((call) => call.body), [{ state: "closed", state_reason: "completed" }, { state: "closed", state_reason: "completed" }]);
  assert.equal(open.calls.filter((call) => call.method === "POST" && call.path.endsWith("/comments")).length, 2);
  const none = fakeApi({ issues: [] });
  await report({ ...ENV, NEEDS: JSON.stringify(needs({ vitest: "success" })) }, none.api);
  assert.equal(none.calls.filter((call) => call.method !== "GET").length, 0);
});

test("report: a run that the plan skipped, and a run in which no job ran, call no API at all", async () => {
  const skipped = fakeApi({ issues: [{ number: 1 }] });
  assert.deepEqual(await report({ ...ENV, NEEDS: JSON.stringify(needs({ vitest: "skipped" }, "true")) }, skipped.api), { action: "nothing" });
  assert.equal(skipped.calls.length, 0);
  const idle = fakeApi({});
  assert.deepEqual(await report({ ...ENV, NEEDS: JSON.stringify(needs({ vitest: "skipped" })) }, idle.api), { action: "nothing" });
  assert.equal(idle.calls.length, 0);
});

test("issueBody names the seed and the repeat command", () => {
  const body = issueBody({ runUrl: "https://r", sha: "b".repeat(40), serverUrl: "https://github.com", repository: "o/r", failedJobs: [], seed: "5", now: "t" });
  assert.match(body, /scripts\/aiken-check --shard N --of 4 --seed 5 --max-success 100/);
  assert.match(body, /\(none named\)/);
});

test("makeApi: JSON, headers, 204, an allowed 404 and an error", async () => {
  const seen = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: text });
      if (request.url === "/missing") response.writeHead(404).end("no");
      else if (request.url === "/empty") response.writeHead(204).end();
      else if (request.url === "/boom") response.writeHead(500).end("broken");
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const api = makeApi({ GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_TOKEN: "t0k" });
    assert.deepEqual(await api("POST", "/x", { a: 1 }), { ok: true });
    assert.equal(seen[0].authorization, "Bearer t0k");
    assert.equal(seen[0].body, '{"a":1}');
    assert.equal(await api("GET", "/empty"), null);
    assert.equal(await api("GET", "/missing", undefined, { allow404: true }), null);
    await assert.rejects(() => api("GET", "/missing"), /HTTP 404/);
    await assert.rejects(() => api("GET", "/boom"), /HTTP 500 broken/);
  } finally {
    server.close();
  }
});
