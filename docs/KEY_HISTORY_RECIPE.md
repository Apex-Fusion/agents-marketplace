# Recipe: check a signature after a key rotation and a revocation

This recipe shows that a signature by a listed key stays verifiable at its time after the key is rotated and the identifier is revoked. You can repeat it on Vector mainnet with your own throwaway keys. Each step names the hosted MCP tool or the HTTP request, the keys that sign, and what to check.

The rules behind the steps are in the method text: [did-vector-method.md](did-vector-method.md) §7.2 (checking a signature at a time), §7.3 (version options) and §8.2 (`updated`, `nextUpdate`).

## What you need

- The hosted MCP server: `https://mcp.vector.mainnet.apexfusion.org/mcp`. It has the build tools and `vector_verify_signature_at`.
- The identity gateway: `https://id.vector.apexfusion.org`.
- One signer for each key, for example `@apexfusion/vector-mcp-signer`, and an Ed25519 signature over your own message.
- Five Ed25519 keys: the wallet W, the controllers C0 and C1, and the listed keys K1 and K2.
- About 12 AP3X in W: the deposit of the record (10 AP3X in our run; most of it comes back in step 9) and the fees. W must hold one pure output of at least 5 AP3X, plus about 1 AP3X more. A transaction that runs a script needs that output as collateral, and the builders refuse to build without it.

## Steps

| # | Do | Signers | Check |
|---|---|---|---|
| 1 | Register: `vector_build_identity_register` with `controller` C0 and `keys` `[{ "key": K1, "purposes": ["authentication", "assertion"] }]`. | W, C0, K1 | The answer gives the DID. The resolver shows the record after 30 confirmations (about 2 minutes). Before that, it answers 404. |
| 2 | Sign: K1 signs the bytes of your message. Write down the time t1. | K1 | Keep the message bytes, the signature and t1. |
| 3 | Change the controller: `vector_build_identity_change_controller` with `new_controller` C1. | W, C0, C1 | The identifier stays the same. |
| 4 | Rotate the key: `vector_build_identity_update` with `remove_keys` `[K1]` and `add_keys` `[{ "key": K2, "purposes": ["authentication", "assertion"] }]`. | W, C1, K2 | After 30 confirmations, the resolver lists K2 and not K1. |
| 5 | Read the history: `GET /1.0/identifiers/{did}?versionTime={time}` with `Accept: application/did-resolution`. | none | At t1: version 0, K1 listed, controller C0. After step 3: version 1. After step 4: version 2, K2 listed, K1 gone. `didDocumentMetadata` gives `updated`, `nextUpdate` and `nextVersionId` of each version. |
| 6 | Revoke: `vector_build_identity_revoke` with `actor` `controller`, `reason` `keyCompromise` and `invalid_from` just after t1. | W, C1 | A `keyCompromise` needs `invalid_from`. The builder accepts an `invalid_from` from one hour before the creation of the record up to the start of the validity window of the revoke, so give a time in the past. |
| 7 | Read the history again, after 30 confirmations of the revoke. | none | At t1: HTTP 410 with the document of version 0 (K1 listed) and `deactivated: true`. At a time at or after `invalid_from`: HTTP 410 with no document. |
| 8 | Check the signature: `vector_verify_signature_at` with `did`, `message_hex` (the signed bytes in hex), `signature_hex`, `key` (the public key of K1, its key hash or its method id) and `at` t1. | none | VALID. At a time at or after `invalid_from`: INVALID. |
| 9 | Take back the deposit: `vector_build_identity_reclaim`. | W, C1 | The record keeps a minimum of about 1.6 AP3X for good (the tombstone). |

Notes:

- `vector_verify_signature_at` decides only for a time at least 10 minutes before now and before the tip of its node. A later change can still have fewer than 30 confirmations, and the gateway does not show it yet. For a more recent time, the tool answers NOT CHECKED. Wait, then ask again.
- Give the exact signed bytes in `message_hex`. The `message` input takes UTF-8 text. A hex string in `message` is checked as text, and the signature then fails.
- The tool builds and signs nothing. Its answer lists each check, with the version that it used.

## Clients and the HTTP 410 body

The gateway answers a deactivated DID with HTTP 410, and the body holds the resolution result. For a `versionTime` before the end, the body holds the document of that time. That body is the answer that an auditor needs. Some HTTP clients hide it by default:

| Client | The 410 body |
|---|---|
| `fetch`, Python `requests`, the Java client of the Universal Resolver | Kept. Read the body as for a 200. |
| `axios` | It throws. The body is in `error.response.data`, or accept the status with `validateStatus`. |
| Rust `ssi` `HTTPDIDResolver`, DIF `web-did-resolver` | Dropped. Send the request to the gateway with a plain HTTP client and read the body. |
| Universal Resolver (`uni-resolver-web`) | A revoked DID, resolved without an option, gives HTTP 404 `NOT_FOUND`, and the body of the gateway is lost. A `versionTime` or `versionId` before the end gives HTTP 410 with the body of that version. Send the DID percent-encoded. Each error of the gateway shows as HTTP 500 with the error body. |

## A run on mainnet

We ran these steps on Vector mainnet with throwaway keys. The record is `did:vector:a6eed6d69ec22d8a58f9d06cfd6f104206519c499f96255e33f97133c975b26a`.

| Step | Transaction |
|---|---|
| Register | `617505d426bb92d12231cb9196f70fa214b0078accd45bc7c32bc8a69ea0fe19` |
| Change the controller | `368d182210f7acb9ccb3e4230189daba4761cfba01e57052fed1f99b25be2124` |
| Rotate the key | `b383a17cbbf155ab4dc90d3a24e50b0cdf09b8e72cb4ceb766fadf56d8dc561c` |
| Revoke with `invalid_from` | `5ed557e393d3ff31f5f2aadb3976df4b2ae02b3e32658f2bda849255c01c00c7` |
| Take back the deposit | `c1b2a42334a1adabcd53099a0f948f1d656c5939dbbda2db66a0392eef79a0f5` |

Results: the reads by `versionTime` gave versions 0, 1 and 2 as in step 5. After the revoke, the read at t1 gave HTTP 410 with the document and K1, and a read after `invalid_from` gave HTTP 410 with no document. `vector_verify_signature_at` gave VALID at t1 and INVALID after `invalid_from`.
