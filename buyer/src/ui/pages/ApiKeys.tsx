/**
 * buyer/src/ui/pages/ApiKeys.tsx — self-serve "Generate API key" page.
 *
 * Mints a custodial gateway API key by POSTing directly to the gateway's
 * public /signup endpoint (cross-origin; the gateway CORS-allows this origin).
 * The raw key is shown ONCE — it is never stored server-side in retrievable
 * form, so it cannot be listed or recovered later. The page also surfaces the
 * funding deposit address and a ready-to-paste usage snippet.
 *
 * Access is gated by the SPA's existing operator login (this page only renders
 * inside <RequireAuth>). The gateway /signup itself stays public + IP
 * rate-limited; per-user accounts are a later feature.
 */

import { useState } from "react";
import { resolveGatewayUrl } from "../gateway.js";

interface SignupResult {
  api_key: string;
  key_prefix: string;
  deposit_address: string;
}

/** Pull a human-readable message out of whatever error shape the gateway
 * returns (OpenAI `{error:{message}}`, plain `{error|message}`, or neither). */
function errorMessage(body: unknown, status: number, statusText: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = b.error;
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
      return (err as Record<string, string>).message;
    }
    if (typeof err === "string") return err;
    if (typeof b.message === "string") return b.message;
  }
  return `${status} ${statusText}`.trim() || "request failed";
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            /* clipboard blocked (insecure context / permissions) — no-op */
          });
      }}
      className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
    >
      {copied ? "Copied!" : (label ?? "Copy")}
    </button>
  );
}

export default function ApiKeys() {
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupResult | null>(null);

  const gatewayUrl = resolveGatewayUrl();
  const baseUrl = `${gatewayUrl}/openai/v1`;

  async function generate() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${gatewayUrl}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(label.trim() ? { label: label.trim() } : {}),
      });
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        throw new Error(errorMessage(body, res.status, res.statusText));
      }
      const r = body as Partial<SignupResult> | null;
      if (!r || typeof r.api_key !== "string" || typeof r.deposit_address !== "string") {
        throw new Error("unexpected response from gateway");
      }
      setResult({
        api_key: r.api_key,
        key_prefix: r.key_prefix ?? r.api_key.slice(0, 12),
        deposit_address: r.deposit_address,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not reach the gateway");
    } finally {
      setLoading(false);
    }
  }

  const curlSnippet =
    result === null
      ? ""
      : [
          `curl ${baseUrl}/chat/completions \\`,
          `  -H "Authorization: Bearer ${result.api_key}" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -d '{"model": "<model>", "messages": [{"role": "user", "content": "Hello"}]}'`,
        ].join("\n");

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">API Keys</h1>
        <p className="text-sm text-gray-600">
          Generate an OpenAI-compatible API key for the marketplace gateway. Each key has its own
          custodial wallet — fund its deposit address with AP3X, then point any OpenAI SDK at{" "}
          <code className="font-mono text-xs">{baseUrl}</code>.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
        <label className="block text-sm font-medium text-gray-700">
          Label <span className="font-normal text-gray-400">(optional)</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. my-laptop"
            maxLength={120}
            disabled={loading}
            className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={loading}
          className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          data-testid="generate-api-key"
        >
          {loading ? "Generating…" : "Generate API key"}
        </button>
        {error !== null && (
          <p className="text-sm text-red-600" data-testid="api-key-error">
            {error}
          </p>
        )}
      </div>

      {result !== null && (
        <div className="space-y-4 rounded-lg border border-amber-300 bg-amber-50 p-4" data-testid="api-key-result">
          <div className="rounded border border-amber-400 bg-amber-100 px-3 py-2 text-sm text-amber-900">
            Copy your API key now — it is shown <strong>only once</strong> and cannot be recovered. If you
            lose it, generate a new one.
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">API key</span>
              <CopyButton value={result.api_key} />
            </div>
            <code className="mt-1 block break-all rounded bg-white px-3 py-2 font-mono text-sm">
              {result.api_key}
            </code>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Deposit address (fund with AP3X)</span>
              <CopyButton value={result.deposit_address} />
            </div>
            <code className="mt-1 block break-all rounded bg-white px-3 py-2 font-mono text-sm">
              {result.deposit_address}
            </code>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Base URL</span>
              <CopyButton value={baseUrl} />
            </div>
            <code className="mt-1 block break-all rounded bg-white px-3 py-2 font-mono text-sm">
              {baseUrl}
            </code>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Quick start</span>
              <CopyButton value={curlSnippet} />
            </div>
            <pre className="mt-1 overflow-x-auto rounded bg-gray-900 px-3 py-2 font-mono text-xs text-gray-100">
              {curlSnippet}
            </pre>
            <p className="mt-1 text-xs text-gray-500">
              Replace <code className="font-mono">&lt;model&gt;</code> with a model from{" "}
              <code className="font-mono">{baseUrl}/models</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
