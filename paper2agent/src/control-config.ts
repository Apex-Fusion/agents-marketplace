/**
 * paper2agent/src/control-config.ts — environment for the Paper2Agent control service.
 *
 * Required:
 *   PAPER2AGENT_CONTROL_TOKEN     — bearer token the buyer proxy sends. At least
 *                                   32 printable characters, no whitespace.
 *
 * Optional:
 *   PAPER2AGENT_CONTROL_PORT      — default 8095.
 *   PAPER2AGENT_CONTROL_HOST      — listen address (IP literal), default 127.0.0.1.
 *   PAPER2AGENT_CONTROL_DATA_DIR  — SQLite database and per-attempt build
 *                                   directories (default ./data/paper2agent-control).
 *   PAPER2AGENT_PUBLISHER_URL     — publisher service base URL. Set together with
 *   PAPER2AGENT_PUBLISHER_TOKEN   — the publisher management bearer token (same rules
 *                                   as the control token). Unset: publishing is unavailable.
 */
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { PaperBuildBudget } from "@marketplace/shared/paper2agent/workflow";

const TOKEN_RE = /^[\x21-\x7e]{32,}$/;
const PORT_RE = /^[1-9]\d{0,4}$/;

const DEFAULT_BUDGET: PaperBuildBudget = { max_model_calls: 32, max_output_tokens: 4096, timeout_ms: 900_000 };
const MAXIMUM_BUDGET: PaperBuildBudget = { max_model_calls: 64, max_output_tokens: 8192, timeout_ms: 3_600_000 };

export interface PaperControlConfig {
  /** Absolute directory for control.db and build work directories. */
  dataDir: string;
  port: number;
  host: string;
  token: string;
  /** Both null, or both set. */
  publisherUrl: string | null;
  publisherToken: string | null;
  defaultBudget: PaperBuildBudget;
  maximumBudget: PaperBuildBudget;
  /** Waiting builds; at most one build runs at a time. */
  maxQueuedBuilds: number;
}

function token(env: Record<string, string | undefined>, name: string): string {
  const value = env[name] ?? "";
  if (!TOKEN_RE.test(value)) {
    throw new Error(`loadPaperControlConfig: ${name} must be at least 32 printable characters without whitespace`);
  }
  return value;
}

function publisherUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("loadPaperControlConfig: PAPER2AGENT_PUBLISHER_URL must be an absolute http(s) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("loadPaperControlConfig: PAPER2AGENT_PUBLISHER_URL must be an http(s) URL without credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

export function loadPaperControlConfig(env: Record<string, string | undefined> = process.env): PaperControlConfig {
  const portText = env.PAPER2AGENT_CONTROL_PORT ?? "";
  let port = 8095;
  if (portText !== "") {
    if (!PORT_RE.test(portText) || Number(portText) > 65535) {
      throw new Error("loadPaperControlConfig: PAPER2AGENT_CONTROL_PORT must be an integer from 1 to 65535");
    }
    port = Number(portText);
  }
  const host = env.PAPER2AGENT_CONTROL_HOST || "127.0.0.1";
  if (isIP(host) === 0) throw new Error("loadPaperControlConfig: PAPER2AGENT_CONTROL_HOST must be an IP address literal");
  const url = env.PAPER2AGENT_PUBLISHER_URL ?? "";
  const publisherToken = env.PAPER2AGENT_PUBLISHER_TOKEN ?? "";
  if ((url === "") !== (publisherToken === "")) {
    throw new Error("loadPaperControlConfig: set PAPER2AGENT_PUBLISHER_URL and PAPER2AGENT_PUBLISHER_TOKEN together");
  }
  return {
    dataDir: resolve(env.PAPER2AGENT_CONTROL_DATA_DIR || "./data/paper2agent-control"),
    port,
    host,
    token: token(env, "PAPER2AGENT_CONTROL_TOKEN"),
    publisherUrl: url === "" ? null : publisherUrl(url),
    publisherToken: url === "" ? null : token(env, "PAPER2AGENT_PUBLISHER_TOKEN"),
    defaultBudget: { ...DEFAULT_BUDGET },
    maximumBudget: { ...MAXIMUM_BUDGET },
    maxQueuedBuilds: 20,
  };
}
