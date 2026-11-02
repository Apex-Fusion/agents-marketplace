# identity-gateway

Resolver for `did:vector` identifiers. The method specification is
[`docs/did-vector-method.md`](../docs/did-vector-method.md) (Part 1). The implementation plan is
[`docs/IDENTITY_REGISTRY.md`](../docs/IDENTITY_REGISTRY.md) (Part 2, Section 8).

The resolver reads the identity registry and the legacy registry on Vector mainnet. It builds the
versions, the view and the effective status of a record and of its ancestors, and it returns the DID
document and the metadata of Part 1 Sections 7 and 8. Licence: Apache-2.0 (see `LICENSE`).

## Run

From the repository root:

```sh
npx -y pnpm@10.33.2 install --frozen-lockfile
npx -y pnpm@10.33.2 --filter identity-gateway dev      # tsx, listens on 127.0.0.1:8080
curl -s http://127.0.0.1:8080/1.0/identifiers/did:vector:<64 hex>
curl -s http://127.0.0.1:8080/healthz                    # 200 {"status":"ok"}, no ledger call
```

Compiled run: `npx -y pnpm@10.33.2 --filter identity-gateway build`, then
`node identity-gateway/dist/main.js`.

Docker (the build context is the repository root, because the image uses the pnpm workspace):

```sh
docker build -f identity-gateway/Dockerfile -t identity-gateway:<version> .
docker run --rm -p 8080:8080 identity-gateway:<version>
```

The image runs as the `node` user with `HOST=0.0.0.0` and `PORT=8080`. Its health check calls
`/healthz`.

## Configuration

Every variable is optional, except that a deployed identity registry needs both
`IDENTITY_POLICY_ID` and `CUTOFF_SLOT`.

| Variable | Default | Use |
|---|---|---|
| `IDENTITY_POLICY_ID` | none | Policy ID (script hash) of the identity registry. Published at deployment. Without it, no identifier is an identity-registry record. |
| `IDENTITY_ADDRESS` | the enterprise address of `IDENTITY_POLICY_ID` | Must equal that address. The resolver refuses to start otherwise. |
| `CUTOFF_SLOT` | none | Legacy identifiers minted in this slot or later resolve as `NOT_FOUND`. From this slot on, legacy records are Suspended (`unaccountable`). Without it, no cutoff applies. |
| `LEGACY_POLICY_ID` | `be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01` | Policy ID of the legacy registry. |
| `LEGACY_ADDRESS` | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` | Must be the enterprise address of `LEGACY_POLICY_ID`. |
| `GENESIS_NETWORK_MAGIC` | `764824073` | Expected network magic. |
| `GENESIS_SYSTEM_START` | `2025-08-29T16:40:00Z` | Expected system start (`YYYY-MM-DDThh:mm:ssZ` or POSIX seconds). Block time = system start + slot × slot length. |
| `GENESIS_SLOT_LENGTH` | `1` | Expected slot length in seconds. |
| `GENESIS_SECURITY_PARAM` | `2160` | Expected security parameter k. |
| `KOIOS_URL` | `https://v2.koios.vector.mainnet.apexfusion.org/api/v1` | Koios API root. |
| `KOIOS_TOKEN` | none | Optional Koios bearer token. Do not commit it. |
| `OGMIOS_URL` | `wss://ogmios.vector.mainnet.apexfusion.org` | Ogmios WebSocket, for vkey witnesses (legacy key search). |
| `HOST` / `PORT` | `127.0.0.1` / `8080` (the image: `0.0.0.0` / `8080`) | Listen address. |

The testnet uses the same network magic as mainnet. So the resolver compares all four genesis values
with the values that Koios reports (`/genesis`). If one differs, every resolution is
`INTERNAL_ERROR`, and the next request checks again.

## HTTPS binding (Part 1 Section 7.4)

- `GET /1.0/identifiers/{did}`. The resolver percent-decodes the path once. Query parameters are the
  options `versionId`, `versionTime`, `expandRelativeUrls` and `noCache`. Another parameter is
  `FEATURE_NOT_SUPPORTED`; a bad value, a repeated option or both version options is
  `INVALID_OPTIONS`.
- `Accept` (RFC 9110, q-values): the resolution result (`application/did-resolution`) or the
  document only (`application/did`). On a tie, the result wins. Errors and deactivated DIDs always
  get the result.
- The body is the JCS (RFC 8785) serialisation. Every response has `Cache-Control: no-store`.
- Status: 200 found (also Suspended), 410 `deactivated: true`, 400 `INVALID_DID` /
  `INVALID_OPTIONS`, 404 `NOT_FOUND`, 406 `REPRESENTATION_NOT_SUPPORTED`, 501
  `METHOD_NOT_SUPPORTED` / `FEATURE_NOT_SUPPORTED`, 500 `INTERNAL_ERROR`.
- `GET /healthz` answers 200 and reads nothing from the ledger.

The gateway writes no request log. It logs errors without the requested DID.

## Internal API

`src/index.ts` exports the resolver core for the gateway services:

- `new VectorResolver(chain, settings, options?)`;
- `resolveDid(did, options?)`: the resolution result; it never throws;
- `currentRecord(vectorId)`: the view and the effective status without options (Part 2 Section 8.4);
- `listRecords()`: every identifier that resolves, in the ledger order of its first mint, with its
  status-list index (Part 2 Section 8.6).

## Chain data

Koios supplies the asset histories, the transactions (with inline datum bytes), datums by hash,
blocks, the policy asset index and the genesis values. Koios on Vector exposes no witnesses, so the
legacy key search reads blocks through Ogmios chain synchronisation. The resolver depends only on the
`ChainSource` interface (`src/chain/types.ts`).

Each resolution reads the tip first and ignores transactions in later blocks. A record history is
kept while the tip stays the same.

## Tests and vectors

```sh
npx vitest run identity-gateway/          # from the repository root
(cd identity-gateway && npx tsc --noEmit)
```

`test/vectors/*.json` are the published DID-document vectors (Part 2 Section 12.4). Each file holds
the settings, a ledger, the requests and the expected results. To change them, edit
`test/vectors/scenarios.ts`, run `npx tsx identity-gateway/test/vectors/generate.ts`, and check every
changed result against Part 1. `test/golden-cbor.test.ts` checks the codecs against the CBOR fixtures
of `contracts/identity-marketplace/fixtures/`.

## Troubleshooting

| Symptom | Cause and action |
|---|---|
| Every request is 500 `INTERNAL_ERROR` | The log line names the failed read. Koios or Ogmios is down or slow, or the genesis values differ from the configuration (wrong `KOIOS_URL`, or testnet). |
| Legacy DIDs have no keys and `controllerKeyNotFound` | No vkey witness of the record's own token transactions has the owner hash (Part 1 Section 8.1). The key appears after the owner key signs a transaction of the record. |
| 500 only for legacy DIDs | Ogmios is not reachable from the container. Check `OGMIOS_URL`. |
| `NOT_FOUND` for a new record | A version shows after 30 confirmations. Wait, or check the mint with Koios. |
| The process exits at start | A configuration value is invalid; the message names it (for example `IDENTITY_ADDRESS` that is not the address of `IDENTITY_POLICY_ID`). |

## Update the image

1. Build off-host (Part 2 Section 8.1): `docker build -f identity-gateway/Dockerfile -t identity-gateway:<version> .`
   from a clean checkout of the release tag.
2. Push the version tag to the registry. Do not use a `latest` tag.
3. On the host, set the new tag in the compose file, pull, and restart the service.
4. Check `GET /healthz` and resolve one native and one legacy DID.
