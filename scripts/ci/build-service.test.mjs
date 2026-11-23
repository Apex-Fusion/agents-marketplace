// Table test of rewriteSource in scripts/ci/build-service.mjs (the bundles that the images run). Run: node --test scripts/ci/
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { rewriteSource } from "./build-service.mjs";

const FILE = "/repo/packages/shared/src/tx/escrow/claim.ts";
const FILE_URL = JSON.stringify(pathToFileURL(FILE).href);

test("a marked dynamic import through a string constant becomes a literal import", () => {
  const source = [
    'const liveCborPath = "../internal/liveCbor.js";',
    "const { buildLiveTxForClaim } = await import(/* @vite-ignore */ liveCborPath);",
  ].join("\n");
  assert.equal(
    rewriteSource(source, FILE, false),
    ['const liveCborPath = "../internal/liveCbor.js";', 'const { buildLiveTxForClaim } = await import("../internal/liveCbor.js");'].join("\n"),
  );
});

test("import.meta.url becomes the URL of the source file, except in the entry", () => {
  const source = "const here = dirname(fileURLToPath(import.meta.url));";
  assert.equal(rewriteSource(source, FILE, false), `const here = dirname(fileURLToPath(${FILE_URL}));`);
  assert.equal(rewriteSource(source, FILE, true), source);
});

test("a marked import that cannot become literal stops the build", () => {
  for (const source of [
    "await import(/* @vite-ignore */ livePath);",
    "const livePath = `./live.js`;\nawait import(/* @vite-ignore */ livePath);",
    "await import( /* @vite-ignore */ join(dir, name));",
  ]) {
    assert.throws(() => rewriteSource(source, FILE, false), /@vite-ignore/, source);
  }
});
