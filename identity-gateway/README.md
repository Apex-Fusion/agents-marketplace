# identity-gateway

Resolver for `did:vector` identifiers (method spec `2026-10-27-did-vector-method-spec-v2.md`).
Milestone M0 resolves **generation-1 (legacy) records on Vector mainnet only**. No generation-2
registry exists yet.

## Run

```sh
pnpm --filter identity-gateway start        # listens on 127.0.0.1:8080
curl http://127.0.0.1:8080/1.0/identifiers/did:vector:<64 hex>
```

| Variable | Default | Use |
|---|---|---|
| `KOIOS_URL` | `https://v2.koios.vector.mainnet.apexfusion.org/api/v1` | Koios API root |
| `KOIOS_TOKEN` | none | Optional Koios bearer token. Do not commit it. |
| `OGMIOS_URL` | `wss://ogmios.vector.mainnet.apexfusion.org` | Ogmios WebSocket, for block contents |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address |

Tests: `pnpm --filter identity-gateway test` (also part of the root `pnpm test`). Type check:
`pnpm --filter identity-gateway typecheck`.

## HTTPS binding

`GET /1.0/identifiers/{did}` (the DID may be percent-encoded). The body is the JCS (RFC 8785)
serialisation of the result.

- `Accept` absent, `*/*`, `application/did-resolution`, `application/ld+json`: the complete resolution
  result, `Content-Type: application/did-resolution`.
- `Accept: application/did` (or `application/did+ld+json`, `application/did+json`): the DID document
  only, `Content-Type: application/did`.

| Outcome | Status |
|---|---|
| Resolved | 200 |
| Token burned (legacy deregistration) | 410, minimal document, `deactivated: true` |
| Never minted; token not held by an authentic record; legacy DID with another policy | 404 `NOT_FOUND` |
| Malformed DID, uppercase hex, unknown network | 400 `INVALID_DID` |
| Other DID method | 501 `METHOD_NOT_SUPPORTED` |
| `did:vector:testnet:...`, any query option (`versionId`, `versionTime`, ...) | 501 `FEATURE_NOT_SUPPORTED` |
| Unsupported `Accept` | 406 `REPRESENTATION_NOT_SUPPORTED` |
| Koios or Ogmios failure | 500 `INTERNAL_ERROR` (cause written to stderr) |

## What a legacy document contains (method spec 6.5)

- `id` is the DID as requested; `canonicalId` is `did:vector:<asset name>`.
- The controller key `#c0` (Ed25519 Multikey) is listed under `capabilityInvocation` and
  `authentication`. It is the key of a vkey witness whose blake2b-224 hash is the record's owner
  hash. With no such witness, there is no verification method and `vectorMetadataError` is set
  (`controllerKeyNotFound`, `controllerIsScript`, `recordDatumInvalid`, `recordDatumUnavailable`).
- The self-declared v1 fields (name, description, capabilities, framework, endpoint) are not rendered.
- Metadata: `created`, `updated`, `versionId`, `canonicalId`, `vectorOrigin: "legacy"`,
  `vectorStatus` (`active`), `vectorLedger` (`txId`, `outputIndex`, `blockHash`, `blockHeight`,
  `slot`, `confirmations`).

## Chain data

Koios supplies the indexes (asset history, unspent outputs, transactions, payment-credential
history, block hashes). Koios on Vector stores no transaction bytes and shows no witnesses, so the
vkey witnesses come from the block itself, read through Ogmios chain synchronisation. The resolver
uses the `ChainSource` interface (`src/chain/types.ts`) and does not depend on either service.

## M0 limits

- Mainnet, generation 1, current version only. Generation-2 rules (adoption, the generation-2
  deployment slot, `unaccountable` suspension of legacy records) are not implemented.
- `versionId` is the number of transactions that spent and recreated the record since the mint. The
  v1 datum has no version field.
- The witness search covers the blocks of the record's own transactions and of every transaction
  that spends from or pays to an address with the owner hash as payment credential. A key that signed
  only elsewhere is not found.
- `confirmations` is the tip height minus the block height (0 for a transaction in the tip block).
- Asymmetric acceptance (method spec 8.2) and signed results are not implemented.
