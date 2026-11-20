// GET /policy (Part 1 Section 10; Part 2 Sections 8.1, 8.4 and 8.5): the listing rule, the fetch
// rules, the confirmation rule, the retention of the web proxy's access log, the bound of each
// revocation path at each surface, and the bound for an open escrow. The text of an earlier member
// changes only when the rule that it states changes; other readers use these members.

import { FETCH_LIMITS } from "../fetch/fetcher.js";
import { DAY_MS, FIRST_RETRY_MS } from "../fetch/scheduler.js";
import { CONFIRMATION_DEPTH } from "../resolve/settings.js";
import type { RenderConfig } from "./config.js";
import { ESCROW_BOUND, ESCROW_BOUND_ABOUT, revocationBounds } from "./policy-bounds.js";

export function policyDocument(config: RenderConfig): Record<string, unknown> {
  return {
    listingRule:
      "The catalogs (/.well-known/ai-catalog.json and /.well-known/ard.json) and the MCP subregistry (/v0/servers) list an agent only when all of these conditions are true. " +
      "The agent is independent: it is not a subagent. " +
      "Its effective status without resolution options is Active. " +
      "Its endpoint is reachable: the last protocol detection of the current endpoint succeeded. " +
      "The catalogs show an A2A agent through its agent card and an MCP agent through its server card.",
    fetchRules:
      "The gateway detects protocols and verifies domains in background jobs. It never fetches during a request. " +
      "It fetches only https URLs whose host resolves to public unicast addresses. It checks the addresses for each connection and each redirect. " +
      "It does not follow a redirect to another host. " +
      `Each fetch is limited to ${FETCH_LIMITS.maxBytes} bytes (1 MiB) and ${FETCH_LIMITS.timeoutMs / 1000} seconds. ` +
      `It makes at most one fetch to a host each ${FETCH_LIMITS.hostIntervalMs / 1000} seconds. ` +
      "It checks each Active agent again every day and after each change of its record. " +
      `After a check that found no protocol, it checks again after ${FIRST_RETRY_MS / 60_000} minutes, then after twice as long each time, but never later than a day after the last check.`,
    confirmationRule:
      "Everything that the gateway issues uses the view without resolution options. " +
      "A change that reduces what a record allows takes effect at once. " +
      `Other changes take effect when their transaction has ${CONFIRMATION_DEPTH} confirmations. ` +
      `A revocation or retirement shows as Suspended (deactivationPending) until it has ${CONFIRMATION_DEPTH} confirmations.`,
    requestLog: "The gateway writes no request log. It logs errors without the requested DID.",
    accessLogRetention: config.accessLogRetention,
    limits: {
      fetchMaxBytes: FETCH_LIMITS.maxBytes,
      fetchTimeoutSeconds: FETCH_LIMITS.timeoutMs / 1000,
      fetchIntervalPerHostSeconds: FETCH_LIMITS.hostIntervalMs / 1000,
      maxRedirects: FETCH_LIMITS.maxRedirects,
      recheckSeconds: DAY_MS / 1000,
      firstRetrySeconds: FIRST_RETRY_MS / 1000,
      confirmations: CONFIRMATION_DEPTH,
    },
    revocationBounds: revocationBounds(config),
    escrowBound: { about: ESCROW_BOUND_ABOUT, sentences: ESCROW_BOUND },
  };
}
