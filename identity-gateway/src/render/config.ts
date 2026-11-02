// Runtime configuration of the renderings, the policy page and the background jobs.

export interface RenderConfig {
  /** Public HTTPS origin of the gateway (GATEWAY_BASE_URL). It names the did:web aliases, catalog URLs and MCP server names. */
  readonly baseUrl: string;
  /** Text that /policy publishes on the retention of the web proxy's access log (ACCESS_LOG_RETENTION). */
  readonly accessLogRetention: string;
  /** The background fetch jobs run (FETCH_JOBS=on, the default; off stops all fetches and so all listing). */
  readonly fetchJobs: boolean;
  /** Time between background scans (FETCH_SCAN_INTERVAL_S, default 600 seconds). */
  readonly scanIntervalMs: number;
}

export const DEFAULT_BASE_URL = "https://id.vector.apexfusion.org";
export const DEFAULT_ACCESS_LOG_RETENTION = "The operator has not published the retention time of the access log yet.";

function origin(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`GATEWAY_BASE_URL must be an https origin, got "${text}"`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`GATEWAY_BASE_URL must be an https origin without path, query or credentials, got "${text}"`);
  }
  return url.origin;
}

export function loadRenderConfig(env: NodeJS.ProcessEnv): RenderConfig {
  const jobs = env.FETCH_JOBS || "on";
  if (jobs !== "on" && jobs !== "off") throw new Error(`FETCH_JOBS must be "on" or "off", got "${jobs}"`);
  const interval = env.FETCH_SCAN_INTERVAL_S || "600";
  if (!/^\d+$/.test(interval) || Number(interval) < 60 || Number(interval) > 86_400) {
    throw new Error(`FETCH_SCAN_INTERVAL_S must be an integer in [60, 86400], got "${interval}"`);
  }
  return {
    baseUrl: origin(env.GATEWAY_BASE_URL || DEFAULT_BASE_URL),
    accessLogRetention: env.ACCESS_LOG_RETENTION || DEFAULT_ACCESS_LOG_RETENTION,
    fetchJobs: jobs === "on",
    scanIntervalMs: Number(interval) * 1000,
  };
}
