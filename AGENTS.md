# Rules for agents

Commands, tiers and the selection rule are in `docs/TESTING.md`. The reasons are in `docs/TEST-REVISION.md`.

## Start of a task

- Look for an open issue with the label `nightly-failure` (`gh issue list --label nightly-failure --state open`).
  Name it in your first report, with its run URL. A red nightly run does not stop your work.

## The test loop

- Run `scripts/test-changed`. It runs the tests that your change reaches, the typecheck of the changed packages and
  `aiken check` of the changed Aiken area, on a build host through `rx`. It prints each command.
- Never run the full suite. CI runs the gate, and the nightly run runs everything.
- Never run a test, a typecheck or `aiken check` on this computer. When `rx` fails (exit status 125) or no build host answers,
  push the branch and let CI test.

## When to write a test

Write a test only in these cases:

- You fixed a bug: write one regression test, at the lowest level that shows the bug.
- You added or changed behavior on a money, signature, chain-data or security path: write one test, or one table test with one
  accepted control.
- The owner or a row of a spec names the case.

Never write a test for wiring, config defaults, logs, UI text or a pure refactor. Do not check by hand that a test fails when you
remove the guard (no mutation checks by hand).

## Aiken tests for a future contract version

- One `fail` test for each refusal branch that a spec row names.
- One accepted control for each family of refusals.
- Variants go into a property test.
- No second level of one rule. The one exception is the Decision 10 window refusals.

## Pull requests

- Push your branch, open the pull request, then run `gh pr merge --auto --rebase`. Watch CI (`gh pr checks`). When a job is red,
  repair it and push again.
- The `gate` job is the only required check. It prints how many test lines and how many source lines the pull request adds. When
  the test lines are more, give the reason in the text of the pull request.
- A pull request that prunes tests attaches the table of `scripts/coverage-diff`.
- Never push to `main`. Never merge with `--admin`. Only the owner can allow it.

## Task briefs

A brief that you write for another agent follows these rules. It never asks for the full suite, and it does not ask for tests that
the rules above do not allow.
