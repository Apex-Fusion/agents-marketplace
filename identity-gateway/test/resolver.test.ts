import { describe, expect, test } from "vitest";
import { DID_CONTEXT } from "../src/resolve/document.js";
import { canonicalize } from "../src/resolve/jcs.js";
import { ed25519Multikey } from "../src/resolve/multikey.js";
import { DidVectorResolver, httpStatus } from "../src/resolve/resolver.js";
import {
  ASSET,
  CANONICAL_DID,
  FakeChain,
  LEGACY_DID,
  MINT_BLOCK,
  MINT_TX,
  OWNER_HASH,
  OWNER_KEY,
  OWNER_MULTIKEY,
  POLICY,
  WALLET,
  datumFor,
  keyHashOf,
  realMint,
} from "./fixtures.js";

const KEY_B = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
const HASH_B = keyHashOf(KEY_B);
const KEY_C = "8f3c1a0e3d2b4c5a69788796a5b4c3d2e1f00112233445566778899aabbccdd0";

const resolve = (chain: FakeChain, did: string, options: Record<string, string> = {}) => new DidVectorResolver(chain).resolve(did, options);

describe("valid legacy DID", () => {
  test("renders the controller key from the registration witness, with the canonical ID", async () => {
    const chain = FakeChain.history([realMint()]);
    const result = await resolve(chain, LEGACY_DID);

    expect(keyHashOf(OWNER_KEY)).toBe(OWNER_HASH);
    expect(httpStatus(result)).toBe(200);
    expect(result.didResolutionMetadata).toEqual({ contentType: "application/did" });
    expect(result.didDocument).toEqual({
      "@context": DID_CONTEXT,
      id: LEGACY_DID,
      verificationMethod: [{ id: `${LEGACY_DID}#c0`, type: "Multikey", controller: LEGACY_DID, publicKeyMultibase: OWNER_MULTIKEY }],
      capabilityInvocation: ["#c0"],
      authentication: ["#c0"],
    });
    expect(result.didDocumentMetadata).toEqual({
      created: "2026-04-15T21:02:22Z",
      updated: "2026-04-15T21:02:22Z",
      versionId: "0",
      canonicalId: CANONICAL_DID,
      vectorOrigin: "legacy",
      vectorStatus: { status: "active", effective: "active" },
      vectorLedger: {
        txId: MINT_TX,
        outputIndex: 0,
        blockHash: MINT_BLOCK.hash,
        blockHeight: MINT_BLOCK.height,
        slot: MINT_BLOCK.slot,
        confirmations: chain.tipInfo.blockHeight - MINT_BLOCK.height,
      },
    });
  });

  test("the canonical form resolves the same record under its own id", async () => {
    const result = await resolve(FakeChain.history([realMint()]), CANONICAL_DID);
    expect(result.didDocument?.id).toBe(CANONICAL_DID);
    expect(result.didDocument?.verificationMethod?.[0]).toMatchObject({ id: `${CANONICAL_DID}#c0`, publicKeyMultibase: OWNER_MULTIKEY });
    expect(result.didDocumentMetadata.canonicalId).toBe(CANONICAL_DID);
  });

  test("self-declared v1 fields are not rendered", async () => {
    const body = canonicalize(await resolve(FakeChain.history([realMint()]), LEGACY_DID));
    for (const word of ["GovernanceProposer", "claude-code", "governance", "name", "description", "service", "capabilities"]) {
      expect(body).not.toContain(word);
    }
  });
});

