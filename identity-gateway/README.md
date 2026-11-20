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
| `IDENTITY_POLICY_ID` | none | Policy ID (script hash) of the identity registry. Published at deployment. Without it, no identifier is an identity-registry record. Mainnet: `d958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762`. |
| `IDENTITY_ADDRESS` | the enterprise address of `IDENTITY_POLICY_ID` | Must equal that address. The resolver refuses to start otherwise. Mainnet: `addr1w8v43wprl248d9mapgrmm93zap7cuty97e5j7luw3kmhwcs8vm9vk`. |
| `CUTOFF_SLOT` | none | Legacy identifiers minted in this slot or later resolve as `NOT_FOUND`. From this slot on, legacy records are Suspended (`unaccountable`). Without it, no cutoff applies. Mainnet: `37218553`. |
| `LEGACY_POLICY_ID` | `be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01` | Policy ID of the legacy registry. |
| `LEGACY_ADDRESS` | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` | Must be the enterprise address of `LEGACY_POLICY_ID`. |
| `GENESIS_NETWORK_MAGIC` | `764824073` | Expected network magic. |
| `GENESIS_SYSTEM_START` | `2025-08-29T16:40:00Z` | Expected system start (`YYYY-MM-DDThh:mm:ssZ` or POSIX seconds). Block time = system start + slot × slot length. |
| `GENESIS_SLOT_LENGTH` | `1` | Expected slot length in seconds. |
| `GENESIS_SECURITY_PARAM` | `2160` | Expected security parameter k. |
| `KOIOS_URL` | `https://v2.koios.vector.mainnet.apexfusion.org/api/v1` | Koios API root. |
| `KOIOS_TOKEN` | none | Optional Koios bearer token. Do not commit it. |
| `KOIOS_RATE_PER_SECOND` | `10` | Koios calls per second on average, in bursts of at most twice as many (1 to 100). The Koios of Vector refuses a client above about 300 requests in 10 s (see "Chain data"). |
| `OGMIOS_URL` | `wss://ogmios.vector.mainnet.apexfusion.org` | Ogmios WebSocket, for vkey witnesses (legacy key search). |
| `HOST` / `PORT` | `127.0.0.1` / `8080` (the image: `0.0.0.0` / `8080`) | Listen address. |
| `GATEWAY_BASE_URL` | `https://id.vector.apexfusion.org` | Public HTTPS origin of the gateway (no path); the only base-URL variable. It names the `did:web` aliases, the URLs in the catalogs and the MCP server names. It is also the RFC 8414 issuer, `<base>/token` is the audience of agent JWTs, and its host is the SPIFFE trust domain. |
| `ACCESS_LOG_RETENTION` | "The operator has not published the retention time of the access log yet." | Text that `/policy` publishes on the retention of the web proxy's access log (Part 2 Section 8.1). |
| `FETCH_JOBS` | `on` | `off` stops all background fetches. Then no agent is reachable, so the catalogs and the MCP subregistry are empty. |
| `FETCH_SCAN_INTERVAL_S` | `600` | Seconds between background scans (60 to 86400). A record change starts a new check at the next scan. |
| `GATEWAY_ED25519_KEY_FILE` / `GATEWAY_P256_KEY_FILE` | none | PEM private key files of the gateway keys (Part 2 Section 8.2): PKCS#8, or SEC1 for P-256. The gateway refuses a file that its group or other users can read or write (use mode 600 or 400, owned by the container user). Set both or neither; without them the M4 services are off and agent cards answer 503. |
| `GATEWAY_VECTOR_ID` | none | The gateway's own identifier (64 hex), required with the key files. Key IDs are `did:vector:<id>#<key hash>`, and the gateway's DID issues credentials. |
| `DELEGATION_POLICY_ID` / `DELEGATION_ADDRESS` | none | The delegation contract (policy ID = script hash; the address must be its enterprise address). Without it, delegation tokens are refused. Mainnet: `bdc16990b844a8860f28c51bb0e6a469c84bebcd57db699ce204785a` / `addr1wx7uz6vshpz23ps09rz3hv8x535usjlte4tak6vuugz8sks9wdc5c`. |
| `STATUS_LIST_REFRESH_SECONDS` | `60` | How old the status lists and the status-list index are before a request builds them again (1 to 2400). The age counts from the last read of the chain, by a build or a follow step. For the lists, the limit is the longer of this value and two follow intervals. It is also the `ttl` of the lists, and the longest `max-age` of a list response. |
| `STATUS_LIST_BACKGROUND_REFRESH_SECONDS` | `600` | How long after the end of a full build the timer starts the next full build, with no request (60 to 2400, and not below `STATUS_LIST_REFRESH_SECONDS`). The gateway refuses a value that breaks the timing rule: see "Status list timing". |
| `STATUS_LIST_FOLLOW_SECONDS` | `10` | How often the timer reads the changes of the chain into the status lists: 0, or a multiple of 10 up to 300. With 0, the lists change only when a build ends. See "Status list timing". |

