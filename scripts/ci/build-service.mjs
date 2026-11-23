#!/usr/bin/env node
/**
 * scripts/ci/build-service.mjs: bundle the server of a service into <service>/dist-server/ with esbuild.
 *
 *   node scripts/ci/build-service.mjs <service>...     buyer gateway indexer supplier wallet-monitor paper2agent
 *   node scripts/ci/build-service.mjs --all
 *
 * The Dockerfiles and the CI job `typecheck` run it. The image starts `node --enable-source-maps <service>/dist-server/index.js`,
 * so no tsx process and no esbuild process run next to the service. The bundle keeps the semantics that the sources had under tsx:
 * - The workspace packages (@marketplace/*) go into the bundle, because they export .ts files.
 * - Each other import stays external. Its specifier becomes the absolute file that Node resolves from the importing source file:
 *   pnpm gives each package only its own dependencies, so a dependency of packages/shared is not visible from buyer/.
 * - In each bundled source file except the entry, import.meta.url becomes the URL of that source file. Code that finds files next
 *   to itself (the blueprints in contracts/, createRequire) keeps working, because the image keeps the sources at the same path.
 * - A dynamic import through a constant with the @vite-ignore marker becomes a literal import. The live CBOR builders hide lucid from
 *   the browser bundle that way. esbuild then puts the module into a lazy chunk, so lucid loads only on the live path, as before.
 * The output is valid only at the path where it was built (/repo in the images). The build fails on a marked import without a
 * constant and on an import that does not resolve. esbuild loads only when a bundle is built, so the tests of the CI scripts can
 * import rewriteSource without packages.
 */
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SERVICES = ["buyer", "gateway", "indexer", "supplier", "wallet-monitor", "paper2agent"];
const WORKSPACE = /^@marketplace\//;
const HIDDEN_IMPORT = /import\(\/\* @vite-ignore \*\/ (\w+)\)/g;
const LEFT_HIDDEN = /import\(\s*\/\*\s*@vite-ignore/;

/** The source with import.meta.url fixed to the file (not in the entry) and each marked dynamic import made literal. */
export function rewriteSource(text, file, isEntry) {
  let out = isEntry ? text : text.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(file).href));
  out = out.replace(HIDDEN_IMPORT, (_whole, name, offset, source) => {
    const decls = [...source.slice(0, offset).matchAll(new RegExp(`const ${name} = ("[^"\\n]+");`, "g"))];
    if (decls.length === 0) throw new Error(`${file}: import(/* @vite-ignore */ ${name}) has no constant ${name} before it`);
    return `import(${decls.at(-1)[1]})`;
  });
  if (LEFT_HIDDEN.test(out)) throw new Error(`${file}: an import with @vite-ignore has a form that this script cannot make literal`);
  return out;
}

function servicePlugin(entry, unresolved) {
  return {
    name: "marketplace-service",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData?.inner) return undefined;
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        if (WORKSPACE.test(args.path)) return undefined;
        const found = await b.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { inner: true },
        });
        if (found.errors.length > 0) {
          unresolved.push(`${args.path} (from ${args.importer})`);
          return { path: args.path, external: true };
        }
        return { path: found.path, external: true };
      });
      b.onLoad({ filter: /\.[cm]?tsx?$/ }, async (args) => {
        if (args.path.includes(`${sep}node_modules${sep}`)) return undefined;
        const text = await readFile(args.path, "utf8");
        return {
          contents: rewriteSource(text, args.path, args.path === entry),
          loader: args.path.endsWith("x") ? "tsx" : "ts",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

/** Bundles one entry file into outdir (index.js, chunks/, source maps). Throws when an import does not resolve. */
export async function bundle(entry, outdir) {
  const { build } = await import("esbuild");
  const unresolved = [];
  await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outdir,
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    // Node resolves with these conditions and fields; the external paths must be the files that Node would load.
    conditions: ["module-sync"],
    mainFields: ["main"],
    sourcemap: true,
    sourcesContent: false,
    legalComments: "none",
    logLevel: "warning",
    plugins: [servicePlugin(entry, unresolved)],
  });
  if (unresolved.length > 0) throw new Error(`${entry}: imports that do not resolve:\n  ${unresolved.join("\n  ")}`);
}

export async function buildService(service) {
  if (!SERVICES.includes(service)) throw new Error(`unknown service ${service}; known: ${SERVICES.join(", ")}`);
  await bundle(join(ROOT, service, "src", "index.ts"), join(ROOT, service, "dist-server"));
  console.log(`${service}: ${service}/dist-server/index.js`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const services = args.includes("--all") ? SERVICES : args;
  if (services.length === 0) {
    console.error("usage: node scripts/ci/build-service.mjs <service>... | --all");
    process.exit(2);
  }
  for (const service of services) await buildService(service);
}
