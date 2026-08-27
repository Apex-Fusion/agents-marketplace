import { describe, expect, it } from "vitest";
import { redactPublicPreview } from "../../supplier/src/reseller/evidenceStore.js";

describe("redactPublicPreview", () => {
  it("removes common credentials and personal data before publication", () => {
    const preview = redactPublicPreview(
      [
        "SUPPLIER_PRIV_KEY_HEX=" + "a".repeat(64),
        "password=hunter2",
        "Authorization: Bearer secret-token",
        '{"password":"hunter two words"}',
        "GATEWAY_API_KEY=plain-secret-value",
        "Authorization: Basic dXNlcjpwYXNz",
        "email test@example.com",
        "https://example.com/private",
        "eyJheader.payload.signature",
        "ghp_1234567890abcdefghijklmnop",
      ].join(" "),
      1000,
    );
    expect(preview).not.toContain("hunter2");
    expect(preview).not.toContain("secret-token");
    expect(preview).not.toContain("hunter two words");
    expect(preview).not.toContain("plain-secret-value");
    expect(preview).not.toContain("dXNlcjpwYXNz");
    expect(preview).not.toContain("test@example.com");
    expect(preview).not.toContain("example.com/private");
    expect(preview).not.toContain("eyJheader");
    expect(preview).not.toContain("ghp_");
    expect(preview).not.toContain("a".repeat(64));
  });

  it("applies the configured public preview limit", () => {
    const preview = redactPublicPreview("x".repeat(100), 20);
    expect(preview).toHaveLength(20);
    expect(preview.endsWith("…")).toBe(true);
  });
});
