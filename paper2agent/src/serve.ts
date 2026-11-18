import type { Server } from "node:http";
import type { Express } from "express";
import type { DecoderHealth, DecoderHealthOptions } from "@marketplace/shared/tx/server";

export type PaperRole = "control" | "publisher";

/** What one role gives the server: its Express app, where it listens, and how it stops. */
export interface RoleStart {
  app: Express;
  host: string;
  port: number;
  /** Closes the service. The publisher drains accepted paid work here. */
  closeService: () => Promise<void>;
}

/**
 * Listens, takes the shutdown path on SIGTERM and SIGINT, and starts the health check of the decoder library when `startHealth` is
 * given. The publisher loads the library and gets the check; the control role does not load it and gets none.
 *
 * The shutdown is one function. The signals run it, and the check of the decoder library runs it when the library cannot decode, so
 * that Docker starts the process again. It runs one time.
 */
export async function serve(role: PaperRole, start: RoleStart, startHealth?: (options: DecoderHealthOptions) => DecoderHealth): Promise<Server> {
  const { app, host, port, closeService } = start;
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(port, host, () => resolve(listening));
      listening.once("error", reject);
    });
  } catch (error) { await closeService(); throw error; }
  console.log(`Paper2Agent ${role} listening on ${host}:${port}`);

  let stopping = false;
  const stop = (): void => {
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
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, stop);
  startHealth?.({ server, stop });
  return server;
}
