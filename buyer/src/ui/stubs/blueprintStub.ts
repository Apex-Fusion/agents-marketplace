/**
 * blueprintStub.ts — browser stub for packages/shared/src/tx/blueprint.ts
 *
 * `tx/blueprint.ts` reads `contracts/marketplace/plutus.json` from disk via
 * Node's `fs`/`path`/`url` builtins. The buyer-app's React SPA bundle
 * transitively imports `loadBlueprint` (through `Marketplace.ts` → tx/index
 * → escrow/postEscrow), but never CALLS it — every actual tx-construction
 * path lives server-side behind /v1/* endpoints. This stub is aliased in
 * vite.config.ts so the browser bundle gets a safe no-op instead of pulling
 * Node builtins into Rollup's analyzer.
 *
 * If anything in the browser does call loadBlueprint() at runtime, that's a
 * design error — fail loudly so it's caught.
 */

export interface Blueprint {
  advertScriptHash: string;
  escrowScriptHash: string;
  advertScriptAddress(networkId: 0 | 1): string;
  escrowScriptAddress(networkId: 0 | 1): string;
}

export function loadBlueprint(): Blueprint {
  throw new Error(
    "loadBlueprint() called from the browser bundle — tx construction must " +
      "happen server-side via /v1/* endpoints, not in the SPA.",
  );
}
