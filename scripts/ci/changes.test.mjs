// Tests of scripts/ci/changes.mjs on a small tree that has the shape of this repository. Run: node --test scripts/ci/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALWAYS_RUN, analyse, buildGraph, isAikenTest, isDoc, isTestPath, isUnitUiTest, lineClass, outputs } from "./changes.mjs";

const pkg = (name, deps = {}, exports = undefined) => JSON.stringify({ name, dependencies: deps, ...(exports ? { exports } : {}) });

/** A tree with the shape of the repository: a shared package, packages that import it, a leaf package, tests of every kind. */
const TREE = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "buyer"\n  - "gateway"\n  - "identity-gateway"\n  - "indexer-ui"\n\nonlyBuiltDependencies:\n  - better-sqlite3\n',
  "package.json": "{}",
  "vitest.config.ts": "export default {};",
  "vitest.workspace.ts": "export default [];",
  "tests/setup.ts": "",
  "packages/shared/package.json": pkg("@marketplace/shared", {}, { ".": "./src/index.ts", "./tx": "./src/tx/index.ts" }),
  "packages/shared/src/index.ts": 'export * from "./util.js";\n',
  "packages/shared/src/util.ts": "export const x = 1;\n",
  "packages/shared/src/tx/index.ts": 'import "../blueprint.js";\n',
  "packages/shared/src/blueprint.ts": 'import nodePath from "node:path";\nexport const p = nodePath.resolve(here, "..", "contracts", project, "plutus.json");\n',
  "packages/shared/src/own.test.ts": 'import { x } from "./util.js";\n',
  "buyer/package.json": pkg("@marketplace/buyer", { "@marketplace/shared": "workspace:*" }, { "./sdk": "./src/sdk.ts" }),
  "buyer/src/sdk.ts": 'import { x } from "@marketplace/shared";\n',
  "gateway/package.json": pkg("@marketplace/gateway", { "@marketplace/buyer": "workspace:*" }),
  "gateway/src/main.ts": 'import { sdk } from "@marketplace/buyer/sdk";\n',
  "gateway/test/http.test.ts": 'import "../src/main.js";\n',
  "identity-gateway/package.json": pkg("identity-gateway"),
  "identity-gateway/src/a.ts": "export const a = 1;\n",
  "identity-gateway/test/http.test.ts": 'import "../src/a.js";\n',
  "indexer-ui/package.json": pkg("@marketplace/indexer-ui"),
  "indexer-ui/src/c.ts": "export const c = 1;\n",
  "tests/unit/shared-only.test.ts": 'import { x } from "@marketplace/shared";\n',
  "tests/unit/buyer.test.ts": 'import "../../buyer/src/sdk.js";\n',
  "tests/unit/ui.test.tsx": 'import "../../indexer-ui/src/c.js";\n',
  "tests/unit/golden.test.ts": 'const text = readFileSync(new URL("../fixtures/golden/x.hex", import.meta.url));\n',
  "tests/unit/scan.test.ts": 'const DIRS = ["indexer-ui/src", "gateway/src"];\n',
  "tests/unit/decoder-sites.test.ts": "",
  "tests/unit/helper-user.test.ts": 'import "../fixtures/helper.js";\n',
  "tests/unit/blueprint-direct.test.ts": 'import "../fixtures/bp.js";\n',
  "tests/unit/tx.test.ts": 'import "@marketplace/shared/tx";\n',
  "tests/unit/names-doc.test.ts": 'const doc = "docs/guide.md";\n',
  "tests/fixtures/helper.ts": "export {};\n",
  "tests/fixtures/golden/x.hex": "00\n",
  "tests/fixtures/bp.ts": 'export const BP = join(root, "contracts/identity-marketplace/plutus.json");\n',
  "tests/legacy-registry/x.test.ts": 'import "../../packages/shared/src/util.js";\n',
  "tests/identity-deploy/y.test.ts": 'import "../../contracts/identity-marketplace/deploy/z.js";\n',
  "contracts/identity-marketplace/deploy/z.ts": "export {};\n",
  "contracts/identity-marketplace/lib/a.ak": "",
  "contracts/identity-marketplace/lib/a_tests.ak": "",
  "contracts/identity-marketplace/plutus.json": "{}",
  "contracts/identity-marketplace/fixtures/cbor-fixtures.json": "{}",
  "contracts/identity-marketplace/aiken-shards.json": "{}",
  "contracts/identity-marketplace/README.md": "",
  "contracts/identity-marketplace/tests/escrow.md": "",
  "contracts/marketplace/plutus.json": "{}",
  "contracts/marketplace/validators/x.ak": "",
  "docs/guide.md": "",
  "docs/other.md": "",
  "README.md": "",
  "deploy/mainnet/deploy.sh": "",
  "scripts/aiken-check": "",
};
for (const name of ALWAYS_RUN) TREE[name] ??= "";

