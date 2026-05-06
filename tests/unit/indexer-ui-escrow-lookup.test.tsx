// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-escrow-lookup.test.tsx — GREEN (M1-F-5)
 *
 * Category F: EscrowLookup component (~6 tests)
 *
 * Mock strategy: vi.mock client.js at module level; per-test control via
 * fetchEscrowMock.mockResolvedValue / mockRejectedValue.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Module-level mock — hoisted above imports.
vi.mock("../../indexer-ui/src/api/client.js", () => ({
  fetchEscrow: vi.fn(),
  fetchSuppliers: vi.fn(),
  fetchHealthz: vi.fn(),
  fetchCapabilities: vi.fn(),
}));

import EscrowLookup from "../../indexer-ui/src/components/EscrowLookup.js";

const { fetchEscrow: fetchEscrowMock } = await import("../../indexer-ui/src/api/client.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const VALID_REF = "a".repeat(64) + "#0";

const SAMPLE_ESCROW = {
  utxo_ref: VALID_REF,
  buyer_pkh: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  supplier_pkh: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
};

// ─── Input ────────────────────────────────────────────────────────────────────

describe("EscrowLookup — input", () => {
  it("renders escrow-ref-input and escrow-lookup-submit", async () => {
    (fetchEscrowMock as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_ESCROW);
    render(<EscrowLookup />);
    const input = document.querySelector("[data-testid='escrow-ref-input']");
    const btn = document.querySelector("[data-testid='escrow-lookup-submit']");
    expect(input).not.toBeNull();
    expect(btn).not.toBeNull();
  });

  it("accepts a valid <hex64>#<int> ref value", async () => {
    (fetchEscrowMock as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_ESCROW);
    render(<EscrowLookup />);
    const input = document.querySelector("[data-testid='escrow-ref-input']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_REF } });
    expect(input.value).toBe(VALID_REF);
  });

  it("does not call fetchEscrow when input format is invalid", async () => {
    const user = userEvent.setup();
    (fetchEscrowMock as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_ESCROW);
    render(<EscrowLookup />);
    const input = document.querySelector("[data-testid='escrow-ref-input']") as HTMLInputElement;
    const btn = document.querySelector("[data-testid='escrow-lookup-submit']") as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "not-a-valid-ref" } });
    await user.click(btn);
    // Should not have been called due to validation
    expect(fetchEscrowMock).not.toHaveBeenCalled();
  });
});

// ─── 404 path ─────────────────────────────────────────────────────────────────

describe("EscrowLookup — not found", () => {
  it("renders 'not found' indicator on 404 response", async () => {
    const user = userEvent.setup();
    (fetchEscrowMock as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("escrow not found"), { status: 404 }),
    );
    render(<EscrowLookup />);
    const input = document.querySelector("[data-testid='escrow-ref-input']") as HTMLInputElement;
    const btn = document.querySelector("[data-testid='escrow-lookup-submit']") as HTMLButtonElement;
    fireEvent.change(input, { target: { value: VALID_REF } });
    await user.click(btn);
    await waitFor(() => {
      const notFound =
        document.querySelector("[data-testid='escrow-not-found']") ??
        screen.queryByText(/not found/i);
      expect(notFound).not.toBeNull();
    });
  });
});

// ─── Success path ─────────────────────────────────────────────────────────────

describe("EscrowLookup — state machine view", () => {
  it("renders escrow-state-machine on successful fetch", async () => {
    const user = userEvent.setup();
    (fetchEscrowMock as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_ESCROW);
    render(<EscrowLookup />);
    const input = document.querySelector("[data-testid='escrow-ref-input']") as HTMLInputElement;
    const btn = document.querySelector("[data-testid='escrow-lookup-submit']") as HTMLButtonElement;
    fireEvent.change(input, { target: { value: VALID_REF } });
    await user.click(btn);
    await waitFor(() => {
      const sm = document.querySelector("[data-testid='escrow-state-machine']");
      expect(sm).not.toBeNull();
    });
  });

  it("highlights current state pill as active, other states as dimmed", async () => {
    const user = userEvent.setup();
    (fetchEscrowMock as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_ESCROW);
    render(<EscrowLookup />);
    const input = document.querySelector("[data-testid='escrow-ref-input']") as HTMLInputElement;
    const btn = document.querySelector("[data-testid='escrow-lookup-submit']") as HTMLButtonElement;
    fireEvent.change(input, { target: { value: VALID_REF } });
    await user.click(btn);
    await waitFor(() => {
      const current = document.querySelector("[data-testid='escrow-state-current']");
      const others = document.querySelectorAll("[data-testid='escrow-state-other']");
      expect(current).not.toBeNull();
      expect(others.length).toBeGreaterThan(0);
      // Current state text should match SAMPLE_ESCROW.state
      expect(current!.textContent).toMatch(/open/i);
    });
  });
});
