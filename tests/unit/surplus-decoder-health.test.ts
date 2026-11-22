/**
 * surplus-decoder-health.test.ts — the surplus seller starts the health check of the decoder library with its own shutdown.
 *
 * The surplus seller is a process with its own HTTP server. Its proof publisher builds transactions, so it loads the decoder
 * library. When the library cannot decode a known value, the seller takes the path that a SIGTERM takes (stop the proof publisher,
 * stop the controller, close the server) and ends with exit code 1, so that Docker starts it again. The check itself is tested in
 * decoder-health.test.ts; here a stand-in starts it, and the test runs both triggers through one scenario.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { DecoderHealthOptions } from "../../packages/shared/src/tx/server.js";
import { DECODER_STOP_LIMIT_MS, installShutdown } from "../../supplier/src/cli/surplus-seller.js";

/** The options of `vi.waitFor`: the shutdown ends in a few ms, so the check runs every 5 ms (the default is 50 ms). */
const POLL = { interval: 5 };

let on: MockInstance<typeof process.on>;
let log: MockInstance<typeof console.log>;
let exitCode: typeof process.exitCode;
const servers: Server[] = [];
afterEach(async () => {
  on?.mockRestore();
  log?.mockRestore();
  process.exitCode = exitCode;
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
});

async function boot() {
  exitCode = process.exitCode;
  // The handlers are not registered for real: the worker keeps its own signal behaviour.
  on = vi.spyOn(process, "on").mockImplementation((() => process) as never);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const order: string[] = [];
  const controller = { stop: async () => { order.push("controller"); } };
  const publisher = { stop: async () => { order.push("publisher"); } };
  let options: DecoderHealthOptions | undefined;
  const started = vi.fn((given: DecoderHealthOptions) => {
    options = given;
    return { check: () => undefined, close: () => undefined, watchesStackPointer: true };
  });
  installShutdown({ server, controller, publisher }, started);
  const handler = on.mock.calls.find(([signal]) => signal === "SIGTERM")?.[1] as (() => void) | undefined;
  return { server, order, started, options: options!, handler: handler! };
}

describe("surplus seller: the check of the decoder library", () => {
  it.each(["a SIGTERM", "the check of the decoder library"])("shuts the seller down in the same way for %s", async (trigger) => {
    const { server, order, started, options, handler } = await boot();
    expect(started).toHaveBeenCalledTimes(1);
    expect(options.server).toBe(server);
    expect(options.stopLimitMs).toBe(DECODER_STOP_LIMIT_MS);
    expect(handler).toBeTypeOf("function");
    if (trigger === "a SIGTERM") handler();
    else expect(options.stop(1)).toBe(true);
    await vi.waitFor(() => expect(server.listening).toBe(false), POLL);
    expect(order).toEqual(["publisher", "controller"]);
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      `Surplus seller controller shutting down (${trigger === "a SIGTERM" ? "SIGTERM" : "the decoder check"})`,
    ]);
    expect(process.exitCode).toBe(trigger === "a SIGTERM" ? exitCode : 1);
  });

  it("does the shutdown one time, with no change of the exit code, when the check follows a SIGTERM", async () => {
    const { server, order, options, handler } = await boot();
    handler();
    expect(options.stop(1)).toBe(false);
    await vi.waitFor(() => expect(server.listening).toBe(false), POLL);
    expect(order).toEqual(["publisher", "controller"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(exitCode);
  });

  it("works with no proof publisher", async () => {
    exitCode = process.exitCode;
    on = vi.spyOn(process, "on").mockImplementation((() => process) as never);
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
    let stopped = false;
    let options: DecoderHealthOptions | undefined;
    installShutdown({ server, controller: { stop: async () => { stopped = true; } }, publisher: null }, (given) => {
      options = given;
      return { check: () => undefined, close: () => undefined, watchesStackPointer: true };
    });
    expect(options!.stop(1)).toBe(true);
    await vi.waitFor(() => expect(server.listening).toBe(false), POLL);
    expect(stopped).toBe(true);
  });
});