const files = Object.keys(TREE);
const run = (changed) => analyse({ changed, files: files.filter((file) => TREE[file] !== undefined), read: (path) => TREE[path] });
const selected = (changed) => run(changed).vitestFiles;

test("docs only selects nothing and skips every job", () => {
  const result = run(["docs/other.md", "README.md", "contracts/identity-marketplace/README.md"]);
  assert.equal(result.docsOnly, true);
  assert.equal(result.vitestMode, "none");
  assert.equal(result.runTypecheck, false);
  assert.deepEqual([result.aikenEval, result.contractsIdentity, result.contractsLegacy], [false, false, false]);
});

test("an empty change is docs only", () => {
  assert.equal(run([]).docsOnly, true);
});

test("a document that a test names by its path is not docs only: that test runs", () => {
  const result = run(["docs/guide.md"]);
  assert.equal(result.docsOnly, false);
  assert.equal(result.vitestMode, "selected");
  assert.ok(result.vitestFiles.includes("tests/unit/names-doc.test.ts"));
});

test("a change of the shared package selects it, the packages that import it, and the tests that reach any of them", () => {
  const result = run(["packages/shared/src/util.ts"]);
  assert.deepEqual(result.packagesSelected, ["buyer", "gateway", "packages/shared"]);
  assert.deepEqual(result.vitestFiles, [
    "gateway/test/http.test.ts", "packages/shared/src/own.test.ts", "tests/unit/buyer.test.ts", "tests/unit/decoder-sites.test.ts",
    "tests/unit/shared-only.test.ts", "tests/unit/tx.test.ts",
  ]);
  // Another package that does not import it, and its tests, stay out.
  assert.ok(!result.vitestFiles.includes("identity-gateway/test/http.test.ts"));
  assert.ok(!result.vitestFiles.includes("tests/unit/ui.test.tsx"));
  // The 4 folders import the shared package: the job aiken-eval runs.
  assert.equal(result.aikenEval, true);
});

test("a change of a leaf package selects its own tests, the tests that reach it and the tests that scan its folder", () => {
  assert.deepEqual(selected(["indexer-ui/src/c.ts"]), ["tests/unit/decoder-sites.test.ts", "tests/unit/scan.test.ts", "tests/unit/ui.test.tsx"]);
  assert.deepEqual(selected(["identity-gateway/src/a.ts"]), ["identity-gateway/test/http.test.ts", "tests/unit/decoder-sites.test.ts"]);
});

test("a package folder of a package that imports another is selected by that import only in one direction", () => {
  // buyer changes: buyer and gateway (imports buyer). The shared package stays out.
  const result = run(["buyer/src/sdk.ts"]);
  assert.deepEqual(result.packagesSelected, ["buyer", "gateway"]);
  assert.ok(result.vitestFiles.includes("tests/unit/buyer.test.ts"));
  assert.ok(result.vitestFiles.includes("gateway/test/http.test.ts"));
  assert.ok(!result.vitestFiles.includes("packages/shared/src/own.test.ts"));
});

test("a changed test file selects itself and the always-run list", () => {
  assert.deepEqual(selected(["tests/unit/buyer.test.ts"]), ["tests/unit/buyer.test.ts", "tests/unit/decoder-sites.test.ts"]);
});

test("a deleted test file selects nothing but the always-run list", () => {
  const result = run(["tests/unit/gone.test.ts"]);
  assert.deepEqual(result.vitestFiles, ["tests/unit/decoder-sites.test.ts"]);
});

test("a changed test helper selects the tests that import it", () => {
  assert.deepEqual(selected(["tests/fixtures/helper.ts"]), ["tests/unit/decoder-sites.test.ts", "tests/unit/helper-user.test.ts"]);
});

test("a data file that a test reads by its path selects that test", () => {
  assert.deepEqual(selected(["tests/fixtures/golden/x.hex"]), ["tests/unit/decoder-sites.test.ts", "tests/unit/golden.test.ts"]);
});

test("a change of the identity contract selects the direct readers of the blueprints, not every test that builds a transaction", () => {
  const result = run(["contracts/identity-marketplace/lib/a.ak"]);
  assert.equal(result.contractsIdentity, true);
  assert.equal(result.contractsLegacy, false);
  assert.equal(result.aikenEval, true);
  assert.ok(result.vitestFiles.includes("tests/unit/blueprint-direct.test.ts"));
  assert.ok(!result.vitestFiles.includes("tests/unit/tx.test.ts"));
});

