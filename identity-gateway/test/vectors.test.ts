// The published DID-document vectors (Part 2 Section 12.4): each file holds a ledger, the resolver
// settings, the requests and the expected results. The resolver must reproduce every result byte for
// byte under JCS.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { canonicalize } from "../src/resolve/jcs.js";
import { VectorResolver, httpStatus } from "../src/resolve/resolver.js";
import { chainFromJson, type VectorFile } from "./vectors/format.js";

const directory = join(dirname(fileURLToPath(import.meta.url)), "vectors");
const files: VectorFile[] = readdirSync(directory)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(directory, f), "utf8")) as VectorFile);

describe("DID-document vectors", () => {
  test("the set covers Part 2 Section 12.4", () => {
    expect(files.map((f) => f.name).sort()).toEqual([
      "adopted",
      "legacy-after-cutoff",
      "legacy-before-cutoff",
      "legacy-deregistered",
      "pending-versions",
      "retired-successor",
      "revoked-invalid-from",
      "root-agent",
      "subagent",
      "suspended-two-authors",
      "unaccountable",
    ]);
  });

  describe.each(files.map((f) => [f.name, f] as const))("%s", (_name, file) => {
    test.each(file.requests.map((r, i) => [i, r] as const))("request %i", async (_index, request) => {
      const resolver = new VectorResolver(chainFromJson(file.ledger), file.settings, {
        log: (m) => {
          throw new Error(m);
        },
      });
      const result = await resolver.resolveDid(request.did, request.options);
      expect(canonicalize(result)).toBe(canonicalize(request.result));
      expect(httpStatus(result)).toBe(request.httpStatus);
    });
  });
});
