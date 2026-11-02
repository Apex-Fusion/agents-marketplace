import { KoiosOgmiosChainSource } from "./chain/koios-ogmios-source.js";
import { KoiosClient } from "./chain/koios.js";
import { loadConfig } from "./config.js";
import { FactsStore } from "./fetch/facts.js";
import { startBackgroundJobs } from "./fetch/jobs.js";
import { m4ServicesFromEnv } from "./m4/index.js";
import { loadRenderConfig } from "./render/config.js";
import { VectorResolver } from "./resolve/resolver.js";
import { createResolverServer } from "./server/http.js";
import { m4Routes } from "./server/routes-m4.js";
import { renderRoutes } from "./server/routes-render.js";

const config = loadConfig(process.env);
const renderConfig = loadRenderConfig(process.env);
const chain = new KoiosOgmiosChainSource({
  koios: new KoiosClient({ baseUrl: config.koiosUrl, token: config.koiosToken }),
  ogmiosUrl: config.ogmiosUrl,
});
const facts = new FactsStore();
const resolver = new VectorResolver(chain, config.resolver, { fetchedFacts: facts.provider });
// The scan reads every record; its own resolver keeps the request path's history cache intact.
const jobs = renderConfig.fetchJobs
  ? startBackgroundJobs(new VectorResolver(chain, config.resolver), facts, config.resolver, { scanIntervalMs: renderConfig.scanIntervalMs })
  : null;
// M4 services (Part 2 Section 8.6) start when both gateway key files are set. Status-list builds read
// every record, so they also get their own resolver.
const m4 = m4ServicesFromEnv(process.env, { baseUrl: renderConfig.baseUrl, records: new VectorResolver(chain, config.resolver), chain });
const server = createResolverServer(resolver, {
  routes: [
    renderRoutes({
      records: resolver,
      facts,
      snapshot: () => jobs?.snapshot ?? { scannedAt: null, records: [] },
      settings: config.resolver,
      config: renderConfig,
      // The Ed25519 key of the gateway (Part 2 Section 8.2) signs agent cards; without it they answer 503.
      signer: m4?.context.keys.ed25519 ?? null,
    }),
    ...(m4 ? [m4Routes(m4)] : []),
  ],
});
m4?.start();
server.listen(config.port, config.host, () => {
  const identity = config.resolver.registries.identity;
  console.error(
    `identity-gateway listening on http://${config.host}:${config.port}/1.0/identifiers/{did} ` +
      `(identity registry ${identity ? identity.policyId : "not configured"}, legacy registry ${config.resolver.registries.legacy.policyId}, ` +
      `background fetch jobs ${renderConfig.fetchJobs ? "on" : "off"}, M4 services ${m4 ? "on" : "off"})`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void jobs?.stop();
    m4?.stop();
    server.close(() => process.exit(0));
  });
}
