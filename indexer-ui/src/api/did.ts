/**
 * indexer-ui/src/api/did.ts — the agent DID of an advert or escrow.
 *
 * The indexer sends `agent_id` as 64 lowercase hex characters (Part 2 §6.4).
 * The canonical DID is `did:vector:<vector-id>` (docs/did-vector-method.md
 * Section 3). This module stays apart from client.ts, which the UI tests
 * replace with mocks.
 */

/** The canonical DID of the agent `agentId`. */
export function agentDid(agentId: string): string {
  return `did:vector:${agentId}`;
}
