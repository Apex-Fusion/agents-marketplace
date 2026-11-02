# apex-fusion/identity-marketplace

Aiken project for the Vector identity registry (`did:vector`) and the contracts that use it: attestation, delegation, vault, escrow and advert.

Specifications (source of truth):

- [`docs/did-vector-method.md`](../../docs/did-vector-method.md) (Part 1): identifier, record format (§5), operations, resolution.
- [`docs/IDENTITY_REGISTRY.md`](../../docs/IDENTITY_REGISTRY.md) (Part 2): contract rules (§2–§6), library (§3.10), tests (§12).

## Library

| Module | Content |
|---|---|
| `lib/vector_identity.ak` | `find_record`, `effective`, `active_key`, `independent`, `has_capability`, `controller_signed` and the shared constants (Part 2 §3.10) |
| `lib/vector_identity/types.ak` | Record types of Part 1 §5 and `Effective` |
| `lib/vector_identity/redeemers.ak` | Identity contract redeemers (Part 2 §3.1) |
| `lib/identity_marketplace/types.ak` | Attestation, delegation, vault, escrow and advert types (Part 2 §4–§6) |
| `lib/identity_marketplace/common.ak` | Validity window, signatures, exact addresses, values, transaction scope |
| `lib/identity_marketplace/cbor_fixtures.ak` | Test-only CBOR fixtures (see [`fixtures/README.md`](fixtures/README.md)) |

The module contracts (`vector-agent-modules`) vendor `lib/vector_identity.ak` and `lib/vector_identity/` unchanged. These files must compile with aiken-lang/stdlib v3.0.0 and v3.1.0.

The legacy escrow and advert blueprints stay in `contracts/marketplace/`.

## Build and test

```sh
aiken check -D
aiken build
```

Aiken v1.1.21, Plutus V3, aiken-lang/stdlib v3.1.0.
