import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface DemoOptions {
  gatewayUrl: string;
  dashboardUrl: string;
  model: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}

interface PublicJob {
  escrow_ref: string;
  status: "settled" | "failed";
  upstream_cost_usd: string | null;
  ap3x_payout: string;
  failure_reason: string | null;
}

export function parseDemoArgs(argv: string[]): DemoOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid demo argument near ${flag ?? "end"}`);
    }
    if (
      flag !== "--gateway-url" &&
      flag !== "--dashboard-url" &&
      flag !== "--model" &&
      flag !== "--prompt" &&
      flag !== "--max-tokens" &&
      flag !== "--timeout-ms"
    ) {
      throw new Error(`unknown demo argument: ${flag}`);
    }
    values[flag] = value;
  }
  const gatewayUrl = requiredUrl(values["--gateway-url"], "--gateway-url");
  const dashboardUrl = requiredUrl(values["--dashboard-url"], "--dashboard-url");
  const model = requiredString(values["--model"], "--model");
  const prompt = values["--prompt"] ?? "Reply with one sentence that confirms this marketplace job completed.";
  const maxTokens = positiveInteger(values["--max-tokens"] ?? "64", "--max-tokens");
  const timeoutMs = positiveInteger(values["--timeout-ms"] ?? "900000", "--timeout-ms");
  return {
    gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
    dashboardUrl: dashboardUrl.replace(/\/+$/, ""),
    model,
    prompt,
    maxTokens,
    timeoutMs,
  };
}

export async function runResellerDemo(
  options: DemoOptions,
  gatewayApiKey: string,
): Promise<Record<string, unknown>> {
  if (gatewayApiKey === "") throw new Error("GATEWAY_API_KEY is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(
      `${options.gatewayUrl}/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: options.prompt }],
          max_tokens: options.maxTokens,
          stream: false,
          public_preview: true,
        }),
        signal: controller.signal,
      },
    );
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new Error(
        `gateway returned HTTP ${response.status}: ${JSON.stringify(body)}`,
      );
    }
    const escrowRef = response.headers.get("x-vector-escrow-ref");
    if (!escrowRef) throw new Error("gateway response omitted X-Vector-Escrow-Ref");
    const job = await waitForPublicJob(
      options.dashboardUrl,
      escrowRef,
      options.timeoutMs,
      controller.signal,
    );
    if (job.status === "failed") {
      throw new Error(`reseller job failed: ${job.failure_reason ?? "unknown"}`);
    }
    return {
      completion_id: body?.id ?? null,
      escrow_ref: escrowRef,
      model: body?.model ?? options.model,
      upstream_cost_usd: job.upstream_cost_usd,
      ap3x_payout: job.ap3x_payout,
      dashboard_url: options.dashboardUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPublicJob(
  dashboardUrl: string,
  escrowRef: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PublicJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${dashboardUrl}/api/jobs?limit=100`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(`dashboard jobs returned HTTP ${response.status}`);
    }
    const body = await response.json() as { jobs?: PublicJob[] };
    const job = body.jobs?.find((candidate) => candidate.escrow_ref === escrowRef);
    if (job) return job;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`timed out waiting for dashboard settlement ${escrowRef}`);
}

function requiredString(value: string | undefined, flag: string): string {
  if (!value || value.trim() === "") throw new Error(`${flag} is required`);
  return value.trim();
}

function requiredUrl(value: string | undefined, flag: string): string {
  const raw = requiredString(value, flag);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${flag} must be a valid URL`);
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${flag} must use HTTPS except on loopback`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${flag} must not contain credentials, query, or fragment`);
  }
  return raw;
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${flag} must be a positive safe integer`);
  }
  return Number(value);
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  try {
    const result = await runResellerDemo(
      parseDemoArgs(argv),
      env.GATEWAY_API_KEY ?? "",
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`reseller demo failed: ${message}\n`);
    return 1;
  }
}

const invoked = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (invoked) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
