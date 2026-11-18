/**
 * serve.test.ts — how the Paper2Agent process listens, shuts down, and starts the health check of the decoder library.
 *
 * The publisher loads the decoder library, and its supplier children run the supplier entry point (tested in the supplier tests).
 * The control role does not load the library. The publisher gets the health check, with its own shutdown as the stop. The control
 * role gets none, and its module for the check is not loaded.
 */

import { createServer, type Server } from "node:net";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import type { DecoderHealth, DecoderHealthOptions } from "@marketplace/shared/tx/server";
import { main, type PaperRoles } from "../src/index.js";
import { serve, type RoleStart } from "../src/serve.js";

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

const health: DecoderHealth = { check: () => undefined, close: () => undefined, watchesStackPointer: true };

async function roleStart(closeService: () => Promise<void> = async () => undefined): Promise<RoleStart> {
  return { app: express(), host: "127.0.0.1", port: await freePort(), closeService };
}

let on: MockInstance<typeof process.on>;
let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exitCode: typeof process.exitCode;
const opened: HttpServer[] = [];
afterEach(async () => {
  on?.mockRestore();
  log?.mockRestore();
  error?.mockRestore();
  process.exitCode = exitCode;
  for (const server of opened.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
});

function quiet(): void {
  exitCode = process.exitCode;
  // The handlers are not registered for real: the worker keeps its own signal behaviour.
  on = vi.spyOn(process, "on").mockImplementation((() => process) as never);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
}

const handlerOf = (signal: string): (() => void) => on.mock.calls.find(([name]) => name === signal)?.[1] as () => void;

describe("serve", () => {
  it("publisher: starts the health check with the server and the function that SIGTERM and SIGINT run, and that function drains first", async () => {
    quiet();
    let release: () => void = () => undefined;
    const closeService = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    let options: DecoderHealthOptions | undefined;
    const server = await serve("publisher", await roleStart(closeService), (given) => { options = given; return health; });
    opened.push(server);

    expect(options!.server).toBe(server);
    expect(options!.stop).toBe(handlerOf("SIGTERM"));
    expect(options!.stop).toBe(handlerOf("SIGINT"));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Paper2Agent publisher listening on 127\.0\.0\.1:\d+$/));

    options!.stop();
    options!.stop(); // a second call does nothing more
    await vi.waitFor(() => expect(closeService).toHaveBeenCalledTimes(1));
    // The publisher drains accepted paid work before it closes the server.
    expect(server.listening).toBe(true);
    release();
    await vi.waitFor(() => expect(server.listening).toBe(false));
    expect(closeService).toHaveBeenCalledTimes(1);
  });

  it("control: starts no health check, and closes the server and the service together", async () => {
    quiet();
    const closeService = vi.fn(async () => undefined);
    const server = await serve("control", await roleStart(closeService));
    opened.push(server);
    handlerOf("SIGTERM")();
    await vi.waitFor(() => expect(server.listening).toBe(false));
    expect(closeService).toHaveBeenCalledTimes(1);
  });

  it("writes the error, sets the exit code, and stops the connections of the control role when the shutdown fails", async () => {
    quiet();
    const server = await serve("control", await roleStart(async () => { throw new Error("close failed"); }));
    opened.push(server);
    const closeAll = vi.spyOn(server, "closeAllConnections");
    handlerOf("SIGINT")();
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(error).toHaveBeenCalledWith("Paper2Agent control shutdown failed", expect.objectContaining({ message: "close failed" }));
    expect(closeAll).toHaveBeenCalled();
  });

  it("closes the service and throws when the server cannot listen", async () => {
    quiet();
    const taken = await new Promise<Server>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => resolve(s)); });
    const closeService = vi.fn(async () => undefined);
    const address = taken.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await expect(serve("publisher", { app: express(), host: "127.0.0.1", port, closeService })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(closeService).toHaveBeenCalledTimes(1);
    expect(on).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => taken.close(() => resolve()));
  });
});

describe("main: the roles", () => {
  function roles(): { roles: PaperRoles; startHealth: Mock; loaded: Mock } {
    const startHealth = vi.fn((_options: DecoderHealthOptions) => health);
    const loaded = vi.fn(async () => startHealth);
    return {
      startHealth,
      loaded,
      roles: { control: async () => roleStart(), publisher: async () => roleStart(), startHealth: loaded },
    };
  }

  it("the publisher starts the health check with its own shutdown", async () => {
    quiet();
    const fake = roles();
    await main("publisher", fake.roles);
    expect(fake.startHealth).toHaveBeenCalledTimes(1);
    const options = fake.startHealth.mock.calls[0]![0] as DecoderHealthOptions;
    opened.push(options.server as HttpServer);
    expect(options.stop).toBe(handlerOf("SIGTERM"));
  });

  it("the control role starts no health check, and does not load the module for it", async () => {
    quiet();
    const fake = roles();
    const control = vi.spyOn(fake.roles, "control");
    await main("control", fake.roles);
    expect(control).toHaveBeenCalledTimes(1);
    expect(fake.loaded).not.toHaveBeenCalled();
    expect(fake.startHealth).not.toHaveBeenCalled();
    // The server of the control role stays open until the afterEach of this file closes it through the signal path.
    handlerOf("SIGTERM")();
  });

  it.each([undefined, "", "both", "Publisher"])("refuses the role %j with the usage line", async (role) => {
    await expect(main(role, roles().roles)).rejects.toThrow("Usage: tsx paper2agent/src/index.ts <control|publisher>");
  });
});
