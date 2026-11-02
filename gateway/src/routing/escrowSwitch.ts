/**
 * gateway/src/routing/escrowSwitch.ts — the escrow switch (Part 2 §9.6).
 *
 * From SWITCH_SLOT on, builders create only new escrows and adverts, so the
 * gateway routes only new adverts (agent_id set). The indexer applies the
 * same slot to its listing (§6.4); this check keeps the gateway right when the
 * indexer runs without it. The switch is one-way: once the chain tip reaches
 * the slot, the answer stays true. Before that, the gateway reads the tip at
 * most once per TIP_RECHECK_MS. A failed tip read keeps the last answer, so an
 * Ogmios outage does not hide every model; the indexer listing and the buyer
 * SDK (its own switchSlot check) still refuse legacy adverts after the switch.
 */

import type { GatewayDeps } from "../deps.js";

const TIP_RECHECK_MS = 15_000;

interface SwitchState {
  passed: boolean;
  checkedAt: number;
}

/** Per configuration, so each test deps object starts fresh. */
const states = new WeakMap<GatewayDeps["config"], SwitchState>();

/** True once the chain tip has reached the configured switch slot. */
export async function newAdvertsOnly(deps: Pick<GatewayDeps, "config" | "chain">): Promise<boolean> {
  const switchSlot = deps.config.switchSlot;
  if (switchSlot === null) return false;
  let state = states.get(deps.config);
  if (state === undefined) {
    state = { passed: false, checkedAt: Number.NEGATIVE_INFINITY };
    states.set(deps.config, state);
  }
  const now = Date.now();
  if (state.passed || now - state.checkedAt < TIP_RECHECK_MS) return state.passed;
  state.checkedAt = now;
  try {
    state.passed = (await deps.chain.tip()) >= switchSlot;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gateway] escrow switch: chain tip unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
  return state.passed;
}

/**
 * Paper2AgentClient options of the identity release: the switch slot (Post
 * makes only new escrows from it on) and the network of its record lookups.
 * The gateway spreads them into the client options at each construction.
 */
export function paper2AgentClientOptions(config: GatewayDeps["config"]): { switchSlot: number | null; networkId: 0 | 1 } {
  return { switchSlot: config.switchSlot, networkId: config.networkId };
}
