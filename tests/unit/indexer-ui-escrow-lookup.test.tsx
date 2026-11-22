// @vitest-environment happy-dom
/**
 * tests/unit/indexer-ui-escrow-lookup.test.tsx — EscrowLookup: the ref check before the request, the not-found view (the `.status`
 * of the error that client.ts throws) and the state pills. client.js is mocked.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Module-level mock — hoisted above the imports, so the import below is the mock.
vi.mock("../../indexer-ui/src/api/client.js", () => ({
  fetchEscrow: vi.fn(),
}));

import EscrowLookup from "../../indexer-ui/src/components/EscrowLookup.js";
import { fetchEscrow } from "../../indexer-ui/src/api/client.js";
import { UI_ESCROW_REF as VALID_REF, buildUiEscrowView } from "../fixtures/indexer-ui-side/sample-escrow.js";

const fetchEscrowMock = vi.mocked(fetchEscrow);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SAMPLE_ESCROW = buildUiEscrowView();

/** Types `ref` in the input and clicks the lookup button. */
async function lookUp(ref: string): Promise<void> {
  const user = userEvent.setup();
  fireEvent.change(screen.getByTestId("escrow-ref-input"), { target: { value: ref } });
  await user.click(screen.getByTestId("escrow-lookup-submit"));
}

describe("EscrowLookup", () => {
  it("does not call fetchEscrow when input format is invalid", async () => {
    fetchEscrowMock.mockResolvedValue(SAMPLE_ESCROW);
    render(<EscrowLookup />);
    await lookUp("not-a-valid-ref");
    await act(async () => {});
    expect(fetchEscrowMock).not.toHaveBeenCalled();
  });

  it("shows the not-found view when fetchEscrow rejects with status 404", async () => {
    fetchEscrowMock.mockRejectedValue(Object.assign(new Error("escrow not found"), { status: 404 }));
    render(<EscrowLookup />);
    await lookUp(VALID_REF);
    expect(await screen.findByTestId("escrow-not-found")).toBeInTheDocument();
  });

  it("asks for the typed ref, and highlights the current state pill and no other", async () => {
    fetchEscrowMock.mockResolvedValue(SAMPLE_ESCROW);
    render(<EscrowLookup />);
    await lookUp(VALID_REF);
    expect(await screen.findByTestId("escrow-state-machine")).toBeInTheDocument();
    expect(fetchEscrowMock).toHaveBeenCalledWith(VALID_REF);
    // The current pill shows the state of the escrow; no other pill does.
    expect(screen.getByTestId("escrow-state-current")).toHaveTextContent(SAMPLE_ESCROW.state);
    const others = screen.getAllByTestId("escrow-state-other");
    expect(others.length).toBeGreaterThan(0);
    for (const pill of others) expect(pill).not.toHaveTextContent(SAMPLE_ESCROW.state);
  });
});
