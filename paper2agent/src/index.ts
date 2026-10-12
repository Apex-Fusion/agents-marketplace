import type { Server } from "node:http";
import type { Express } from "express";

const role = process.argv[2];
let app: Express;
let host: string;
let port: number;
let closeService: () => Promise<void>;

if (role === "control") {
  const [{ loadPaperControlConfig }, { PaperControlStore }, { PaperControlService, createPaperControlApp },
    { DockerAgentBuilder, loadDockerAgentBuilderConfig }] = await Promise.all([
    import("./control-config.js"), import("./store.js"), import("./control.js"), import("./build.js"),
  ]);
  const config = loadPaperControlConfig();
  const store = new PaperControlStore(config.dataDir);
  const service = new PaperControlService({ config, store,
    builder: new DockerAgentBuilder(loadDockerAgentBuilderConfig(process.env)) });
  try { await service.start(); } catch (error) { await service.close(); store.close(); throw error; }
  app = createPaperControlApp({ service, token: config.token });
  ({ host, port } = config);
  closeService = async () => { try { await service.close(); } finally { store.close(); } };
} else if (role === "publisher") {
  const [{ loadPaperPublisherConfig }, { PaperPublisherService, createPaperPublisherApp }] = await Promise.all([
    import("./publisher-config.js"), import("./publisher.js"),
  ]);
  const config = loadPaperPublisherConfig();
  const service = await PaperPublisherService.open(config);
  app = createPaperPublisherApp(service);
  ({ host, port } = config);
  closeService = () => service.close();
} else {
  throw new Error("Usage: tsx paper2agent/src/index.ts <control|publisher>");
}

let server: Server;
try {
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening));
    listening.once("error", reject);
  });
} catch (error) { await closeService(); throw error; }
console.log(`Paper2Agent ${role} listening on ${host}:${port}`);

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      // Keep result lookup available while the publisher drains accepted paid work.
      if (role === "publisher") await closeService();
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (role === "control") await Promise.all([closed, closeService()]);
      else await closed;
    })().catch((error: unknown) => {
      console.error(`Paper2Agent ${role} shutdown failed`, error);
      process.exitCode = 1;
      if (role === "control") server.closeAllConnections();
    });
  });
}
