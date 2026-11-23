// GET /schemas/{name}.json (server/routes-schemas.ts): the files of a folder, as they are, with the media type of JSON Schema.

import { readFileSync } from "node:fs";
import { once } from "node:events";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createResolverServer } from "../src/server/http.js";
import { loadSchemas, schemaRoutes } from "../src/server/routes-schemas.js";

const FOLDER = new URL("./fixtures/schemas/", import.meta.url);
const FILE = readFileSync(new URL("example-1.json", FOLDER));

const server = createResolverServer(
  {
    resolveDid: async () => {
      throw new Error("a schema request does not resolve a DID");
    },
  },
  { log: () => undefined, routes: [schemaRoutes(loadSchemas(FOLDER))] },
);
let base = "";
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server has no TCP address");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.close();
  await once(server, "close");
});

test("a schema file is served as it is, with the media type of JSON Schema; no other name is served", async () => {
  const response = await fetch(`${base}/schemas/example-1.json`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/schema+json");
  expect(Buffer.from(await response.arrayBuffer()).equals(FILE)).toBe(true);

  const head = await fetch(`${base}/schemas/example-1.json`, { method: "HEAD" });
  expect([head.status, head.headers.get("content-length"), (await head.text()).length]).toEqual([200, String(FILE.length), 0]);

  for (const [path, status] of [
    ["/schemas/other-1.json", 404],
    ["/schemas/Example-1.json", 404],
    ["/schemas/..%2fexample-1.json", 404],
    ["/schemas/", 404],
  ] as const) {
    expect([path, (await fetch(`${base}${path}`)).status]).toEqual([path, status]);
  }
  expect((await fetch(`${base}/schemas/example-1.json`, { method: "POST" })).status).toBe(405);
});
