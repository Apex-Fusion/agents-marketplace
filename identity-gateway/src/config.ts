// Runtime configuration from the environment. Every value has a public default except KOIOS_TOKEN,
// which is optional and never logged.

export interface GatewayConfig {
  koiosUrl: string;
  koiosToken: string | undefined;
  ogmiosUrl: string;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a TCP port, got ${env.PORT}`);
  return {
    koiosUrl: env.KOIOS_URL || "https://v2.koios.vector.mainnet.apexfusion.org/api/v1",
    koiosToken: env.KOIOS_TOKEN || undefined,
    ogmiosUrl: env.OGMIOS_URL || "wss://ogmios.vector.mainnet.apexfusion.org",
    host: env.HOST || "127.0.0.1",
    port,
  };
}
