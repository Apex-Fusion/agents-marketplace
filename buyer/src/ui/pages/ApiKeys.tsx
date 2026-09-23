/**
 * buyer/src/ui/pages/ApiKeys.tsx — operator key list and self-serve creation.
 *
 * Lists stored key prefixes and live wallet balances through the authenticated
 * buyer API. Full keys are never stored in retrievable form. Public gateway
 * signup returns a new key once, together with its funding deposit address.
 */

import { useEffect, useState } from "react";
import { resolveGatewayUrl } from "../gateway.js";

interface SignupResult {
  api_key: string;
  key_prefix: string;
  deposit_address: string;
}

interface ApiKeySummary {
  id: string;
  key_prefix: string;
  label: string | null;
  deposit_address: string;
  created_at: number;
  disabled: boolean;
  demo: boolean;
  balance_lovelace: string | null;
  balance_error: string | null;
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
    if (typeof b.message === "string") return b.message;
    if (typeof err === "string") return err;
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
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setListLoading(true);
    setListError(null);
    setKeys(null);
    fetch("/v1/api-keys", { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(errorMessage(body, res.status, res.statusText));
        if (!body || !Array.isArray(body.keys)) throw new Error("Unexpected API key list response");
        return body.keys as ApiKeySummary[];
      })
      .then((rows) => {
        if (!controller.signal.aborted) setKeys(rows);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setListError(e instanceof Error ? e.message : "Could not load API keys");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

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
      setReloadKey((k) => k + 1);
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
          `curl ${baseUrl}/responses \\`,
          `  -H "Authorization: Bearer ${result.api_key}" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -d '{"model": "<model>", "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}]}'`,
        ].join("\n");

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">API Keys</h1>
        <p className="text-sm text-gray-600">
          Generate an OpenAI-compatible API key for the marketplace gateway. Each key has its own
          gateway-managed wallet (the gateway holds this wallet's key) - fund its deposit address with AP3X, then point any OpenAI SDK at{" "}
          <code className="font-mono text-xs">{baseUrl}</code>.
        </p>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4 space-y-3" aria-labelledby="api-key-list-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="api-key-list-heading" className="text-lg font-semibold">Existing API keys</h2>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={listLoading}
            className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {listLoading ? "Loading…" : "Refresh balances"}
          </button>
        </div>
        <p className="text-sm text-gray-600">
          All gateway keys, including demo and disabled keys. Only key prefixes are shown.
          Wallet balances exclude funds held in escrow.
        </p>
        {listLoading ? (
          <p className="text-sm text-gray-500" role="status">Loading API keys and balances…</p>
        ) : listError !== null ? (
          <p className="text-sm text-red-600" role="alert">{listError}</p>
        ) : keys?.length === 0 ? (
          <p className="text-sm text-gray-500">No API keys yet. Generate a key below.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">API key prefixes and wallet balances</caption>
              <thead className="border-b text-gray-500">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">API key</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Wallet balance</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Deposit address</th>
                  <th scope="col" className="py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {keys?.map((key) => (
                  <tr key={key.id}>
                    <td className="py-3 pr-4 align-top">
                      <code className="whitespace-nowrap font-mono">{key.key_prefix}…</code>
                      <div className="mt-1 text-gray-600">{key.label || "No label"}</div>
                      <div className="mt-1 flex gap-2 text-xs text-gray-500">
                        <span>{key.disabled ? "Disabled" : "Active"}</span>
                        {key.demo && <span>Demo</span>}
                      </div>
                    </td>
                    <td className="py-3 pr-4 align-top whitespace-nowrap">
                      {key.balance_lovelace === null ? (
                        <span className="text-red-600">{key.balance_error ?? "Balance unavailable"}</span>
                      ) : (
                        <span className="font-medium">
                          {(Number(key.balance_lovelace) / 1e6).toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 6,
                          })} AP3X
                        </span>
                      )}
                    </td>
                    <td className="min-w-48 max-w-sm py-3 pr-4 align-top">
                      <code className="block break-all font-mono text-xs">{key.deposit_address}</code>
                      <div className="mt-1"><CopyButton value={key.deposit_address} label="Copy address" /></div>
                    </td>
                    <td className="py-3 align-top text-gray-600">
                      {new Date(key.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
