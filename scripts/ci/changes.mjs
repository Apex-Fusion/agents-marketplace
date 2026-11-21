#!/usr/bin/env node
/**
 * scripts/ci/changes.mjs: choose the jobs of the workflow `CI` for one change.
 *
 * It needs Node 20 and no packages. The job `changes` of .github/workflows/ci.yml runs it on a full checkout.
 *
 *   node scripts/ci/changes.mjs                       the event of the workflow (env, see below); writes $GITHUB_OUTPUT
 *   node scripts/ci/changes.mjs --files LIST          changed paths, one on each line ("-" reads stdin); no git
 *   node scripts/ci/changes.mjs --base A --head B     the paths of `git diff A...B`
 *   node scripts/ci/changes.mjs --all                 every tracked path changed
 *   --json                                            print the result as JSON (default: a text summary)
 *
 * Event (env): GITHUB_EVENT_NAME, PR_BASE_SHA, PR_HEAD_SHA (pull_request); PUSH_BEFORE, PUSH_AFTER (push).
 * A push with no usable `before` commit, and any other event, counts as "every path changed".
 *
 * Outputs (all strings):
 *   docs_only           "true" when no changed path can change a test or a build.
 *   run_typecheck       "true" for any change that is not docs only.
 *   vitest_mode         "none", "all" (every test file of the projects unit and ui) or "selected" (the files of vitest_files).
 *   vitest_count        number of selected files.
 *   vitest_files        the selected test files, one on each line.
 *   vitest_exclude      test files that the substring filter of vitest would add by mistake, one on each line.
 *   aiken_eval          "true" when the job `aiken-eval` runs (blueprint build, the vitest project aiken-eval, generator check).
 *   contracts_identity  "true" when the job `aiken-check` runs (aiken tests of contracts/identity-marketplace).
 *   contracts_legacy    "true" when the job `legacy-contract` runs (contracts/marketplace).
 *   test_lines, source_lines   added lines of test code and of source code (git numstat; 0 without git).
 *
 * The vitest selection is "by package" (decision of the repository owner):
 *   1. A changed file of a workspace package selects that package and each package that imports it
 *      (package.json dependencies and imports between the source folders).
 *   2. A test file is selected when its import graph (all imports, followed to the end) reaches a source file of a selected
 *      package. Besides the imports, the graph follows each text in the code that names a file or a folder of the repository
 *      ("../fixtures/golden", "deploy/mainnet", "plutus.json"), so a test that reads a data file or scans a folder is selected
 *      when that file or folder changes.
 *   3. Each test file inside a selected package folder is selected (gateway/test, paper2agent/test, ...).
 *   4. Each changed test file is selected. A changed test helper selects the test files that import it.
 *   5. The test files of ALWAYS_RUN are always selected.
 *   6. A change below contracts/identity-marketplace/ selects the test files that read the blueprints or the CBOR fixtures.
 *   7. A change of the root build or test config, or of .github/ or scripts/ci/, selects everything.
 * Docs only selects nothing.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

// ── Rules: edit here ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Test files that run with every selection. They scan the text of the repository, so no import reaches them. */
export const ALWAYS_RUN = ["tests/unit/decoder-sites.test.ts"];

/** The folders of the vitest project `aiken-eval` (vitest.workspace.ts). The job `aiken-eval` runs them; the projects `unit` and `ui` do not. */
export const EVAL_DIRS = ["tests/legacy-registry", "tests/identity-builders", "tests/identity-vectors", "tests/identity-deploy"];

/** Where the projects `unit` and `ui` (vitest.workspace.ts) look for tests: a folder prefix and the extensions of its test files. */
const UNIT_UI_TEST_ROOTS = [
  ["tests/unit/", "tsx"], ["packages/", "ts"], ["gateway/", "ts"], ["paper2agent/", "ts"], ["identity-gateway/", "ts"],
];

