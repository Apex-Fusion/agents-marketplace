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
| `GATEWAY_BASE_URL` | `https://id.vector.apexfusion.org` | Public HTTPS origin of the gateway (no path); the only base-URL variable. It names the `did:web` aliases, the URLs in the catalogs and the MCP server names. It is also the RFC 8414 issuer, `<base>/token` is the audience of agent JWTs, and its host is the SPIFFE trust domain. |
| `ACCESS_LOG_RETENTION` | "The operator has not published the retention time of the access log yet." | Text that `/policy` publishes on the retention of the web proxy's access log (Part 2 Section 8.1). |
| `FETCH_JOBS` | `on` | `off` stops all background fetches. Then no agent is reachable, so the catalogs and the MCP subregistry are empty. |
| `FETCH_SCAN_INTERVAL_S` | `600` | Seconds between background scans (60 to 86400). A record change starts a new check at the next scan. |
| `GATEWAY_ED25519_KEY_FILE` / `GATEWAY_P256_KEY_FILE` | none | PEM private key files of the gateway keys (Part 2 Section 8.2): PKCS#8, or SEC1 for P-256. The gateway refuses a file that its group or other users can read or write (use mode 600 or 400, owned by the container user). Set both or neither; without them the M4 services are off and agent cards answer 503. |
| `GATEWAY_VECTOR_ID` | none | The gateway's own identifier (64 hex), required with the key files. Key IDs are `did:vector:<id>#<key hash>`, and the gateway's DID issues credentials. |
| `DELEGATION_POLICY_ID` / `DELEGATION_ADDRESS` | none | The delegation contract (policy ID = script hash; the address must be its enterprise address). Without it, delegation tokens are refused. |
| `STATUS_LIST_REFRESH_SECONDS` | `60` | How long built status lists and the status-list index are used (1 to 3600). It is also the `ttl` of the lists. |

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

The gateway's own JWK set (`GET /.well-known/jwks.json`) belongs to the M4 services. The renderings
sign agent cards with the M4 Ed25519 key (`main.ts` passes `keys.ed25519` as their signer).

## M4 services (Part 2 Section 8.6)

They run when the two key files are set. Everything that they issue uses the view without options
(Part 2 Section 8.4). Errors are `{"error", "error_description"}` (RFC 6749 Section 5.2). Token,
credential and POST responses have `Cache-Control: no-store`; the JWK set, the metadata, the bundle
and the status lists are public and cacheable.