The testnet uses the same network magic as mainnet. So the resolver compares all four genesis values
with the values that Koios reports (`/genesis`). If one differs, every resolution is
`INTERNAL_ERROR`, and the next request checks again.

## HTTPS binding (Part 1 Section 7.4)

- `GET /1.0/identifiers/{did}`, and `HEAD` with the same status and header fields and no body
  (RFC 9110 Section 9.3.2). The resolver percent-decodes the path once. Query parameters are the
  options `versionId`, `versionTime`, `expandRelativeUrls` and `noCache`. Another parameter is
  `FEATURE_NOT_SUPPORTED`; a bad value, a repeated option or both version options is
  `INVALID_OPTIONS`.
- `Accept` (RFC 9110 Section 12.5.1, q-values): the resolution result (`application/did-resolution`)
  or the document only (`application/did`). The most specific range that matches a media type gives
  its weight, so `application/did-resolution;q=0.1, application/*` gives the document. Wildcards
  weigh only these two media types; the other names of the Part 1 table count when a range names
  them exactly. Ranges with `q=0` are ignored (Part 1 Section 7.4). On a tie, the result wins.
  Errors and deactivated DIDs always get the result.
- The body is the JCS (RFC 8785) serialisation. Every response has `Cache-Control: no-store`.
- Status: 200 found (also Suspended), 410 `deactivated: true`, 400 `INVALID_DID` /
  `INVALID_OPTIONS`, 404 `NOT_FOUND`, 406 `REPRESENTATION_NOT_SUPPORTED`, 501
  `METHOD_NOT_SUPPORTED` / `FEATURE_NOT_SUPPORTED`, 500 `INTERNAL_ERROR`.
