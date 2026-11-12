/**
 * supplier-routes-internal-error.test.ts — the central error handler of the supplier
 * answers 500 internal_error and writes ONE line on stderr.
 *
 * The line has the method, the route path, the class of the error and the top stack
 * frame. It never has the error message, the query string or the body: the message of a
 * JSON parse error quotes the request body, and a backend error can quote prompts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference, Utxo } from "../../packages/shared/src/chain/index.js";
import { SupplierState } from "../../supplier/src/state.js";
import { createApp } from "../../supplier/src/server.js";
import { buildSampleConfig } from "../fixtures/supplier-side/sample-config.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";

const PRIVATE_TEXT = "my private prompt text";

/** A chain whose every UTxO lookup fails with the given value. */
class FailingChain extends MockChainProvider {
  constructor(private readonly failure: unknown) {
    super();
  }

  override async queryUtxo(_ref: OutputReference): Promise<Utxo | null> {
    throw this.failure;
  }
}

function makeApp(chain: MockChainProvider): Application {
  return createApp({
    chain,
    state: new SupplierState(),
    config: buildSampleConfig(),
    supplierKey: buildSupplierWalletKey(),
  });
}

function silentErrorLog() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supplier central error handler — log line", () => {
  it("writes one line with the method, the path, the class and the top frame", async () => {
    const errorLog = silentErrorLog();
    const res = await request(makeApp(new FailingChain(new TypeError(PRIVATE_TEXT))))
      .get("/capability?token=hunter2");

    expect(res.status).toBe(500);
    expect(res.body.reason).toBe("internal_error");
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]).toHaveLength(1);
    expect(String(errorLog.mock.calls[0]![0])).toMatch(
      /^\[internal_error\] method=GET path=\/capability error_class=TypeError frame=\S*supplier-routes-internal-error\.test\.ts:\d+$/,
    );
  });

  it("does not write the error message or the query string", async () => {
    const errorLog = silentErrorLog();
    await request(makeApp(new FailingChain(new TypeError(PRIVATE_TEXT)))).get("/capability?token=hunter2");

    const line = String(errorLog.mock.calls[0]![0]);
    expect(line).not.toContain(PRIVATE_TEXT);
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("?");
  });

  it("does not write the body that a JSON parse error quotes", async () => {
    const errorLog = silentErrorLog();
    const body = `{"input": ${PRIVATE_TEXT} }`;
    const res = await request(makeApp(new MockChainProvider()))
      .post("/v1/responses?token=hunter2")
      .set("Content-Type", "application/json")
      .send(body);

    // The parse error message quotes the body. The handler still answers it as before.
    expect(res.status).toBe(500);
    expect(res.body.message).toContain("my private");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = String(errorLog.mock.calls[0]![0]);
    expect(line).toMatch(
      /^\[internal_error\] method=POST path=\/v1\/responses error_class=SyntaxError frame=\S*body-parser\/lib\/types\/json\.js:\d+$/,
    );
    expect(line).not.toContain("private");
    expect(line).not.toContain("hunter2");
  });

  it("skips the lines of a message that has several lines and looks like a frame", async () => {
    const errorLog = silentErrorLog();
    const hostile = new Error(`first line\n    at fake (/secret/path.js:1:2)\nthird line ${PRIVATE_TEXT}`);
    await request(makeApp(new FailingChain(hostile))).get("/capability");

    const line = String(errorLog.mock.calls[0]![0]);
    expect(line).toMatch(/ error_class=Error frame=\S*supplier-routes-internal-error\.test\.ts:\d+$/);
    expect(line).not.toContain("secret");
    expect(line).not.toContain(PRIVATE_TEXT);
    expect(line).not.toMatch(/[\r\n]/);
  });

  it("writes the type and no frame for a thrown value that is not an Error", async () => {
    const errorLog = silentErrorLog();
    const res = await request(makeApp(new FailingChain(PRIVATE_TEXT))).get("/capability");

    expect(res.status).toBe(500);
    expect(errorLog.mock.calls).toEqual([
      ["[internal_error] method=GET path=/capability error_class=string frame=unknown"],
    ]);
  });

  it("writes no line for a request that has no error", async () => {
    const errorLog = silentErrorLog();
    const res = await request(makeApp(new MockChainProvider())).get("/status");

    expect(res.status).toBe(200);
    expect(errorLog).not.toHaveBeenCalled();
  });
});