test("a change of the blueprint selects each test that reaches it, also through the shared package", () => {
  const result = run(["contracts/identity-marketplace/plutus.json"]);
  assert.ok(result.vitestFiles.includes("tests/unit/blueprint-direct.test.ts"));
  assert.ok(result.vitestFiles.includes("tests/unit/tx.test.ts"));
  assert.ok(result.vitestFiles.includes("gateway/test/http.test.ts") === false);
  assert.equal(result.contractsIdentity, true);
});

test("a change of the legacy contract runs the legacy job only", () => {
  const result = run(["contracts/marketplace/validators/x.ak"]);
  assert.deepEqual([result.contractsIdentity, result.contractsLegacy, result.aikenEval], [false, true, false]);
});

test("a change of the Aiken tool runs both Aiken jobs", () => {
  const result = run(["scripts/aiken-check"]);
  assert.deepEqual([result.contractsIdentity, result.contractsLegacy], [true, true]);
  const plan = run(["contracts/identity-marketplace/aiken-shards.json"]);
  assert.deepEqual([plan.contractsIdentity, plan.contractsLegacy], [true, true]);
});

test("a change of a map of the identity contract runs the job aiken-check and no other job", () => {
  for (const path of ["contracts/identity-marketplace/tests/escrow.md", "contracts/identity-marketplace/tests/identity.md"]) {
    const result = run([path]);
    assert.equal(result.docsOnly, true, path);
    assert.deepEqual([result.contractsIdentity, result.contractsLegacy, result.aikenEval, result.runTypecheck], [true, false, false, false], path);
    assert.equal(result.vitestMode, "none", path);
  }
  // Other documents add no job.
  for (const path of ["contracts/identity-marketplace/README.md", "contracts/identity-marketplace/tests/notes/x.md", "docs/other.md"]) {
    assert.equal(run([path]).contractsIdentity, false, path);
  }
});

test("a change of the CI files selects every job; a change of the root config selects all tests", () => {
  for (const path of [".github/workflows/ci.yml", ".github/actions/setup-aiken/action.yml", "scripts/ci/changes.mjs"]) {
    const result = run([path]);
    assert.equal(result.vitestMode, "all", path);
    assert.deepEqual([result.runTypecheck, result.aikenEval, result.contractsIdentity, result.contractsLegacy], [true, true, true, true], path);
  }
  for (const path of ["package.json", "vitest.config.ts", "vitest.workspace.ts", "tests/setup.ts", "pnpm-lock.yaml", "tsconfig.base.json", "patches/x.patch"]) {
    const result = run([path]);
    assert.equal(result.vitestMode, "all", path);
    assert.equal(result.aikenEval, true, path);
    assert.equal(result.contractsIdentity, false, path);
  }
});

test("a change of a test of the 4 folders runs the job aiken-eval and no test of the projects unit and ui but the always-run list", () => {
  const result = run(["tests/legacy-registry/x.test.ts"]);
  assert.equal(result.aikenEval, true);
  assert.deepEqual(result.vitestFiles, ["tests/unit/decoder-sites.test.ts"]);
});

test("the substring filter of vitest: a selected path that is the end of another path puts the other path in the exclude list", () => {
  const result = run(["gateway/test/http.test.ts"]);
  assert.deepEqual(result.vitestFiles, ["gateway/test/http.test.ts", "tests/unit/decoder-sites.test.ts"]);
  assert.deepEqual(result.vitestExclude, ["identity-gateway/test/http.test.ts"]);
  assert.deepEqual(run(["identity-gateway/test/http.test.ts"]).vitestExclude, []);
});

test("the outputs: flags as strings, lists with one entry on each line", () => {
  const out = outputs(run(["gateway/test/http.test.ts"]));
  assert.equal(out.vitest_mode, "selected");
  assert.equal(out.vitest_count, "2");
  assert.equal(out.vitest_files, "gateway/test/http.test.ts\ntests/unit/decoder-sites.test.ts");
  assert.equal(out.vitest_exclude, "identity-gateway/test/http.test.ts");
  assert.equal(out.docs_only, "false");
  assert.equal(out.contracts_identity, "false");
});

test("a package export with a star maps the subpath of an import to the file (each star)", () => {
  const tree = {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/lib/package.json": pkg("@x/lib", {}, { "./util/*": "./src/*/*.ts" }),
    "packages/lib/src/a/a.ts": "export const a = 1;\n",
    "tests/unit/wild.test.ts": 'import "@x/lib/util/a";\n',
  };
  const graph = buildGraph(Object.keys(tree), (path) => tree[path]);
  assert.deepEqual([...graph.edges.get("tests/unit/wild.test.ts").files], ["packages/lib/src/a/a.ts"]);
});

