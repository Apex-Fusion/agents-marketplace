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
| `GATEWAY_BASE_URL` | `https://id.vector.apexfusion.org` | Public HTTPS origin of the gateway (no path). It names the `did:web` aliases, the URLs in the catalogs and the MCP server names. |
| `ACCESS_LOG_RETENTION` | "The operator has not published the retention time of the access log yet." | Text that `/policy` publishes on the retention of the web proxy's access log (Part 2 Section 8.1). |
| `FETCH_JOBS` | `on` | `off` stops all background fetches. Then no agent is reachable, so the catalogs and the MCP subregistry are empty. |
| `FETCH_SCAN_INTERVAL_S` | `600` | Seconds between background scans (60 to 86400). A record change starts a new check at the next scan. |

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

## Renderings (Part 2 Section 8.5)

Every rendering uses the view without options (Part 2 Section 8.4): the on-chain profile, the
detected protocol and the listed keys. Bodies are JSON in JCS member order. Every response has
`Cache-Control: no-store` and `Access-Control-Allow-Origin: *`. `HEAD` and the CORS preflight
(`OPTIONS`) also work. An error is `{"error": "<text>"}`: 404 when the identifier does not resolve or
the agent does not qualify, 410 when the DID is deactivated, 500 when the ledger read fails.

| Path | For | Body |
|---|---|---|
| `GET /agents/{id}/did.json` | Active agents (also subagents) | `did:web` alias document, `application/did+json`: `id` = `did:web:<host>:agents:{id}`, `alsoKnownAs` = the `did:vector` DID, then the verified domains; the keys and relationships of the `did:vector` document with absolute DID URLs. |
| `GET /agents/{id}/jwks.json` | Active agents | `application/jwk-set+json` `{keys}`: each listed key (a P-256 key only with a valid proof) as a JWK with `kid` = `did:vector:{id}#<key hash>`, `alg` `EdDSA` or `ES256`, `use` `sig`. A legacy record shows the key that the legacy key search found. |
| `GET /agents/{id}/agent-card.json` | Listed A2A agents | A2A v1.0 agent card: on-chain name and description, the interfaces on the endpoint's origin and the default modes from the detected card, the on-chain capabilities as skills, `version` = versionId, `documentationUrl` = the resolution URL of the DID, `provider` = a verified organisation. Signed as A2A Section 8.4 specifies (JWS over the JCS form, `alg` EdDSA, `typ` JOSE, `kid`, `jku` = `/.well-known/jwks.json`). 503 when no signing key is configured. `application/a2a-agent-card+json` when the client asks for it, else `application/json`. |
| `GET /agents/{id}/server-card` | Listed MCP agents | MCP Server Card v1 (SEP-2127): `name` = `<reverse gateway host>/{id}`, description of at most 100 characters, `remotes` = the endpoint with the protocol versions it named, `_meta` with the DID. |
| `GET /v0/servers`, `GET /v0.1/servers` | Listed MCP agents | MCP Registry list `{servers: [{server, _meta}], metadata: {count, nextCursor?}}` with server.json entries (schema 2025-12-11). Query: `limit` (1-100, default 30), `cursor`, `search` (name substring), `version` (`latest` or exact), `updated_since` (RFC 3339). |
| `GET /.well-known/ai-catalog.json` | Listed A2A and MCP agents | AI Catalog 1.0, `application/ai-catalog+json`: one entry per agent, `identifier` = `urn:air:<gateway host>:agent:{id}`, `type` and `url` of its agent card or server card, `tags` = capabilities, `updatedAt`. |
| `GET /.well-known/ard.json` | Listed A2A and MCP agents | ARD v0.91 manifest `{entries}` with `displayName`, `description`, `capabilities` and `metadata {did, protocol}`. |
| `GET /agents/{id}/oasf.json` | Listed agents | OASF record (schema 1.1.0): profile, `skills` mapped from known capability names, the endpoint as `url` locator, `annotations` with the DID, the protocol and the capabilities. |
| `GET /agents/{id}/registration.json` | Listed agents | ERC-8004 registration file: `services` (A2A, MCP or web, then OASF and DID), `active`, `registrations [{agentId, agentRegistry}]`. `agentId` is the identifier as a decimal integer (78 digits at most, so read it with a big-integer JSON reader). `agentRegistry` is `vector:mainnet:<identity policy>`, or the legacy policy for a legacy record. |
| `GET /policy` | | The listing rule, the fetch rules, the confirmation rule, the request-log statement, `ACCESS_LOG_RETENTION` and the limits as numbers. |

