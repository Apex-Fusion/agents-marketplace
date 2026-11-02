# apex-fusion/identity-marketplace

Aiken project for the Vector identity registry (`did:vector`) and the contracts that use it: attestation, delegation, vault, escrow and advert.

Specifications (source of truth):

- [`docs/did-vector-method.md`](../../docs/did-vector-method.md) (Part 1): identifier, record format (§5), operations, resolution.
- [`docs/IDENTITY_REGISTRY.md`](../../docs/IDENTITY_REGISTRY.md) (Part 2): contract rules (§2–§6), library (§3.10), tests (§12).

## Validators

| Validator | File | Purposes | Parameters | Part 2 |
|---|---|---|---|---|
| `identity` | `validators/identity.ak` | mint, spend | `legacy_hash`, `legacy_root`, `config_policy`, `config_holder` | §3 |
| `config_holder` | `validators/config.ak` | spend (always fails) | — | §3.8 |
| `config_seal` | `validators/config.ak` | mint (one use) | `seed`, `config_holder` | §3.8 |
| `attestation` | `validators/attestation.ak` | mint, spend | `identity_hash` | §4 |
| `delegation` | `validators/delegation.ak` | mint, spend | `identity_hash` | §5.2 |
| `vault` | `validators/vault.ak` | spend | `identity_hash`, `delegation_hash`, `escrow_hash` | §5.3 |
| `escrow` (new) | `validators/escrow.ak` | spend | `identity_hash` | §6.1 |
| `advert` (new) | `validators/advert.ak` | spend | — | §6.2 |

Each validator has an `else` handler that fails every other purpose (§3.9). `plutus.json` is the blueprint of these 8 validators without parameters. The parameters are deployment values: see the §2 table and the deployment order in §3.8. Part 2 §2 also lists Module-1 `identity_party` and the new Module-1, Module-3 and Module-6 deployments. They are in the `vector-agent-modules` repository.

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

From `contracts/identity-marketplace`:

```sh
aiken check -D                      # every Aiken test, with the property tests; a warning fails
aiken build                         # writes plutus.json
git diff --exit-code plutus.json    # the committed blueprint must equal the build
```

Aiken v1.1.21, Plutus V3, aiken-lang/stdlib v3.1.0, aiken-lang/fuzz v2.2.0.

These suites run the compiled scripts with `aiken tx simulate`. Run them from the repository root after `pnpm install`. They need `aiken` v1.1.21 on PATH and no network:

```sh
npx vitest run --config tests/legacy-registry/vitest.config.ts     # deployed legacy registry script and adoption (§12.2)
npx vitest run --config tests/identity-builders/vitest.config.ts   # new escrow and advert with the shared builders (§6)
npx vitest run --config tests/identity-vectors/vitest.config.ts    # vectors, benchmarks, resolver properties (§12.3, §12.4)
```

The root `pnpm test` also needs `aiken`: `tests/unit/identity-tx-*.test.ts` and `tests/unit/paper2agent-identity-e2e.test.ts` evaluate builder transactions. CI (`.github/workflows/ci.yml`) installs the pinned aiken release (`.github/actions/setup-aiken`) and runs all of the commands above.

## Benchmarks, vectors and properties

| Folder | Content | Run | Regenerate |
|---|---|---|---|
| `bench/` | The benchmarks of §12.4: complete signed transactions with the applied scripts of `plutus.json` (test parameters), evaluated with `aiken tx simulate`. `results.json` holds the execution units and sizes. | `npx vitest run --config tests/identity-vectors/vitest.config.ts` (`bench.test.ts` runs each case again and compares the result with `results.json`) | `npx tsx contracts/identity-marketplace/bench/run.ts` writes `results.json`. Do this after a change to a validator or to `plutus.json`, then commit `results.json`. |
| `vectors/` | The published vectors of §12.4: `identifiers.json`, `allowlist.json`, `attestation-envelope.json`, `status-lists.json` | `npx vitest run --config tests/identity-vectors/vitest.config.ts`, and `aiken check -D` (`published_vectors.ak`) | `npx tsx tests/identity-vectors/generate.ts` writes the vectors and `lib/identity_marketplace/properties/published_vectors.ak` (it uses `aiken fmt`). Compare each changed vector with Part 1 and Part 2 before you commit it. |
| `lib/identity_marketplace/properties/` | The Aiken property tests of §12.3 (aiken-lang/fuzz, 100 runs each) and the generated `published_vectors.ak` | `aiken check -D -m identity_marketplace/properties` | Only `published_vectors.ak` is generated (see `vectors/`). |
