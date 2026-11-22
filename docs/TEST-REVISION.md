# Test revision: design

Design of 2026-11-21 for the tests and the CI of this repository. The rules for agents are in `AGENTS.md`; the tier map and the commands are in `docs/TESTING.md`. This file records why.

Tags: **[owner]** a decision of the repository owner; **[owner, against advice]** the owner chose another option than the recommended one; **[fixed]** a consequence that the owner accepted; **[fact]** measured or read; **[default]** a choice of the design author that the owner did not decide; **[estimate]** not measured.

## 1. Purpose

The owner's words: "I just want to ship faster, of course I need correctness but I think it can be offloaded to nightly and CI tests, the local ones are too much." [owner]

The pain: (1) the load on the developer computer when agents run tests and typecheck; (2) agents use much session time to write and repair tests. [owner]

Targets: a pull request with no contract change is green in at most 3 min; a pull request that changes a contract in at most 10 min; the default `pnpm test` on a build host in at most 100 s. [owner]

## 2. Findings

| Area | Fact |
|---|---|
| Load on the developer computer | Since the tests moved to the build hosts (`rx`, 2026-11-20), 0 test or typecheck runs of this repository ran on the developer computer. [fact] |
| Session time | Test and check runs took 1.4 % of the agent time; `aiken check` was 59 % of it. Writing costs more: 38 % of the edit calls touched test files, with 48 % of the written characters. [fact] |
| Cause | No prompt of the owner asked for automated tests. 65 of 179 task briefs did; the main agents wrote them from the spec (`docs/IDENTITY_REGISTRY.md` §12) and from habits. Since 2026-10-20: 69,003 test lines against 44,362 source lines. [fact] |
| CI before the change | The job `contracts` took 15 to 20 min, of which `aiken check` took 14 to 19 min; vitest 36 to 47 s; typecheck 12 to 15 s. The deploy waited for all of it. [fact] |
| vitest | 262 files, 4,780 tests; one full run used 517 CPU s and 37 s wall on a build host; half of the CPU went to module import. No flaky test in 5 runs. Only 47 of 280 test files were type-checked. [fact] |
| Audit | 4,984 cases in 280 files, all read: 80 % valuable; about 1,240 cases and 11,500 lines can go. The weak cases cost repair time, not run time. The run time sat in about 15 files with real sleeps, retry waits, process starts and full-size data, mostly waits inside product code. [fact] |
| Aiken | 1,271 tests (20,665 test lines for 4,634 production lines) guard a frozen live contract. Thread contention made `aiken check` slow: one thread ran it in 517 s against 806 to 893 s with 16 threads, at 1/10 of the CPU. aiken v1.1.24 ran it in 168 s on one thread with the same results, but it changes the compiled code and hashes of 6 of the 8 validators. [fact] |
| Deploy rule | `deploy/mainnet/deploy.sh` rebuilt 28 compose projects for any change below `contracts/`; the images copy only the two `plutus.json` files. [fact] |

## 3. Tiers: what runs where

| Tier | When | What |
|---|---|---|
| Agent loop | during the work | `scripts/test-changed`: the tests that the changed files reach, and the typecheck of the source of the changed packages, on a build host; never the full suite [owner]. Aiken: the changed area only, with one thread [fixed]. When no build host answers: push and let CI test; nothing on the developer computer [owner]. |
| Pull request gate | each pull request | One workflow `CI`: a `changes` job, conditional test jobs, and one `gate` job (`if: always()`) as the only required check; no path filter at the workflow level [fixed]. Vitest by package: the tests that reach the source files of the changed packages and of the packages that import them, plus the test folder of each changed package, plus an always-run list [owner, against advice; fixed]. Typecheck of all source; typecheck of the test files reported from phase 1 and required after phase 4 [owner, against advice: CI only; fixed]. A change below `contracts/identity-marketplace/`: `aiken build` with the blueprint diff, the `aiken-eval` tests (`aiken tx simulate` on the committed blueprint) and `fixtures/generate.mjs --check`, on v1.1.21 [fixed]; the full `aiken check` on v1.1.24 in 4 jobs split by measured cost, with one thread, one fixed seed and a test-count check [owner; fixed]. A change below `contracts/marketplace/`: its `aiken check`, `aiken build` and blueprint diff [owner]. A docs-only change runs no test job [fixed]. |
| Push on `main` | each merge | the same jobs and path rule; then the deploy [fixed] |
| Nightly | 02:30 UTC; not again on a commit with a green nightly run | the full vitest suite with `TEST_DEPTH=nightly` (deep variants), the typecheck of the test files, `aiken check` of both contracts on v1.1.21 (the deployed compiler) in 4 jobs with one thread, a new printed seed and 100 property iterations, both blueprint diffs, `generate.mjs --check` [owner; fixed] |

## 4. Gate, merge and deploy

