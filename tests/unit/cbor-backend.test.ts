/**
 * cbor-backend.test.ts — tests for detectCborBackend()
 *
 * Verifies the dispatch logic that routes builders to the live (lucid-evolution)
 * or mock (synthetic JSON-in-hex) CBOR path based on the ChainProvider type.
 *
 *   MockChainProvider     → "mock"
 *   ReadOnlyOgmiosProvider → "mock"
 *   LiveOgmiosProvider    → "live"
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
});