/** A change below these paths selects the test files that read the listed data files. */
const CONTRACT_READERS = [
  {
    when: /^contracts\/identity-marketplace\//,
    reads: [
      "contracts/identity-marketplace/fixtures/cbor-fixtures.json", "contracts/identity-marketplace/plutus.json",
      "contracts/marketplace/plutus.json",
    ],
  },
  { when: /^contracts\/marketplace\//, reads: ["contracts/marketplace/plutus.json"] },
];

/** A change of one of these selects all tests (and the typecheck and the job aiken-eval). */
const ROOT_CONFIG_RES = [
  /^package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^tsconfig\.base\.json$/, /^\.npmrc$/, /^\.nvmrc$/, /^patches\//,
  /(^|\/)vitest\.[^/]+$/, /^tests\/setup\.ts$/,
];

/** A change of one of these selects every job. */
const CI_RES = [/^\.github\//, /^scripts\/ci\//];

/** A change of one of these runs the Aiken jobs (the tool or the shard plan changed). */
const AIKEN_TOOL_RES = [/^scripts\/aiken-check/, /^contracts\/identity-marketplace\/aiken-shards\.json$/];

/** The Aiken project files that `aiken check` reads. A change of one of these runs the job `aiken-check`. */
const IDENTITY_AIKEN_RE = /^contracts\/identity-marketplace\/(?:lib\/|validators\/|aiken\.(?:toml|lock)$|plutus\.json$|aiken-shards\.json$)/;

/** Paths with no code: no test, no build, no typecheck reads them (a test that names one still selects itself, see `docsOnly`). */
const DOC_RES = [
  /\.(?:md|mdx|txt|png|jpe?g|gif|svg|pdf)$/i, /^docs\//, /^papers\//, /^prompts\//, /(^|\/)LICENSE$/, /^\.gitignore$/, /^\.dockerignore$/,
];

/** Test-only paths. The same rule is in deploy/mainnet/deploy.sh (TEST_ONLY_RE): a change of them restarts no service. */
export const TEST_PATH_RES = [
  /^tests\//, /(^|\/)test\//, /(^|\/)__tests__\//, /\.(?:test|spec)\.[cm]?[jt]sx?$/, /(^|\/)tsconfig\.test\.json$/, /^vitest\.[^/]*$/,
];

const CODE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const LINE_CODE_RE = /\.(?:[cm]?[jt]s|[jt]sx|ak|sh|py|sql|css|html)$|^scripts\/[^/.]+$/; // also the scripts with no extension (scripts/aiken-check)
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** A name that a text can use for a data file: the graph links the text to each tracked file with this name (at most 3). */
const DATA_NAME_RE = /^[\w.@-]+\.(?:json|hex|ya?ml|md|ak|toml|sh)$/;
const GENERIC_NAMES = new Set(["package.json", "tsconfig.json", "README.md", "LICENSE", "aiken.toml", "aiken.lock"]);
const MAX_SCAN_BYTES = 3_000_000;

export const isDoc = (path) => DOC_RES.some((re) => re.test(path));
export const isTestPath = (path) => TEST_PATH_RES.some((re) => re.test(path));

/** An Aiken module that only tests use: a test module, a fixture module, a property module or the test kit. */
export const isAikenTest = (path) =>
  path.endsWith(".ak") && /(?:^|\/)(?:tests?|properties)\/|(?:_tests|tests|fixtures|kit)\.ak$/.test(path);

/** "test", "source" or "other" for the line counts of a pull request. */
export function lineClass(path) {
  if (isDoc(path) || !LINE_CODE_RE.test(path)) return "other";
  return isTestPath(path) || isAikenTest(path) ? "test" : "source";
}

/** True when the projects `unit` and `ui` (the job `vitest`) run the file. */
export function isUnitUiTest(path) {
  if (path.includes("/node_modules/") || path.includes("/dist/")) return false;
  if (EVAL_DIRS.some((dir) => path.startsWith(`${dir}/`))) return false;
  const root = UNIT_UI_TEST_ROOTS.find(([prefix]) => path.startsWith(prefix));
  if (root === undefined) return false;
  return root[1] === "tsx" ? /\.(?:test|spec)\.tsx?$/.test(path) : /\.(?:test|spec)\.ts$/.test(path);
}

// ── The graph ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The glob lines of the block `packages:` of pnpm-workspace.yaml. */
function workspacePatterns(text) {
  const patterns = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/^packages:\s*$/.test(line)) inBlock = true;
    else if (inBlock) {
      const match = /^\s+-\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(line);
      if (match !== null) patterns.push(match[1]);
      else if (/^\S/.test(line)) inBlock = false;
    }
  }
  return patterns;
}

