/**
 * supplier-decoder-health.test.ts — the supplier starts the health check of the decoder library with its own shutdown.
 *
 * The supplier loads the decoder library. The children of the Paper2Agent publisher run this entry point, so they start the check
 * too. When the library cannot decode a known value, the supplier takes the path that a SIGTERM takes (mark the state offline, stop
 * the timers, close the server, exit) and ends with exit code 1, so that Docker starts it again, or the publisher starts the child
 * again. The check itself is tested in decoder-health.test.ts; here a stand-in starts it, and the test runs both triggers through one
 * scenario.
 */

import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { DecoderHealthOptions } from "../../packages/shared/src/tx/server.js";
import { SupplierState } from "../../supplier/src/state.js";
import { DECODER_STOP_LIMIT_MS, main } from "../../supplier/src/index.js";
import { buildSampleEnv } from "../fixtures/supplier-side/sample-config.js";

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
let on: MockInstance<typeof process.on>;
let log: MockInstance<typeof console.log>;
let offline: MockInstance<typeof SupplierState.prototype.markOffline>;
afterEach(() => {
  exit?.mockRestore();
  on?.mockRestore();
  log?.mockRestore();
  offline?.mockRestore();
  vi.unstubAllEnvs();
});

/** Boots the supplier with a stand-in for the check, and gives back what it gave the check and what it registered for SIGTERM. */
async function boot(): Promise<{ options: DecoderHealthOptions; sigterm: () => void }> {
  const port = await freePort();
  for (const [name, value] of Object.entries({ ...buildSampleEnv(), PORT: String(port), SUPPLIER_BIND_HOST: "127.0.0.1" })) vi.stubEnv(name, value);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  // The handlers are not registered for real: the worker keeps its own signal behaviour.
  on = vi.spyOn(process, "on").mockImplementation((() => process) as never);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  offline = vi.spyOn(SupplierState.prototype, "markOffline");
  let options: DecoderHealthOptions | undefined;
  const started = vi.fn((given: DecoderHealthOptions) => {
    options = given;
    return { check: () => undefined, close: () => undefined, watchesStackPointer: true };
  });
  await main(started);
  expect(started).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(options!.server.listening).toBe(true));
  const handler = on.mock.calls.find(([signal]) => signal === "SIGTERM")?.[1] as (() => void) | undefined;
  expect(handler).toBeTypeOf("function");
  return { options: options!, sigterm: handler! };
}

describe("supplier: the check of the decoder library", () => {
  it.each([
    ["a SIGTERM", 0],
    ["the check of the decoder library", 1],
  ])("shuts the supplier down in the same way for %s, with exit code %i", async (trigger, code) => {
    const { options, sigterm } = await boot();
    expect(options.stopLimitMs).toBe(DECODER_STOP_LIMIT_MS);
    if (trigger === "a SIGTERM") sigterm();
    else expect(options.stop(1)).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code));
    expect(options.server.listening).toBe(false);
    expect(offline).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([line]) => String(line)).filter((line) => line.endsWith("shutting down"))).toEqual([
      trigger === "a SIGTERM" ? "received SIGTERM, shutting down" : "received the decoder check, shutting down",
    ]);
  });

  it("does the shutdown one time, with the exit code of the SIGTERM, when the check follows a SIGTERM", async () => {
    const { options, sigterm } = await boot();
    sigterm();
    expect(options.stop(1)).toBe(false);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(offline).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter(([line]) => String(line).endsWith("shutting down"))).toHaveLength(1);
  });
});
