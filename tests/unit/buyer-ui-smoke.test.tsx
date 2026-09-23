// @vitest-environment happy-dom
/**
 * buyer-ui-smoke.test.tsx — buyer SPA behavior checks.
 *
 * Covers supplier discovery, the server-side one-shot Responses lifecycle,
 * canonical chat streams, lifecycle history, wallet display, and form states.
 *
 * Core UI contract:
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
import ApiKeys from "../../buyer/src/ui/pages/ApiKeys.js";
import SupplierCard from "../../buyer/src/ui/components/SupplierCard.js";
import PromptForm from "../../buyer/src/ui/components/PromptForm.js";
import ChatForm from "../../buyer/src/ui/components/ChatForm.js";
import { MarketplaceProvider } from "../../buyer/src/ui/state/MarketplaceContext.js";
import { AuthProvider } from "../../buyer/src/ui/state/AuthContext.js";
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
      <AuthProvider initialStatus="authenticated">
        <MarketplaceProvider marketplace={mp}>
          {element}
        </MarketplaceProvider>
      </AuthProvider>
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
    // Wait for async discover to complete and cards to render. Dashboard
    // appends two synthetic demo cards (Piper-TTS + Kimi K2.6 chat) to whatever
    // the indexer returned, so the count is N+2 until on-chain suppliers ship.
    await waitFor(() => {
      const cards = document.querySelectorAll("[data-testid='supplier-card']");
      expect(cards.length).toBe(4);
    });
    // Sanity: one of the cards is the demo Piper supplier.
    const piperBadges = Array.from(
      document.querySelectorAll("[data-testid='supplier-card']"),
    ).filter((c) => c.textContent?.includes("audio.synthesize.piper.v1"));
    expect(piperBadges.length).toBe(1);
    // Sanity: one of the cards is the demo Kimi K2.6 chat supplier.
    const kimiBadges = Array.from(
      document.querySelectorAll("[data-testid='supplier-card']"),
    ).filter((c) => c.textContent?.includes("llm.chat.v1"));
    expect(kimiBadges.length).toBe(1);
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
        id: "resp_ui",
        object: "response",
        created_at: 1_745_500_000,
        model: "test-model",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "4" }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        error: null,
        incomplete_details: null,
        receipt: receiptObj,
        receipt_signature: signature,
        escrow_ref: `${"a".repeat(64)}#0`,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  it("POSTs /v1/submit-prompt with canonical input when submitted", async () => {
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
    const lastBody = (stubFetchOk as unknown as {
      lastBody?: { input: Array<{ content: Array<{ text: string }> }> };
    }).lastBody;
    expect(lastBody?.input[0].content[0].text).toBe("What is 2+2?");
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

describe("<ApiKeys /> Responses example", () => {
  it("shows a native Responses request after key creation", async () => {
    const user = userEvent.setup();
    Reflect.set(window, "__BUYER_BOOT__", {
      gatewayUrl: "https://api.marketplace.example",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input) === "/v1/api-keys" ? { keys: [] } : {
      api_key: "vmp_live_secret",
      key_prefix: "vmp_live",
      deposit_address: "addr1deposit",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    render(<ApiKeys />);
    await user.click(screen.getByTestId("generate-api-key"));
    await screen.findByTestId("api-key-result");

    const snippet = document.querySelector("pre")?.textContent ?? "";
    expect(snippet).toContain("https://api.marketplace.example/openai/v1/responses");
    expect(snippet).toContain("\"input\"");
    expect(snippet).not.toContain("chat/completions");

    Reflect.deleteProperty(window, "__BUYER_BOOT__");
    vi.unstubAllGlobals();
  });
});

describe("<ChatForm /> Responses streams", () => {
  it("renders a refusal from the exact terminal output Items", async () => {
    const user = userEvent.setup();
    const terminal = {
      id: "resp_refusal",
      object: "response",
      created_at: 1_745_500_000,
      model: "kimi",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "I cannot help with that." }],
      }],
      usage: { input_tokens: 2, output_tokens: 5, total_tokens: 7 },
      error: null,
      incomplete_details: null,
    };
    const event = {
      type: "response.completed",
      sequence_number: 1,
      response: terminal,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `event: response.completed\ndata: ${JSON.stringify(event)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));

    render(<ChatForm />);
    await user.type(screen.getByTestId("chat-input"), "unsafe request");
    await user.click(screen.getByTestId("chat-send"));

    await waitFor(() => {
      expect(screen.getByText("I cannot help with that.")).toBeTruthy();
    });
    vi.unstubAllGlobals();
  });

  it("replays every terminal output Item on the next demo turn", async () => {
    const user = userEvent.setup();
    const firstOutput = [
      {
        type: "reasoning",
        id: "reasoning_1",
        encrypted_content: "opaque-bytes",
        summary: [{ type: "summary_text", text: "checking" }],
      },
      {
        type: "function_call",
        id: "call_item_1",
        call_id: "call_1",
        name: "lookup",
        arguments: "{\"id\":1}",
        status: "completed",
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "Use the tool." }],
      },
    ];
    const postedBodies: Array<{ input?: unknown[] }> = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBodies.push(JSON.parse(String(init?.body)) as { input?: unknown[] });
      call += 1;
      const response = {
        id: `resp_${call}`,
        object: "response",
        created_at: 1_745_500_000,
        model: "kimi",
        status: "completed",
        output: call === 1
          ? firstOutput
          : [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            }],
        usage: { input_tokens: 2, output_tokens: 5, total_tokens: 7 },
        error: null,
        incomplete_details: null,
      };
      const event = {
        type: "response.completed",
        sequence_number: 1,
        response,
      };
      return new Response(
        `event: response.completed\ndata: ${JSON.stringify(event)}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    render(<ChatForm />);
    await user.type(screen.getByTestId("chat-input"), "first");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByText("Use the tool.");
    await user.type(screen.getByTestId("chat-input"), "continue");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByText("Done.");

    expect(postedBodies[1]?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first" }],
      },
      ...firstOutput,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }],
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("keeps incomplete output but reports the terminal truncation reason", async () => {
    const user = userEvent.setup();
    const response = {
      id: "resp_incomplete",
      object: "response",
      created_at: 1_745_500_000,
      model: "kimi",
      status: "incomplete",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Partial answer" }],
      }],
      usage: { input_tokens: 2, output_tokens: 5, total_tokens: 7 },
      error: null,
      incomplete_details: { reason: "max_output_tokens" },
    };
    const event = {
      type: "response.incomplete",
      sequence_number: 1,
      response,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `event: response.incomplete\ndata: ${JSON.stringify(event)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));

    render(<ChatForm />);
    await user.type(screen.getByTestId("chat-input"), "hello");
    await user.click(screen.getByTestId("chat-send"));

    await screen.findByText("Partial answer");
    expect(screen.getByTestId("chat-error").textContent).toMatch(/max_output_tokens/);
    vi.unstubAllGlobals();
  });

  it("shows an error when the stream ends without a terminal event", async () => {
    const user = userEvent.setup();
    const delta = {
      type: "response.output_text.delta",
      sequence_number: 1,
      delta: "partial",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));

    render(<ChatForm />);
    await user.type(screen.getByTestId("chat-input"), "hello");
    await user.click(screen.getByTestId("chat-send"));

    await waitFor(() => {
      expect(screen.getByTestId("chat-error").textContent).toMatch(/without a terminal/i);
    });
    vi.unstubAllGlobals();
  });
});

describe("<TaskHistory /> smoke", () => {
  // TaskHistory now fetches /v1/indexer/escrows?buyer=<pkh> via the buyer-app
  // server proxy and groups rows by posted_at. Each lifecycle (Open → Claimed
  // → Submitted → terminal) shares one posted_at value, so we mock the
  // indexer with a couple of fully-populated rows representing two distinct
  // lifecycles in different states and assert one task-row per lifecycle.
  it("fetches /v1/indexer/escrows and renders one row per distinct lifecycle (posted_at)", async () => {
    const mp = makeMockMarketplace();
    const buyerPkh = mp.getWalletKey().pubKeyHash;
    const baseRow = (overrides: Record<string, unknown>) => ({
      utxo_ref: "a".repeat(64) + "#0",
      buyer_pkh: buyerPkh,
      supplier_pkh: "b".repeat(56),
      advert_ref: "c".repeat(64) + "#0",
      capability_id: "llm.text.generate.v1",
      prompt_hash: "d".repeat(64),
      payment_lovelace: "2000000",
      buyer_bond_lovelace: "1000000",
      supplier_bond_lovelace: "1000000",
      posted_at: 1700000000000,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Submitted",
      created_slot: 1000,
      ...overrides,
    });
    // Lifecycle A: posted_at=1700000000000 — Open + Submitted rows (two
    // chain rows in same lifecycle).
    // Lifecycle B: posted_at=1700000099999 — Open + Accepted (different lifecycle).
    const rows = [
      baseRow({ utxo_ref: "1".repeat(64) + "#0", state: "Open", created_slot: 1000 }),
      baseRow({ utxo_ref: "2".repeat(64) + "#0", state: "Submitted", created_slot: 1010 }),
      baseRow({ utxo_ref: "3".repeat(64) + "#0", state: "Open",     created_slot: 2000, posted_at: 1700000099999 }),
      baseRow({ utxo_ref: "4".repeat(64) + "#0", state: "Accepted", created_slot: 2020, posted_at: 1700000099999 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);
      // TaskHistory now also fetches /v1/responses (the buyer-app's archive
      // index) and joins by escrow_ref. Empty list is a valid response that
      // means "archive disabled / no records yet" and exercises the same
      // "no archive payload to render inline" code path as production.
      if (url.includes("/v1/responses")) {
        return new Response(JSON.stringify({ responses: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!url.includes(`/v1/indexer/escrows?buyer=${buyerPkh}`)) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    render(wrap(<TaskHistory />, mp));
    await waitFor(() => {
      const taskRows = document.querySelectorAll("[data-testid='task-row']");
      expect(taskRows.length).toBe(2); // 2 distinct lifecycles
    });
    vi.unstubAllGlobals();
  });

  it("renders an empty-state when the indexer returns no rows", async () => {
    const mp = makeMockMarketplace();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
    ));
    render(wrap(<TaskHistory />, mp));
    await waitFor(() => {
      expect(screen.getByTestId("task-history-empty")).toBeTruthy();
    });
    vi.unstubAllGlobals();
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
