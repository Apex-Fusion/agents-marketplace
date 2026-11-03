import { KoiosLimiter } from "./chain/limiter.js";
import { KoiosOgmiosChainSource } from "./chain/koios-ogmios-source.js";
import { KoiosClient } from "./chain/koios.js";
import { loadConfig } from "./config.js";
import { FactsStore } from "./fetch/facts.js";
import { startBackgroundJobs } from "./fetch/jobs.js";
import { m4ServicesFromEnv } from "./m4/index.js";
import { loadRenderConfig } from "./render/config.js";
import { LegacyKeySearch } from "./resolve/legacy-key.js";
import { VectorResolver } from "./resolve/resolver.js";
import { createResolverServer } from "./server/http.js";
import { m4Routes } from "./server/routes-m4.js";
import { renderRoutes } from "./server/routes-render.js";

const config = loadConfig(process.env);
const renderConfig = loadRenderConfig(process.env);
// One limiter for every Koios call: requests go before the background passes (chain/limiter.ts).
const limiter = new KoiosLimiter({ ratePerSecond: config.koiosRatePerSecond, burst: 2 * config.koiosRatePerSecond });
const chain = new KoiosOgmiosChainSource({
  koios: new KoiosClient({ baseUrl: config.koiosUrl, token: config.koiosToken, limiter }),
  ogmiosUrl: config.ogmiosUrl,
});
const facts = new FactsStore();
// One legacy key search for every resolver: one cache of witnesses and results, and one limit on
// concurrent Ogmios sessions.
const legacyKeys = new LegacyKeySearch(chain);
const resolver = new VectorResolver(chain, config.resolver, { fetchedFacts: facts.provider, legacyKeys });
// The background scan and the M4 services share a second resolver: the scan and the status-list
// builds are passes over every record, and passes share their ledger reads (resolve/history-store.ts).
// The request path's history cache stays apart.
const records = new VectorResolver(chain, config.resolver, { legacyKeys });
const jobs = renderConfig.fetchJobs ? startBackgroundJobs(records, facts, config.resolver, { scanIntervalMs: renderConfig.scanIntervalMs }) : null;
// M4 services (Part 2 Section 8.6) start when both gateway key files are set.
const m4 = m4ServicesFromEnv(process.env, { baseUrl: renderConfig.baseUrl, records, chain });
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
      `background fetch jobs ${renderConfig.fetchJobs ? "on" : "off"}, M4 services ${m4 ? "on" : "off"}, Koios at most ${config.koiosRatePerSecond} calls/s)`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void jobs?.stop();
    m4?.stop();
    server.close(() => process.exit(0));
  });
}
