/**
 * decoder-health.test.ts — the health of the decoder library in a process.
 *
 * A process that loads the decoder library puts the stack pointer of the library back after each HTTP request and on a timer, and
 * then asks the library to decode one known value. When it cannot, the process writes one line and starts its normal shutdown, so
 * that its supervisor starts it again. These tests use a stand-in for the library: a module with a stack pointer and a decoder
 * that can be made to fail. One test reads the real library, which works, and moves its pointer by hand.
 */

import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { CML } from "@lucid-evolution/lucid";
import {
  decoderWorks,
  restoreStackPointer,
  startDecoderHealth,
  unwatchStackPointer,
  watchStackPointer,
  type DecoderLibrary,
} from "../../packages/shared/src/tx/internal/decoderHealth.js";

const START = 1_048_576;

interface StandIn {
  library: DecoderLibrary;
  /** The stack pointer now. */
  pointer(): number;
  /** Lowers the pointer, as a failed call that did not give its stack back does. */
  lower(bytes: number): void;
  /** Makes the decoder fail from now on (or work again). */
  breakDecoder(broken?: boolean): void;
  decoded: string[];
  freed: number;
}

function standIn(start = START): StandIn {
  let pointer = start;
  let broken = false;
  const state: StandIn = {
    decoded: [],
    freed: 0,
    pointer: () => pointer,
    lower: (bytes) => {
      pointer -= bytes;
    },
    breakDecoder: (value = true) => {
      broken = value;
    },
    library: {
      __wasm: {
        __wbindgen_add_to_stack_pointer: (delta: number) => {
          pointer += delta;
          return pointer;
        },
      },
      PlutusData: {
        from_cbor_hex: (hex: string) => {
          state.decoded.push(hex);
          if (broken) throw new Error("the decoder cannot decode");
          return { free: () => { state.freed += 1; } };
        },
      },
    },
  };
  return state;
}

/** A server that only emits `request`, and a response that only emits `close`. */
function fakeServer(): { server: Server; request: () => EventEmitter } {
  const server = new EventEmitter();
  return {
    server: server as unknown as Server,
    request: () => {
      const response = new EventEmitter();
      server.emit("request", new EventEmitter(), response);
      return response;
    },
  };
}

let error: MockInstance<typeof console.error>;
beforeEach(() => {
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  unwatchStackPointer();
  error.mockRestore();
  vi.useRealTimers();
});

describe("decoderWorks", () => {
  it("decodes one known value and frees the result", () => {
    const library = standIn();
    expect(decoderWorks(library.library)).toBe(true);
    expect(library.decoded).toEqual(["d87980"]);
    expect(library.freed).toBe(1);
  });

  it("says no, and does not throw, when the library cannot decode the value", () => {
    const library = standIn();
    library.breakDecoder();
    expect(decoderWorks(library.library)).toBe(false);
  });

  it("works with the real library", () => {
    expect(decoderWorks()).toBe(true);
  });
});

describe("watchStackPointer", () => {
  it("watches a library that has the pointer, and says so", () => {
    expect(watchStackPointer(standIn().library)).toBe(true);
  });

  it.each([
    ["has no instance", {}],
    ["has an instance that is not an object", { __wasm: 7 }],
    ["has no function for the pointer", { __wasm: {} }],
    ["has a function that gives no number", { __wasm: { __wbindgen_add_to_stack_pointer: () => "x" } }],
    ["has a pointer that is not whole", { __wasm: { __wbindgen_add_to_stack_pointer: () => 1.5 } }],
  ])("watches nothing when the library %s", (_name, library) => {
    expect(watchStackPointer(library)).toBe(false);
    expect(() => restoreStackPointer()).not.toThrow();
  });

  it("watches nothing when two reads of the pointer differ", () => {
    let pointer = 100;
    const library = { __wasm: { __wbindgen_add_to_stack_pointer: () => (pointer += 16) } };
    expect(watchStackPointer(library)).toBe(false);
  });

  it("watches the real library", () => {
    expect(watchStackPointer()).toBe(true);
  });
});

describe("restoreStackPointer", () => {
  it("puts a pointer back that is below its start value, and writes one line with the difference", () => {
    const library = standIn();
    watchStackPointer(library.library);
    library.lower(4096);
    restoreStackPointer();
    expect(library.pointer()).toBe(START);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("4096 bytes below its start value");
    expect(String(error.mock.calls[0]?.[0])).toContain("put it back");
  });

  it("does not touch a pointer at its start value, and writes nothing", () => {
    const library = standIn();
    watchStackPointer(library.library);
    restoreStackPointer();
    restoreStackPointer();
    expect(library.pointer()).toBe(START);
    expect(error).not.toHaveBeenCalled();
  });

  it("does not touch a pointer above its start value", () => {
    const library = standIn();
    watchStackPointer(library.library);
    library.lower(-64);
    restoreStackPointer();
    expect(library.pointer()).toBe(START + 64);
    expect(error).not.toHaveBeenCalled();
  });

  it("does nothing when no pointer is watched", () => {
    const library = standIn();
    library.lower(64);
    restoreStackPointer();
    expect(library.pointer()).toBe(START - 64);
  });

  it("says so when the pointer cannot be put back", () => {
    let pointer = START;
    // A library whose pointer does not move when it is asked to.
    watchStackPointer({ __wasm: { __wbindgen_add_to_stack_pointer: () => pointer } });
    pointer = START - 32;
    restoreStackPointer();
    expect(String(error.mock.calls[0]?.[0])).toContain("32 bytes below its start value");
    expect(String(error.mock.calls[0]?.[0])).toContain("could not put it back");
  });

  it("does not throw when the library throws", () => {
    let throwing = false;
    watchStackPointer({ __wasm: { __wbindgen_add_to_stack_pointer: () => { if (throwing) throw new Error("gone"); return START; } } });
    throwing = true;
    expect(() => restoreStackPointer()).not.toThrow();
  });

  it("puts the pointer of the real library back after it was moved down, and the library still decodes", () => {
    expect(watchStackPointer()).toBe(true);
    const wasm = Reflect.get(CML, "__wasm") as { __wbindgen_add_to_stack_pointer: (delta: number) => number };
    const start = wasm.__wbindgen_add_to_stack_pointer(0);
    wasm.__wbindgen_add_to_stack_pointer(-256);
    expect(wasm.__wbindgen_add_to_stack_pointer(0)).toBe(start - 256);
    restoreStackPointer();
    expect(wasm.__wbindgen_add_to_stack_pointer(0)).toBe(start);
    expect(decoderWorks()).toBe(true);
    expect(String(error.mock.calls[0]?.[0])).toContain("256 bytes below its start value");
  });
});

