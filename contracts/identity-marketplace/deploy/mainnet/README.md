# Identity registry on Vector mainnet: identity side (2026-11-03)

This folder publishes the identity side of the release (Part 2 §11 step 2, [`docs/IDENTITY_REGISTRY.md`](../../../../docs/IDENTITY_REGISTRY.md)). The deployment tool in [`..`](..) wrote these files. They hold only public chain data.

| File | Content |
|---|---|
| `allowlist.json` | The cutoff slot, the legacy policy, the 794 identifiers in leaf order and the Merkle root |
| `allowlist-ids.json` | The same identifiers as a plain list, for `VECTOR_IDENTITY_ALLOWLIST_URL` of the MCP server |
| `deployment.json` | The parameters, hashes, addresses, applied scripts, reference outputs and transaction IDs |

## Values

| Value | |
|---|---|
| Identity registry policy ID (= script hash) | `d958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762` |
| Identity registry address | `addr1w8v43wprl248d9mapgrmm93zap7cuty97e5j7luw3kmhwcs8vm9vk` |
| Cutoff slot | 37,218,553 (2026-11-03T11:09:13Z) |
| Allowlist | 794 identifiers, root `e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01` |
| Configuration policy (`config_seal`) | `c6a8cd37643ec0fffab66807bb53be5903d7ecda887d8af4a085f55a` |
| Configuration holder (`config_holder`) | `288fea77a0f674c6080aadd8ed3ca42cd5a920bf1f00c0d3e63306e4` |
| Configuration seed | `6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a#0` |
| Module-1 hash (M1) | Published after the module side (the seal) |
| `attestation` | `f07c644e042ead094cc501f443e03a8955dc1f4d0dcd5b387863e042` |
| `delegation` | `bdc16990b844a8860f28c51bb0e6a469c84bebcd57db699ce204785a` |
| `escrow` | `bdd86d9ac1e6f2ef6bcf81c14522f86ada1b438ca7ae0c90c8459deb` |
| `vault` | `bd45078144effb5011f161d8bb433f2ee360da458644fca9b818097a` |
| `advert` | `f36e366e06d4480651aa0e1064578f0bfe275af96dfcaaabe5efe26c` |
| Legacy registry (parameter) | `be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01` |
| Blueprint | `contracts/identity-marketplace/plutus.json`, sha256 `9c8d948a2da12fa519b6f97286cbb8374c002b6bca7e4a3ef1a6d65cca51df3e`, Aiken v1.1.21 |

## Reference scripts

The reference outputs are at `addr1vyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkdl5mw`, the address of the zero key hash. Nobody can spend them.

| Script | Reference output |
|---|---|
| `identity` | `3d4471222e524584180a4358e05517a243effc46d15ef62443a82aaed822de46#0` |
| `attestation` | `55dfa9e05ff96844fd4313f1c7cb7f0c7f900f1cdf50099b0e2abb242da4128d#0` |
| `delegation` | `f6d47a62146b2bc4dabc12454c8a3dbbedf673d45a6edccd1c462d55c8ba8be7#0` |
| `vault` | `d0bf8f73c915fcbf57ddba714256e520a9a0820bc9e643218db8cf54762d215b#0` |
| `escrow` | `4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82#0` |
| `advert` | `5efd18a1d90a6b87f1fd4b6fe93acfbe5be082260fd52be194b1088ade7c2758#0` |

## Checks

- `cli.ts check --network mainnet` read the chain at slot 37,218,646: every reference output holds its script hash, and the seed is unspent at the seal-seed address. It reported no problem.
- The Python SDK (`apex-fusion-agent-sdk` 0.2.0, its own flat encoder) derives the same eight script hashes from the root and the seed.
- Anybody can check the root: `npx tsx contracts/identity-marketplace/deploy/cli.ts allowlist --network mainnet --cutoff-slot 37218553` rebuilds the list from Koios.