describe("rotated controller", () => {
  test("uses the latest witness that matches the current owner hash, not the previous owner", async () => {
    const chain = FakeChain.history(
      [realMint(), { kind: "update", height: 4_900_000, owner: HASH_B, witnesses: [OWNER_KEY] }],
      [
        { height: 4_950_000, witnesses: [KEY_C], credentials: [HASH_B] }, // B received funds; B did not sign
        { height: 4_960_000, witnesses: [KEY_B], credentials: [HASH_B] }, // B spent: its witness
        { height: 4_970_000, witnesses: [KEY_B, KEY_C], credentials: [HASH_B] }, // B signed again, more recently
      ],
    );
    const result = await resolve(chain, LEGACY_DID);

    expect(result.didDocument?.verificationMethod).toEqual([
      { id: `${LEGACY_DID}#c0`, type: "Multikey", controller: LEGACY_DID, publicKeyMultibase: ed25519Multikey(Buffer.from(KEY_B, "hex")) },
    ]);
    expect(result.didDocument?.verificationMethod?.[0]?.publicKeyMultibase).not.toBe(OWNER_MULTIKEY);
    expect(result.didDocumentMetadata).toMatchObject({ versionId: "1", updated: "2026-06-08T06:26:40Z" });
    expect(result.didDocumentMetadata.vectorLedger).toMatchObject({ blockHeight: 4_900_000, outputIndex: 0 });
    expect(result.didDocumentMetadata.vectorMetadataError).toBeUndefined();
    // Newest block first; the search stops at the first match.
    expect(chain.witnessCalls).toEqual([4_970_000]);
  });

  test("an owner that signed only an older registry update is still found", async () => {
    const chain = FakeChain.history([
      realMint(),
      { kind: "update", height: 4_900_000, owner: HASH_B, witnesses: [OWNER_KEY] },
      { kind: "update", height: 4_910_000, witnesses: [KEY_B] }, // B updates its own record
      { kind: "update", height: 4_920_000, owner: HASH_B, witnesses: [KEY_C] }, // a later update B did not witness
    ]);
    const result = await resolve(chain, LEGACY_DID);
    expect(result.didDocument?.verificationMethod?.[0]?.publicKeyMultibase).toBe(ed25519Multikey(Buffer.from(KEY_B, "hex")));
    expect(result.didDocumentMetadata.versionId).toBe("3");
    expect(chain.witnessCalls).toEqual([4_920_000, 4_910_000]);
  });
});

describe("controller key unavailable", () => {
  test("no witness for the current owner: no verification method and vectorMetadataError", async () => {
    const chain = FakeChain.history(
      [realMint(), { kind: "update", height: 4_900_000, owner: HASH_B, witnesses: [OWNER_KEY] }],
      [{ height: 4_950_000, witnesses: [KEY_C], credentials: [HASH_B] }],
    );
    const result = await resolve(chain, LEGACY_DID);
    expect(httpStatus(result)).toBe(200);
    expect(result.didDocument).toEqual({ "@context": DID_CONTEXT, id: LEGACY_DID });
    expect(result.didDocumentMetadata).toMatchObject({ vectorMetadataError: "controllerKeyNotFound", versionId: "1", vectorOrigin: "legacy" });
    expect(chain.witnessCalls).toEqual([4_950_000, 4_900_000, MINT_BLOCK.height]);
  });

  test("a script owner renders no verification method", async () => {
    const chain = FakeChain.history([realMint()]);
    chain.utxos[0]!.datumHex = datumFor(OWNER_HASH, true);
    const result = await resolve(chain, LEGACY_DID);
    expect(result.didDocument).toEqual({ "@context": DID_CONTEXT, id: LEGACY_DID });
    expect(result.didDocumentMetadata.vectorMetadataError).toBe("controllerIsScript");
    expect(chain.witnessCalls).toEqual([]);
  });

  test("an undecodable datum renders no verification method", async () => {
    const chain = FakeChain.history([realMint()]);
    chain.utxos[0]!.datumHex = "d87980";
    const result = await resolve(chain, LEGACY_DID);
    expect(result.didDocument).toEqual({ "@context": DID_CONTEXT, id: LEGACY_DID });
    expect(result.didDocumentMetadata.vectorMetadataError).toBe("recordDatumInvalid");
  });
});

describe("burned token", () => {
  test("resolves as deactivated (HTTP 410) with a minimal document", async () => {
    const chain = FakeChain.history([realMint(), { kind: "burn", height: 4_900_000, witnesses: [OWNER_KEY] }]);
    const result = await resolve(chain, LEGACY_DID);
    expect(httpStatus(result)).toBe(410);
    expect(result.didDocument).toEqual({ "@context": DID_CONTEXT, id: LEGACY_DID });
    expect(result.didDocumentMetadata).toEqual({
      created: "2026-04-15T21:02:22Z",
      updated: "2026-06-08T06:26:40Z",
      deactivated: true,
      canonicalId: CANONICAL_DID,
      vectorOrigin: "legacy",
      vectorLedger: {
        txId: chain.txs[1]!.txHash,
        blockHash: chain.txs[1]!.blockHash,
        blockHeight: 4_900_000,
        slot: 4_900_000 * 4,
        confirmations: chain.tipInfo.blockHeight - 4_900_000,
      },
    });
  });
});

