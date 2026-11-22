import { describe, expect, it } from "vitest";
import { downloadPublicHttps, isPublicAddress } from "../src/sources.js";

describe("paper and dependency network boundaries", () => {
  // `isPublicAddress` accepts the "unicast" range of ipaddr.js only. One address for each range class that it refuses, and one text
  // that no parser reads (the `catch` branch).
  it.each([
    ["IPv4 loopback", "127.0.0.1"], ["IPv4 private", "10.0.0.1"], ["IPv4 link-local (cloud metadata)", "169.254.169.254"],
    ["IPv4 carrier-grade NAT", "100.64.0.1"], ["IPv4 unspecified", "0.0.0.0"], ["IPv4 multicast", "224.0.0.1"],
    ["IPv6 loopback", "::1"], ["IPv6 unique local", "fc00::1"], ["IPv6 link-local", "fe80::1"], ["IPv6 6to4", "2002:7f00:1::"],
    ["IPv4-mapped IPv6", "::ffff:127.0.0.1"], ["text that is no address", "not-an-address"],
  ])("denies %s", (_class, address) => { expect(isPublicAddress(address)).toBe(false); });

  it.each([["IPv4", "8.8.8.8"], ["IPv6", "2606:4700:4700::1111"]])("accepts a public %s address", (_family, address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(["file:///etc/passwd", "http://example.com/paper.pdf", "https://user:secret@example.com/paper.pdf", "https://example.com:8443/paper.pdf"])(
    "rejects unsupported paper URL %s before connecting", async (url) => {
      await expect(downloadPublicHttps(url, 1000, new AbortController().signal))
        .rejects.toThrow("Source URL must use an allowed public HTTPS host");
    },
  );

  it("does not fetch from a numeric metadata address", async () => {
    await expect(downloadPublicHttps("https://169.254.169.254/latest/meta-data/", 1000, new AbortController().signal))
      .rejects.toThrow("Source URL resolves to a non-public address");
  });
});