const globRegExp = (glob) => new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);

/** The workspace packages: folder, name, workspace dependencies, entry points. */
function loadPackages(files, read) {
  const patterns = files.includes("pnpm-workspace.yaml") ? workspacePatterns(read("pnpm-workspace.yaml")).map(globRegExp) : [];
  const dirs = files
    .filter((file) => file.endsWith("/package.json"))
    .map((file) => file.slice(0, -"/package.json".length))
    .filter((dir) => patterns.some((re) => re.test(dir)))
    .sort();
  const packages = dirs.map((dir) => {
    const json = JSON.parse(read(`${dir}/package.json`));
    const deps = { ...json.dependencies, ...json.devDependencies };
    return { dir, name: json.name, deps: Object.keys(deps).filter((name) => String(deps[name]).startsWith("workspace:")), exports: json.exports, main: json.main };
  });
  return packages;
}

function exportTarget(pkg, subpath) {
  const pick = (value) => (typeof value === "string" ? value : value && typeof value === "object" ? pick(value.import ?? value.default ?? value.types) : undefined);
  const map = pkg.exports;
  if (map && typeof map === "object") {
    if (subpath in map) return pick(map[subpath]);
    for (const key of Object.keys(map)) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const head = key.slice(0, star);
      const tail = key.slice(star + 1);
      if (subpath.startsWith(head) && subpath.endsWith(tail) && subpath.length >= key.length - 1) {
        const target = pick(map[key]);
        return target?.replaceAll("*", subpath.slice(head.length, subpath.length - tail.length));
      }
    }
    return undefined;
  }
  if (typeof map === "string" && subpath === ".") return map;
  return subpath === "." ? pkg.main : undefined;
}

