# Testing and CI

This file lists the tiers, the commands, the vitest projects, the test depth, the selection rule of the gate, the Aiken shards, the coverage guard and the nightly run.
The rules for agents are in `AGENTS.md`. The reasons for each choice are in `docs/TEST-REVISION.md`.

## 1. Tiers

| Tier | When | What |
|---|---|---|
| Agent loop | During the work | `scripts/test-changed`: the tests that the changed files reach, the typecheck of the changed packages and `aiken check` of the changed Aiken area, on a build host through `rx`. One thread for `aiken check`. Never the full suite. |
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
| The typecheck of the test files (report only) | `rx node scripts/ci/tsc-report.mjs tests/tsconfig.json gateway/tsconfig.test.json paper2agent/tsconfig.test.json` |
| One Aiken area | `rx mise exec github:aiken-lang/aiken@1.1.24 node@20 -- scripts/aiken-check --modules identity_marketplace/escrow` |
| One Aiken shard | `rx mise exec github:aiken-lang/aiken@1.1.24 node@20 -- scripts/aiken-check --shard 1 --of 4 --seed 358316146` |
| The legacy contract | `rx mise exec github:aiken-lang/aiken@1.1.24 node@20 -- scripts/aiken-check --project contracts/marketplace --all` |
| The plan of the Aiken shards | `scripts/aiken-check --check-plan` |
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
| `typecheck` | The change is not docs only | `pnpm -r typecheck` (blocking). Then the type check of the test files in report mode: `tests/tsconfig.json`, `gateway/tsconfig.test.json`, `paper2agent/tsconfig.test.json` and three folder configs. The error count of each config is in the job summary. |
| `vitest` | The selection is not empty | The projects `unit` and `ui`: the selected test files, or every file of the two projects when the selection is `all`. Fails when it runs no file. The 10 slowest test files are in the job summary. |
| `aiken-eval` | `contracts/identity-marketplace/` changed, or a file that the tests of the project `aiken-eval` reach | `aiken build` with the blueprint diff, the project `aiken-eval` (the 4 folders, one run, the 10 slowest files in the job summary), `tsc -p tests/identity-deploy/tsconfig.json`, and `fixtures/generate.mjs --check`. Aiken v1.1.21. |
| `aiken-check` | The identity contract changed, or the Aiken tool changed | 4 shards of `scripts/aiken-check`, aiken v1.1.24, one fixed seed. |
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

The vitest filter is a substring match on the path: `gateway/test/http.test.ts` also matches `identity-gateway/test/http.test.ts`.
`changes.mjs` lists the files that the filter would add by mistake in `vitest_exclude`. `scripts/ci/vitest-run.mjs` gives the list
to the run in the variable `VITEST_EXCLUDE`, and `vitest.workspace.ts` reads it (the option `--exclude` of the command line reaches
no project of a workspace). The run fails when the files that ran are not exactly the selected files.

Known gap (design risk 1): a test that depends on a package without an import (a file that a path built from parts names, a process
that it starts) can miss the gate. The nightly run finds it. Add the test to the always-run list in `scripts/ci/changes.mjs`
(`ALWAYS_RUN`) when it must never miss.

Other jobs, same rule: `aiken-eval` also runs when a file that the tests of the project `aiken-eval` reach changes (for example
`packages/shared/src/**`, `identity-gateway/src/**`). `aiken-check` runs for `contracts/identity-marketplace/{lib,validators}/**`,
`aiken.toml`, `aiken.lock`, `plutus.json`, `aiken-shards.json`, `scripts/aiken-check`. `legacy-contract` runs for
`contracts/marketplace/**` and for the same tool files.

### What a pull request needs in practice

- The change decides: run `printf '<changed paths>' | node scripts/ci/changes.mjs --files -` to see the decision before you push.
- Each run prints the decision and the selected files in the summary of the job `changes`.
- A red `gate` names the job that failed. Open that job, repair, and push again.

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

The shard plan splits the 1,271 tests by measured cost (one thread: the slowest shard takes 161 s on v1.1.21 and 68 s on v1.1.24 on
a calm host; the shards at the time of the check were 363, 359, 284 and 265 tests). Each module with tests is in one shard, except the
property modules: their 15 `prop_*` tests are split by name (`records` goes over all 4 shards). After you add, rename or delete a test
module, or a `prop_*` test in a property module, run `scripts/aiken-check --check-plan` and change `aiken-shards.json`. A run fails when
a test is in no shard or in two, or when the tests that aiken ran are not the tests of the files.

Seeds: the gate uses the fixed seed `358316146`, so that a failure repeats. The nightly run draws a new random seed each night, prints
it, and puts it in the issue. To repeat a night: run the same shard with that seed and `--max-success 100` (on v1.1.21).

## 5. Nightly

`.github/workflows/nightly.yml` runs at 02:30 UTC from the default branch, and by hand (`workflow_dispatch`, never skipped).
The job `plan` skips the run when the head of the branch already has a successful nightly run, and draws the seed. The jobs:

- `vitest`: `pnpm test` (the three projects `unit`, `ui` and `aiken-eval`), with `TEST_DEPTH=nightly` (the deep variants of "Test depth");
- `typecheck-tests`: the type check of the test files, report only;
- `aiken-check`: 4 shards on aiken v1.1.21, one thread, the seed of the night, `--max-success 100`;
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
scripts/coverage-diff                 # the merge base against the head; prints a markdown table; exits 1 when a guarded file lost coverage
scripts/coverage-diff --base <ref> --md-out table.md --json-out result.json
```

Put the table in the text of the pull request. The script needs `rx` and a git worktree. It runs the same v8 coverage of the default
suite (the projects `unit` and `ui`; the base commit needs `vitest.workspace.ts`) twice: on a temporary worktree of the base commit,
and on the head (the worktree with its uncommitted changes). With two answering
build hosts the runs go at the same time; `--host NAME` runs both one after the other on one host. A file lost coverage when, for lines
or for branches, the percentage fell by more than `--epsilon` (default 0.005 points) AND the file has more uncovered items than
before: the v8 provider changes the branch count of a file by a few between two runs of the same code, so a fall with no new
uncovered item is noise. A drop in a guarded file stops the change until a test covers the lines again, or the owner accepts the drop.
When a guarded source file moves or goes, change `tests/coverage-guard.json` in the same pull request (the script fails on a guard
path that no summary holds). A test with a wall-clock limit (`packages/shared/src/cbor-depth.test.ts`) can fail when the build host is
busy: run the script again.

## 8. Gaps that deleted tests described

Phase 3 fills this section. For each deleted test that described a behavior that no other test covers, add one row: the deleted
test, the behavior, why it is not covered now, and the pull request.

| Deleted test | Behavior it described | Why it is not covered now | Pull request |
|---|---|---|---|
