// @vitest-environment happy-dom
/**
 * buyer-ui-smoke.test.tsx — behavior of the buyer SPA: navigation, supplier list, prompt and chat forms, API key example,
 * task history, wallet address and supplier card. The tests stub fetch and the SDK calls, and find elements by role or test id.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { makeSupplierView } from "../fixtures/buyer-side/supplier-views.js";
import { TASK_COMPLETED } from "../fixtures/buyer-side/sample-task-records.js";
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

function wrap(element: React.ReactElement, mp: Marketplace) {
  return (
    <MemoryRouter>
      <MarketplaceProvider marketplace={mp}>
        {element}
      </MarketplaceProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "__BUYER_BOOT__");
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("<App /> smoke", () => {
  it("renders a nav element with links for Dashboard, Tasks, and Wallet", async () => {
    // The indexer is unreachable: the Dashboard calls the real discoverSuppliers, which fails with an IndexerError.
    // This case is the only test of that failure branch of Marketplace.discoverSuppliers. The Marketplace binds the stubbed
    // fetch when it is built, so the stub comes first.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    render(wrap(<App />, makeMockMarketplace()));
    const hrefs = within(screen.getByRole("navigation")).getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/", "/tasks", "/wallet"]));
    await act(async () => {});
  });
});

describe("<Dashboard /> smoke", () => {
  it("renders a SupplierCard for each discovered supplier except offline ones", async () => {
    const mp = makeMockMarketplace();
    vi.spyOn(mp, "discoverSuppliers").mockResolvedValue([
      makeSupplierView({ utxo_ref: "a".repeat(64) + "#0", supplier_pkh: "a".repeat(56) }),
      makeSupplierView({ utxo_ref: "b".repeat(64) + "#0", supplier_pkh: "b".repeat(56) }),
      makeSupplierView({
        utxo_ref: "c".repeat(64) + "#0",
        supplier_pkh: "c".repeat(56),
        model: "offline-model",
        status: "offline",
      }),
    ]);
    render(wrap(<Dashboard />, mp));
    // The Dashboard hides the offline supplier and adds two demo suppliers (Piper TTS and Kimi chat): (3 - 1) + 2 cards.
    const cards = await waitFor(() => {
      const found = screen.getAllByTestId("supplier-card");
      expect(found).toHaveLength(4);
      return found;
    });
    const capabilities = cards.map((card) => card.textContent ?? "");
    expect(capabilities.filter((text) => text.includes("audio.synthesize.piper.v1"))).toHaveLength(1);
    expect(capabilities.filter((text) => text.includes("llm.chat.v1"))).toHaveLength(1);
  });
});

describe("<PromptForm /> smoke", () => {
  // The form POSTs to /v1/submit-prompt: the buyer server runs the lifecycle. The tests stub fetch.
  const advertRef = { txHash: "b".repeat(64), index: 0 };

  function stubFetchOk() {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
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
      receipt: TASK_COMPLETED.receipt,
      receipt_signature: TASK_COMPLETED.receipt_signature,
      escrow_ref: `${"a".repeat(64)}#0`,
    }));
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  it("POSTs /v1/submit-prompt with canonical input when submitted", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchOk();
    render(wrap(<PromptForm advertRef={advertRef} payment_lovelace={2_000_000n} />, makeMockMarketplace()));
    await user.type(screen.getByRole("textbox"), "What is 2+2?");
    await user.click(screen.getByRole("button"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/v1/submit-prompt");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      advert_ref: `${advertRef.txHash}#0`,
      payment_lovelace: "2000000",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is 2+2?" }] }],
    });
    await act(async () => {});
  });

  it("does NOT POST when prompt textarea is empty (client-side validation)", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchOk();
    render(wrap(<PromptForm advertRef={advertRef} payment_lovelace={2_000_000n} />, makeMockMarketplace()));
    // Type nothing; click submit.
    await user.click(screen.getByRole("button"));
    await act(async () => {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders a loading indicator while /v1/submit-prompt is pending", async () => {
    const user = userEvent.setup();
    let resolveFn!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFn = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    render(wrap(<PromptForm advertRef={advertRef} payment_lovelace={2_000_000n} />, makeMockMarketplace()));
    await user.type(screen.getByRole("textbox"), "What is 2+2?");
    await user.click(screen.getByRole("button"));
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    resolveFn(new Response("{}", { status: 502 }));
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("renders an error message when /v1/submit-prompt rejects", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "submit_prompt_failed", message: "supplier offline" },
      { status: 502 },
    )));
    render(wrap(<PromptForm advertRef={advertRef} payment_lovelace={2_000_000n} />, makeMockMarketplace()));
    await user.type(screen.getByRole("textbox"), "Hello?");
    await user.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
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

    const snippet = screen.getByTestId("api-key-result").querySelector("pre")?.textContent ?? "";
    expect(snippet).toContain("https://api.marketplace.example/openai/v1/responses");
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
      expect(screen.getByTestId("chat-transcript")).toHaveTextContent("I cannot help with that.");
    });
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
    await waitFor(() => expect(screen.getByTestId("chat-input")).toBeEnabled());
    await user.type(screen.getByTestId("chat-input"), "continue");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getByTestId("chat-input")).toBeEnabled());

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

    await waitFor(() => expect(screen.getByTestId("chat-transcript")).toHaveTextContent("Partial answer"));
    expect(screen.getByTestId("chat-error").textContent).toMatch(/max_output_tokens/);
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

    expect(await screen.findByTestId("chat-error")).toBeInTheDocument();
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
  });
});

describe("<Wallet /> smoke", () => {
  it("renders the configured walletKey.address", async () => {
    // The balance request fails: the page still shows the address. (A pending stub would leave the error path of the page untested.)
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    render(wrap(<Wallet />, makeMockMarketplace()));
    await act(async () => {});
    // The buyer's bech32 address must appear in the rendered output
    expect(screen.getAllByRole("definition").map((value) => value.textContent)).toContain(buyer.address);
  });
});

describe("<SupplierCard /> smoke", () => {
  it("renders the supplier model and price", () => {
    render(<SupplierCard supplier={makeSupplierView()} />);
    const card = screen.getByTestId("supplier-card");
    expect(within(card).getByRole("heading")).toHaveTextContent("qwen2.5:0.5b");
    expect(card).toHaveTextContent("2.000000 AP3X");
  });

  it("'Use' button is disabled when supplier.status is 'offline'", () => {
    render(<SupplierCard supplier={makeSupplierView({ status: "offline" })} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("'Use' button is enabled when supplier.status is 'free'", () => {
    render(<SupplierCard supplier={makeSupplierView({ status: "free" })} />);
    expect(screen.getByRole("button")).not.toBeDisabled();
  });
});
