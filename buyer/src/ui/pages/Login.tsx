/**
 * buyer/src/ui/pages/Login.tsx — operator password gate.
 *
 * Posts { password } to /v1/auth/login. On 204, calls auth.refresh() which
 * flips the AuthContext to "authenticated" and the surrounding <RequireAuth>
 * unmounts this page and mounts the real app. On 401 → inline "incorrect
 * password" error. On 429 → reads the Retry-After header and surfaces the
 * remaining seconds.
 */

import { useState, useRef, useEffect, type FormEvent } from "react";
import { useAuth } from "../state/AuthContext.js";

export default function Login() {
  const { refresh } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "same-origin",
      });
      if (res.status === 204) {
        setPassword("");
        await refresh();
        return;
      }
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const secs = retryAfter ? Number(retryAfter) : NaN;
        setError(
          Number.isFinite(secs) && secs > 0
            ? `Too many attempts. Try again in ${secs}s.`
            : "Too many attempts. Try again later.",
        );
        return;
      }
      if (res.status === 401) {
        setError("Incorrect password.");
        return;
      }
      if (res.status === 503) {
        setError("Login is not configured on this server. Check BUYER_PASSWORD/SESSION_SECRET.");
        return;
      }
      setError(`Unexpected response (${res.status}). Try again.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white rounded-lg shadow border border-gray-200 p-6 space-y-4"
      >
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Buyer sign in</h1>
          <p className="mt-1 text-sm text-gray-500">
            Enter the operator password to access this buyer instance.
          </p>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Password</span>
          <input
            ref={inputRef}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
          />
        </label>
        {error !== null ? (
          <div role="alert" className="text-sm text-red-600">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="w-full inline-flex justify-center items-center rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-800 disabled:bg-gray-400"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
