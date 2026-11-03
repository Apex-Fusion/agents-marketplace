# Identity deployment tool

This tool deploys the identity side of the identity registry release (Part 2 §11 step 2, [`docs/IDENTITY_REGISTRY.md`](../../../docs/IDENTITY_REGISTRY.md)). The Module-1, Module-3 and Module-6 steps are in the module tool of `vector-agent-modules`.

Run every command from the repository root, after `pnpm install`:

```sh
npx tsx contracts/identity-marketplace/deploy/cli.ts <command> --network mainnet [options]
```

## Rules

- **Network.** Each command except `sign` needs `--network mainnet|testnet`. The tool compares the system start of Ogmios and Koios with the network. A different value stops the run.
- **Endpoints.** Mainnet defaults: Ogmios `https://ogmios.vector.mainnet.apexfusion.org`, submit API `https://submit.vector.mainnet.apexfusion.org/api/submit/tx`, Koios `https://v2.koios.vector.mainnet.apexfusion.org/api/v1`. The flags `--ogmios`, `--submit-url` and `--koios` override them. The environment variables `VECTOR_OGMIOS_URL`, `VECTOR_SUBMIT_URL`, `VECTOR_KOIOS_URL` and `VECTOR_KOIOS_TOKEN` also override them. Flags have priority.
- **Dry run.** A transaction command (`seed`, `publish-refs`, `seal`) builds each transaction and evaluates it with Ogmios `evaluateTransaction`. Then it builds the transaction again with the measured execution units plus 10 %. It prints the fee and min-UTxO table. It sends nothing.
- **Submit.** `--skey <file>` signs (`--seed-skey` for the seal). `--submit` sends, after the table. The tool waits up to 180 s for the result (`--wait <seconds>`, 0: no wait).
- **Build mode.** `--build` writes unsigned transactions to `<state dir>/tx/<step>.unsigned.json`. `sign --tx <file> --skey <file>` signs a file offline. `submit --tx <signed file> --submit` sends it. Without `--submit`, `submit` only checks the file and the signatures.
- **Keys.** A key is a cardano-cli TextEnvelope file (`PaymentSigningKeyShelley_ed25519`) or a file with 64 hex characters. The tool reads a key only from its path. It never prints, logs or copies a key.
- **State.** The state directory is `contracts/identity-marketplace/deploy/state/<network>/` (`--dir` sets another one). Git ignores it.
- **Resume.** Each submitted step records its transaction ID in `deployment.json`. Each command first reads the chain. When the chain shows the result of a step, the step is skipped and recorded. When a recorded transaction is not on chain, the run stops. Wait until the transaction is on chain, or use `--rebuild`.
- **Protocol parameters** come from Ogmios on each run, with the Plutus V3 cost model.
- **Seal-seed guard.** Only the seal spends from the seal-seed key. The other commands take inputs only from the operator address. They refuse an operator address with the seal-seed key, and they refuse a built transaction that needs the seal-seed signature.

## Keys of the release

| Key | Use |
|---|---|
| Operator key | It pays the seed payment and the reference scripts, and it gets the change of the seal. It is also the Module-1 oracle key and the key of the refs-token policy (module tool). |
| Seal-seed key | Its address holds only the config seed. Only the seal spends it. |

Keep both keys outside the repository. `keygen --out <dir> --network mainnet --name <name>` makes a new key pair (`<name>.skey`, mode 600, and `<name>.vkey`). It prints only the address and the key hash. It never replaces a file.

## Release order

The identity-side reference scripts go on chain before Module-1 and the seal, because the seal waits for the Module-1 deployment.

| Step | Command | Result |
|---|---|---|
| 1 | `allowlist --cutoff now` (or `--cutoff-slot <slot>`) | cutoff slot, `allowlist.json`, `allowlist-ids.json` |
| 2 | `seed --skey <operator.skey> --to <seal-seed address> --amount 5 --submit` | config seed at the seal-seed address |
| 3 | `plan --skey <operator.skey>` | `deployment.json`: hashes, addresses, applied scripts; cost table |
| 4 | `publish-refs --skey <operator.skey> --submit` | six reference outputs (`refs`) |
| 5 | `check` | seal: "not yet" |
| 6 | Module tool: Module-1 plan | Module-1 manifest with `hashes.identity_party` (M1) |
| 7 | `seal --module1-manifest <manifest> --seed-skey <seal-seed.skey> --submit` | configuration record with M1 |
| 8 | Module tool: `check-seal`; then `check --module1-manifest <manifest>` | M1 on chain equals the manifest |
| 9 | Module tool: Module-1 on-chain steps, Module-3, Module-6 | |
| 10 | `check --module1-manifest <manifest>` | Part 1 §4 values and the env snippet |

