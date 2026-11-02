import { describe, expect, test } from "vitest";
import { didWebOf, reverseHost } from "../../src/render/agent.js";
import { DEFAULT_ACCESS_LOG_RETENTION, DEFAULT_BASE_URL, loadRenderConfig } from "../../src/render/config.js";
import { renderJson } from "../../src/render/json.js";

describe("render configuration", () => {
  test("defaults", () => {
    expect(loadRenderConfig({})).toEqual({ baseUrl: DEFAULT_BASE_URL, accessLogRetention: DEFAULT_ACCESS_LOG_RETENTION, fetchJobs: true, scanIntervalMs: 600_000 });
  });

  test("values from the environment", () => {
    expect(
      loadRenderConfig({ GATEWAY_BASE_URL: "https://id.example.org/", ACCESS_LOG_RETENTION: "30 days.", FETCH_JOBS: "off", FETCH_SCAN_INTERVAL_S: "900" }),
    ).toEqual({ baseUrl: "https://id.example.org", accessLogRetention: "30 days.", fetchJobs: false, scanIntervalMs: 900_000 });
  });

  test.each([
    [{ GATEWAY_BASE_URL: "http://id.example.org" }, /https origin/],
    [{ GATEWAY_BASE_URL: "https://id.example.org/gateway" }, /without path/],
    [{ GATEWAY_BASE_URL: "not a url" }, /https origin/],
    [{ FETCH_JOBS: "yes" }, /FETCH_JOBS/],
    [{ FETCH_SCAN_INTERVAL_S: "10" }, /FETCH_SCAN_INTERVAL_S/],
    [{ FETCH_SCAN_INTERVAL_S: "1e3" }, /FETCH_SCAN_INTERVAL_S/],
  ])("%o is refused", (env, message) => {
    expect(() => loadRenderConfig(env)).toThrow(message);
  });
});

describe("names", () => {
  test("did:web alias: host, a port with a percent-encoded colon, the agents path", () => {
    expect(didWebOf("https://id.vector.apexfusion.org", "ab".repeat(32))).toBe(`did:web:id.vector.apexfusion.org:agents:${"ab".repeat(32)}`);
    expect(didWebOf("https://localhost:8443", "00".repeat(32))).toBe(`did:web:localhost%3A8443:agents:${"00".repeat(32)}`);
  });

  test("the reverse-DNS namespace of MCP server names", () => {
    expect(reverseHost("https://id.vector.apexfusion.org")).toBe("org.apexfusion.vector.id");
  });
});

describe("rendering JSON", () => {
  test("JCS member order; a bigint is written as an integer of any size", () => {
    const id = BigInt(`0x${"ff".repeat(32)}`);
    expect(renderJson({ b: [1, "x", null, true], a: { agentId: id, z: undefined } })).toBe(
      `{"a":{"agentId":${id.toString(10)}},"b":[1,"x",null,true]}`,
    );
  });
});
