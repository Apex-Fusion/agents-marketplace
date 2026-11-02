import { KoiosOgmiosChainSource } from "./chain/koios-ogmios-source.js";
import { KoiosClient } from "./chain/koios.js";
import { loadConfig } from "./config.js";
import { VectorResolver } from "./resolve/resolver.js";
import { createResolverServer } from "./server/http.js";

const config = loadConfig(process.env);
const chain = new KoiosOgmiosChainSource({
  koios: new KoiosClient({ baseUrl: config.koiosUrl, token: config.koiosToken }),
  ogmiosUrl: config.ogmiosUrl,
});
const server = createResolverServer(new VectorResolver(chain, config.resolver));
server.listen(config.port, config.host, () => {
  const identity = config.resolver.registries.identity;
  console.error(
    `identity-gateway listening on http://${config.host}:${config.port}/1.0/identifiers/{did} ` +
      `(identity registry ${identity ? identity.policyId : "not configured"}, legacy registry ${config.resolver.registries.legacy.policyId})`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
