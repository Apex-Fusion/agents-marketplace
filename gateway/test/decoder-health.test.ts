/**
 * decoder-health.test.ts — the gateway starts the health check of the decoder library with its own shutdown.
 *
 * The gateway loads the decoder library. When the library cannot decode a known value, the gateway takes the path that a SIGTERM
 * takes (stop the sweeper and the wallet ticker, close the server, exit), so that Docker starts it again. The check itself is
 * tested in tests/unit/decoder-health.test.ts; here a stand-in starts it, and the test holds what the gateway gives it.
 */

import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { DecoderHealthOptions } from "@marketplace/shared/tx/server";
import { runMain } from "../src/index.js";

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let exit: MockInstance<typeof process.exit>;
let once: MockInstance<typeof process.once>;
let log: MockInstance<typeof console.log>;
afterEach(() => {
  exit?.mockRestore();
  once?.mockRestore();
  log?.mockRestore();
});

describe("gateway: the check of the decoder library", () => {
  it("gives the check the server and the function of its SIGTERM handler as the stop, and that stop shuts the gateway down", async () => {
    const port = await freePort();
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    // The handlers are not registered for real: the worker keeps its own signal behaviour.
    once = vi.spyOn(process, "once").mockImplementation((() => process) as never);
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let options: DecoderHealthOptions | undefined;
    const started = vi.fn((given: DecoderHealthOptions) => {
      options = given;
      return { check: () => undefined, close: () => undefined, watchesStackPointer: true };
    });

    runMain(
      {
        GATEWAY_MASTER_KEY: "c7".repeat(32),
        INDEXER_URL: "http://indexer.test",
        OGMIOS_URL: "http://ogmios.test",
        LIVE_CHAIN: "1",
        GATEWAY_DB_DIR: join(tmpdir(), `gw-health-${randomUUID()}`),
        GATEWAY_PORT: String(port),
      },
      started,
    );

    expect(started).toHaveBeenCalledTimes(1);
    const server = options!.server;
    await vi.waitFor(() => expect(server.listening).toBe(true));
    // The same function that a SIGTERM runs: the check reuses the normal shutdown, it does not start another one.
    const sigterm = once.mock.calls.find(([signal]) => signal === "SIGTERM")?.[1];
    expect(options!.stop).toBe(sigterm);

    options!.stop();
    options!.stop(); // a second call does nothing more
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(server.listening).toBe(false);
    expect(log.mock.calls.filter(([line]) => line === "[gateway] shutting down...")).toHaveLength(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