- A result has `updated`, the version time of its version, except for version 0. A result with a later
  confirmed version also has `nextUpdate`, the version time of that version. To check a signature that
  was made at time S, resolve with `versionTime` set to S. The document is the right one when
  `updated` (`created` for version 0) is before S and `nextUpdate` is after S. Compare S also with
  `vectorStatus.invalidFrom`: a signature made at or after that time is invalid. A client that checks
  a signature at a time reads `versionId`, `updated`, `nextUpdate`, `vectorStatus` (with
  `invalidFrom`) and `vectorLedger` of the answer. `blockHeight` plus `confirmations` of
  `vectorLedger` give the tip of the gateway. The tool `vector_verify_signature_at` of the MCP server
  does this.
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
| `GET /agents/{id}/agent-card.json` | Listed A2A agents | A2A v1.0 agent card: on-chain name and description, the interfaces on the endpoint's origin and the default modes from the detected card, the on-chain capabilities as skills, `version` = versionId, `documentationUrl` = the resolution URL of the DID, `provider` = a verified organisation. Signed as A2A Section 8.4 specifies (JWS over the JCS form, `alg` EdDSA, `typ` JOSE, `kid`, `jku` = `/.well-known/jwks.json`). 503 when no signing key is configured. `application/a2a-agent-card+json` when the client asks for it, else `application/json`. The gateway signs a card once for each check of the agent and record state, and serves that card again. |
| `GET /agents/{id}/server-card` | Listed MCP agents | MCP Server Card v1 (SEP-2127): `name` = `<reverse gateway host>/{id}`, description of at most 100 characters, `remotes` = the endpoint with the protocol versions it named, `_meta` with the DID. |
| `GET /v0/servers`, `GET /v0.1/servers` | Listed MCP agents | MCP Registry list `{servers: [{server, _meta}], metadata: {count, nextCursor?}}` with server.json entries (schema 2025-12-11). Query: `limit` (1-100, default 30), `cursor`, `search` (name substring), `version` (`latest` or exact), `updated_since` (RFC 3339). |
| `GET /.well-known/ai-catalog.json` | Listed A2A and MCP agents | AI Catalog 0.9 (the release candidate of version 1.0), `application/ai-catalog+json`: one entry per agent. `identifier` = `urn:air:<gateway host>:{id}`, where `{id}` is the id of the agent's DID. `type` and `url` of its agent card or server card, `tags` = capabilities, `updatedAt`, and `extensions` = `{"<gateway host in reverse DNS order>": {"did": "did:vector:{id}"}}` (on the Foundation gateway the key is `org.apexfusion.vector.id`). |
| `GET /.well-known/ard.json` | Listed A2A and MCP agents | ARD v0.91 manifest `{entries}` with `identifier` (as in the AI Catalog), `displayName`, `description`, `capabilities` and `metadata {did, protocol}`. |
| `GET /agents/{id}/oasf.json` | Listed agents | OASF record (schema 1.1.0): profile, `skills` mapped from known capability names, the endpoint as `url` locator, `annotations` with the DID, the protocol and the capabilities. |
| `GET /agents/{id}/registration.json` | Listed agents | ERC-8004 registration file: `services` (A2A, MCP or web, then OASF and DID), `active`, `registrations [{agentId, agentRegistry}]`. `agentId` is the identifier as a decimal integer (78 digits at most, so read it with a big-integer JSON reader). `agentRegistry` is `vector:mainnet:<identity policy>`, or the legacy policy for a legacy record. |
| `GET /policy` | | The listing rule, the fetch rules (with the repeat of a check that found no protocol), the confirmation rule, the request-log statement, `ACCESS_LOG_RETENTION` and the limits as numbers (with `firstRetrySeconds`). Also the bound of each revocation path at each surface (`revocationBounds`) and the bound for an open escrow (`escrowBound`). The numbers of `revocationBounds` follow `STATUS_LIST_FOLLOW_SECONDS`, `STATUS_LIST_REFRESH_SECONDS`, `STATUS_LIST_BACKGROUND_REFRESH_SECONDS` and `FETCH_SCAN_INTERVAL_S`. |

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
| `POST /spiffe/nonce` | | `{nonce, expires_in: 300}`: single-use, valid for 5 minutes. The gateway stores nothing when it issues a nonce: the nonce holds its issue time, random bytes and an HMAC tag under a key of the process. It keeps a nonce only after an authenticated request used it. |
| `POST /spiffe/x509-svid` | JSON `{csr, proof}`: a PKCS #10 request for a P-256 key (PEM or base64url DER) and a JWT by an authentication key (EdDSA or ES256, the agent-JWT rules) with the claims `nonce` and `cnf.jwk` = the request's public key | `{spiffe_id, x509_svid (PEM), bundle (PEM CA), expires_at}`. One URI SAN `spiffe://<host>/agent/<id>`, empty subject, 1 hour, `noRevAvail`. 403 `agent_not_active`. |
| `POST /spiffe/jwt-svid` | JSON `{subject_token, audience}` (1 to 8 audiences) | `{spiffe_id, svid, expires_at}`: ES256, 5 minutes. |
| `GET /spiffe/bundle` | | SPIFFE bundle (`https_web`): the CA certificate (`use` x509-svid, `x5c`) and the JWT-SVID key (`use` jwt-svid, `kid`), `spiffe_refresh_hint` 300. |
| `GET /status/bsl/{n}` | | `application/vc+jwt`: a BitstringStatusListCredential with `statusPurpose` [revocation, suspension]: 2 × 131,072 bits, the revocation bit of position p at p and its suspension bit at 131,072 + p. |
| `GET /status/tsl/{n}` | | `application/statuslist+jwt`: 2 bits per entry, 0 valid, 1 invalid (Revoked or Retired), 2 suspended. An entry also reads 2 while an access token that names it was revoked by a status change and can still be accepted (until its `exp` plus 30 s), also after the agent is Active again; new tokens of that agent read 2 for that time too. |
| `GET /agents/{id}/credential` | | `application/vc+jwt`: a VC 2.0 credential of the gateway's DID with the subject DID, `created`, `origin` and, for a subagent, `parent`; two `BitstringStatusListEntry` items. 409 when the agent is not Active, 410 when deactivated. |

