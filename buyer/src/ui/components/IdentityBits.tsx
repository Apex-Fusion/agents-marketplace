/**
 * buyer/src/ui/components/IdentityBits.tsx — small shared pieces of the
 * identity and dispute views: the /v1/identity/summaries hook, the effective
 * status pill, explorer links and value formatters.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router-dom";

/** One entry of GET /v1/identity/summaries. */
export interface IdentitySummary {
  did: string;
  status: number;
  name: string | null;
  origin: string | null;
  effective: string | null;
  effectiveReason: string | null;
  accountable: boolean;
  module1: boolean;
  holds?: Array<{ by: string | null; reason: string | null; since: string | null; until: string | null }>;
}

export const HEX64_RE = /^[0-9a-f]{64}$/;

export function shortDid(id: string): string {
  return `did:vector:${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function EffectivePill({ effective }: { effective: string | null | undefined }) {
  const colour = effective === "active"
    ? "bg-green-100 text-green-700"
    : effective === "suspended"
      ? "bg-amber-100 text-amber-700"
      : effective === "revoked" || effective === "retired" || effective === "deactivated"
        ? "bg-red-100 text-red-700"
        : "bg-gray-200 text-gray-600";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${colour}`}>{effective ?? "unknown"}</span>
  );
}

export function TxLink({ tx }: { tx: string | null | undefined }) {
  if (!tx) return <span className="text-gray-400">—</span>;
  return (
    <a
      className="font-mono text-xs text-blue-600 hover:underline"
      href={`https://vector.apexscan.org/en/transaction/${tx}/summary/`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {tx.length > 20 ? `${tx.slice(0, 10)}…${tx.slice(-6)}` : tx}
    </a>
  );
}

/** Client-side link inside a router; a plain link outside one (component tests). */
export function AgentLink({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  const inRouter = useInRouterContext();
  return inRouter
    ? <Link to={`/agents/${id}`} className={className}>{children}</Link>
    : <a href={`/agents/${id}`} className={className}>{children}</a>;
}

/** "12.500000 AP3X" from a lovelace decimal string. */
export function ap3x(lovelace: string | number | null | undefined): string {
  if (lovelace === null || lovelace === undefined || lovelace === "") return "—";
  try {
    const n = BigInt(lovelace);
    return `${n / 1_000_000n}.${String(n % 1_000_000n).padStart(6, "0")} AP3X`;
  } catch {
    return `${String(lovelace)} lovelace`;
  }
}

/** "2026-11-04 10:05 UTC" from an ISO time; "—" when absent or invalid. */
export function utc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** GET a same-origin JSON route; the body is null when it is not JSON. */
export async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { cache: "no-store" });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Identity summaries of the given agent ids (one request; unknown ids are skipped). */
export function useSummaries(ids: ReadonlyArray<string | null | undefined>): Record<string, IdentitySummary> {
  const key = [...new Set(ids.filter((id): id is string => typeof id === "string" && HEX64_RE.test(id)))]
    .sort()
    .slice(0, 60)
    .join(",");
  const [summaries, setSummaries] = useState<Record<string, IdentitySummary>>({});
  useEffect(() => {
    if (key === "") return;
    let cancelled = false;
    getJson(`/v1/identity/summaries?ids=${key}`)
      .then(({ status, body }) => {
        if (!cancelled && status === 200 && typeof body === "object" && body !== null) {
          setSummaries(body as Record<string, IdentitySummary>);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key]);
  return summaries;
}