test("path classes", () => {
  // The test-only rule is the one of deploy/mainnet/deploy.sh (TEST_ONLY_RE).
  for (const path of ["tests/unit/a.ts", "gateway/test/x.ts", "supplier/src/__tests__/a.ts", "packages/shared/src/a.test.ts", "buyer/src/ui/A.test.tsx", "gateway/tsconfig.test.json", "vitest.config.ts", "vitest.workspace.ts", "tests/tsconfig.json"]) {
    assert.equal(isTestPath(path), true, path);
  }
  for (const path of ["gateway/src/contest.ts", "supplier/src/attest/a.ts", "contracts/identity-marketplace/lib/a.ak", "packages/shared/src/tx/index.ts", ".github/workflows/ci.yml", "tsconfig.base.json"]) {
    assert.equal(isTestPath(path), false, path);
  }
  assert.equal(isDoc("docs/a.png"), true);
  assert.equal(isDoc("supplier/src/a.ts"), false);
  assert.equal(isAikenTest("contracts/identity-marketplace/lib/identity_marketplace/escrow/rule_tests.ak"), true);
  assert.equal(isAikenTest("contracts/identity-marketplace/lib/identity_marketplace/identity/tests/update.ak"), true);
  assert.equal(isAikenTest("contracts/identity-marketplace/lib/identity_marketplace/identity/kit.ak"), true);
  assert.equal(isAikenTest("contracts/identity-marketplace/lib/identity_marketplace/properties/records.ak"), true);
  assert.equal(isAikenTest("contracts/identity-marketplace/lib/identity_marketplace/escrow/rules.ak"), false);
  assert.equal(isAikenTest("contracts/identity-marketplace/validators/escrow.ak"), false);
  assert.equal(lineClass("tests/unit/a.test.ts"), "test");
  assert.equal(lineClass("contracts/identity-marketplace/lib/identity_marketplace/escrow/rule_tests.ak"), "test");
  assert.equal(lineClass("gateway/src/a.ts"), "source");
  assert.equal(lineClass("contracts/identity-marketplace/validators/escrow.ak"), "source");
  assert.equal(lineClass("scripts/aiken-check"), "source");
  assert.equal(lineClass("scripts/ci/changes.test.mjs"), "test");
  assert.equal(lineClass("pnpm-lock.yaml"), "other");
  assert.equal(lineClass("docs/a.md"), "other");
  assert.equal(lineClass("tests/fixtures/golden/x.hex"), "other");
  // The projects unit and ui run these. The folders are the ones of vitest.workspace.ts.
  assert.equal(isUnitUiTest("tests/unit/a.test.ts"), true);
  assert.equal(isUnitUiTest("tests/unit/a.test.tsx"), true);
  assert.equal(isUnitUiTest("gateway/test/a.test.ts"), true);
  assert.equal(isUnitUiTest("identity-gateway/test/a.test.ts"), true);
  assert.equal(isUnitUiTest("packages/shared/src/a.test.ts"), true);
  assert.equal(isUnitUiTest("paper2agent/test/a.test.ts"), true);
  assert.equal(isUnitUiTest("gateway/test/a.test.tsx"), false);
  assert.equal(isUnitUiTest("tests/legacy-registry/a.test.ts"), false);
  assert.equal(isUnitUiTest("scripts/ci/gate.test.mjs"), false);
  assert.equal(isUnitUiTest("indexer-ui/src/a.test.ts"), false);
  // The folders that no test file uses are not in the projects: buyer, supplier, indexer, tests/ogmios, tests/lifecycle.
  for (const path of ["buyer/src/a.test.ts", "buyer/src/ui/A.test.tsx", "supplier/src/a.test.ts", "indexer/src/a.test.ts", "tests/ogmios/a.test.ts", "tests/lifecycle/a.test.ts"]) {
    assert.equal(isUnitUiTest(path), false, path);
  }
});

test("the command line writes GITHUB_OUTPUT in the delimiter form for the lists", () => {
  const root = mkdtempSync(join(tmpdir(), "changes-test-"));
  try {
    for (const [path, text] of Object.entries(TREE)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const out = join(root, "github-output");
    writeFileSync(out, "");
    const script = join(dirname(fileURLToPath(import.meta.url)), "changes.mjs");
    const run1 = spawnSync(process.execPath, [script, "--root", root, "--files", "-"], {
      input: "gateway/test/http.test.ts\n", encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out },
    });
    assert.equal(run1.status, 0, run1.stderr);
    const text = readFileSync(out, "utf8");
    assert.match(text, /^vitest_mode=selected$/m);
    assert.match(text, /^vitest_files<<CI_EOF\ngateway\/test\/http\.test\.ts\ntests\/unit\/decoder-sites\.test\.ts\nCI_EOF$/m);
    assert.match(text, /^vitest_exclude<<CI_EOF\nidentity-gateway\/test\/http\.test\.ts\nCI_EOF$/m);
    assert.match(text, /^docs_only=false$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