Index i of `listRecords()` is in list n = floor(i / 131,072) at position i mod 131,072. The bits of
a list are the effective statuses of the records as of one ledger tip, the ledger point of the list.
`iat` and `validFrom` are the block time of that tip. A list is valid for one hour after its ledger
point (`exp`, `validUntil`). The ledger point never goes back: a state with an earlier block time or
a lower block height than the lists that readers have is not published.

Two things make the lists. A *follow step* runs every `STATUS_LIST_FOLLOW_SECONDS`. It reads the new
tip and the list of records. Then it reads the effective status of each record that is not final and
of each record that got its index. A record is final when its status is Revoked or Retired. A *full
build* is one pass over every record. It makes the first lists, and it repairs the lists when the
steps cannot. Both read only the effective status of each record (`currentStatus`, no legacy key
search), as of the tip that they read first.

The first build starts with the services. After that, a build starts in three cases. The last build
ended `STATUS_LIST_BACKGROUND_REFRESH_SECONDS` ago (the timer checks every 10 s). A request finds
lists that no step and no build has read from the chain for longer than `STATUS_LIST_REFRESH_SECONDS`
(or two follow intervals, when that is longer): the steps fail. A step finds that an index changed or
that a record left the list. At most one build runs at a time. A build that the timer or a request
starts waits until one refresh interval has passed since the last build started, also after a failed
build. A build that a step starts (the repair build) starts as soon as no build runs; after a failed
build it waits for one refresh interval too. At most one step runs at a time. A failed build or step
keeps the previous lists, and the timer goes on. Until a build ends, requests get the previous lists.
Without valid lists, a request waits up to 10 s for the running build, then it is 503. After a failed
build, a request without valid lists is 503 at once, until the next build starts.

A status other than Active that the gateway sees (at introspection, or in the status watcher every
30 s) revokes every token of that agent issued up to then. A token revoked on its own (`/revoke`, or
a delegation that no longer passes) shows only in introspection. Introspection reads the status of
each agent that the token names on every call, and, for a delegation token, the delegation chain. So
a cut delegation makes the tokens under it inactive at once: the first call after the block with the
cut is at the Koios tip. A verifier that checks a token only locally (the signature and `exp`) sees a
change only when the token expires. A token lasts at most 5 minutes. A verifier that also reads the
status list sees a change of an agent after the delay of the list (see "Status list timing"), but it
never sees a cut delegation: the lists show agents, not delegations. Replay stores, nonces and issued
tokens are in memory: a restart makes earlier tokens and nonces inactive. A single-use value (the
`jti` of a subject token, a client assertion or a DPoP proof, a used nonce) goes into the replay
store only after the request authenticated, and the store keeps a 128-bit digest of each value.

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

### Status list timing

The bits of a list are the effective statuses as of one ledger tip, its ledger point. `iat` and
`validFrom` are the block time of that tip. The ledger point never goes back. A signed list is valid
for 3600 s after its ledger point (`exp`, `validUntil`). A reader always gets the last valid lists,
also while a build runs. So a reader waits for a build only when no list is valid: after a start,
until the first build ends, or after steps and builds that fail for longer than the lists stay valid.
When the tip of the ledger source is older than 3600 s, no list is valid. Readers then get 503 with
`Retry-After: 5`, and the error output has this line:

    identity-gateway: status lists unavailable: no valid status lists: the ledger tip is older than 3600 s

The lists are back at the first step or build that reads a tip that is less than 3600 s old.