describe("not found", () => {
  test("an identifier that was never minted is NOT_FOUND (404)", async () => {
    const result = await resolve(new FakeChain(), `did:vector:${"ab".repeat(32)}`);
    expect(httpStatus(result)).toBe(404);
    expect(result.didDocument).toBeNull();
    expect(result.didResolutionMetadata.error).toMatchObject({ type: "https://www.w3.org/ns/did#NOT_FOUND" });
  });

  test("a token held outside the registry address is not an authentic record", async () => {
    const chain = FakeChain.history([realMint()]);
    chain.utxos[0]!.address = WALLET;
    const result = await resolve(chain, LEGACY_DID);
    expect(httpStatus(result)).toBe(404);
    expect(result.didResolutionMetadata.error?.detail).toContain("authentic");
  });

  test("a record output holding a second token of the policy is not authentic", async () => {
    const chain = FakeChain.history([realMint()]);
    chain.utxos[0]!.assets.push({ policyId: POLICY, assetName: "cd".repeat(32), quantity: 1n });
    expect(httpStatus(await resolve(chain, LEGACY_DID))).toBe(404);
  });

  test("a legacy DID naming another policy is NOT_FOUND", async () => {
    const result = await resolve(FakeChain.history([realMint()]), `did:vector:agent:${"0".repeat(56)}:${ASSET}`);
    expect(httpStatus(result)).toBe(404);
  });
});

describe("invalid DIDs", () => {
  const cases: Array<[string, string]> = [
    ["uppercase vector-id", `did:vector:${ASSET.toUpperCase()}`],
    ["uppercase legacy policy", `did:vector:agent:${POLICY.toUpperCase()}:${ASSET}`],
    ["uppercase legacy asset", `did:vector:agent:${POLICY}:${ASSET.toUpperCase()}`],
    ["uppercase method", `did:VECTOR:${ASSET}`],
    ["uppercase literal", `did:vector:AGENT:${POLICY}:${ASSET}`],
    ["unknown network", `did:vector:preprod:${ASSET}`],
    ["short vector-id", `did:vector:${ASSET.slice(2)}`],
    ["long vector-id", `did:vector:${ASSET}00`],
    ["legacy without policy", `did:vector:agent:${ASSET}`],
    ["short legacy policy", `did:vector:agent:${POLICY.slice(2)}:${ASSET}`],
    ["non-hex", `did:vector:${"g".repeat(64)}`],
    ["path", `did:vector:${ASSET}/path`],
    ["not a DID", "vector:abc"],
    ["empty", ""],
  ];
  test.each(cases)("%s is INVALID_DID (400)", async (_name, did) => {
    const result = await resolve(new FakeChain(), did);
    expect(result.didResolutionMetadata.error?.type).toBe("https://www.w3.org/ns/did#INVALID_DID");
    expect(httpStatus(result)).toBe(400);
    expect(result.didDocument).toBeNull();
  });

  test("another DID method is METHOD_NOT_SUPPORTED (501)", async () => {
    const result = await resolve(new FakeChain(), "did:web:example.com");
    expect(result.didResolutionMetadata.error?.type).toBe("https://www.w3.org/ns/did#METHOD_NOT_SUPPORTED");
    expect(httpStatus(result)).toBe(501);
  });

  test("testnet and resolution options are FEATURE_NOT_SUPPORTED (501)", async () => {
    const testnet = await resolve(new FakeChain(), `did:vector:testnet:${ASSET}`);
    expect(testnet.didResolutionMetadata.error?.type).toBe("https://www.w3.org/ns/did#FEATURE_NOT_SUPPORTED");
    const versioned = await resolve(FakeChain.history([realMint()]), LEGACY_DID, { versionId: "0" });
    expect(versioned.didResolutionMetadata.error?.type).toBe("https://www.w3.org/ns/did#FEATURE_NOT_SUPPORTED");
    expect(httpStatus(versioned)).toBe(501);
  });
});

describe("determinism", () => {
  const steps = () => [realMint(), { kind: "update" as const, height: 4_900_000, owner: HASH_B, witnesses: [OWNER_KEY] }];
  const others = [{ height: 4_960_000, witnesses: [KEY_B], credentials: [HASH_B] }];

  test("two renders of the same ledger state are byte-identical under JCS", async () => {
    const first = canonicalize(await resolve(FakeChain.history(steps(), others), LEGACY_DID));
    const reordered = FakeChain.history(steps(), others);
    reordered.txs.reverse();
    const second = canonicalize(await new DidVectorResolver(reordered).resolve(LEGACY_DID));
    expect(second).toBe(first);
  });

  test("the serialisation is canonical: sorted members, no whitespace", async () => {
    const body = canonicalize(await resolve(FakeChain.history(steps(), others), LEGACY_DID));
    expect(canonicalize(JSON.parse(body))).toBe(body);
    expect(body).not.toMatch(/\s/);
    expect(body.indexOf('"didDocument"')).toBeLessThan(body.indexOf('"didDocumentMetadata"'));
    expect(body.indexOf('"didDocumentMetadata"')).toBeLessThan(body.indexOf('"didResolutionMetadata"'));
  });
});
