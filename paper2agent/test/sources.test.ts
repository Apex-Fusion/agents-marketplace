import { describe, expect, it } from "vitest";
import { downloadPublicHttps, isPublicAddress } from "../src/sources.js";

describe("paper and dependency network boundaries", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2002:7f00:1::"])(
    "denies non-public address %s", (address) => { expect(isPublicAddress(address)).toBe(false); },
  );

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(["file:///etc/passwd", "http://example.com/paper.pdf", "https://user:secret@example.com/paper.pdf", "https://example.com:8443/paper.pdf"])(
    "rejects unsupported paper URL %s before connecting", async (url) => {
      await expect(downloadPublicHttps(url, 1000, new AbortController().signal)).rejects.toThrow();
    },
  );

  it("does not fetch from a numeric metadata address", async () => {
    await expect(downloadPublicHttps("https://169.254.169.254/latest/meta-data/", 1000,
      new AbortController().signal)).rejects.toThrow();
  });
});