The lists follow the chain. Every `STATUS_LIST_FOLLOW_SECONDS` (10 s) the timer runs a follow step. A
step makes 5 Koios calls (the tip, two asset indexes, two holder pages) and 3 more for each record
that it reads again. A record is read again when its tokens moved, when its newest transaction has
fewer than 30 confirmations, or when no output holds its tokens. A record with the status Revoked or
Retired is final: a step does not read it. The status is the status of the resolver, so the end of a
record and the lift of a hold show after 30 confirmations, and a subagent follows its parent.

A change shows in the lists after its block is at the tip of the ledger source (Koios). With the
default settings, these are the bounds:

| Change | The list shows it | Typical | At most |
|---|---|---|---|
| A hold (controller, party or Module-1) | suspension bit set | 6 s | 16 s (11 s when no full build runs) |
| A hold that ends by time | suspension bit cleared | not given | 24 s after its end time |
| The lift of a hold | suspension bit cleared | 122 s | 256 s |
| A revocation or a retirement | suspension bit set, then revocation bit set and suspension bit cleared | 6 s, then 122 s | 16 s, then 256 s |

A change of a parent shows for each subagent with the same bounds as for the parent. The numbers are
computed from the settings in force and from planning values for the time of a step and the time
between blocks. Nobody measures them while the gateway runs. They do not count the cache of a
reader. A list response has `Cache-Control: public, max-age=<n>`, where n is the smaller of
`STATUS_LIST_REFRESH_SECONDS` (60 s) and the seconds left until the list expires. So a reader can
keep a list for 60 s at most, and never past its `exp`. `GET /policy` gives the bounds of every
revocation path at every surface, with their formulas, for the settings that the gateway runs with
(`revocationBounds`). It is the live and complete table.

When the steps fail, the lists keep their last state, and a full build repairs them. With
`STATUS_LIST_FOLLOW_SECONDS=0`, only a full build changes the lists. A change then shows after two
builds, the build interval and one tick of the timer: 2 × the time of a build +
`STATUS_LIST_BACKGROUND_REFRESH_SECONDS` + 10 s. With a build of 474 s (the longest that was
measured) and the default interval, a hold shows in at most 1,558 s, and a lift or a revocation in at
most 1,798 s (computed).

In a rare case, the records do not fit the lists any more. This happens after a rollback of more than
30 blocks, or when Koios gives an answer that misses a record: an index changes, or a record leaves
the list. The steps cannot go on then. The lists stay valid and keep their last good state: no bit
changes, and `iat` does not move. A repair build reads every record again. It starts as soon as no
build runs, and after a failed build it waits one refresh interval. The table gives the bound for the
repaired lists, counted from the moment that the block is at the Koios tip. `F` is
`STATUS_LIST_FOLLOW_SECONDS`, `S` is the time of one step (1 s, and 6 s while a build runs), `d` is
the time of a full build (474 s, the longest that was measured), and `R` is
`STATUS_LIST_REFRESH_SECONDS` (60 s).

| Case | The repaired lists come within | With these values (computed) |
|---|---|---|
| No build runs when the step sees the problem | `F + S + d` | 485 s |
| A build runs when the step sees the problem | `2d + F + S` | 964 s |
| A repair build fails | add `R` for each failed try, and the time of the next full build | `R` is 60 s |

The log has a line about this problem at once, and then one line for each refresh interval at most
(see the log lines below). The reason in it is `an index changed` or `a record left the list`.

The full build is the safety net. The timer starts it when the last build ended
`STATUS_LIST_BACKGROUND_REFRESH_SECONDS` ago. A request starts it when no step and no build has read
the chain for `STATUS_LIST_REFRESH_SECONDS` (or two follow intervals, when that is longer). A build
makes about 2,300 Koios calls and takes 4 to 8 minutes. The lists that it makes are as old as the
build when it ends, so the rule is

    background interval + 10 s + time of the build + age of the bits at the end of the build <= 3600 s

