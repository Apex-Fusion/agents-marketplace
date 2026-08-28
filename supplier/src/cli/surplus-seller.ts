import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadSurplusManagerConfig } from "../surplus/config.js";
import { SurplusClient } from "../surplus/client.js";
import { SurplusSellerController } from "../surplus/controller.js";
import { OpenRouterKeyClient } from "../surplus/openRouterKey.js";
import { FileSurplusStateStore } from "../surplus/state.js";
import {
  SurplusDashboardService,
  type SurplusDashboardSnapshot,
} from "../surplus/dashboard.js";
import { renderSurplusDashboardPage } from "../surplus/dashboardPage.js";

export async function runSurplusSeller(
  env: Record<string, string | undefined>,
): Promise<{ server: Server; controller: SurplusSellerController }> {
  const config = loadSurplusManagerConfig(env);
  const client = new SurplusClient({
    apiBaseUrl: config.apiBaseUrl,
    sellerApiKey: config.sellerApiKey,
    timeoutMs: config.requestTimeoutMs,
  });
  const allowance = new OpenRouterKeyClient({
    baseUrl: config.capacityBaseUrl,
    apiKey: config.providerApiKey,
    timeoutMs: config.requestTimeoutMs,
  });
  const stateStore = new FileSurplusStateStore(config.statePath);
  const controller = new SurplusSellerController({
    config,
    client,
    allowance,
    stateStore,
    log: (message) => console.log(message),
  });
  const dashboard = new SurplusDashboardService({
    controller,
    client,
    allowance,
    config,
  });
  const server = createSurplusServer(controller, dashboard);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, "0.0.0.0", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  await controller.start();
  return { server, controller };
}

interface DashboardSource {
  getSnapshot(): Promise<SurplusDashboardSnapshot>;
}

export function createSurplusServer(
  controller: Pick<SurplusSellerController, "snapshot" | "healthy">,
  dashboard: DashboardSource,
): Server {
  return createServer((request, response) => {
    void handleRequest(controller, dashboard, request, response);
  });
}

async function handleRequest(
  controller: Pick<SurplusSellerController, "snapshot" | "healthy">,
  dashboard: DashboardSource,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = request.url?.split("?")[0] ?? "/";
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  if (request.method === "GET" && path === "/") {
    response.statusCode = 302;
    response.setHeader("location", "/reseller");
    response.end();
    return;
  }
  if (
    request.method === "GET" &&
    (path === "/reseller" || path === "/reseller/")
  ) {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self' 'unsafe-inline'; connect-src 'self'; " +
        "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    response.end(renderSurplusDashboardPage());
    return;
  }
  const status = controller.snapshot();
  if (request.method === "GET" && path === "/healthz") {
    const healthy = controller.healthy();
    response.statusCode = healthy ? 200 : 503;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: healthy, phase: status.phase }));
    return;
  }
  if (request.method === "GET" && path === "/status") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(status));
    return;
  }
  if (request.method === "GET" && path === "/dashboard/api") {
    try {
      const snapshot = await dashboard.getSnapshot();
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(snapshot));
    } catch {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "dashboard_data_unavailable" }));
    }
    return;
  }
  response.statusCode = 404;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: "not_found" }));
}

export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const { server, controller } = await runSurplusSeller(env);
  console.log("Surplus seller controller listening");
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Surplus seller controller shutting down (${signal})`);
    await controller.stop();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const invoked = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (invoked) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Surplus seller controller failed: ${detail}`);
    process.exitCode = 1;
  });
}