const IMPORT_RES = [
  /\bfrom\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1/g,
  /\brequire\s*\(\s*(["'])([^"'\n]+)\1/g,
  /\bvi\s*\.\s*(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*(["'])([^"'\n]+)\1/g,
];
/** A quoted text on one line. Template texts with `${}` give their fixed parts, so that "`${ROOT}/deploy/mainnet/${name}`" names deploy/mainnet. */
const LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/**
 * Build the graph of a tree.
 * @param {string[]} files tracked paths (with `/`)
 * @param {(path: string) => string} read text of a file
 */
export function buildGraph(files, read) {
  const fileSet = new Set(files);
  const dirSet = new Set();
  const byBase = new Map();
  for (const file of files) {
    for (let dir = posix.dirname(file); dir !== "." && dir !== "/" && !dirSet.has(dir); dir = posix.dirname(dir)) dirSet.add(dir);
    if (isDoc(file)) continue; // Reference copies below docs/ do not count as the file that a text names.
    const base = posix.basename(file);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(file);
  }
  const packages = loadPackages(files, read);
  const byName = [...packages].sort((a, b) => b.name.length - a.name.length);
  const byDir = [...packages].sort((a, b) => b.dir.length - a.dir.length);

  /** The package that a path belongs to as source: not a test file and not in a test folder of the package. */
  const packageOf = (path) => {
    const pkg = byDir.find((p) => path.startsWith(`${p.dir}/`));
    if (pkg === undefined) return undefined;
    const inner = path.slice(pkg.dir.length + 1);
    return TEST_FILE_RE.test(inner) || /(^|\/)(?:tests?|__tests__)\//.test(inner) ? undefined : pkg;
  };

  const resolveFile = (base) => {
    if (fileSet.has(base)) return base;
    const js = /^(.*)\.(?:js|jsx|mjs|cjs)$/.exec(base);
    if (js !== null) for (const ext of [".ts", ".tsx", ".mts", ".cts"]) if (fileSet.has(js[1] + ext)) return js[1] + ext;
    for (const ext of [".ts", ".tsx", ".js", ".mjs", ".json"]) if (fileSet.has(base + ext)) return base + ext;
    for (const ext of [".ts", ".tsx", ".js", ".mjs"]) if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return undefined;
  };

  const resolveSpecifier = (from, specifier) => {
    const spec = specifier.split("?")[0];
    if (spec.startsWith(".")) return resolveFile(posix.join(posix.dirname(from), spec));
    const pkg = byName.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (pkg === undefined) return undefined;
    const target = exportTarget(pkg, spec === pkg.name ? "." : `.${spec.slice(pkg.name.length)}`);
    return target === undefined ? undefined : resolveFile(posix.join(pkg.dir, target));
  };

  /** The files and folders of the repository that a quoted text names, seen from the file `from`. */
  const resolveText = (from, text) => {
    const found = { files: [], dirs: [] };
    if (text.length < 2 || text.length > 260 || /[\s*?<>|"'`{}()[\]$#,;=]/.test(text) || text.includes("://") || text.startsWith("node:")) return found;
    const relative = text.startsWith("./") || text.startsWith("../");
    const trimmed = text.replace(/^\/+/, "").replace(/\/+$/, "");
    if (trimmed === "") return found;
    const candidates = new Set(relative ? [posix.normalize(posix.join(posix.dirname(from), text))] : [trimmed, posix.normalize(posix.join(posix.dirname(from), trimmed))]);
    for (const candidate of candidates) {
      if (candidate === "." || candidate.startsWith("..")) continue;
      if (fileSet.has(candidate)) found.files.push(candidate);
      else if (dirSet.has(candidate) && candidate.includes("/")) found.dirs.push(candidate);
      else if (relative) {
        const resolved = resolveFile(candidate);
        if (resolved !== undefined) found.files.push(resolved);
      }
    }
    if (!text.includes("/") && DATA_NAME_RE.test(text) && !GENERIC_NAMES.has(text)) {
      const same = byBase.get(text) ?? [];
      if (same.length <= 3) found.files.push(...same);
    }
    return found;
  };

  /** edges: file -> { files, dirs } that its code names. */
  const edges = new Map();
  for (const file of files) {
    if (!CODE_RE.test(file)) continue;
    const text = read(file);
    if (text.length > MAX_SCAN_BYTES) continue;
    const out = { files: new Set(), dirs: new Set() };
    for (const re of IMPORT_RES) {
      for (const match of text.matchAll(re)) {
        const target = resolveSpecifier(file, match[2]);
        if (target !== undefined && target !== file) out.files.add(target);
      }
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"') && !line.includes("'") && !line.includes("`")) continue;
      for (const match of line.matchAll(LITERAL_RE)) {
        const parts = match[1] === "`" ? match[2].split(/\$\{[^}]*\}/) : [match[2]];
        for (const part of parts) {
          const named = resolveText(file, part);
          for (const target of named.files) if (target !== file) out.files.add(target);
          for (const dir of named.dirs) out.dirs.add(dir);
        }
      }
    }
    edges.set(file, out);
  }

  const reachCache = new Map();
  /**
   * Everything that `start` reaches: tracked files (code is followed to the end, data is a leaf) and the folders that its code
   * names. With `direct`, the walk does not enter the source of a workspace package: it finds what a test and its helpers read.
   */
  const reach = (start, direct = false) => {
    const key = direct ? `direct:${start}` : start;
    const cached = reachCache.get(key);
    if (cached !== undefined) return cached;
    const seen = new Set([start]);
    const dirs = new Set();
    const stack = [start];
    while (stack.length > 0) {
      const edge = edges.get(stack.pop());
      if (edge === undefined) continue;
      for (const target of edge.files) {
        if (seen.has(target)) continue;
        seen.add(target);
        if (CODE_RE.test(target) && !(direct && packageOf(target) !== undefined)) stack.push(target);
      }
      for (const dir of edge.dirs) dirs.add(dir);
    }
    const result = { files: seen, dirs: [...dirs] };
    reachCache.set(key, result);
    return result;
  };
  /** True when a change of `path` can change what `start` reads. */
  const reads = (start, path, direct = false) => {
    const r = reach(start, direct);
    return r.files.has(path) || r.dirs.some((dir) => path.startsWith(`${dir}/`));
  };

  // Packages that import a package: the dependencies of package.json and the imports between the source folders.
  const importers = new Map(packages.map((pkg) => [pkg.dir, new Set()]));
  for (const pkg of packages) {
    for (const name of pkg.deps) {
      const dep = packages.find((p) => p.name === name);
      if (dep !== undefined && dep.dir !== pkg.dir) importers.get(dep.dir).add(pkg.dir);
    }
  }
  for (const [file, edge] of edges) {
    const from = packageOf(file);
    if (from === undefined) continue;
    for (const target of edge.files) {
      const to = packageOf(target);
      if (to !== undefined && to.dir !== from.dir) importers.get(to.dir).add(from.dir);
    }
  }

  return { files, fileSet, packages, packageOf, importers, reach, reads, edges };
}

// ── The decision ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ changed: string[], files: string[], read: (path: string) => string, lines?: { test: number, source: number } }} input
 *   `changed`: the changed paths (also deleted ones); `files`: the tracked paths after the change.
 */
export function analyse({ changed: changedInput, files, read, lines = { test: 0, source: 0 } }) {
  const graph = buildGraph(files, read);
  const changed = [...new Set(changedInput.filter((path) => path !== ""))].sort();
  const present = changed.filter((path) => graph.fileSet.has(path));
  const unitUiTests = files.filter(isUnitUiTest).sort();
  const unitUiTestSet = new Set(unitUiTests);
  const reasons = new Map();
  const why = (test, reason) => {
    if (!reasons.has(test)) reasons.set(test, new Set());
    reasons.get(test).add(reason);
  };
  const code = changed.filter((path) => !isDoc(path));
  const touches = (...res) => code.some((path) => res.some((re) => re.test(path)));

  const ciChanged = touches(...CI_RES);
  const rootConfigChanged = touches(...ROOT_CONFIG_RES);
  const aikenToolChanged = touches(...AIKEN_TOOL_RES);

  // A document that a test names (by its path) is not "docs only": that test must run.
  const docReaders = new Set();
  for (const path of changed.filter(isDoc)) for (const test of unitUiTests) if (graph.reads(test, path)) docReaders.add(test);
  const docsOnly = code.length === 0 && docReaders.size === 0;

  const result = {
    changed, docsOnly, ciChanged, rootConfigChanged, runTypecheck: !docsOnly, lines,
    vitestMode: "none", vitestFiles: [], vitestExclude: [],
    aikenEval: false, contractsIdentity: false, contractsLegacy: false,
    packagesChanged: [], packagesSelected: [], reasons: {},
  };

  result.contractsIdentity = !docsOnly && (ciChanged || aikenToolChanged || touches(IDENTITY_AIKEN_RE));
  result.contractsLegacy = !docsOnly && (ciChanged || aikenToolChanged || touches(/^contracts\/marketplace\//));

  // The job aiken-eval: the listed paths, and every file that a test of the 4 folders reaches.
  const evalTests = files.filter((file) => TEST_FILE_RE.test(file) && EVAL_DIRS.some((dir) => file.startsWith(`${dir}/`)));
  result.aikenEval =
    !docsOnly &&
    (ciChanged || rootConfigChanged || touches(/^contracts\/identity-marketplace\//, /^packages\/shared\/src\/tx\//, ...EVAL_DIRS.map((dir) => new RegExp(`^${dir}/`))) ||
      code.some((path) => evalTests.some((test) => graph.reads(test, path))));

  if (docsOnly) return finish(result, reasons);
  if (ciChanged || rootConfigChanged) {
    result.vitestMode = "all";
    return finish(result, reasons);
  }

  // 1. packages
  const changedPackages = new Set();
  for (const path of changed) {
    const pkg = graph.packageOf(path);
    if (pkg !== undefined) changedPackages.add(pkg.dir);
  }
  // Each package that imports a selected package, also through another package (a worklist, not one pass).
  const selectedPackages = new Set(changedPackages);
  const queue = [...changedPackages];
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    for (const importer of graph.importers.get(dir) ?? []) {
      if (!selectedPackages.has(importer)) {
        selectedPackages.add(importer);
        queue.push(importer);
      }
    }
  }
  result.packagesChanged = [...changedPackages].sort();
  result.packagesSelected = [...selectedPackages].sort();

  for (const test of unitUiTests) {
    // 2. the import graph reaches a source file of a selected package, or a changed path
    for (const file of graph.reach(test).files) {
      const pkg = graph.packageOf(file);
      if (pkg !== undefined && selectedPackages.has(pkg.dir)) {
        why(test, `reaches ${pkg.dir}`);
        break;
      }
    }
    for (const path of changed) if (graph.reads(test, path)) why(test, `reads ${path}`);
    // 3. the test files of a selected package
    for (const dir of selectedPackages) if (test.startsWith(`${dir}/`)) why(test, `test of ${dir}`);
  }
  // 4. changed test files
  for (const path of present) if (unitUiTestSet.has(path)) why(path, "changed");
  // 5. the always-run list
  for (const test of ALWAYS_RUN) if (unitUiTestSet.has(test)) why(test, "always");
  // 6. the test files that read the blueprints and the CBOR fixtures themselves
  for (const { when, reads } of CONTRACT_READERS) {
    if (!touches(when)) continue;
    for (const test of unitUiTests) for (const data of reads) if (graph.reads(test, data, true)) why(test, `reads ${data}`);
  }

  result.vitestFiles = [...reasons.keys()].filter((test) => unitUiTestSet.has(test)).sort();
  result.vitestMode = result.vitestFiles.length > 0 ? "selected" : "none";
  // The filter of vitest is a substring match on the path: "gateway/test/a.test.ts" also matches "identity-gateway/test/a.test.ts".
  const chosen = new Set(result.vitestFiles);
  const lower = result.vitestFiles.map((file) => file.toLowerCase());
  result.vitestExclude = unitUiTests.filter((test) => !chosen.has(test) && lower.some((file) => test.toLowerCase().includes(file)));
  return finish(result, reasons);
}

function finish(result, reasons) {
  const chosen = new Set(result.vitestFiles);
  result.reasons = Object.fromEntries([...reasons].filter(([test]) => chosen.has(test)).map(([test, set]) => [test, [...set]]));
  return result;
}

// ── Git and files ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const lines0 = (text) => text.split("\0").filter((entry) => entry !== "");

/** The tracked files of a folder: `git ls-files` or, without a `.git` folder (a copy on a build host), a walk. */
export function listFiles(root) {
  if (existsSync(posix.join(root, ".git"))) return lines0(git(["ls-files", "-z"], root));
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(posix.join(root, dir), { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", ".vitest-cache", "build", "coverage"].includes(entry.name)) continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out;
}

const commitExists = (sha, cwd) => {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
};

/** The changed paths and the added lines of the event. Every path counts as changed when the event gives no usable range. */
function eventDiff(env, root, files) {
  const all = { changed: files, lines: { test: 0, source: 0 }, range: "every tracked path" };
  const zero = /^0+$/;
  let range;
  if (env.GITHUB_EVENT_NAME === "pull_request" && env.PR_BASE_SHA && env.PR_HEAD_SHA) range = [`${env.PR_BASE_SHA}...${env.PR_HEAD_SHA}`];
  else if (env.GITHUB_EVENT_NAME === "push" && env.PUSH_BEFORE && !zero.test(env.PUSH_BEFORE) && env.PUSH_AFTER && commitExists(env.PUSH_BEFORE, root)) {
    range = [env.PUSH_BEFORE, env.PUSH_AFTER];
  }
  if (range === undefined) return all;
  try {
    return { ...rangeDiff(range, root), range: range.join(" ") };
  } catch (error) {
    // A safe answer: run everything.
    console.warn(`::warning::git diff ${range.join(" ")} failed (${String(error.message).split("\n")[0]}): every path counts as changed`);
    return all;
  }
}

function rangeDiff(range, root) {
  const changed = lines0(git(["diff", "--name-only", "--no-renames", "-z", ...range], root));
  const lines = { test: 0, source: 0 };
  for (const entry of lines0(git(["diff", "--numstat", "--no-renames", "-z", ...range], root))) {
    const [added, , path] = entry.split("\t");
    const count = Number(added);
    if (Number.isFinite(count) && path !== undefined) {
      const kind = lineClass(path);
      if (kind !== "other") lines[kind] += count;
    }
  }
  return { changed, lines };
}

// ── Output ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function outputs(result) {
  return {
    docs_only: String(result.docsOnly),
    run_typecheck: String(result.runTypecheck),
    vitest_mode: result.vitestMode,
    vitest_count: String(result.vitestFiles.length),
    aiken_eval: String(result.aikenEval),
    contracts_identity: String(result.contractsIdentity),
    contracts_legacy: String(result.contractsLegacy),
    test_lines: String(result.lines.test),
    source_lines: String(result.lines.source),
    vitest_files: result.vitestFiles.join("\n"),
    vitest_exclude: result.vitestExclude.join("\n"),
  };
}

export function summary(result, range) {
  const flag = (value) => (value ? "run" : "skip");
  const out = [
    "### Changes",
    "",
    `Range: \`${range}\`. Changed paths: ${result.changed.length}.`,
    "",
    "| Job | Decision | Reason |",
    "|---|---|---|",
    `| typecheck | ${flag(result.runTypecheck)} | ${result.docsOnly ? "docs only" : "code changed"} |`,
    `| vitest | ${result.vitestMode}${result.vitestMode === "selected" ? ` (${result.vitestFiles.length} files)` : ""} | ${result.ciChanged ? "the CI files changed" : result.rootConfigChanged ? "the root build or test config changed" : result.docsOnly ? "docs only" : `packages: ${result.packagesSelected.join(", ") || "none"}`} |`,
    `| aiken-eval | ${flag(result.aikenEval)} | |`,
    `| aiken-check | ${flag(result.contractsIdentity)} | |`,
    `| legacy-contract | ${flag(result.contractsLegacy)} | |`,
    "",
    `Added lines: ${result.lines.test} of test code, ${result.lines.source} of source code.`,
  ];
  if (result.vitestMode === "selected") {
    out.push("", `<details><summary>Selected test files (${result.vitestFiles.length})</summary>`, "");
    for (const file of result.vitestFiles) out.push(`- \`${file}\`: ${(result.reasons[file] ?? []).slice(0, 3).join("; ")}`);
    out.push("", "</details>");
  }
  return `${out.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--files") options.files = argv[++i];
    else if (arg === "--base") options.base = argv[++i];
    else if (arg === "--head") options.head = argv[++i];
    else if (arg === "--root") options.root = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root ?? process.cwd();
  const files = listFiles(root);
  const read = (path) => readFileSync(posix.join(root, path), "utf8");
  let diff;
  if (options.files !== undefined) {
    const text = options.files === "-" ? readFileSync(0, "utf8") : readFileSync(options.files, "utf8");
    diff = { changed: text.split("\n").map((line) => line.trim()).filter(Boolean), lines: { test: 0, source: 0 }, range: `list ${options.files}` };
  } else if (options.base !== undefined && options.head !== undefined) {
    diff = { ...rangeDiff([`${options.base}...${options.head}`], root), range: `${options.base}...${options.head}` };
  } else if (options.all) {
    diff = { changed: files, lines: { test: 0, source: 0 }, range: "every tracked path" };
  } else {
    diff = eventDiff(process.env, root, files);
  }
  const result = analyse({ changed: diff.changed, files, read, lines: diff.lines });
  const text = summary(result, diff.range);
  if (options.json) console.log(JSON.stringify({ range: diff.range, ...result, outputs: outputs(result) }, null, 2));
  else console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (process.env.GITHUB_OUTPUT) {
    const lists = new Set(["vitest_files", "vitest_exclude"]);
    let block = "";
    for (const [name, value] of Object.entries(outputs(result))) {
      // A list uses the delimiter form of GITHUB_OUTPUT: one entry on each line.
      block += lists.has(name) ? `${name}<<CI_EOF\n${value}\nCI_EOF\n` : `${name}=${value}\n`;
    }
    appendFileSync(process.env.GITHUB_OUTPUT, block);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