The gateway allows 1200 s for the last three terms together. So each interval is at most 2400 s, and
the gateway refuses a longer one when it starts. The message names the setting. At the longest
interval, a build of up to 590 s keeps a valid list at every moment, also with
`STATUS_LIST_FOLLOW_SECONDS=0`. The default of 600 s allows a build of up to 1490 s (both computed).
A longer interval means fewer Koios calls. A build of 241 s makes 2,312 calls: at 600 s that is
about 2.7 calls per second of the 10 that the gateway may use.

Each build writes two lines to the error output. The word in brackets tells what started the build:
`start` (the first build of the services), `timer`, `request`, `repair` (a step found that the
records do not fit the lists) or `call` (code asked for the build). The first two lines below are
written once, when the services start. The `not rebuilt` line says that a build failed and gives the
reason; the last lists stay. A step writes a line in three cases: a bit changed; the step failed (the
`not followed` line, one line for each refresh interval at most; the lists keep their last state); or
the records do not fit the lists. The `unavailable` line comes with each 503 for a list. The last line
is a warning: the build was so long that a list can expire before the next build ends. Use a shorter
`STATUS_LIST_BACKGROUND_REFRESH_SECONDS` then. The lines hold no list content and no identifier.

    identity-gateway: status lists: the timer builds them again when they are older than <seconds> s; a list is valid for <seconds> s
    identity-gateway: status lists: they follow the chain: the timer reads the changes every <seconds> s
    identity-gateway: status lists: they do not follow the chain: only a build changes them
    identity-gateway: status lists: build started (timer): the lists are <seconds> s old
    identity-gateway: status lists: build ended after <seconds> s: <count> records
    identity-gateway: status lists not rebuilt after <seconds> s: <reason>
    identity-gateway: status lists: followed to block <height> after <seconds> s: <count> of <count> records changed
    identity-gateway: status lists not followed after <seconds> s: <reason>
    identity-gateway: status lists: the records do not fit the lists (<reason>); the lists do not change until a full build ends
    identity-gateway: status lists unavailable: <reason>
    identity-gateway: status lists: the build took <seconds> s, and the interval is <seconds> s. A list is valid for <seconds> s, so a list can expire before the next build ends. Use a shorter STATUS_LIST_BACKGROUND_REFRESH_SECONDS.

## Background jobs (Part 1 Section 9, Part 2 Sections 8.5 and 8.6)

