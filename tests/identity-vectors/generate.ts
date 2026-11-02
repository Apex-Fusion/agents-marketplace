// Writes the published vectors (Part 2 §12.4) to contracts/identity-marketplace/vectors/ and the
// Aiken module that checks the identifiers and the allowlist proofs. Needs `aiken` on PATH (fmt).
//   npx tsx tests/identity-vectors/generate.ts
// Review every changed vector against Part 1 and Part 2 before committing: the files are the reference.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIKEN_VECTOR_MODULE, formatAiken, renderAikenVectors } from "./aiken-vectors.js";
import { VECTOR_DIR, allowlistVectors, identifierVectors, vectorFiles } from "./vectors.js";

mkdirSync(VECTOR_DIR, { recursive: true });
for (const [name, text] of Object.entries(await vectorFiles())) {
  writeFileSync(join(VECTOR_DIR, name), text);
  console.log(`wrote contracts/identity-marketplace/vectors/${name}`);
}
writeFileSync(AIKEN_VECTOR_MODULE, formatAiken(renderAikenVectors(identifierVectors(), allowlistVectors())));
console.log("wrote contracts/identity-marketplace/lib/identity_marketplace/properties/published_vectors.ak");