Do each step first without `--submit` (dry run). Read the table. Then add `--submit`.

## Commands

### allowlist

```sh
cli.ts allowlist --network mainnet --cutoff now
```

- **Input:** the legacy registry policy `be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01` (mainnet; `--legacy-policy` on testnet) and Koios.
- **Rule:** the list holds every token name of the policy whose first mint is in a slot before the cutoff. Burned names stay in the list (Part 2 §9.1). Koios `asset_list` gives every name. Koios `policy_asset_info` gives the time of the first mint. For a name that this cache does not have yet, `asset_txs` gives it. `--cutoff now` uses the Koios tip. An explicit cutoff must not be after the Koios tip plus one slot.
- **Output:** `allowlist.json` with `cutoff_slot`, `policy`, `count`, `ids` and `root`. The `ids` are in leaf order (sorted by blake2b_256 of the identifier). The root comes from `buildAllowlistTree` of `packages/shared/src/identity/allowlist.ts`. `allowlist-ids.json` is the plain list for `VECTOR_IDENTITY_ALLOWLIST_URL` of the MCP server.
- **Check:** after a plan, a new cutoff needs a new state directory.

### seed

```sh
cli.ts seed --network mainnet --skey <operator.skey> --to <seal-seed address> --amount 5
```

- A plain payment from the operator with exactly one output at the seal-seed address (output 0). The rest goes back to the operator.
- The amount must be at least 3 AP3X. The seal pays the configuration record, its fee, the collateral and a change output from the seed alone.
- The tool refuses when the seal-seed address already holds outputs. Then use one of them with `plan --seed <ref>`.
- **Output:** `config_seed` and `steps.seed`.

### plan

```sh
cli.ts plan --network mainnet --skey <operator.skey> [--seed <txid#ix>] [--seed-address <address>] [--allowlist <file>]
```

- It checks that the seed is an unspent output at the seal-seed address. `--no-seed-check` skips the check, for cost estimates with a made-up seed only.
- It applies the parameters in the contract order: `config_holder`; `config_seal(seed, config_holder)`; `identity(legacy_hash, legacy_root, config_policy, config_holder)`; `attestation`, `delegation` and `escrow` (identity hash); `vault(identity, delegation, escrow)`; `advert`. It uses `apply_params_to_script` of `@lucid-evolution/uplc`, as the MCP server and both SDKs do. A test compares every script with `aiken blueprint apply`.
- **Output:** `deployment.json` and the cost table of the steps that are not done. Stand-ins replace unknown values (the table says which).
- A new plan replaces the old plan only when nothing of the old plan is on chain.

### publish-refs

```sh
cli.ts publish-refs --network mainnet --skey <operator.skey> [--scripts identity,attestation,delegation,vault,escrow,advert] [--to <address>]
```

- One transaction per script, with one reference output of the ledger minimum (`buildPublishReferenceScripts` of `@marketplace/shared/tx/server`, the only publisher; `supplier/src/cli/publish-reference-scripts.ts` uses it too).
- The default address is the enterprise address of the zero key hash: `addr1vyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkdl5mw`. Nobody can spend it.
- Each transaction spends the change of the one before, so the list is valid before the first one is on chain.
- `config_seal` and `config_holder` get no reference output.
- Before `--submit` or `--build`, the config seed must be unspent at the seal-seed address.
- **Output:** `refs.<name>` = `<txid>#0` and `steps.publish-<name>`.

### seal

```sh
cli.ts seal --network mainnet --module1-manifest <manifest> --seed-skey <seal-seed.skey>
```

- It reads `hashes.identity_party` (M1) and `identity.{identity_hash, config_policy, config_holder}` (and `identity.identity_ref`, when set) of the Module-1 manifest. It refuses a malformed M1 and any difference from the plan.
- It builds the seal with `buildConfigSeal`. The transaction spends only the seed. The seed is also the collateral. The `identity-config` token goes to the exact `config_holder` address with the inline datum M1. The change goes to the operator.
- **Output:** `seal` = `{tx, module1_hash, config_record}` and `steps.seal`.

### check (read-only)

```sh
cli.ts check --network mainnet [--module1-manifest <manifest>]
```