A scan runs at start and every `FETCH_SCAN_INTERVAL_S`; it is one pass over the records (see "Chain
data"). It reads the current record of every identifier and starts a check for each Active record
that has no facts yet, that changed (a new base or pending version), or whose last check is due again
(see below). Requests never fetch: they read the stored facts,
and a fact counts only while its inputs still apply to the view that the answer shows (the same
endpoint, a domain that the view still names, a signing key that is still an assertion key of the
view). A result for `versionId` or `versionTime` applies the facts to the view at that version or
time.

A check is due again one day after it ended. A check whose detection found no protocol is due
sooner: 10 minutes after it ended, then 20, 40 and 80 minutes, and so on (twice as long after each
such check in a row), but never more than one day. A record change starts the waits again. The first
scan after the due time starts the check. The facts are in memory, so a start of the gateway starts
every check again. A check that found no protocol writes one line to the error output. It names the
host and the reason, and never a DID:

    identity-gateway: background check found no protocol at <host> (<reason>); the next check is in <minutes> minutes

- **Protocol detection:** A2A (`<endpoint origin>/.well-known/agent-card.json` is a valid agent card
  with an interface on that origin), then MCP (`server/discover` of revision 2026-07-28, then
  `initialize` of revision 2025-11-25), then web (a GET of the endpoint answers 2xx). The endpoint is
  reachable when one check succeeds. Detection keeps at most 8 interfaces (URL at most 512 bytes,
  binding and version at most 64 bytes), 16 input and 16 output modes (at most 255 bytes each) and 16
  MCP protocol versions (at most 64 bytes each), the first ones in answer order; it leaves out a
  longer item.
- **Domain linkage:** the endpoint host and each party organisation that is a domain. A DNS TXT
  record `_did.<domain>` with the DID (or `did=` and the DID), or a Domain Linkage Credential in
  `https://<domain>/.well-known/did-configuration.json` (JWT format, EdDSA or ES256, signed by an
  assertion key of the DID). Verified domains go to `alsoKnownAs`; a verified organisation gets
  `organisationVerified`.
- **Fetch rules:** `https` only; every address of the host must be public unicast, checked for each
  connection and each redirect, and the connection goes to the checked address; no redirect to
  another host or port; at most 5 redirects, 1 MiB and 10 seconds; at most one fetch per host each
  minute. The host of that limit is the destination: a trailing dot does not count, and an
  IPv4-mapped or NAT64 IPv6 literal counts as its IPv4 address.
- The resolver shows the results in `vectorFetched` (URL, fetch time, SHA-256 of the bytes; a DNS
  check has the URL `dns:_did.<domain>?type=TXT`).

## Internal API

`src/index.ts` exports the resolver core for the gateway services:

- `new VectorResolver(chain, settings, options?)`;
- `resolveDid(did, options?)`: the resolution result; it never throws;
- `currentRecord(vectorId, list?)`: the view and the effective status without options (Part 2
  Section 8.4); with a list of `listRecords()`, as of the tip of that list (a pass, see "Chain data");
- `currentStatus(vectorId, list?)`: the effective status alone, without the legacy key search
  (status lists and token checks);
- `listRecords()`: every identifier that resolves, in the ledger order of its first mint, with its
  status-list index (Part 2 Section 8.6);
- `options.fetchedFacts(subject, legacyPolicyId)`: the stored facts that apply to the view of a
  result; `options.legacyKeys`: a `LegacyKeySearch` that several resolvers of one chain source share.

## Chain data

Koios supplies the asset histories, the transactions (with inline datum bytes), datums by hash,
blocks, the policy asset index, the outputs that hold an asset now (`asset_utxos`) and the genesis
values. Koios on Vector exposes no witnesses, so the legacy key search reads blocks through Ogmios
chain synchronisation. The resolver depends only on the `ChainSource` interface
(`src/chain/types.ts`).

Each resolution reads the tip first and ignores transactions in later blocks. A record history is
kept while the tip stays the same.

**Koios limit (`src/chain/limiter.ts`).** The Koios of Vector (HAProxy behind Cloudflare) answers
HTTP 429 when it gets about 300 requests in 10 s: a `text/html` page without `Retry-After` and
without rate-limit headers. It refuses while the requests go on, and other clients get refusals at
the same time. One limiter takes every Koios call of the process: `KOIOS_RATE_PER_SECOND` calls per
second on average (bursts of twice as many), at most 4 at the same time. Calls for requests start
before background calls (the scan, status-list builds). After an HTTP 429, no call starts until the
pause ends: `Retry-After` when the answer has it, else 10 s, doubled after each further 429 up to
60 s. Then the refused call is made again (at most 5 attempts), and calls run one at a time until one
succeeds. A request does not wait for a pause longer than 15 s: it fails at once (500
`INTERNAL_ERROR`).

**Passes.** The scan and the status-list builds are passes over every record: `listRecords()` reads
the tip once, and `currentRecord(id, list)` or `currentStatus(id, list)` reads each record as of the
tip of that list. Passes keep their ledger reads (`src/resolve/history-store.ts`). Before its first
history, a pass reads the outputs that hold the tokens of all its records (`asset_utxos`, 1,000
assets in one request). A transaction that mints, moves or burns a token spends or makes such an
output, so a pass reads a record again only when the holders of its tokens changed, when its newest
transaction has fewer than 30 confirmations, or when no output holds its tokens. A read that started
before a pass read its tip serves that pass only when the holders vouch for it. `main.ts` gives the
scan and the M4 services one resolver, so they share these reads; the request path has its own
resolver and cache. The timer of the status lists starts one full pass in each background interval,
and one follow step in each follow interval. A step makes 5 calls and 3 more for each record that it
reads again, so a longer `STATUS_LIST_BACKGROUND_REFRESH_SECONDS` means fewer passes.

Measured on mainnet (826 records, 2026-11-03). Before: the start scan made 4,110 Koios calls (one
tip, two asset histories, one transaction read and one block read for each record) in about 10 s,
and each status-list build 3,333. Now: the start (the first scan and the first status-list build
together) makes 3,328 calls at 10 calls per second; a later scan or build makes 5 calls (1 tip, 2
asset indexes, 2 holder pages) and 3 more for each record that it reads again. A resolution makes
4 calls at a new tip and 1 at the same tip, as before.

Measured on mainnet with 874 records: a first status-list build makes 2,647 calls in 263 s. A later
build makes 2,312 calls in 241 s, because 769 of the records have no output that holds their tokens,
so a build reads each of them again. A follow step makes 5 calls in about 0.6 s.

The legacy key search reads the blocks of a record's transactions newest first, in windows of 1, 2,
4 and so on up to 64 blocks. A window is one Koios read and one Ogmios session; in the session, a
block that follows the previous one needs no new intersection. The search keeps the witnesses of each
transaction that it read (by block hash and transaction ID) and, once the last output of the base
version has 30 confirmations, its result. At most 4 sessions run at the same time. `main.ts` gives
its two resolvers one search, so they share these caches.

`listRecords()` keeps each first mint with 30 confirmations between builds. It does not read the
mint of a legacy asset that Koios shows as created at or after the cutoff slot (`creation_time` of
`policy_asset_mints`), unless the identity registry has the same name.

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
| The log shows "Koios … answered HTTP 429" | Koios refused the gateway or another client of the same Koios: the gateway pauses all Koios calls (10 s, then 20, 40 and 60 s) and makes the refused calls again. Requests in a pause longer than 15 s are 500. If it happens without other clients, lower `KOIOS_RATE_PER_SECOND`. |
| Status lists are 503 after a start | The first build reads every record once (minutes at 10 Koios calls per second). Requests are 503 until it ends; then they are 200. The timer keeps the lists valid from then on. |
| Status lists are 503 although the gateway runs for a long time | No list is valid: the builds fail, a build is longer than the lists stay valid, or the ledger tip is older than 3600 s. The lists are valid for 3600 s after the block time of the tip that they read, so a Koios that stays at one tip for an hour makes them expire. Look for `status lists not rebuilt`, `the build took` and `status lists unavailable: no valid status lists: the ledger tip is older than 3600 s` in the log (see "Status list timing"), and find why Koios does not move. A failed build is tried again one refresh interval after it started. For a build that is too long for the interval, set a shorter `STATUS_LIST_BACKGROUND_REFRESH_SECONDS`. If a build takes longer than 3600 s, find why Koios is slow. |
| A change shows late in the status lists | Look for `status lists not followed` and `the records do not fit the lists` in the log. Koios is slow or down, or the records changed after a rollback: the lists keep the last state, and a full build repairs them (see "Status list timing" for the bounds). With `STATUS_LIST_FOLLOW_SECONDS=0`, only a build changes the lists, so a change takes minutes. |
| Legacy DIDs have no keys and `controllerKeyNotFound` | No vkey witness of the record's own token transactions has the owner hash (Part 1 Section 8.1). The key appears after the owner key signs a transaction of the record. |
| 500 only for legacy DIDs | Ogmios is not reachable from the container. Check `OGMIOS_URL`. |
| `NOT_FOUND` for a new record | A version shows after 30 confirmations. Wait, or check the mint with Koios. |
| The process exits at start | A configuration value is invalid; the message names it (for example `IDENTITY_ADDRESS` that is not the address of `IDENTITY_POLICY_ID`). |
| An agent is not in the catalogs, or its card is 404 "not listed (…)" | The reason names the failed condition of the listing rule (`notIndependent`, `notActive`, `notReachable`). For `notReachable`: the last detection failed, or the endpoint changed and the next scan has not checked it yet. Resolve the DID: `vectorProfile.protocol` and `vectorFetched` show the last successful detection. A host gets at most one fetch each minute, so a check of many agents on one host takes minutes. After a gateway start, every check starts again, because the facts are in memory. A card that goes live after a check is found by a later check: after 10 minutes at the earliest, then after longer waits. The log line `background check found no protocol at <host> (<reason>); the next check is in <n> minutes` names the reason. |
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
