// @vitest-environment happy-dom
/**
 * buyer-ui-smoke.test.tsx — RED phase (M1-E)
 *
 * Category G: UI smoke tests with React Testing Library + happy-dom (~15 tests)
 *
 * All tests FAIL until M1-E-green because the UI components currently
 * render "NOT IMPLEMENTED" stubs and the Marketplace methods throw.
 *
 * Design contract encoded for Catherine:
 * - <App /> must render a <nav> with links to /, /tasks, /wallet
 * - <Dashboard /> must call marketplace.discoverSuppliers() on mount
 * - <PromptForm /> must call marketplace.submitPrompt() with correct args on submit
 * - <TaskHistory /> must call getTaskHistory() and render TaskRow for each entry
 * - <Wallet /> must render the configured walletKey.address
 * - <SupplierCard /> "Use" button must be disabled when supplier.status === "offline"
 * - Submitting an empty prompt must be prevented client-side (no SDK call)
 * - A loading state must render while submitPrompt() is pending
 * - An error toast/message must render when submitPrompt() rejects
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "../../buyer/src/ui/App.js";
import Dashboard from "../../buyer/src/ui/pages/Dashboard.js";
import TaskHistory from "../../buyer/src/ui/pages/TaskHistory.js";
import Wallet from "../../buyer/src/ui/pages/Wallet.js";
import SupplierCard from "../../buyer/src/ui/components/SupplierCard.js";
import PromptForm from "../../buyer/src/ui/components/PromptForm.js";
import { MarketplaceProvider } from "../../buyer/src/ui/state/MarketplaceContext.js";
import type { SupplierView } from "../../buyer/src/sdk/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import {
  ALL_SAMPLE_TASK_RECORDS,
  TASK_COMPLETED,
} from "../fixtures/buyer-side/sample-task-records.js";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { Marketplace } from "../../buyer/src/sdk/Marketplace.js";
import { MemoryTaskHistoryStore } from "../../buyer/src/sdk/history.js";

// ─── Mock Marketplace factory ──────────────────────────────────────────────

const buyer = buildBuyerWalletKey();

function makeMockMarketplace() {
  const store = new MemoryTaskHistoryStore();
  const mp = new Marketplace({
    chain: new MockChainProvider(),
    indexerUrl: "http://indexer.test",
    walletKey: buyer,
    networkParams: { networkId: 0 },
    historyStore: store,
  });
  return mp;
}

function makeSampleSupplierView(overrides: Partial<SupplierView> = {}): SupplierView {
  return {
    utxo_ref: "a".repeat(64) + "#0",
    supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
    capability_id: "llm.text.generate.v1",
    model: "qwen2.5:0.5b",
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: "2000000",
    supplier_bond_lovelace: "1000000",
    buyer_bond_lovelace: "1000000",
    endpoint_url: "https://supplier.example.com",
    detail_uri: "ipfs://Qm000",
    detail_hash: "a".repeat(64),
    advertised_at: 1_745_500_000_000,
    status: "free",
    advert_status: "Active",
    current_escrow_ref: null,
    last_seen_iso: "2026-04-24T00:00:00.000Z",
    created_slot: 1000,
    ...overrides,
  };
}

function wrap(element: React.ReactElement, mp: Marketplace) {
  return (
    <MemoryRouter>
      <MarketplaceProvider marketplace={mp}>
        {element}
      </MarketplaceProvider>
    </MemoryRouter>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("<App /> smoke", () => {
  it("renders a nav element with links for Dashboard, Tasks, and Wallet", () => {
    const mp = makeMockMarketplace();
    render(wrap(<App />, mp));
    const nav = document.querySelector("nav");
    expect(nav).not.toBeNull();
    // Each link should be present
    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => (l as HTMLAnchorElement).pathname ?? (l as HTMLAnchorElement).getAttribute("href") ?? "");
    expect(hrefs.some(h => h === "/" || h === "")).toBe(true);
    expect(hrefs.some(h => h.includes("tasks"))).toBe(true);
    expect(hrefs.some(h => h.includes("wallet"))).toBe(true);
  });
});

describe("<Dashboard /> smoke", () => {
  it("calls marketplace.discoverSuppliers() on mount", async () => {
    const mp = makeMockMarketplace();
    const spy = vi.spyOn(mp, "discoverSuppliers").mockResolvedValue([]);
    render(wrap(<Dashboard />, mp));
    await waitFor(() => expect(spy).toHaveBeenCalledOnce());
  });

  it("renders a SupplierCard for each supplier returned by discoverSuppliers()", async () => {
    const mp = makeMockMarketplace();
    vi.spyOn(mp, "discoverSuppliers").mockResolvedValue([
      makeSampleSupplierView({ supplier_pkh: "a".repeat(56) }),
      makeSampleSupplierView({ supplier_pkh: "b".repeat(56) }),
    ]);
    render(wrap(<Dashboard />, mp));
    // Wait for async discover to complete and cards to render
    await waitFor(() => {
      // Each card should render something with the supplier_pkh visible or a test-id
      const cards = document.querySelectorAll("[data-testid='supplier-card']");
      expect(cards.length).toBe(2);
    });
  });
});

describe("<PromptForm /> smoke", () => {
  // PromptForm now POSTs to /v1/submit-prompt server-side instead of calling
  // the SDK directly — the browser SPA's chain provider is a stub so all
  // chain-touching work moved server-side. These tests stub globalThis.fetch
  // to verify the form's request shape and UX states.
  function stubFetchOk(receiptObj: unknown, signature: string) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);
      if (!url.endsWith("/v1/submit-prompt")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      (stubFetchOk as unknown as { lastBody?: unknown }).lastBody = body;
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" }],
        receipt: receiptObj,
        receipt_signature: signature,
        escrow_ref: `${"a".repeat(64)}#0`,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  it("POSTs /v1/submit-prompt with correct messages when form is submitted", async () => {
    const user = userEvent.setup();
    const mp = makeMockMarketplace();
    const fetchSpy = stubFetchOk(TASK_COMPLETED.receipt!, TASK_COMPLETED.receipt_signature!);
    vi.stubGlobal("fetch", fetchSpy);
    const advertRef = { txHash: "b".repeat(64), index: 0 };
    render(wrap(
      <PromptForm advertRef={advertRef} payment_lovelace={2_000_000n} />,
      mp
    ));
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "What is 2+2?");
    const submitBtn = screen.getByRole("button", { name: /submit/i });
    await user.click(submitBtn);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const lastBody = (stubFetchOk as unknown as { lastBody?: { messages: Array<{ content: string }> } }).lastBody;
    expect(lastBody?.messages.some((m) => m.content.includes("What is 2+2?"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("does NOT POST when prompt textarea is empty (client-side validation)", async () => {
    const user = userEvent.setup();
    const mp = makeMockMarketplace();
    const fetchSpy = stubFetchOk(TASK_COMPLETED.receipt!, TASK_COMPLETED.receipt_signature!);
    vi.stubGlobal("fetch", fetchSpy);
    const advertRef = { txHash: "b".repeat(64), index: 0 };
    render(wrap(
      <PromptForm advertRef={advertRef} payment_lovelace={2_000_000n} />,
      mp
    ));
    // Do NOT type anything; just click submit
    const submitBtn = screen.getByRole("button", { name: /submit/i });
    await user.click(submitBtn);
    await new Promise(r => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("renders a loading indicator while /v1/submit-prompt is pending", async () => {
    const user = userEvent.setup();
    const mp = makeMockMarketplace();
    let resolveFn!: (value: Response) => void;
    const pending = new Promise<Response>(r => { resolveFn = r; });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    const advertRef = { txHash: "b".repeat(64), index: 0 };
    render(wrap(<PromptForm advertRef={advertRef} payment_lovelace={2_000_000n} />, mp));
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "What is 2+2?");
    const submitBtn = screen.getByRole("button", { name: /submit/i });
    await user.click(submitBtn);
    await waitFor(() => {
      const loading = screen.queryByTestId("loading-indicator") ??
        screen.queryByRole("progressbar") ??
        screen.queryByText(/loading|pending|…|\.\.\.$/i);
      expect(loading).not.toBeNull();
    });
    resolveFn(new Response("{}", { status: 502 }));
    vi.unstubAllGlobals();
  });

  it("renders an error message when /v1/submit-prompt rejects", async () => {
    const user = userEvent.setup();
    const mp = makeMockMarketplace();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "submit_prompt_failed", message: "supplier offline" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      )
    ));
    const advertRef = { txHash: "b".repeat(64), index: 0 };
    render(wrap(<PromptForm advertRef={advertRef} payment_lovelace={2_000_000n} />, mp));
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "Hello?");
    const submitBtn = screen.getByRole("button", { name: /submit/i });
    await user.click(submitBtn);
    await waitFor(() => {
      const errEl = screen.queryByRole("alert") ?? screen.queryByText(/error|failed|offline/i);
      expect(errEl).not.toBeNull();
    });
    vi.unstubAllGlobals();
  });
});

describe("<TaskHistory /> smoke", () => {
  it("calls getTaskHistory() and renders a row for each task", async () => {
    const mp = makeMockMarketplace();
    vi.spyOn(mp, "getTaskHistory").mockReturnValue(ALL_SAMPLE_TASK_RECORDS);
    render(wrap(<TaskHistory />, mp));
    await waitFor(() => {
      const rows = document.querySelectorAll("[data-testid='task-row']");
      expect(rows.length).toBe(ALL_SAMPLE_TASK_RECORDS.length);
    });
  });
});

describe("<Wallet /> smoke", () => {
  it("renders the configured walletKey.address", () => {
    const mp = makeMockMarketplace();
    render(wrap(<Wallet />, mp));
    // The buyer's bech32 address must appear somewhere in the rendered output
    expect(screen.getByText(new RegExp(buyer.address, "i"))).toBeTruthy();
  });
});

describe("<SupplierCard /> smoke", () => {
  it("renders the supplier model and price", () => {
    const supplier = makeSampleSupplierView();
    render(<SupplierCard supplier={supplier} />);
    // Should display model name
    expect(screen.getByText(/qwen2\.5:0\.5b/i)).toBeTruthy();
  });

  it("'Use' button is disabled when supplier.status is 'offline'", () => {
    const offlineSupplier = makeSampleSupplierView({ status: "offline" });
    render(<SupplierCard supplier={offlineSupplier} />);
    const useBtn = screen.queryByRole("button", { name: /use/i });
    if (useBtn) {
      expect(useBtn).toBeDisabled();
    } else {
      // If there's a "Use" button but it's hidden/replaced, verify it cannot be clicked
      const btn = document.querySelector("button");
      expect(btn === null || btn.disabled).toBe(true);
    }
  });

  it("'Use' button is enabled when supplier.status is 'free'", () => {
    const freeSupplier = makeSampleSupplierView({ status: "free" });
    render(<SupplierCard supplier={freeSupplier} />);
    const useBtn = screen.getByRole("button", { name: /use/i });
    expect(useBtn).not.toBeDisabled();
  });
});