- The config seed: unspent at the seal-seed address before the seal.
- Each recorded reference output: on chain, at the reference address, with the expected script hash.
- The configuration record: the token and the inline datum M1 at the exact `config_holder` address; M1 equals `hashes.identity_party` of the manifest. Before the seal it says "not yet".
- The Part 1 §4 values: policy ID, address, cutoff slot, allowlist and root, configuration policy, M1.
- An env snippet with the names of each consumer: the marketplace services (`IDENTITY_POLICY_ID`, `IDENTITY_REF_UTXO`, `IDENTITY_ESCROW_REF_UTXO`, `IDENTITY_ADVERT_REF_UTXO`), the identity gateway (`IDENTITY_POLICY_ID`, `IDENTITY_ADDRESS`, `CUTOFF_SLOT`, `DELEGATION_POLICY_ID`, `DELEGATION_ADDRESS`), the indexer (`IDENTITY_ADDRESS`, `IDENTITY_ADVERT_SCRIPT_ADDRESS`, `IDENTITY_ESCROW_SCRIPT_ADDRESS`), the MCP server (`VECTOR_IDENTITY_*`), both SDKs (`VECTOR_IDENTITY_*`, `VECTOR_*_REF_UTXO`, `VECTOR_IDENTITY_CONFIG_UTXO`) and the Module-6 client (`VECTOR_MODULE6_IDENTITY_HASH`).
- Exit status 1 when a published value is wrong or missing.

## deployment.json

| Key | Written by | Value |
|---|---|---|
| `format`, `network`, `network_id` | first command | `vector-identity-deployment/1`; network ID 1 on both Vector networks |
| `cutoff_slot`, `legacy_hash`, `legacy_root`, `allowlist` | `allowlist` | `allowlist` = `{file, count, sha256}` |
| `operator_address`, `seal_seed_address`, `config_seed` | `seed`, `plan` | `config_seed` = `<txid>#<ix>` |
| `config_holder`, `config_holder_address`, `config_policy`, `identity_hash`, `identity_address`, `attestation_hash`, `delegation_hash`, `escrow_hash`, `vault_hash`, `advert_hash`, `reference_address`, `blueprint`, `scripts` | `plan` | `scripts.<name>` = `{title, parameters, hash, address, size, compiled_code}` |
| `refs` | `publish-refs` | name → `<txid>#<ix>` |
| `seal` | `seal` | `null`, then `{tx, module1_hash, config_record}` |
| `steps`, `pending` | each transaction | step → `{tx, time}`; build mode: step → `{tx, file, built, signers}` |

The module tool reads `identity_hash`, `config_policy`, `config_holder`, `refs.identity`, `reference_address`, `operator_address`, `seal_seed_address` and `config_seed`. It never spends the config seed.

## Costs

The tool computed this table in a dry run on mainnet (`plan --no-seed-check` with a made-up seed, slot 37,178,810, 2026-11-03). The protocol parameters were 45 per byte plus 156,253, and 4,310 per UTxO byte. One stand-in wallet output paid each transaction. Values are AP3X.

| Step | Bytes | Fee | Min-UTxO (locked for good) |
|---|---:|---:|---:|
| seed (5 AP3X to the seal-seed address) | 250 | 0.167503 | — |
| publish-identity | 13,968 | 0.784813 | 59.982270 |
| publish-attestation | 7,495 | 0.493528 | 32.083640 |
| publish-delegation | 7,342 | 0.486643 | 31.424210 |
| publish-vault | 7,193 | 0.479938 | 30.782020 |
| publish-escrow | 6,347 | 0.441868 | 27.135760 |
| publish-advert | 1,285 | 0.214078 | 5.318540 |
| seal (paid from the seed) | 1,240 | 0.220939 | 1.232660 |
| **Total** | | **3.289310** | **187.959100** |

The release spends 191.248410 AP3X for good. The seed must hold at least 2.311289 AP3X; the change of the seal goes back to the operator. More wallet inputs add about 0.0018 AP3X of fee each.

## Tests

```sh
npx tsc -p tests/identity-deploy/tsconfig.json
npx vitest run --config tests/identity-deploy/vitest.config.ts
```

The tests need `aiken` v1.1.21 on PATH and no network. They compare the plan with `aiken blueprint apply`, run the seed, publish and seal transactions through `aiken tx simulate` (`evaluateBuiltTx` of `tests/legacy-registry/harness/identity.ts`), compare the allowlist roots with `vectors/allowlist.json`, and run the whole release over an in-memory ledger (resume, build mode, seal-seed guard).