- `main` has branch protection: the `gate` job is the only required check, no required approval, no up-to-date rule; admins can go around it in an outage. GitHub auto-merge with the rebase method. [owner; fixed]
- An agent merges only through auto-merge; a direct push to `main` or an admin merge only on the owner's word. [fixed]
- `deploy.sh` treats only `contracts/*/plutus.json` as shared below `contracts/`. [owner]
- `deploy.sh` ignores test-only paths when it selects the projects to rebuild, so a change of tests alone restarts nothing. [default]
- A red nightly run does not stop deploys. [owner]

## 5. Aiken contracts

- Compiler: v1.1.24 for `aiken check` in the pull request gate and the agent loop, on a temporary copy with `compiler = "v1.1.24"`; the committed `aiken.toml` keeps v1.1.21 [owner, against advice; default]. v1.1.21 stays for `aiken build`, the blueprint diffs, `generate.mjs`, the `aiken tx simulate` tests and the nightly `aiken check` [owner].
- Each `aiken check` runs with `RAYON_NUM_THREADS=1`, without CPU pinning. [fixed]
- Pruning of 222 tests that repeat a rule at a second level, differ from another test by one literal, or are single elements of an enumeration. Each removed test names the kept test of the same rule; the must-keep list stays (L-1, LOW-1, LOW-2, F-05, the Decision 10 window refusals, `cut_tests`, the spec attacks); the rule-to-test maps get updated; a script checks the maps. [owner, against advice; fixed]
- The legacy contract `contracts/marketplace` (live until the drain of the legacy escrows ends) runs at night and in a pull request that changes it. [owner]
- Rule for a future contract version: one `fail` test for each refusal branch that a spec row names, one accepted control for each family of refusals, variants in a property test when a fuzzer exists, no second level of one rule except the Decision 10 window refusals. [owner]

## 6. TypeScript pruning and repairs

- Class rules on the audit candidates [owner]: wiring or echo, delete; tautology, bare not-throw, length-grew, delete, or assert the result when it is the only test of a path; duplicate, keep the one at the lowest level; variants, one table with the boundary rows and one row for each branch; over-mocked, delete, or rewrite on the shared fakes when it is the only test of a path; source-text pin, delete, except the decoder-site guard.
- Proof for each pruning change: line and branch coverage of each source file before and after, on a build host, in the pull request text. A drop in a money, signature or chain-decoding file stops the change until a test covers the lines again or the owner accepts the drop. [owner; fixed]
- About 15 table tests for money and key paths that have no direct test. [owner]
- UI tests check behavior and find elements by role or test id; the identity gateway policy page keeps its text checks. [owner]
- Repairs of tests that are wrong today: a sweeper case that passes without reaching its subject, golden files that skip in silence when their fixture is missing, a file with no assertion, 10 cases skipped with no condition, timing asserts, a host file path that the handlers read, stale "RED phase" headers. [fixed]

## 7. Structure and speed

- One vitest workspace with the projects `unit`, `ui` and `aiken-eval`. [fixed]
- Deep variants only at night through `TEST_DEPTH=nightly`; each property test prints its seed. [fixed]
- Cheaper forms of the slow files: fake timers, one fixture for each table, `Buffer.equals`, fewer ticks, an entry test in process. [fixed]
- Product changes with unchanged production values, one pull request each [owner]: (1) the gateway passes the SDK poll interval from a setting; (2) the gateway wallet confirmation poll, the indexer retry wait and the supplier SIGTERM grace become settings; (3) the status-list decoder skips zero entries; (4) the barrel `packages/shared/src/tx/server.ts` splits into a part with lucid and a part without. The owner dropped (4) after its measurement (section 16).
- The flat `tests/unit` layout stays. [owner]

## 8. Rules for agents [owner]

The rules are in `AGENTS.md`. In short: a new test only for a fixed bug, for new or changed behavior on a money, signature, chain-data or security path, or for a case that the owner or a spec row names; no mutation checks by hand [owner, against advice]; task briefs follow the same rules; the agent loop of section 3; an open `nightly-failure` issue goes into the first report; a pull request that adds more test lines than source lines gives the reason.

## 9. Alarms and notices

- A red nightly run opens or updates one GitHub issue with the label `nightly-failure`, assigned to the owner; the next green run closes it. [owner; fixed]
- Each CI run lists its 10 slowest test files in the run summary. [fixed]
- Each pull request summary shows the test lines and the source lines that it adds. [owner]

## 10. Build plan [owner]

| Phase | Content |
|---|---|
| 1. Gate and rules | the `deploy.sh` change first; the new `ci.yml`; the nightly workflow; v1.1.24 in the aiken setup action; `scripts/test-changed`, `scripts/aiken-check`, `scripts/coverage-diff`; `AGENTS.md`, `CLAUDE.md`, `docs/TESTING.md`; then branch protection and auto-merge, after the new gate ran on `main` |
| 2. Speed | the vitest workspace and `TEST_DEPTH`; the 4 product changes, released to mainnet before `main` moves, as in the existing release practice |
| 3. Pruning and repairs | 6 agents at once, one area each: transactions and contract evaluation; chain, CBOR and providers; supplier; buyer, indexer and UI; gateways and Paper2Agent; the Aiken suite |
| 4. Test types | the type errors of the test files; then the test typecheck becomes required |

