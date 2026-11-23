// GET /schemas/{name}.json: the JSON Schema files that the gateway publishes. The files are in the
// folder `identity-gateway/schemas`, next to `src` and `dist`, and the image holds that folder. The
// route reads the folder once, when the gateway starts, and serves each file as it is. A file name is
// lowercase letters, digits and hyphens, then `.json`; no other name is served. The `$id` of each file
// is its URL under the public origin of the gateway.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Route } from "./http.js";

const FILE_NAME = /^[a-z0-9][a-z0-9-]*\.json$/;
const SCHEMA_PATH = /^\/schemas\/([a-z0-9][a-z0-9-]*\.json)$/;
export const SCHEMA_MEDIA_TYPE = "application/schema+json";

/** The schema files of a folder (a `file:` URL that ends with a slash), by file name. A folder that does not exist holds none. */
export function loadSchemas(dir: URL): ReadonlyMap<string, Buffer> {
  if (!existsSync(dir)) return new Map();
  return new Map(
    readdirSync(dir)
      .filter((name) => FILE_NAME.test(name))
      .map((name): [string, Buffer] => [name, readFileSync(new URL(name, dir))]),
  );
}

/**
 * The route of the schema files. A path that names no file is not its own (the server answers 404). The
 * files do not change while the gateway runs, so a client may keep a file for an hour.
 * `Access-Control-Allow-Origin: *` lets a validator in a browser read it, and the preflight answers as
 * the render routes do.
 */
export function schemaRoutes(schemas: ReadonlyMap<string, Buffer>): Route {
  return async (req, res, path) => {
    const body = schemas.get(SCHEMA_PATH.exec(path)?.[1] ?? "");
    if (body === undefined) return false;
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "Accept, Content-Type, If-None-Match",
        "access-control-max-age": "86400",
      });
      res.end();
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, OPTIONS", "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("method not allowed\n");
      return true;
    }
    res.writeHead(200, {
      "content-type": SCHEMA_MEDIA_TYPE,
      "content-length": body.length,
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  };
}
