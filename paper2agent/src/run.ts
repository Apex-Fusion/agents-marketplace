import type { DecoderHealth, DecoderHealthOptions } from "@marketplace/shared/tx/server";
import { serve, type PaperRole, type RoleStart } from "./serve.js";

async function startControl(): Promise<RoleStart> {
  const [{ loadPaperControlConfig }, { PaperControlStore }, { PaperControlService, createPaperControlApp },
    { DockerAgentBuilder, loadDockerAgentBuilderConfig }] = await Promise.all([
    import("./control-config.js"), import("./store.js"), import("./control.js"), import("./build.js"),
  ]);
  const config = loadPaperControlConfig();
  const store = new PaperControlStore(config.dataDir);
  const service = new PaperControlService({ config, store,
    builder: new DockerAgentBuilder(loadDockerAgentBuilderConfig(process.env)) });
  try { await service.start(); } catch (error) { await service.close(); store.close(); throw error; }
  const app = createPaperControlApp({ service, token: config.token });
  const { host, port } = config;
  return { app, host, port, closeService: async () => { try { await service.close(); } finally { store.close(); } } };
}

async function startPublisher(): Promise<RoleStart> {
  const [{ loadPaperPublisherConfig }, { PaperPublisherService, createPaperPublisherApp }] = await Promise.all([
    import("./publisher-config.js"), import("./publisher.js"),
  ]);
  const config = loadPaperPublisherConfig();
  const service = await PaperPublisherService.open(config);
  const app = createPaperPublisherApp(service);
  const { host, port } = config;
  return { app, host, port, closeService: () => service.close() };
}

/** Only the publisher loads the decoder library (the control role does not), so only its module is loaded for the health check. */
async function loadStartHealth(): Promise<(options: DecoderHealthOptions) => DecoderHealth> {
  return (await import("@marketplace/shared/tx/server")).startDecoderHealth;
}

export interface PaperRoles {
  control: () => Promise<RoleStart>;
  publisher: () => Promise<RoleStart>;
  /** The health check of the decoder library, for the roles that load it. */
  startHealth: () => Promise<(options: DecoderHealthOptions) => DecoderHealth>;
}

const ROLES: PaperRoles = { control: startControl, publisher: startPublisher, startHealth: loadStartHealth };

/** Starts one role. A test passes stand-ins for the roles and for the health check. */
export async function main(role: string | undefined, roles: PaperRoles = ROLES): Promise<void> {
  if (role !== "control" && role !== "publisher") throw new Error("Usage: tsx paper2agent/src/index.ts <control|publisher>");
  const start = await roles[role]();
  await serve(role satisfies PaperRole, start, role === "publisher" ? await roles.startHealth() : undefined);
}