## 11. Expected result [estimate]

| Item | Before | After |
|---|---|---|
| Pull request with no contract change | 15 to 20 min | about 1.5 to 2 min |
| Pull request with a contract change | 15 to 20 min | about 2 to 3 min |
| Deploy start after a merge | 15 to 20 min | about 2 min |
| CPU of `aiken check` | 4,467 to 6,283 CPU s | about 200 CPU s in the gate; about 630 CPU s at night |
| Test code | 77,851 TypeScript test lines, 1,271 Aiken tests | about 11,500 lines and 222 Aiken tests fewer; about 15 new gap tests |

## 12. Owner decisions against the advice

| Decision | Owner | Advice |
|---|---|---|
| Red nightly run | issue only | issue and Slack |
| Mutation checks by hand | none | only for new money or security guards |
| Vitest scope of the gate | by package | the whole suite |
| Typecheck of test files | CI only | CI and the agent loop |
| Budget of the default `pnpm test` | 100 s | 30 s |
| Compiler for `aiken check` | v1.1.24 (nightly on v1.1.21) | v1.1.21 everywhere |
| Aiken pruning | prune 222 tests | no pruning |
| Property iterations at night | 100 | 1,000 |

## 13. Defaults of the design author

- CI keeps the typecheck of all source packages in the gate (12 to 15 s), not by package.
- The v1.1.24 check runs on a temporary copy with `compiler = "v1.1.24"`; nothing commits that line.
- The gate seed is one fixed value; the shard lists of the 4 Aiken jobs live in one file.
- The coverage proof uses `scripts/coverage-diff` and a file list in `docs/TESTING.md`.
- Branch protection: `strict: false`, 0 approvals, `enforce_admins: false`.
- `deploy.sh` ignores test-only paths (section 4).

## 14. Risks that stay open

1. By-package gate: a test that depends on a package without an import (a fixture file, a started process, a repository scan) can miss the gate and fail only at night, after the deploy.
2. No mutation checks by hand: a new guard can get a test that passes for a wrong reason; 81 Aiken `fail` tests have no reason trace and pass on any crash.
3. Type errors in test files show only in CI.
4. The gate tests Aiken code that v1.1.24 compiled; 6 of the 8 validators compile to other code. The nightly v1.1.21 run finds a difference one night later.
5. The Aiken pruning has no coverage tool; its proof is the named twin and the map check.
6. 100 property iterations at night find rare cases less often.
7. `deploy.sh` deploys the head of `origin/main`, not the tested commit.
8. `enforce_admins: false`: an admin token can push to `main` around the gate.
9. A red nightly run does not stop a deploy.

## 15. Evidence

The fact reports and measurements of this design (audit tables, CI logs, build-host measurements) are kept outside the repository.

## 16. Result (2026-11-22)

Measured after phases 1 to 4 (`main` = `4d1fb4a`).

| Item | Before | After |
|---|---|---|
| Pull request with no contract change | 15 to 20 min | about 2 to 3 min (one `gate` run) |
| Pull request with a contract change | 15 to 20 min | about 3 to 4 min (4 Aiken shards of 96 to 116 s each) |
| Deploy start after a merge | 15 to 20 min | about 3 min |
| Nightly run | none | about 5 min |
| TypeScript test files and cases | 280 and 4,984 | 273 and 3,918 (with about 86 new gap tests) |
| TypeScript test lines | 77,851 | 64,997 (shared fixtures and helpers: 7,958 to 8,772 lines) |
| Aiken tests | 1,271 | 1,156 |
| Full vitest run on a quiet build host | 55 s wall, 561 CPU s (5 configs) | 40 s wall, 498 CPU s (one workspace) |
| Test files that CI type-checks | 47 of 280 | 273 of 273, 0 errors, blocking |
| Skipped test cases | 10 | 0 |
| Deploy runs of the test-only pull requests | none | 17 runs, each "no running compose project is affected" |

Changes against the plan:

- The owner dropped product change (4), the split of `packages/shared/src/tx/server.ts`. The split alone did not lower the number of test files that load lucid (80 before, 80 after); a gain needs lazy imports in 7 product files on money paths. Module import is still about half of the CPU of a full run.
- The status-list decoder is about 5 times faster in the tests. The status-list build on production did not get faster (385 s for 882 records): its cost is elsewhere.
- The Aiken pruning removed 89 tests and folded 26 into a twin with `and { }`: 115 tests, not 222. Each cluster of similar tests keeps one test, and the must-keep rules keep more.
- Coverage rule: a drop counts only when a statement or branch that the base run covers is uncovered in the head run (`scripts/coverage-diff`, by line and column). v8 adds and moves uncovered items between runs, so a rule on percentages gave false flags.
