// The fetch rules of Part 1 Section 9 and Part 2 Section 8.5: https only, public unicast addresses
// for each connection and each redirect, no redirect to another host, 1 MiB, 10 seconds, one fetch
// per host each minute.

import { afterEach, describe, expect, test, vi } from "vitest";
import { FETCH_LIMITS, FetchError } from "../../src/fetch/fetcher.js";
import { FakeNet } from "./support.js";

const failureOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (e) {
    if (e instanceof FetchError) return e.code;
    throw e;
  }
  throw new Error("the fetch succeeded");
};

afterEach(() => {
  vi.useRealTimers();
});

describe("scheme and credentials", () => {
  test.each([
    ["http", "http://agent.example.org/"],
    ["ftp", "ftp://agent.example.org/"],
    ["credentials", "https://user:secret@agent.example.org/"],
    ["not a URL", "agent.example.org"],
  ])("%s is not fetched", async (_name, url) => {
    const net = new FakeNet().host("agent.example.org");
    expect(await failureOf(net.fetcher().fetch(url))).toBe("notHttps");
    expect(net.lookups).toEqual([]);
    expect(net.calls).toEqual([]);
  });

  test("a redirect to http is not followed", async () => {
    const net = new FakeNet().host("agent.example.org");
    net.on("https://agent.example.org/", { status: 302, headers: { location: "http://agent.example.org/" } });
    expect(await failureOf(net.fetcher().fetch("https://agent.example.org/"))).toBe("notHttps");
    expect(net.calls).toHaveLength(1);
  });
});

