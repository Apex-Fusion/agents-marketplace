// Writes the DID-document vector files (Part 2 Section 12.4) from scenarios.ts:
//   npx tsx identity-gateway/test/vectors/generate.ts
// Review every changed result against Part 1 before committing: the files are the reference.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../src/resolve/jcs.js";
import { VectorResolver, httpStatus } from "../../src/resolve/resolver.js";
import { ledgerToJson, type VectorFile } from "./format.js";
import { scenarios } from "./scenarios.js";

const directory = dirname(fileURLToPath(import.meta.url));

for (const scenario of scenarios()) {
  const ledger = ledgerToJson(scenario.builder.chain);
  const resolver = new VectorResolver(scenario.builder.chain, scenario.builder.settings, {
    log: (m) => {
      throw new Error(`${scenario.name}: ${m}`);
    },
  });
  const requests: VectorFile["requests"] = [];
  for (const request of scenario.requests) {
    const options = request.options ?? {};
    const result = await resolver.resolveDid(request.did, options);
    // JCS member order, so that the file shows the result as resolvers serialise it.
    requests.push({ did: request.did, options: { ...options }, httpStatus: httpStatus(result), result: JSON.parse(canonicalize(result)) });
  }
  const file: VectorFile = {
    name: scenario.name,
    description: scenario.description,
    specification: "docs/did-vector-method.md",
    comparison:
      "Resolve each request against the ledger (as of its tip) and the settings. The JCS (RFC 8785) serialisation of the result must equal that of `result`, except the error `title` (Part 1 Section 8.2).",
    settings: scenario.builder.settings,
    ledger,
    requests,
  };
  writeFileSync(join(directory, `${scenario.name}.json`), `${JSON.stringify(file, null, 2)}\n`);
  console.log(`wrote ${scenario.name}.json (${requests.length} requests)`);
}
