# Testing and CI

This file lists the tiers, the commands, the vitest projects, the test depth, the selection rule of the gate, the Aiken shards, the coverage guard and the nightly run.
The rules for agents are in `AGENTS.md`. The reasons for each choice are in `docs/TEST-REVISION.md`.

## 1. Tiers

| Tier | When | What |
|---|---|---|
| Agent loop | During the work | `scripts/test-changed`: the tests that the changed files reach, the typecheck of the source of the changed packages (not of the test files: CI checks them, by the owner's decision) and `aiken check` of the changed Aiken area, on a build host through `rx`. One thread for `aiken check`. Never the full suite. |
| Pull request gate | Each pull request | The workflow `CI` (`.github/workflows/ci.yml`). The job `changes` chooses the jobs. The job `gate` is the only required check. |
| Push on `main` | Each merge | The same jobs and the same path rule as the pull request. Then `deploy-mainnet.yml` deploys. |
| Nightly | 02:30 UTC | `.github/workflows/nightly.yml`: everything, with `TEST_DEPTH=nightly`, on the compiler of the deployed contracts. |

When no build host answers (`rx` exits with 125), push the branch and let CI test. Do not run tests on your own computer.

## 2. Commands

All commands that load the CPU run on a build host through `rx` (`rx --help`).

| Need | Command |
|---|---|
| The tests, the typecheck and the Aiken area that your change reaches | `scripts/test-changed` (add `--dry-run` to see the commands) |
| One test file | `rx pnpm exec vitest run tests/unit/<file>.test.ts` |
| The tests that import one source file | `rx pnpm exec vitest related --run --project unit --project ui <source file>` |
| One vitest project | `rx pnpm exec vitest run --project unit` (also `ui`, `aiken-eval`; section "Vitest projects") |
| The 4 Aiken folders, or one of them | `rx pnpm exec vitest run --project aiken-eval [tests/identity-deploy/]` |
| The deep variants of a test file | `rx TEST_DEPTH=nightly pnpm exec vitest run <file>` (section "Test depth") |
| The typecheck of one package | `rx pnpm --filter ./<package folder> typecheck` |
| The typecheck of all source | `rx pnpm -r typecheck` |
| The typecheck of the test files (blocking in CI) | `rx node scripts/ci/tsc-report.mjs tests/tsconfig.json gateway/tsconfig.test.json paper2agent/tsconfig.test.json tests/legacy-registry/tsconfig.json tests/identity-builders/tsconfig.json tests/identity-vectors/tsconfig.json` |
| One Aiken area | `rx mise exec github:aiken-lang/aiken@1.1.24 node@20 -- scripts/aiken-check --modules identity_marketplace/escrow` |
| One Aiken shard | `rx mise exec github:aiken-lang/aiken@1.1.24 node@20 -- scripts/aiken-check --shard 1 --of 4 --seed 358316146` |
| The legacy contract | `rx mise exec github:aiken-lang/aiken@1.1.24 node@20 -- scripts/aiken-check --project contracts/marketplace --all` |
| The plan of the Aiken shards | `scripts/aiken-check --check-plan` |
| The maps of the Aiken tests: does each name exist? | `node scripts/aiken-check-maps` (runs no aiken, about 1 s) |
| The jobs that CI would run for a change | `printf 'gateway/src/sweeper.ts\n' \| node scripts/ci/changes.mjs --files -` |
| The tests of the CI scripts | `rx node --test scripts/ci/*.test.mjs` |
| Coverage before and after a pruning change | `scripts/coverage-diff` (section 7) |

### Vitest projects

`vitest.workspace.ts` defines three projects. `pnpm test` (`vitest run`) runs all three. `vitest.config.ts` holds only the options of
the whole run (`passWithNoTests`, `cacheDir`): vitest 2 gives a project none of its options.

| Project | Test files | Environment | Time limit of a test | Needs |
|---|---|---|---|---|
| `unit` | The `.test.ts` files of `tests/unit`, `packages`, `gateway`, `paper2agent` and `identity-gateway` | Node | 20 s (the first transaction build of a worker loads the lucid WASM) | `aiken` v1.1.21 on `PATH` for `tests/unit/identity-tx-*.test.ts` and `tests/unit/paper2agent-identity-e2e.test.ts` |
| `ui` | The `.test.tsx` files of `tests/unit` | happy-dom | 20 s | `tests/setup.ts` loads the matchers of jest-dom. No other project loads it. |
| `aiken-eval` | `tests/legacy-registry`, `tests/identity-builders`, `tests/identity-vectors`, `tests/identity-deploy` | Node | 300 s | `aiken` v1.1.21 on `PATH`, no network |

Run one project with `--project <name>`. Repeat the flag for more projects. A path filter works across the projects, so
`vitest run tests/identity-deploy/` runs that folder and needs no `--config`. The job `vitest` of the gate runs `unit` and `ui`.
The job `aiken-eval` runs `aiken-eval`. The nightly run runs all three.

A new test folder needs entries in three places: the `include` of its project in `vitest.workspace.ts`, `UNIT_UI_TEST_ROOTS` or
`EVAL_DIRS` in `scripts/ci/changes.mjs`, and, for `aiken-eval`, the cases of `scripts/test-changed`. A test file outside these folders
runs in no project. The alias block of the lucid entry points is in `vitest.workspace.ts`, once.

### Test depth

A deep variant of a test (bigger data, more property runs) runs only at night. `.github/workflows/nightly.yml` sets
`TEST_DEPTH=nightly`. No other run sets it. `tests/depth.ts` exports `nightly`, which is true when `TEST_DEPTH=nightly`:

```ts
import { nightly } from "../depth"; // from a file in tests/unit; the path depends on the folder of the test

const runs = nightly ? 1_000 : 100; // an example: the deep number only at night
```

Rules:

- Deep sizes and more property runs belong to the night only. The pull request and the agent loop run the small variant, which
  checks the same rule with a few cases.
- Each property test prints its seed and gives the same seed to `fc.assert`. The log of a red night run then names the seed. To
  repeat the run, put that seed in the options of `fc.assert`:

  ```ts
  const seed = Date.now();
  console.info(`seed ${seed}`);
  await fc.assert(property, { seed, numRuns: nightly ? 1_000 : 100 });
  ```

- Run the deep variants of one file on a build host with `rx TEST_DEPTH=nightly pnpm exec vitest run <file>`.

## 3. The pull request gate

The workflow `CI` has the same triggers as before: a push on `main`, and each pull request. The jobs:

| Job | Runs when | What it does |
|---|---|---|
| `changes` | Always | Lists the changed files (the pull request from the merge base to the head, a push from `before` to the new commit; every file when `before` is missing). Runs `scripts/ci/changes.mjs`. Tests the CI scripts first. |
| `typecheck` | The change is not docs only | `pnpm -r typecheck` (blocking). Then the type check of the test files (blocking too): `tests/tsconfig.json`, `gateway/tsconfig.test.json`, `paper2agent/tsconfig.test.json` and three folder configs. An error in any config fails the job. The error count of each config is in the job summary. Section "The type check of the test files". |
| `vitest` | The selection is not empty | The projects `unit` and `ui`: the selected test files, or every file of the two projects when the selection is `all`. Fails when it runs no file. The 10 slowest test files are in the job summary. |
| `aiken-eval` | `contracts/identity-marketplace/` changed, or a file that the tests of the project `aiken-eval` reach | `aiken build` with the blueprint diff, the project `aiken-eval` (the 4 folders, one run, the 10 slowest files in the job summary), `tsc -p tests/identity-deploy/tsconfig.json`, and `fixtures/generate.mjs --check`. Aiken v1.1.21. |
| `aiken-check` | The identity contract changed, the Aiken tool changed, or a map `contracts/identity-marketplace/tests/*.md` changed | The map check (`scripts/aiken-check-maps`), then 4 shards of `scripts/aiken-check`, aiken v1.1.24, one fixed seed. |
| `legacy-contract` | `contracts/marketplace/` changed, or the Aiken tool changed | `scripts/aiken-check --project contracts/marketplace --all` on aiken v1.1.24, then `aiken build` on v1.1.21 with the blueprint diff (a v1.1.21 build equals the committed `plutus.json` byte for byte). |
| `gate` | Always (`if: always()`) | Reads the result of each job (`scripts/ci/gate.mjs`). |

The `gate` job is the only required check of the branch rule. GitHub counts a skipped required job as passed, so the gate decides
by itself: the job `changes` must succeed; a job that had to run must succeed; a job that did not have to run must be skipped or
succeed. A new job needs two edits: add it to `needs` of `gate`, and to `JOBS` in `scripts/ci/gate.mjs` (with its test in
`scripts/ci/gate.test.mjs`). Until then it blocks nothing.

The gate also prints how many test lines and how many source lines the pull request adds. When the test lines are more, the
notice says that the text of the pull request must give the reason. The notice never fails the gate.

### The selection rule (vitest, by package)

`scripts/ci/changes.mjs` reads each file of the repository once and builds the import graph of all code files. Besides the imports,
the graph follows each quoted text that names a file or a folder of the repository (`"../fixtures/golden"`, `"deploy/mainnet"`,
`"plutus.json"`). So a test that reads a data file or scans a folder is selected when that file or folder changes.

1. A changed file of a workspace package selects that package and each package that imports it (the `workspace:` dependencies of
   `package.json` and the imports between the source folders).
2. A test file is selected when its import graph reaches any source file of a selected package.
3. Each test file inside a selected package folder is selected (`gateway/test`, `paper2agent/test`, `identity-gateway/test`,
   `packages/shared/src/*.test.ts`).
4. Each changed test file is selected. A changed test helper (`tests/fixtures/**`, `tests/unit/__helpers__/**`,
   `tests/legacy-registry/harness/**`) selects the test files that import it.
5. The always-run list is selected for each change that is not docs only: `tests/unit/decoder-sites.test.ts` (it scans the source
   text, so no import reaches it).
6. A change below `contracts/identity-marketplace/` also selects the test files that read the blueprints
   (`contracts/*/plutus.json`) or `fixtures/cbor-fixtures.json` themselves. A change of a blueprint selects each test that reaches it.
7. A change of the root build or test config selects everything (`all`): `package.json`, `pnpm-lock.yaml`,
   `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`, `.nvmrc`, `patches/**`, any `vitest.*` file (`vitest.config.ts`,
   `vitest.workspace.ts`), `tests/setup.ts`. A change of `.github/**` or `scripts/ci/**` selects everything and switches on every job.
8. A change of documents only (`*.md`, `docs/**`, images, `LICENSE`) selects nothing and runs no job. A document that a test names
   by its path is not "documents only".
   The maps `contracts/identity-marketplace/tests/*.md` are an exception: a change of a map runs the job `aiken-check` (the map check).

The vitest filter is a substring match on the path: `gateway/test/http.test.ts` also matches `identity-gateway/test/http.test.ts`.
`changes.mjs` lists the files that the filter would add by mistake in `vitest_exclude`. `scripts/ci/vitest-run.mjs` gives the list
to the run in the variable `VITEST_EXCLUDE`, and `vitest.workspace.ts` reads it (the option `--exclude` of the command line reaches
no project of a workspace). The run fails when the files that ran are not exactly the selected files.

Known gap (design risk 1): a test that depends on a package without an import (a file that a path built from parts names, a process
that it starts) can miss the gate. The nightly run finds it. Add the test to the always-run list in `scripts/ci/changes.mjs`
(`ALWAYS_RUN`) when it must never miss.

Other jobs, same rule: `aiken-eval` also runs when a file that the tests of the project `aiken-eval` reach changes (for example
`packages/shared/src/**`, `identity-gateway/src/**`). `aiken-check` runs for `contracts/identity-marketplace/{lib,validators}/**`,
`aiken.toml`, `aiken.lock`, `plutus.json`, `aiken-shards.json`, `scripts/aiken-check`, `scripts/aiken-check-maps` and the maps
`contracts/identity-marketplace/tests/*.md`. `legacy-contract` runs for
`contracts/marketplace/**` and for the same tool files.

### What a pull request needs in practice

- The change decides: run `printf '<changed paths>' | node scripts/ci/changes.mjs --files -` to see the decision before you push.
- Each run prints the decision and the selected files in the summary of the job `changes`.
- A red `gate` names the job that failed. Open that job, repair, and push again.

### The type check of the test files

A test file with a type error fails the job `typecheck`, and so it fails the gate. The agent loop does not type-check the test files: `scripts/test-changed` checks the source of the changed packages only, by the owner's decision (`docs/TEST-REVISION.md`, section 12). When the job is red, run the command of section 2 for the config that the job summary names, repair the file, and push again.

- The configs: `tests/tsconfig.json` (`tests/unit`, `tests/fixtures`, `tests/setup.ts`, `tests/depth.ts`), `gateway/tsconfig.test.json`, `paper2agent/tsconfig.test.json`, and the configs of `tests/legacy-registry`, `tests/identity-builders` and `tests/identity-vectors`. `tests/identity-deploy/tsconfig.json` is checked in the job `aiken-eval`. The tests of `identity-gateway` and `packages/shared` are part of the `pnpm -r typecheck` of their packages.
- Repair the type, not the check. Build a config from the shared sample builder: `buildSampleConfig` (`tests/fixtures/supplier-side/sample-config.ts`), `buildSampleSurplusConfig` (`tests/fixtures/supplier-side/sample-surplus-config.ts`) or `buildSampleGatewayConfig` (`tests/fixtures/gateway-side/sample-config.ts`). A new field of the config then breaks one file, not ten.
- Use `satisfies`, a typed helper or a type annotation. Never `as any`, never `// @ts-ignore`.
- A deliberate wrong input (a `null` where the type forbids it) takes a cast through `unknown` and one comment that says why.
- When only a change of the product code can fix the error, keep the test and put a narrow `// @ts-expect-error <reason>` on that line. The compiler then fails when the error goes away.

## 4. Aiken

| Use | Compiler | Where |
|---|---|---|
| `aiken build`, the blueprint diffs, `fixtures/generate.mjs`, `aiken tx simulate` (the project `aiken-eval` and 7 test files of the project `unit`), the nightly `aiken check` | v1.1.21 (the compiler of the deployed contracts; `compiler = "v1.1.21"` in both `aiken.toml` files) | `aiken-eval`, `vitest`, nightly |
| `aiken check` in the gate and in the agent loop | v1.1.24, on a temporary copy of the project whose `aiken.toml` says `compiler = "v1.1.24"` | `aiken-check`, `legacy-contract`, `scripts/test-changed` |

v1.1.24 compiles other code for 6 of the 8 validators of the identity project. So its `aiken check` is a faster check of the same
sources, and the nightly run on v1.1.21 is the check of the deployed code. Nothing commits the v1.1.24 compiler line.

The action `.github/actions/setup-aiken` installs a release and checks its sha256. It knows v1.1.21 (default) and v1.1.24
(`aiken-x86_64-unknown-linux-musl.tar.gz`, sha256 `c378acccdaf9533f3375ea623c948d3dcb21f7e8c5ecbb741162c53653470b13`, equal to the
`.sha256` file of the release). Pass `version: v1.1.24` to use it.

`scripts/aiken-check` runs `aiken check -D` with `RAYON_NUM_THREADS=1` (one thread is faster than many and uses a tenth of the CPU),
on a temporary copy of the project, with exact filters. It reads the test definitions of the `.ak` files itself and fails when a
test fails, or when the number or the names of the tests that ran differ from the files. It prints the seed first.

| Mode | Use |
|---|---|
| `--shard N --of 4` | One shard of the plan `contracts/identity-marketplace/aiken-shards.json` (the 4 CI jobs) |
| `--modules <substring>[,...]` | Each test of the modules whose name contains the text (the agent loop) |
| `--all` | Each test of the project (`--project contracts/marketplace`) |
| `--check-plan` | Validates the plan against the files; runs no aiken |

`mise exec <tool> --` starts a clean environment, so name `node@20` in the same call (the script starts with `#!/usr/bin/env node`).
`aiken fmt --check` is not part of any job: it fails today for the legacy contract (3 files) and, on v1.1.24, for the identity contract.

The shard plan splits the 1,156 tests by measured cost. 454 of them are `fail` tests and 15 are property tests (`prop_*`). The 4 shards
hold 324, 342, 238 and 252 tests. One thread: the slowest shard took 161 s on v1.1.21 and 68 s on v1.1.24 on a calm host before 115
tests were pruned. No calm host measured it again, and `estimated_seconds` of the plan keeps the old values. Each module with tests is
in one shard, except the property modules: their 15 `prop_*` tests are split by name (`records` goes over all 4 shards). After you add,
rename or delete a test module, or a `prop_*` test in a property module, run `scripts/aiken-check --check-plan` and change
`aiken-shards.json`. A run fails when a test is in no shard or in two, or when the tests that aiken ran are not the tests of the files.

`scripts/aiken-check-maps` checks the maps `contracts/identity-marketplace/tests/*.md`. A map tells which Aiken tests cover each attack
row of `docs/IDENTITY_REGISTRY.md` §12.1. The script reads the `.ak` files and the maps, and runs no aiken (about 1 s). It fails when a
name in backticks that looks like a test name is not a test, when a pattern such as `datum_valid_*` matches no test, when a row of an
attack table names no test, or when a count row is wrong. Run `node scripts/aiken-check-maps` after you delete or rename an Aiken test.
The job `aiken-check` runs it before its shard, and the nightly job `aiken-check` runs it too.

Seeds: the gate uses the fixed seed `358316146`, so that a failure repeats. The nightly run draws a new random seed each night, prints
it, and puts it in the issue. To repeat a night: run the same shard with that seed and `--max-success 100` (on v1.1.21).

## 5. Nightly

`.github/workflows/nightly.yml` runs at 02:30 UTC from the default branch, and by hand (`workflow_dispatch`, never skipped).
The job `plan` skips the run when the head of the branch already has a successful nightly run, and draws the seed. The jobs:

- `vitest`: `pnpm test` (the three projects `unit`, `ui` and `aiken-eval`), with `TEST_DEPTH=nightly` (the deep variants of "Test depth");
- `typecheck-tests`: the type check of the test files (blocking: an error fails the job). It runs the six configs of the gate and `tests/identity-deploy/tsconfig.json`;
- `aiken-check`: the map check, then 4 shards on aiken v1.1.21, one thread, the seed of the night, `--max-success 100`;
- `legacy-contract`: the legacy contract on v1.1.21;
- `blueprints`: the blueprint diff of the identity contract and `fixtures/generate.mjs --check`;
- `report`: opens or updates ONE issue with the label `nightly-failure` (assigned to `dcejtlin-apex`, with the run, the commit, the
  failed jobs and the seed) when a job failed, and closes it with a comment when the run is green.

A red nightly run does not stop a deploy. Agents look for an open `nightly-failure` issue at the start of a task (`AGENTS.md`).

## 6. Deploy

`deploy/mainnet/deploy.sh` decides from the diff which compose projects to rebuild. It drops test-only paths first (`tests/`, `test/`,
`__tests__/`, `*.test.*`, `*.spec.*`, `tsconfig.test.json`, `vitest.*` in the root) and logs how many it ignored. Below `contracts/`
only the two `plutus.json` blueprints count, because the images copy only these files. A change of tests alone, or of an Aiken
test, restarts nothing. `FORCE=1` still redeploys everything.

## 7. Coverage guard

Phase 3 removes weak tests. Each such pull request must show that no source file lost line or branch coverage, and in particular none
of the money, signature and chain-decoding files in `tests/coverage-guard.json` (84 files: money, chain-decoding, signature and key
code; no UI, no CLI entry point that no test loads, no config module).

```
scripts/coverage-diff                 # the merge base against the head; prints a markdown table; exits 1 when a guarded file lost a covered location
scripts/coverage-diff --base <ref> --md-out table.md --json-out result.json
```

Put the table in the text of the pull request. The script needs `rx` and a git worktree. It runs the same v8 coverage of the default
suite (the projects `unit` and `ui`; the base commit needs `vitest.workspace.ts`) twice, with the reporters `json-summary` and `json`:
on a temporary worktree of the base commit, and on the head (the worktree with its uncommitted changes). With two answering build hosts
the runs go at the same time; `--host NAME` runs both one after the other on one host.

The rule: a guarded file lost coverage when it has a statement or a branch that the base run covers (count above 0) and the head run
does not cover (count 0). The script reads `coverage-final.json` of both runs and matches the locations by source position (line and
column; a branch by its start, its end and its arm), not by the key of the v8 data. v8 adds and moves items with count 0 between two
runs of the same code, so the keys and the number of branches of a file shift. A base location with no head location at the same
position is not compared (the source changed there, or v8 reports no range for it). The script exits 1 when a guarded file has a lost
location, and prints each one with its file, line and kind (`statement` or `branch`). A run of consecutive lost lines is one row of the
table; `--json-out` holds every location.

The percentages in the table are information. The flag `fell` marks a fall of a percentage by more than `--epsilon` (default 0.005
points) with more uncovered items than before. Without a lost location it is no drop. A drop in a guarded file stops the change until a
test covers the location again, or the owner accepts the drop. When a guarded source file moves or goes, change
`tests/coverage-guard.json` in the same pull request (the script fails on a guard path that no summary holds). The wall-clock limit of
`packages/shared/src/cbor-depth.test.ts` applies only in the night run (`TEST_DEPTH=nightly`) since #53, so the gate has no test that a
busy build host can fail on time. A test that failed for another reason on a busy host: run the script again.

## 8. Gaps that deleted tests described

Phase 3 fills this section. For each deleted test that described a behavior that no other test covers, add one row: the deleted
test, the behavior, why it is not covered now, and the pull request.

| Deleted test | Behavior it described | Why it is not covered now | Pull request |
|---|---|---|---|
| `supplier-config.test.ts:36,43,50,55,201,247,316,372` | The defaults and the custom values of `PORT`, `OLLAMA_TIMEOUT_MS`, `OPENAI_UPSTREAM_API`, `CHAT_SETTLE_MODE` and `OPENAI_MODEL_OVERRIDE` | The owner rule: no test for config defaults, or for a value that the test sets and reads back. | #44 |
| `supplier-config.test.ts:122,128,134` | `loadConfig` reads `ADVERT_REF` | `parseAdvertRef` has the same cases. No test shows that `loadConfig` refuses a malformed `ADVERT_REF`. | #44 |
| `supplier-jobs.test.ts:65,90` | `JobStore.create` gives a UUID v4 | `supplier-routes-chat-async.test.ts` checks the format of the `job_id` in the 202 body. | #44 |
| `supplier-chat-deadline-live.test.ts:320,407` ("not 408" on a live chain and on the mock chain) | The request goes on to the Claim. On a live chain this ran `runConsolidateWallet` (lines 65 to 73) through the wallet-health hook, by accident. | No test targets `runConsolidateWallet.ts`. | #45 |
| `supplier-routes-chat.test.ts:354` (the cap, "not 400") | A background run of the real `callOllama` with no fetch stub gave a network error (`ollama.ts` lines 61, 63, 64, 90, 91), by accident. | The case "network error" of `supplier-ollama.test.ts` runs that path since #44. | #45 |
| `buyer-server-config.test.ts`, "serves static dist" | The static bundle mount of the buyer server (`buyer/src/server.ts:1404-1458`) | The case passed a folder that does not exist, so it never reached the mount. No test reaches it. | #48 |
| None. The pull request found the gap. | `Marketplace.discoverSuppliers`: a network or timeout `HttpError`, and a body that is not an array | These two branches had no test before. | #48 |
| `buyer-ui-disputes.test.tsx`, "stops at 200 cases" | The notice at the 200-case cap (`Disputes.tsx:933-935`) | The owner ordered the deletion. No other test shows the notice. | #48 |
| `buyer-ui-resale-dashboard.test.tsx`, the class checks | The proof states `pending` and `failed` of `ResaleDashboard` differ by text and class only | No test id or role tells them apart, so no test checks them. | #48 |
| The boot cases of the indexer server test | `createApp` adds app-level listeners for `chain-event` and `sync-progress` (`server.ts:116-124`) | No test asserts `listenerCount` now. That code exists only for the deleted boot cases. | #49 |
| `indexer-config.test.ts`, the default and pass-through cases | The defaults of `loadConfig` (8090, 20000, 0, 600), the pass-through of `ogmiosUrl` and `dbPath`, and the empty legacy addresses | The owner rule: no test for config defaults. | #49 |
| `indexer-block-processor.test.ts`, the fixture cases | The `address` field of the PostAdvert event | No other test asserts it. | #49 |
| `indexer-ui-events-log.test.tsx`, the scroll case | The label `live` or `disconnected` of the connection (`EventsLog.tsx:111-112`) | The deleted case was the only test that set `connected`. The label has no test id or role. | #50 |
| Text checks of the indexer UI tests | The datum marker of `escrow-refund` and the status of `status-pill` | No data handle exists (the test id has no attribute), so no test checks them. | #50 |
| `identity-gateway/test/render/units.test.ts:7-9` ("defaults") | `loadRenderConfig({})` gives the defaults of `GATEWAY_BASE_URL` and `ACCESS_LOG_RETENTION` | It was the only test with an empty environment. The owner rule: no test for config defaults. `render/config.ts` lost 2 branch arms. | #51 |
| `identity-gateway/test/render/policy.test.ts:266-277` | The formula strings of the main cells of `/policy` | They copied the constants `F` of `policy-bounds.ts`. No test pins the strings any more. | #51 |
| `paper2agent/test/serve.test.ts:152-162` | The control role gets no decoder health check through `main` | The case counted the calls of a stand-in. No other test checks it. | #51 |
| None. `tx-submit-live.test.ts`, `tx-submit-live-time.test.ts` and `tx-live-integration.test.ts` had only skipped live cases. | Live Release of the legacy layout (`buildLiveTxForRelease`) builds a real transaction | No test builds it. `tx-release-live-dispatch.test.ts` mocks the builder and tests the dispatch only. A drain of legacy escrows can still need it. | #55 |
| None (same files). | Live RetireAdvert of the legacy layout (`buildLiveTxForRetireAdvert`) builds a real transaction | No test builds it. `tx-retire-advert.test.ts` tests the mock chain only. | #55 |
| `cbor-escrow-datum.test.ts`, "invalid state constructor tag" | The state check of `decodeEscrowDatum` (`EscrowDatum.ts:238-246`), its odd-length check and its non-hex check | The deleted case had 1 field, so the decoder refused it at the field count. It never reached the state check. No test covers these three checks, before or after. | #53 |
| `lucid-context.test.ts`, "`lucid.wallet()` does not throw" | `createLucidContext` selects the wallet of the key that it gets | The deleted case checked only that `wallet()` does not throw. No test asserts the wallet address. | #54 |
| `mock-chain-provider.test.ts`, the cases of the injected `evaluator` | `evaluateTx` passes `ok`, `error` and `cost` of an injected evaluator through | The cases tested the mock only. No other test calls it with an injected evaluator. | #54 |
| `cli-post-advert-flow.test.ts`, the log cases | The log lines of `runPostAdvert` and their order, the default `console.log`, and the default `awaitTimeoutMs` of 120,000 (in the parser and in the flow) | The rules of `AGENTS.md` forbid tests for logs and for config defaults. | #54 |

The skipped live cases also described the live Submit of the legacy layout. A running case covers it since #55: the lifecycle case of
`tests/unit/tx-post-escrow-live.test.ts` builds Post, Claim, Submit and Accept with a fixed clock. It reads the receipt hash and the
submit stamp of the Submit datum.
