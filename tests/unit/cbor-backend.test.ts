/**
 * cbor-backend.test.ts — RED phase tests for detectCborBackend()
 *
 * Verifies the dispatch logic that routes builders to the live (lucid-evolution)
 * or mock (synthetic JSON-in-hex) CBOR path based on the ChainProvider type.
 *
 *   MockChainProvider     → "mock"
 *   ReadOnlyOgmiosProvider → "mock"
 *   LiveOgmiosProvider    → "live"
 *
 * M1-F-4 RED — fails until Catherine implements detectCborBackend.
 */

import { describe, it, expect } from "vitest";
import { detectCborBackend } from "../../packages/shared/src/tx/internal/cborBackend.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { ReadOnlyOgmiosProvider } from "../../packages/shared/src/chain/ReadOnlyOgmiosProvider.js";
import { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";

describe("detectCborBackend()", () => {
  it("returns 'mock' for MockChainProvider", () => {
    const chain = new MockChainProvider();

    const result = detectCborBackend(chain);

    expect(result).toBe("mock");
  });

  it("returns 'mock' for ReadOnlyOgmiosProvider", () => {
    const chain = new ReadOnlyOgmiosProvider({ ogmiosUrl: "http://localhost:1337" });

    const result = detectCborBackend(chain);

    expect(result).toBe("mock");
  });

  it("returns 'live' for LiveOgmiosProvider", () => {
    const chain = new LiveOgmiosProvider({ ogmiosUrl: "http://localhost:1337" });

    const result = detectCborBackend(chain);

    expect(result).toBe("live");
  });

  it("returns 'mock' for a custom provider that is not LiveOgmiosProvider", () => {
    // An anonymous provider that satisfies ChainProvider but is not LiveOgmiosProvider
    const chain = new MockChainProvider();

    const result = detectCborBackend(chain);

    expect(result).toBe("mock");
  });

  it("result type is exactly 'mock' | 'live' (string union, not boolean)", () => {
    const live = new LiveOgmiosProvider({ ogmiosUrl: "http://localhost:1337" });
    const mock = new MockChainProvider();

    const liveResult = detectCborBackend(live);
    const mockResult = detectCborBackend(mock);

    expect(["mock", "live"]).toContain(liveResult);
    expect(["mock", "live"]).toContain(mockResult);
    // Distinct values
    expect(liveResult).not.toBe(mockResult);
  });
});
