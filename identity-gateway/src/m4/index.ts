// M4 services of the gateway (Part 2 Section 8.6): authorisation server metadata, the token service,
// introspection and revocation, SPIFFE, status lists and identity credentials. They build on the
// resolver core: everything that they issue uses the view without options (Part 2 Section 8.4).

import type { ChainSource } from "../chain/types.js";
import { loadGatewayKeys, type GatewayKeys } from "../keys/gateway-keys.js";
import { loadM4Config } from "./config.js";
import type { M4Context, M4Settings, RecordSource } from "./context.js";
import { DelegationSource } from "./delegation.js";
import { SingleUseStore } from "./replay.js";
import { SpiffeService } from "./spiffe.js";
import { StatusLists } from "./status-lists.js";
import { TokenRegistry, TokenService } from "./tokens.js";

/** How often the status watcher checks the agents of live tokens. */
export const STATUS_WATCH_INTERVAL_MS = 30_000;

export interface M4ServicesOptions {
  readonly settings: M4Settings;
  readonly keys: GatewayKeys;
  /** The resolver core (`VectorResolver`). */
  readonly records: RecordSource;
  readonly chain: ChainSource;
  /** POSIX milliseconds; default Date.now. */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface M4Services {
  readonly context: M4Context;
  readonly tokens: TokenService;
  readonly statusLists: StatusLists;
  readonly spiffe: SpiffeService;
  readonly delegations: DelegationSource | null;
  /** Starts the status watcher, which revokes the tokens of agents whose effective status is no longer Active. */
  start(): void;
  stop(): void;
}

export function createM4Services(options: M4ServicesOptions): M4Services {
  const context: M4Context = {
    settings: options.settings,
    keys: options.keys,
    records: options.records,
    chain: options.chain,
    now: options.now ?? Date.now,
    log: options.log ?? ((message) => console.error(message)),
  };
  const replay = new SingleUseStore();
  const delegations = options.settings.delegation ? new DelegationSource(options.chain, options.settings.delegation) : null;
  const registry = new TokenRegistry();
  const statusLists = new StatusLists(context, (now) => registry.heldEntries(now));
  const tokens = new TokenService(context, replay, statusLists, delegations, registry);
  const spiffe = new SpiffeService(context, replay, tokens);
  let timer: NodeJS.Timeout | undefined;
  return {
    context,
    tokens,
    statusLists,
    spiffe,
    delegations,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void tokens.checkStatuses(), STATUS_WATCH_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * The M4 services from the environment (see config.ts), or null when no key files are configured.
 * `baseUrl` is the gateway's public origin (GATEWAY_BASE_URL).
 */
export function m4ServicesFromEnv(
  env: NodeJS.ProcessEnv,
  dependencies: { readonly baseUrl: string; readonly records: RecordSource; readonly chain: ChainSource; readonly log?: (message: string) => void },
): M4Services | null {
  const { baseUrl, ...rest } = dependencies;
  const config = loadM4Config(env, baseUrl);
  if (config === null) return null;
  const keys = loadGatewayKeys(config.keyFiles, config.gatewayId);
  return createM4Services({ settings: config, keys, ...rest });
}

export type { M4Context, M4Settings, RecordSource } from "./context.js";
export { loadM4Config, type M4Config } from "./config.js";
