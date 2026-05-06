/**
 * indexer-ui/src/components/EscrowLookup.tsx — escrow ref → state machine view.
 *
 * Workflow:
 *   1. User enters a UTxO ref `<txhash:64hex>#<idx>`.
 *   2. Client-side validates against /^[0-9a-fA-F]{64}#\d+$/.
 *   3. On valid submit, calls fetchEscrow(ref). On 404 shows "not found";
 *      on success renders a state-machine pill row with the current state
 *      highlighted.
 *
 * data-testid hooks (test contract):
 *   - escrow-ref-input          — text input
 *   - escrow-lookup-submit      — submit button
 *   - escrow-not-found          — shown on 404
 *   - escrow-state-machine      — shown on 200
 *   - escrow-state-current      — current-state pill (one)
 *   - escrow-state-other        — non-current pills (rest)
 */

import { useState } from "react";
import { fetchEscrow, type EscrowView } from "../api/client.js";

const REF_REGEX = /^[0-9a-fA-F]{64}#\d+$/;

const KNOWN_STATES = [
  "Open",
  "Claimed",
  "Submitted",
  "Accepted",
  "Reclaimed",
  "Released",
] as const;

type ErrState = { kind: "not_found" } | { kind: "other"; message: string };

export default function EscrowLookup() {
  const [ref, setRef] = useState<string>("");
  const [escrow, setEscrow] = useState<EscrowView | null>(null);
  const [err, setErr] = useState<ErrState | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const onSubmit = async (): Promise<void> => {
    if (!REF_REGEX.test(ref)) {
      // Invalid format: no fetch, mark inline error so user sees feedback.
      setEscrow(null);
      setErr({ kind: "other", message: "Invalid ref format — expected <64-hex>#<index>." });
      return;
    }
    setLoading(true);
    setErr(null);
    setEscrow(null);
    try {
      const result = await fetchEscrow(ref);
      setEscrow(result);
    } catch (e: unknown) {
      const status = (e as { status?: number } | null)?.status;
      if (status === 404) {
        setErr({ kind: "not_found" });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setErr({ kind: "other", message });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-md bg-white p-4 shadow-sm">
      <div className="flex gap-2">
        <input
          type="text"
          data-testid="escrow-ref-input"
          placeholder="<txhash>#<idx>"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          className="flex-1 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
        />
        <button
          type="button"
          data-testid="escrow-lookup-submit"
          onClick={onSubmit}
          disabled={loading}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Looking up…" : "Lookup"}
        </button>
      </div>

      {err && err.kind === "not_found" && (
        <div
          data-testid="escrow-not-found"
          role="alert"
          className="mt-3 rounded bg-yellow-50 p-2 text-sm text-yellow-800"
        >
          Escrow not found.
        </div>
      )}
      {err && err.kind === "other" && (
        <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-800">
          {err.message}
        </div>
      )}

      {escrow && (
        <div className="mt-3" data-testid="escrow-state-machine">
          <div className="mb-2 text-xs text-gray-500">
            <span className="font-mono">{escrow.utxo_ref}</span>
          </div>
          <ol className="flex flex-wrap gap-2">
            {KNOWN_STATES.map((state) => {
              const isCurrent = state === escrow.state;
              return (
                <li
                  key={state}
                  data-testid={isCurrent ? "escrow-state-current" : "escrow-state-other"}
                  className={
                    "rounded-full px-3 py-1 text-xs font-medium " +
                    (isCurrent
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-100 text-gray-400")
                  }
                >
                  {state}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
