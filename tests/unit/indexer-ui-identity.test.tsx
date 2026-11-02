// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-identity.test.tsx — identity registry fields in the
 * indexer dashboard (Part 2 §6.1, §6.4): the agent DID column, the escrow
 * layout, agent, refund and value-cap facts, and the RefundRevokedEscrow
 * event of the SSE stream.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SAMPLE_FREE_SUPPLIER,
  SAMPLE_NEW_ADVERT_SUPPLIER,
  UI_AGENT_ID,
} from "../fixtures/indexer-ui-side/sample-supplier-rows.js";

vi.mock("../../indexer-ui/src/api/client.js", () => ({
  fetchSuppliers: vi.fn(),
  fetchHealthz: vi.fn(),
  fetchCapabilities: vi.fn(),
  fetchEscrow: vi.fn(),
}));

vi.mock("../../indexer-ui/src/hooks/useSSE.js", () => ({
  useSSE: vi.fn(() => ({ events: [], lastSeenSlot: null, connected: true })),
  MAX_EVENTS: 500,
}));

import SuppliersTable from "../../indexer-ui/src/components/SuppliersTable.js";
import EscrowLookup from "../../indexer-ui/src/components/EscrowLookup.js";
import { subscribeToEvents, type ChainEvent } from "../../indexer-ui/src/api/sse.js";
// vi.mock above is hoisted: these names are the mocks.
import { fetchSuppliers as fetchSuppliersMock, fetchEscrow as fetchEscrowMock } from "../../indexer-ui/src/api/client.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const VALID_REF = "a".repeat(64) + "#0";

const LEGACY_ESCROW = {
  utxo_ref: VALID_REF,
  buyer_pkh: "c".repeat(56),
  supplier_pkh: "b".repeat(56),
  advert_ref: "b".repeat(64) + "#0",
  capability_id: "llm.text.generate.v1",
  request_spec_hash: "d".repeat(64),
  prompt_hash: "e".repeat(64),
  payment_lovelace: "2000000",
  buyer_bond_lovelace: "1000000",
  supplier_bond_lovelace: "1000000",
  deliver_by: 1_745_600_000,
  posted_at: 1_745_500_000,
  submitted_at: null,
  result_receipt_hash: null,
  state: "Open",
  created_slot: 3000,
  layout: "legacy",
  agent_id: null,
  refund: null,
  routable: true,
};

async function lookUp(escrow: unknown): Promise<void> {
  const user = userEvent.setup();
  (fetchEscrowMock as ReturnType<typeof vi.fn>).mockResolvedValue(escrow);
  render(<EscrowLookup />);
  const input = document.querySelector("[data-testid='escrow-ref-input']") as HTMLInputElement;
  fireEvent.change(input, { target: { value: VALID_REF } });
  await user.click(document.querySelector("[data-testid='escrow-lookup-submit']") as HTMLButtonElement);
  await waitFor(() => expect(document.querySelector("[data-testid='escrow-state-machine']")).not.toBeNull());
}

const text = (testId: string): string | null =>
  document.querySelector(`[data-testid='${testId}']`)?.textContent ?? null;

describe("SuppliersTable — agent column", () => {
  it("shows the canonical DID of a new advert and 'legacy' for a legacy advert", async () => {
    (fetchSuppliersMock as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE_NEW_ADVERT_SUPPLIER, SAMPLE_FREE_SUPPLIER]);
    render(<SuppliersTable />);
    await waitFor(() => {
      const cells = [...document.querySelectorAll("[data-testid='supplier-agent']")].map((cell) => cell.textContent);
      expect(cells).toEqual([`did:vector:${UI_AGENT_ID}`, "legacy"]);
    });
    expect(document.querySelector("th:nth-child(3)")?.textContent).toBe("Agent");
  });
});

describe("EscrowLookup — identity facts", () => {
  it("shows the layout, agent DID and refund address of a new escrow above the value cap", async () => {
    await lookUp({
      ...LEGACY_ESCROW,
      layout: "identity",
      agent_id: UI_AGENT_ID,
      refund: { address: "addr1vxrefundexample", datum: "d87980" },
      routable: false,
    });
    expect(text("escrow-layout")).toBe("identity");
    expect(text("escrow-agent")).toBe(`did:vector:${UI_AGENT_ID}`);
    expect(text("escrow-refund")).toBe("addr1vxrefundexample (with datum)");
    expect(text("escrow-not-routable")).toMatch(/10,000 AP3X/);
  });

  it("shows a legacy escrow as legacy, with no agent and the buyer key as refund target", async () => {
    await lookUp(LEGACY_ESCROW);
    expect(text("escrow-layout")).toBe("legacy");
    expect(text("escrow-agent")).toBe("none");
    expect(text("escrow-refund")).toBe("buyer key");
    expect(document.querySelector("[data-testid='escrow-not-routable']")).toBeNull();
  });

  it("reads a row from an indexer without the identity fields as legacy", async () => {
    const { layout: _layout, agent_id: _agent, refund: _refund, routable: _routable, ...older } = LEGACY_ESCROW;
    await lookUp(older);
    expect(text("escrow-layout")).toBe("legacy");
    expect(text("escrow-refund")).toBe("buyer key");
    expect(document.querySelector("[data-testid='escrow-not-routable']")).toBeNull();
  });
});

describe("SSE — RefundRevokedEscrow", () => {
  it("subscribes to the RefundRevokedEscrow event and forwards it", () => {
    const listeners = new Map<string, (msg: MessageEvent) => void>();
    class FakeEventSource {
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {}
      addEventListener(type: string, handler: (msg: MessageEvent) => void): void {
        listeners.set(type, handler);
      }
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const received: ChainEvent[] = [];

    const stop = subscribeToEvents("", (event) => received.push(event));
    listeners.get("RefundRevokedEscrow")!(
      { data: JSON.stringify({ type: "RefundRevokedEscrow", ref: VALID_REF, slot: 42, txHash: "f".repeat(64) }) } as MessageEvent,
    );
    stop();

    expect(received).toEqual([{
      type: "RefundRevokedEscrow", ref: VALID_REF, slot: 42, txHash: "f".repeat(64), address: undefined,
    }]);
  });
});