| Endpoint | Request | Response |
|---|---|---|
| `GET /.well-known/jwks.json` | | `{keys}`: the Ed25519 key (`alg` EdDSA) and the P-256 key (`alg` ES256), `use` sig, `kid` = `did:vector:<gateway id>#<key hash>`. |
| `GET /.well-known/oauth-authorization-server` | | RFC 8414 metadata: issuer, token, introspection and revocation endpoints, `private_key_jwt` with EdDSA, DPoP algorithms, the delegation `authorization_details` type. |
| `POST /token` | Form (RFC 8693): `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token` (JWT, EdDSA by an authentication key of the agent: header `kid` = the key's DID URL; `iss` = `sub` = `did:vector:<id>`; `aud` = `<base>/token`; `iat`, `exp` with `exp - iat <= 300`; single-use `jti`), `subject_token_type=urn:ietf:params:oauth:token-type:jwt`, at least one `audience` or `resource`, optional `requested_token_type`, optional RFC 7523 client assertion, optional `authorization_details` with one `{"type":"https://id.vector.apexfusion.org/ns/delegation","identifier":"<delegation id>","actions"?,"locations"?}` (`actions` and `locations`, when present, are not empty). Header `DPoP` (RFC 9449) is required; for a delegation it must be signed by the leaf's `delegate_key`. | `{access_token, issued_token_type, token_type: "DPoP", expires_in, authorization_details?}`. The token: ES256, `typ` at+jwt, `iss`, `sub`, `aud`, `iat`, `exp` (at most 5 minutes, and not after the delegation period), `jti`, `client_id`, `cnf.jkt`, `status.status_list {idx, uri}` (the entry of the requesting agent). Without a delegation, `sub` = `did:vector:<id>` of the requesting agent, and the token has no `act`. With a delegation (Part 2 Section 5.4, RFC 8693 Section 4.1): `sub` = the root delegator (`did:vector:<id>` for an agent, `<base>/principals/key/<key hash>` for a principal key); `act` = the delegates, with the requesting agent (the current actor) outermost and each earlier delegate nested inside; and `authorization_details`. |
| `POST /introspect` | Form: `token`, client assertion (required) | RFC 7662: `{active: false}`, or the claims with `active: true` and `token_type`. `sub` and `act` have the same meaning as in the token (RFC 8693 Section 4.1). Only tokens that this process issued. |
| `POST /revoke` | Form: `token`, client assertion (required) | RFC 7009: 200 with an empty body; 400 `unauthorized_client` when the client is not an agent that the token names in `sub`, `act` or `client_id`. |
| `POST /spiffe/nonce` | | `{nonce, expires_in: 300}`: single-use, valid for 5 minutes. |
| `POST /spiffe/x509-svid` | JSON `{csr, proof}`: a PKCS #10 request for a P-256 key (PEM or base64url DER) and a JWT by an authentication key (EdDSA or ES256, the agent-JWT rules) with the claims `nonce` and `cnf.jwk` = the request's public key | `{spiffe_id, x509_svid (PEM), bundle (PEM CA), expires_at}`. One URI SAN `spiffe://<host>/agent/<id>`, empty subject, 1 hour, `noRevAvail`. 403 `agent_not_active`. |
| `POST /spiffe/jwt-svid` | JSON `{subject_token, audience}` (1 to 8 audiences) | `{spiffe_id, svid, expires_at}`: ES256, 5 minutes. |
| `GET /spiffe/bundle` | | SPIFFE bundle (`https_web`): the CA certificate (`use` x509-svid, `x5c`) and the JWT-SVID key (`use` jwt-svid, `kid`), `spiffe_refresh_hint` 300. |
| `GET /status/bsl/{n}` | | `application/vc+jwt`: a BitstringStatusListCredential with `statusPurpose` [revocation, suspension]: 2 × 131,072 bits, the revocation bit of position p at p and its suspension bit at 131,072 + p. |
| `GET /status/tsl/{n}` | | `application/statuslist+jwt`: 2 bits per entry, 0 valid, 1 invalid (Revoked or Retired), 2 suspended. |
| `GET /agents/{id}/credential` | | `application/vc+jwt`: a VC 2.0 credential of the gateway's DID with the subject DID, `created`, `origin` and, for a subagent, `parent`; two `BitstringStatusListEntry` items. 409 when the agent is not Active, 410 when deactivated. |

Index i of `listRecords()` is in list n = floor(i / 131,072) at position i mod 131,072. A status
other than Active that the gateway sees (at introspection, or in the status watcher every 30 s)
revokes every token of that agent issued up to then. Replay stores, nonces and issued tokens are in
memory: a restart makes earlier tokens inactive.

A delegation token needs the whole chain to pass the use checks of Part 2 Section 5.2, as the
delegation contract applies them: each delegation is authentic, unspent and has 30 confirmations;
each delegator agent and the delegate are Active; the delegate key of the delegation and of every
ancestor link is still a listed Ed25519 key of its delegate with the delegation purpose, so the
removal of a key ends every sub-delegation that this key signed; the time is inside the period of
each delegation; and the delegation covers the requested actions and resources. An empty resource
list covers nothing. Introspection checks the chain again.

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
| Agent cards are 503 | No Ed25519 signing key is configured: set `GATEWAY_ED25519_KEY_FILE`, `GATEWAY_P256_KEY_FILE` and `GATEWAY_VECTOR_ID`. |
| The process exits with "key file … is readable by its group or by other users" | Make the key file readable only by the container user (mode 600 or 400). |
| A domain stays unverified | The TXT record must be exactly the DID (or `did=` and the DID). A DID configuration needs a JWT Domain Linkage Credential signed by a key with the assertion purpose; the JSON-LD format is not supported. The host must resolve to public addresses only. |

## Update the image

1. Build off-host (Part 2 Section 8.1): `docker build -f identity-gateway/Dockerfile -t identity-gateway:<version> .`
   from a clean checkout of the release tag.
2. Push the version tag to the registry. Do not use a `latest` tag.
3. On the host, set `IDENTITY_GATEWAY_VERSION=<version>` in `deploy/mainnet/.env` (git-ignored), then pull and restart the service with `deploy/mainnet/docker-compose.gateway-identity.yml`. Do not edit the compose file on the host: `deploy.sh` refuses to run on a changed checkout.
4. Check `GET /healthz` and resolve one native and one legacy DID.
