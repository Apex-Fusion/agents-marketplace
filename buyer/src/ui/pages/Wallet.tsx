/**
 * buyer/src/ui/pages/Wallet.tsx — wallet address + balance view.
 */

import { useMarketplace } from "../state/MarketplaceContext.js";

export default function Wallet() {
  const marketplace = useMarketplace();
  const walletKey = marketplace.getWalletKey();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Wallet</h1>
      <dl className="space-y-2">
        <div>
          <dt className="text-sm text-gray-500">Address</dt>
          <dd className="font-mono text-sm break-all">{walletKey.address}</dd>
        </div>
        <div>
          <dt className="text-sm text-gray-500">Public key hash</dt>
          <dd className="font-mono text-sm break-all">{walletKey.pubKeyHash}</dd>
        </div>
      </dl>
    </div>
  );
}
