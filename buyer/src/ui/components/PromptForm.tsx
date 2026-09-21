/**
 * buyer/src/ui/components/PromptForm.tsx — prompt submission form.
 *
 * The submit flow runs ENTIRELY server-side via POST /v1/submit-prompt:
 *   server-side SDK does PostEscrow → supplier inference → on-chain verify
 * The browser only sends the prompt + advert_ref and waits for the receipt.
 * That keeps the buyer's private key out of the SPA bundle and avoids any
 * direct chain-provider call from the browser (the browser SDK has a chain
 * stub that throws on use; only the server-side SDK has a real Live chain).
 *
 * UX:
 *   - empty content blocks submission client-side (no fetch issued)
 *   - shows a loading indicator while the server is running the lifecycle
 *     (typically 30–60s on testnet — PostEscrow confirm + inference)
 *   - shows an error alert on failure
 *   - emits onSubmit(result) when the supplier response arrives
 */

import { useState } from "react";
import type { SubmitPromptResult } from "../../sdk/types.js";
import type { OutputReference } from "@marketplace/shared/chain";
import {
  normalizeResponseOutput,
  responseOutputText,
  type ResponseObject,
  type ResponseRequest,
} from "@marketplace/shared/responses";

export interface PromptFormProps {
  advertRef: OutputReference;
  payment_lovelace: bigint;
  onSubmit?: (result: SubmitPromptResult) => void;
}

type ServerResponse = Omit<Partial<ResponseObject>, "error"> & {
  receipt?: SubmitPromptResult["receipt"];
  receipt_signature?: string;
  escrow_ref?: string;
  error?: ResponseObject["error"] | string;
  message?: string;
};

function refToOutput(refStr: string | undefined): OutputReference | null {
  if (!refStr) return null;
  const m = /^([0-9a-f]{64})#(\d+)$/.exec(refStr);
  if (!m) return null;
  return { txHash: m[1], index: Number(m[2]) };
}

function responseDisplay(result: ResponseObject): string {
  return result.output.flatMap((item) =>
    item.type === "message"
      ? item.content.map((part) =>
          part.type === "refusal" ? part.refusal : part.text
        )
      : []
  ).join("");
}

export default function PromptForm({ advertRef, payment_lovelace, onSubmit }: PromptFormProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitPromptResult | null>(null);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (content.trim().length === 0) return;
    setLoading(true);
    setError(null);
    const request: ResponseRequest = {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
      }],
    };
    try {
      const resp = await fetch("/v1/submit-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          advert_ref: `${advertRef.txHash}#${advertRef.index}`,
          ...request,
          payment_lovelace: payment_lovelace.toString(),
        }),
      });
      const body = (await resp.json()) as ServerResponse;
      if (!resp.ok) {
        throw new Error(`${body.error ?? resp.statusText}: ${body.message ?? ""}`);
      }
      const escrow = refToOutput(body.escrow_ref);
      if (
        !escrow ||
        !body.receipt ||
        !body.receipt_signature ||
        body.object !== "response" ||
        typeof body.id !== "string" ||
        typeof body.created_at !== "number" ||
        typeof body.model !== "string" ||
        (body.status !== "completed" && body.status !== "incomplete") ||
        (body.usage !== null && (
          typeof body.usage !== "object" ||
          Array.isArray(body.usage) ||
          !("input_tokens" in body.usage) ||
          !("output_tokens" in body.usage) ||
          !("total_tokens" in body.usage) ||
          typeof body.usage.input_tokens !== "number" ||
          typeof body.usage.output_tokens !== "number" ||
          typeof body.usage.total_tokens !== "number"
        )) ||
        (body.error !== null && (
          typeof body.error !== "object" || Array.isArray(body.error)
        )) ||
        (
          body.status === "incomplete"
            ? (
                body.incomplete_details === null ||
                typeof body.incomplete_details !== "object" ||
                Array.isArray(body.incomplete_details) ||
                !("reason" in body.incomplete_details) ||
                typeof body.incomplete_details.reason !== "string"
              )
            : body.incomplete_details !== null
        )
      ) {
        throw new Error("server response missing canonical response or receipt fields");
      }
      // The guard validates these fields, but TypeScript does not retain
      // property-level narrowing when assigning the complete objects.
      const usage = body.usage as ResponseObject["usage"];
      const incompleteDetails = body.incomplete_details as ResponseObject["incomplete_details"];
      const responseFields = { ...body };
      delete responseFields.receipt;
      delete responseFields.receipt_signature;
      delete responseFields.escrow_ref;
      delete responseFields.message;
      const resultObject: ResponseObject = {
        ...responseFields,
        object: "response",
        id: body.id,
        created_at: body.created_at,
        model: body.model,
        status: body.status,
        output: normalizeResponseOutput(body.output),
        usage,
        error: body.error ?? null,
        incomplete_details: incompleteDetails,
      };
      const r: SubmitPromptResult = {
        response: responseOutputText(resultObject.output),
        request,
        result: resultObject,
        receipt: body.receipt,
        receiptSignature: body.receipt_signature,
        escrowRef: escrow,
      };
      setResult(r);
      if (onSubmit) onSubmit(r);
    } catch (err) {
      setError((err as Error).message ?? "submit failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <textarea
        className="w-full rounded border border-gray-300 p-3 text-sm font-mono text-gray-900"
        rows={6}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Type a prompt..."
        disabled={loading}
        aria-label="prompt input"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-gray-400"
          disabled={loading}
        >
          Submit
        </button>
        {loading && (
          <span data-testid="loading-indicator" role="progressbar" className="text-sm text-gray-300">
            Running lifecycle on chain… (30–60s)
          </span>
        )}
      </div>
      {error && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {result && !error && (
        <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          <p className="font-medium">Response</p>
          <pre className="whitespace-pre-wrap font-mono text-xs">{responseDisplay(result.result)}</pre>
        </div>
      )}
    </form>
  );
}