describe("public unicast addresses, checked for each connection", () => {
  test.each([
    ["a private address", ["10.0.0.5"]],
    ["loopback", ["127.0.0.1"]],
    ["the cloud metadata address", ["169.254.169.254"]],
    ["a public and a private address", ["93.184.216.34", "192.168.0.10"]],
    ["IPv6 loopback", ["::1"]],
    ["IPv6 unique local", ["fd00::5"]],
    ["IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
  ])("a host that resolves to %s is not fetched", async (_name, addresses) => {
    const net = new FakeNet().host("agent.example.org", ...addresses);
    net.on("https://agent.example.org/", { body: "secret" });
    expect(await failureOf(net.fetcher().fetch("https://agent.example.org/"))).toBe("privateAddress");
    expect(net.calls).toEqual([]);
  });

  test.each(["https://127.0.0.1/", "https://[::1]/", "https://10.0.0.1:8443/admin"])("the address literal %s is not fetched", async (url) => {
    const net = new FakeNet();
    expect(await failureOf(net.fetcher().fetch(url))).toBe("privateAddress");
    expect(net.lookups).toEqual([]);
    expect(net.calls).toEqual([]);
  });

  test("the connection goes to the checked address", async () => {
    const net = new FakeNet().host("agent.example.org", "93.184.216.34");
    net.on("https://agent.example.org/", { body: "ok" });
    await net.fetcher().fetch("https://agent.example.org/");
    expect(net.calls[0]).toMatchObject({ address: "93.184.216.34", url: "https://agent.example.org/" });
  });

  test("a redirect resolves the host again; a private answer then stops the fetch (DNS rebinding)", async () => {
    const net = new FakeNet().host("agent.example.org", "93.184.216.34");
    net.on("https://agent.example.org/start", () => {
      net.dns.set("agent.example.org", ["127.0.0.1"]);
      return { status: 302, headers: { location: "/next" } };
    });
    net.on("https://agent.example.org/next", { body: "internal" });
    expect(await failureOf(net.fetcher().fetch("https://agent.example.org/start"))).toBe("privateAddress");
    expect(net.lookups).toEqual(["agent.example.org", "agent.example.org"]);
    expect(net.calls.map((c) => c.url)).toEqual(["https://agent.example.org/start"]);
  });

  test("a host that does not resolve", async () => {
    expect(await failureOf(new FakeNet().fetcher().fetch("https://nowhere.example.org/"))).toBe("dns");
  });
});

describe("redirects", () => {
  test.each([
    ["another host", "https://other.example.org/"],
    ["a subdomain", "https://www.agent.example.org/"],
    ["another port", "https://agent.example.org:8443/"],
  ])("a redirect to %s is not followed", async (_name, location) => {
    const net = new FakeNet().host("agent.example.org").host("other.example.org").host("www.agent.example.org");
    net.on("https://agent.example.org/", { status: 301, headers: { location } });
    expect(await failureOf(net.fetcher().fetch("https://agent.example.org/"))).toBe("otherHost");
    expect(net.calls.map((c) => c.url)).toEqual(["https://agent.example.org/"]);
    expect(net.closed).toBe(1);
  });

  test("a redirect on the same host is followed, within the same fetch slot", async () => {
    const net = new FakeNet().host("agent.example.org");
    net.on("https://agent.example.org/a", { status: 307, headers: { location: "https://AGENT.example.org/b" } });
    net.on("https://agent.example.org/b", { status: 200, body: "done" });
    const result = await net.fetcher().fetch("https://agent.example.org/a");
    expect(result).toMatchObject({ url: "https://agent.example.org/b", status: 200 });
    expect(Buffer.from(result.body).toString()).toBe("done");
    expect(net.clock.sleeps).toEqual([]);
  });

  test("303 turns a POST into a GET without a body; 307 keeps the POST", async () => {
    const net = new FakeNet().host("agent.example.org");
    net.on("https://agent.example.org/rpc", { status: 307, headers: { location: "/rpc2" } }, "POST");
    net.on("https://agent.example.org/rpc2", { status: 303, headers: { location: "/result" } }, "POST");
    net.on("https://agent.example.org/result", { body: "{}" });
    await net.fetcher().fetch("https://agent.example.org/rpc", { method: "POST", body: Buffer.from("{}") });
    expect(net.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "https://agent.example.org/rpc", "{}"],
      ["POST", "https://agent.example.org/rpc2", "{}"],
      ["GET", "https://agent.example.org/result", ""],
    ]);
  });

  test(`more than ${FETCH_LIMITS.maxRedirects} redirects`, async () => {
    const net = new FakeNet().host("agent.example.org");
    net.on("https://agent.example.org/loop", { status: 302, headers: { location: "/loop" } });
    expect(await failureOf(net.fetcher().fetch("https://agent.example.org/loop"))).toBe("tooManyRedirects");
    expect(net.calls).toHaveLength(FETCH_LIMITS.maxRedirects + 1);
  });
});

describe("size limit (1 MiB)", () => {
  test("exactly 1 MiB is read", async () => {
    const net = new FakeNet().host("agent.example.org");
    net.on("https://agent.example.org/", { chunks: [new Uint8Array(FETCH_LIMITS.maxBytes / 2), new Uint8Array(FETCH_LIMITS.maxBytes / 2)] });
    expect((await net.fetcher().fetch("https://agent.example.org/")).body.byteLength).toBe(1_048_576);
  });

  test("a declared length above 1 MiB is refused before the body is read", async () => {
    const net = new FakeNet().host("agent.example.org");
    net.on("https://agent.example.org/", { headers: { "content-length": String(FETCH_LIMITS.maxBytes + 1) }, stallBody: true, chunks: [] });
    expect(await failureOf(net.fetcher().fetch("https://agent.example.org/"))).toBe("tooLarge");
    expect(net.closed).toBe(1);
  });

  test("a body that grows above 1 MiB without a declared length is cut off", async () => {
    const net = new FakeNet().host("agent.example.org");
    const chunk = new Uint8Array(512 * 1024);
    net.on("https://agent.example.org/", { chunks: [chunk, chunk, new Uint8Array(1)] });
    expect(await failureOf(net.fetcher().fetch("https://agent.example.org/"))).toBe("tooLarge");
    expect(net.closed).toBe(1);
  });
});