The gateway's own JWK set (`GET /.well-known/jwks.json`) belongs to the M4 services.

**Listing rule (Part 2 Section 8.4).** The catalogs and the MCP subregistry list an agent only when
it is independent (lineage Root), its effective status without options is Active, and the last
detection of its current endpoint succeeded. The catalogs read the records of the last background
scan; the per-agent renderings read the record at the current tip.

## Background jobs (Part 1 Section 9, Part 2 Sections 8.5 and 8.6)

A scan runs at start and every `FETCH_SCAN_INTERVAL_S`. It reads the current record of every
identifier and starts a check for each Active record that has no facts yet, that changed (a new base
or pending version), or whose facts are a day old. Requests never fetch: they read the stored facts,
and a fact counts only while its inputs still apply (the same endpoint, a domain that the record
still names, a signing key that is still an assertion key).

- **Protocol detection:** A2A (`<endpoint origin>/.well-known/agent-card.json` is a valid agent card
  with an interface on that origin), then MCP (`server/discover` of revision 2026-07-28, then
  `initialize` of revision 2025-11-25), then web (a GET of the endpoint answers 2xx). The endpoint is
  reachable when one check succeeds.
- **Domain linkage:** the endpoint host and each party organisation that is a domain. A DNS TXT
  record `_did.<domain>` with the DID (or `did=` and the DID), or a Domain Linkage Credential in
  `https://<domain>/.well-known/did-configuration.json` (JWT format, EdDSA or ES256, signed by an
  assertion key of the DID). Verified domains go to `alsoKnownAs`; a verified organisation gets
  `organisationVerified`.
- **Fetch rules:** `https` only; every address of the host must be public unicast, checked for each
  connection and each redirect, and the connection goes to the checked address; no redirect to
  another host or port; at most 5 redirects, 1 MiB and 10 seconds; at most one fetch per host each
  minute.
- The resolver shows the results in `vectorFetched` (URL, fetch time, SHA-256 of the bytes; a DNS
  check has the URL `dns:_did.<domain>?type=TXT`).

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
| An agent is not in the catalogs, or its card is 404 "not listed (…)" | The reason names the failed condition of the listing rule (`notIndependent`, `notActive`, `notReachable`). For `notReachable`: the last detection failed, or the endpoint changed and the next scan has not checked it yet. Resolve the DID: `vectorProfile.protocol` and `vectorFetched` show the last successful detection. A host gets at most one fetch each minute, so a check of many agents on one host takes minutes. |
| A web agent is not in the catalogs | The AI Catalog and ARD formats list A2A agent cards and MCP server cards only. Its other renderings (`did.json`, `oasf.json`, `registration.json`) work. |
| Agent cards are 503 | No Ed25519 signing key is configured for the renderings. |
| A domain stays unverified | The TXT record must be exactly the DID (or `did=` and the DID). A DID configuration needs a JWT Domain Linkage Credential signed by a key with the assertion purpose; the JSON-LD format is not supported. The host must resolve to public addresses only. |

## Update the image

1. Build off-host (Part 2 Section 8.1): `docker build -f identity-gateway/Dockerfile -t identity-gateway:<version> .`
   from a clean checkout of the release tag.
2. Push the version tag to the registry. Do not use a `latest` tag.
3. On the host, set the new tag in the compose file, pull, and restart the service.
4. Check `GET /healthz` and resolve one native and one legacy DID.
