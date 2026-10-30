// Registry generations of Vector mainnet (method spec Section 4).
//
// Generation 2 is not deployed: its policy and address are "assigned at deployment". Until it is,
// every mainnet identifier resolves against generation 1 only, no generation-1 token can have been
// minted after the generation-2 deployment slot, no burn can be an adoption, and every legacy
// record is effectively active (Section 6.5). When generation 2 is deployed, these rules change and
// this resolver must be extended before it is used again.

export const GENERATION_1 = {
  generation: 1,
  policyId: "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01",
  scriptAddress: "addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42",
} as const;
