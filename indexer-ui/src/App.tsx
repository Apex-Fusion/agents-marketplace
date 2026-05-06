/**
 * indexer-ui/src/App.tsx — single-page dashboard with 5 panels.
 *
 * Sets document.title and renders the 5 panel sections + their components.
 *
 * Test contract:
 *   - <h1> at level 1 contains "Marketplace Indexer"
 *   - document.title === "Marketplace Indexer"
 *   - Five h2 headings: "Sync Progress", "Suppliers", "Capabilities",
 *                       "Live Events", "Escrow Lookup"
 */

import { useEffect } from "react";

import SyncProgress from "./components/SyncProgress.js";
import SuppliersTable from "./components/SuppliersTable.js";
import CapabilitiesPanel from "./components/CapabilitiesPanel.js";
import EventsLog from "./components/EventsLog.js";
import EscrowLookup from "./components/EscrowLookup.js";

export default function App() {
  useEffect(() => {
    document.title = "Marketplace Indexer";
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <main className="mx-auto max-w-7xl p-6">
        <h1 className="mb-6 text-2xl font-bold">Marketplace Indexer</h1>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">Sync Progress</h2>
          <SyncProgress />
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">Suppliers</h2>
          <SuppliersTable />
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">Capabilities</h2>
          <CapabilitiesPanel />
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">Live Events</h2>
          <EventsLog />
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">Escrow Lookup</h2>
          <EscrowLookup />
        </section>
      </main>
    </div>
  );
}
