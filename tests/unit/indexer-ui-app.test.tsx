// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-app.test.tsx — the indexer dashboard shell. The only test of App.tsx.
 * <App /> mounts with its five real children; only the network is stubbed (fetch and EventSource).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "../../indexer-ui/src/App.js";
import { SAMPLE_FREE_SUPPLIER } from "../fixtures/indexer-ui-side/sample-supplier-rows.js";

const streams: string[] = [];

/** An EventSource that records the URL that it opens and sends no event. */
class FakeEventSource {
  onerror: (() => void) | null = null;
  constructor(url: string) {
    streams.push(url);
  }
  addEventListener(): void {}
  close(): void {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  streams.length = 0;
});

describe("<App />", () => {
  it("mounts the five panels with their real children, and each panel requests its data", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      switch (url) {
        case "/healthz":
          return Response.json({ ok: true, sync_slot: 750, tip_slot: 1000, ogmios_status: "connected", db_size_bytes: 0 });
        case "/suppliers":
          return Response.json([SAMPLE_FREE_SUPPLIER]);
        case "/capabilities":
          return Response.json([{ capability_id: "llm.text.generate.v1", supplier_count: 1 }]);
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    }));
    vi.stubGlobal("EventSource", FakeEventSource);

    render(<App />);

    // One handle for each panel: the sync gauge, the suppliers table, the capability cards, the event log and the escrow lookup.
    expect(screen.getByTestId("sync-progress")).toBeInTheDocument();
    expect(screen.getByTestId("suppliers-table")).toBeInTheDocument();
    expect(screen.getByTestId("events-log")).toBeInTheDocument();
    expect(screen.getByTestId("escrow-lookup-submit")).toBeInTheDocument();

    // The panels show what the stubbed indexer sends.
    expect(await screen.findAllByTestId("supplier-row")).toHaveLength(1);
    expect(await screen.findAllByTestId("capability-card")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("sync-progress")).toHaveTextContent(/750\D*1000/));

    // One request for each data source. The sync panel may ask for /healthz more than once. The event log opens its stream.
    expect(requested.filter((url) => url === "/suppliers")).toHaveLength(1);
    expect(requested.filter((url) => url === "/capabilities")).toHaveLength(1);
    expect(requested).toContain("/healthz");
    expect(streams).toContain("/events?stream=1&limit=10");
  });
});