describe("time limit (10 seconds)", () => {
  test("a server that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const net = new FakeNet().host("agent.example.org");
    net.on("https://agent.example.org/", { stall: true });
    const failure = failureOf(net.fetcher().fetch("https://agent.example.org/"));
    await vi.advanceTimersByTimeAsync(FETCH_LIMITS.timeoutMs - 1);
    let settled = false;
    void failure.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toBe("timeout");
  });

  test("a body that stops in the middle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const net = new FakeNet().host("agent.example.org");
    net.on("https://agent.example.org/", { chunks: [Buffer.from("{")], stallBody: true });
    const failure = failureOf(net.fetcher().fetch("https://agent.example.org/"));
    await vi.advanceTimersByTimeAsync(FETCH_LIMITS.timeoutMs);
    expect(await failure).toBe("timeout");
  });

  test("a DNS answer that never comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const net = new FakeNet();
    net.lookup = () => new Promise(() => undefined);
    const fetcher = net.fetcher();
    const failure = failureOf(fetcher.fetch("https://slow.example.org/"));
    await vi.advanceTimersByTimeAsync(FETCH_LIMITS.timeoutMs);
    expect(await failure).toBe("timeout");
  });
});

describe("rate limit (one fetch per host each minute)", () => {
  test("a second fetch to the same host waits a minute; another host does not wait", async () => {
    const net = new FakeNet().host("agent.example.org").host("other.example.org");
    net.on("https://agent.example.org/a", { body: "a" }).on("https://agent.example.org/b", { body: "b" }).on("https://other.example.org/", { body: "c" });
    const fetcher = net.fetcher();
    const start = net.clock.now();
    await fetcher.fetch("https://agent.example.org/a");
    await fetcher.fetch("https://other.example.org/");
    await fetcher.fetch("https://agent.example.org/b");
    expect(net.calls.map((c) => [c.url, c.at - start])).toEqual([
      ["https://agent.example.org/a", 0],
      ["https://other.example.org/", 0],
      ["https://agent.example.org/b", 60_000],
    ]);
    expect(net.clock.sleeps).toEqual([60_000]);
  });

  test("concurrent fetches to one host start a minute apart, in call order; the host name is compared without case", async () => {
    const net = new FakeNet().host("agent.example.org");
    for (const p of ["1", "2", "3"]) net.on(`https://agent.example.org/${p}`, { body: p });
    const fetcher = net.fetcher();
    await Promise.all([fetcher.fetch("https://agent.example.org/1"), fetcher.fetch("https://AGENT.example.org/2"), fetcher.fetch("https://agent.example.org/3")]);
    // The test clock jumps at each sleep, so the slot waits show the spacing: each later fetch waited one interval.
    expect(net.calls.map((c) => c.url)).toEqual(["https://agent.example.org/1", "https://agent.example.org/2", "https://agent.example.org/3"]);
    expect(net.clock.sleeps).toEqual([60_000, 60_000]);
  });

  test("a failed fetch also uses the host's slot", async () => {
    const net = new FakeNet().host("agent.example.org", "10.0.0.1");
    const fetcher = net.fetcher();
    await failureOf(fetcher.fetch("https://agent.example.org/"));
    await failureOf(fetcher.fetch("https://agent.example.org/"));
    expect(net.clock.sleeps).toEqual([60_000]);
  });
});

test("a result has the final URL, the start time and the SHA-256 of the body", async () => {
  const net = new FakeNet().host("agent.example.org");
  net.on("https://agent.example.org/", { body: "hello" });
  const result = await net.fetcher().fetch("https://agent.example.org/");
  expect(result).toMatchObject({
    url: "https://agent.example.org/",
    status: 200,
    fetchedAt: net.clock.now(),
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  });
  expect(net.calls[0]!.headers["accept-encoding"]).toBe("identity");
});
