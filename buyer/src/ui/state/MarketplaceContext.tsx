/**
 * buyer/src/ui/state/MarketplaceContext.tsx — React context wrapping a Marketplace instance.
 *
 * Provides the shared SDK instance to every page/component via React context.
 * Tests inject a mock Marketplace; in production the boot script constructs
 * one from BuyerConfig and wraps the app with <MarketplaceProvider>.
 */

import React, { createContext, useContext } from "react";
import type { Marketplace } from "../../sdk/Marketplace.js";

export interface MarketplaceContextValue {
  marketplace: Marketplace | null;
}

export const MarketplaceContext = createContext<MarketplaceContextValue>({ marketplace: null });

export function useMarketplace(): Marketplace {
  const { marketplace } = useContext(MarketplaceContext);
  if (!marketplace) {
    throw new Error("useMarketplace: no Marketplace in context — wrap app in <MarketplaceProvider>");
  }
  return marketplace;
}

export interface MarketplaceProviderProps {
  marketplace: Marketplace;
  children: React.ReactNode;
}

export function MarketplaceProvider({ marketplace, children }: MarketplaceProviderProps) {
  return (
    <MarketplaceContext.Provider value={{ marketplace }}>
      {children}
    </MarketplaceContext.Provider>
  );
}
