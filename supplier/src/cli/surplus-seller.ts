import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadSurplusManagerConfig } from "../surplus/config.js";
import { SurplusClient } from "../surplus/client.js";
import { SurplusSellerController } from "../surplus/controller.js";
import { OpenRouterKeyClient } from "../surplus/openRouterKey.js";
import { FileSurplusStateStore } from "../surplus/state.js";

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
  const server = createStatusServer(controller);
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

function createStatusServer(controller: SurplusSellerController): Server {
  return createServer((request, response) => {
    const status = controller.snapshot();
    if (request.method === "GET" && request.url === "/healthz") {
      const healthy = controller.healthy();
      response.statusCode = healthy ? 200 : 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: healthy, phase: status.phase }));
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(status));
      return;
    }
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "not_found" }));
  });
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
