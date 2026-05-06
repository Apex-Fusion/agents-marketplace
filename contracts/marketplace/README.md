# local-agents/marketplace

Aiken validators for the Local Agents Marketplace (M1, v1). Two validators ship from this project:

- **AdvertScript** (`validators/advert.ak`) — supplier-owned advertisement registry; redeemers `PostAdvert | UpdateAdvert | RetireAdvert`.
- **EscrowScript** (`validators/escrow.ak`) — happy-path bonded escrow, state machine `Open → Claimed → Submitted → Accepted | Released` (and `Open|Claimed → Reclaimed`); redeemers `Claim | Submit | Accept | Reclaim | Release`.

Datum schemas mirror `packages/shared/src/cbor/types.ts` byte-for-byte (Plutus Constr0 with fields in declaration order). Spec: `docs/ARCHITECTURE.md` §4. `ACCEPT_WINDOW = 600_000 ms` (10 min) lives in `lib/marketplace/common.ak`. Compile with `aiken check && aiken build`; the resulting `plutus.json` is consumed by M1-B's tx builders.
