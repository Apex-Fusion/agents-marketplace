import { Paper2AgentClient, type Paper2AgentOffer } from "@marketplace/buyer/sdk/paper2agent";
import { paper2AgentToolName } from "@marketplace/shared/paper2agent";
import type { GatewayDeps } from "../deps.js";

export type ToolCatalog = ReadonlyMap<string, Paper2AgentOffer>;

/**
 * One cached discovery for the public tools/list and tools/call. A load reads the
 * indexer, each advert UTxO and each supplier /capability, so concurrent requests
 * share one load and its result stays for `mcpCatalogTtlMs`. Failures are not cached.
 * With a publisher prefix, only adverts whose endpoint is under it are listed: the
 * endpoint URL is on-chain advert data, and tools/call sends it the route token.
 */
export function createToolCatalog(deps: GatewayDeps): () => Promise<ToolCatalog> {
  let client: Paper2AgentClient | undefined;
  let cached: { tools: ToolCatalog; expiresAt: number } | undefined;
  let loading: Promise<ToolCatalog> | undefined;

  const load = async (): Promise<ToolCatalog> => {
    client ??= new Paper2AgentClient({ chain: deps.chain, indexerUrl: deps.config.indexerUrl, fetchFn: deps.fetchFn });
    // Busy and not yet polled tools stay listed; a call waits or reports busy.
    const offers = await client.discover({ includeBusy: true });
    const tools = new Map<string, Paper2AgentOffer>();
    const collisions = new Set<string>();
    for (const offer of offers) {
      if (!underPrefix(offer.endpointUrl, deps.config.paper2agentToolEndpointPrefix)) continue;
      const name = paper2AgentToolName(offer.manifest);
      if (collisions.has(name)) continue;
      const previous = tools.get(name);
      if (previous && previous.manifestHash !== offer.manifestHash) {
        tools.delete(name);
        collisions.add(name);
        continue;
      }
      tools.set(name, offer);
    }
    return tools;
  };

  return () => {
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.tools);
    loading ??= load()
      .then((tools) => {
        cached = { tools, expiresAt: Date.now() + deps.config.mcpCatalogTtlMs };
        return tools;
      })
      .finally(() => { loading = undefined; });
    return loading;
  };
}

/** Compares the normalized URL, so dot segments cannot leave the prefix. */
function underPrefix(endpointUrl: string, prefix: string | undefined): boolean {
  if (prefix === undefined) return true;
  try {
    return new URL(endpointUrl).href.startsWith(prefix);
  } catch {
    return false;
  }
}
