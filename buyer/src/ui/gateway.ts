/**
 * buyer/src/ui/gateway.ts — resolve the OpenAI-compatible gateway base URL the
 * SPA should call for the "Generate API key" page.
 *
 * Resolution order:
 *   1. window.__BUYER_BOOT__.gatewayUrl — injected by the buyer server from the
 *      GATEWAY_PUBLIC_URL env (the configured value). Present on any page load
 *      made while the buyer_session cookie is valid.
 *   2. Derived "api." + current host — the deploy convention is exactly
 *      api.<buyer-host> (marketplace.… → api.marketplace.…). This covers the
 *      gap right after a fresh login, when the SPA flips auth state WITHOUT a
 *      page reload so the boot block (which is only injected into
 *      server-rendered HTML) hasn't been re-fetched yet.
 *
 * The result never has a trailing slash.
 */

interface BuyerBootMaybeGateway {
  gatewayUrl?: string;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveGatewayUrl(): string {
  const boot = (window as unknown as { __BUYER_BOOT__?: BuyerBootMaybeGateway })
    .__BUYER_BOOT__;
  const configured = boot?.gatewayUrl?.trim();
  if (configured) return stripTrailingSlashes(configured);
  return `${window.location.protocol}//api.${window.location.host}`;
}