describe("startDecoderHealth", () => {
  it("changes nothing and writes nothing when the library works: not after a request, not on the timer", () => {
    vi.useFakeTimers();
    const library = standIn();
    const stop = vi.fn();
    const { server, request } = fakeServer();
    const health = startDecoderHealth({ server, stop, library: library.library });
    for (let i = 0; i < 5; i += 1) request().emit("close");
    vi.advanceTimersByTime(10_000);
    expect(stop).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(library.pointer()).toBe(START);
    health.close();
  });

  it("checks after each request ends, not before", () => {
    const library = standIn();
    const { server, request } = fakeServer();
    const health = startDecoderHealth({ server, stop: vi.fn(), library: library.library });
    const before = library.decoded.length;
    const response = request();
    expect(library.decoded.length).toBe(before);
    response.emit("close");
    expect(library.decoded.length).toBe(before + 1);
    health.close();
  });

  it("checks on a timer of 1 s, and the timer does not keep the process alive", () => {
    vi.useFakeTimers();
    const library = standIn();
    const timers = vi.spyOn(globalThis, "setInterval");
    const { server } = fakeServer();
    const health = startDecoderHealth({ server, stop: vi.fn(), library: library.library });
    expect(timers).toHaveBeenCalledTimes(1);
    expect(timers.mock.calls[0]?.[1]).toBe(1000);
    const timer = timers.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    const before = library.decoded.length;
    vi.advanceTimersByTime(3000);
    expect(library.decoded.length).toBe(before + 3);
    health.close();
    timers.mockRestore();
  });

  it("puts the pointer back before the self-check, so a library that works again does not stop the process", () => {
    const library = standIn();
    const stop = vi.fn();
    const { server, request } = fakeServer();
    const health = startDecoderHealth({ server, stop, library: library.library });
    library.lower(8192);
    request().emit("close");
    expect(library.pointer()).toBe(START);
    expect(stop).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("8192 bytes below its start value");
    health.close();
  });

  it("writes one line and stops the process one time when the library cannot decode, also if more checks follow", () => {
    vi.useFakeTimers();
    const library = standIn();
    const stop = vi.fn();
    const { server, request } = fakeServer();
    startDecoderHealth({ server, stop, library: library.library });
    library.breakDecoder();
    request().emit("close");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toBe("The decoder library cannot decode a known value. The process stops so that its supervisor starts it again.");
    request().emit("close");
    vi.advanceTimersByTime(5000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("stops the process from the timer as well, when no request comes", () => {
    vi.useFakeTimers();
    const library = standIn();
    const stop = vi.fn();
    startDecoderHealth({ server: fakeServer().server, stop, library: library.library });
    library.breakDecoder();
    vi.advanceTimersByTime(999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops the process when the library cannot decode, also if the pointer was not low", () => {
    const library = standIn();
    const stop = vi.fn();
    const { server, request } = fakeServer();
    startDecoderHealth({ server, stop, library: library.library });
    library.breakDecoder();
    request().emit("close");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not throw out of a timer or a request when the stop throws, and writes the error", () => {
    const library = standIn();
    const { server, request } = fakeServer();
    startDecoderHealth({ server, stop: () => { throw new Error("shutdown failed"); }, library: library.library });
    library.breakDecoder();
    expect(() => request().emit("close")).not.toThrow();
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("shutdown failed");
  });

  it("does nothing more after close()", () => {
    vi.useFakeTimers();
    const library = standIn();
    const stop = vi.fn();
    const { server, request } = fakeServer();
    const health = startDecoderHealth({ server, stop, library: library.library });
    health.close();
    library.breakDecoder();
    library.lower(64);
    request().emit("close");
    vi.advanceTimersByTime(5000);
    expect(stop).not.toHaveBeenCalled();
    expect(library.pointer()).toBe(START - 64);
  });

  it("still checks the decoder when the library has no pointer to watch", () => {
    const stop = vi.fn();
    const library = standIn();
    const bare = { PlutusData: library.library.PlutusData };
    const { server, request } = fakeServer();
    const health = startDecoderHealth({ server, stop, library: bare });
    expect(health.watchesStackPointer).toBe(false);
    library.breakDecoder();
    request().emit("close");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("runs with the real library: no stop, no line", () => {
    const stop = vi.fn();
    const { server, request } = fakeServer();
    const health = startDecoderHealth({ server, stop });
    expect(health.watchesStackPointer).toBe(true);
    request().emit("close");
    health.check();
    expect(stop).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    health.close();
  });
});
