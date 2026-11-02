/**
 * The published vectors of Part 2 §12.4 that are not DID documents (the
 * gateway publishes those in identity-gateway/test/vectors):
 *
 * - identifiers and their DNS-safe form (Part 1 §3.1, §3.2);
 * - `legacy_root` membership proofs (Part 2 §3.4), also for trees with an
 *   odd number of leaves;
 * - the attestation envelope: `Sig_structure`, protected header and Ed25519
 *   signature (Part 2 §4.2);
 * - the status-list bits of the gateway's vector set (Part 2 §8.4, §8.6).
 *
 * generate.ts writes them to contracts/identity-marketplace/vectors/ and
 * writes the Aiken checks of the identifiers and the proofs. The tests compute
 * every vector again and compare.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";
import {
  buildAllowlistTree,
  dnsSafe,
  keyHash,
  legacyVectorDid,
  serialiseSeed,
  vectorDid,
  vectorIdFromSeed,
  verifyAllowlistProof,
} from "@marketplace/shared/identity";
import { gatewayKey } from "../../identity-gateway/src/keys/gateway-keys.js";
import type { M4Context } from "../../identity-gateway/src/m4/context.js";
import { LIST_SIZE, StatusLists } from "../../identity-gateway/src/m4/status-lists.js";
import { VectorResolver } from "../../identity-gateway/src/resolve/resolver.js";
import { LEGACY_REGISTRY } from "../../identity-gateway/src/resolve/settings.js";
import { blockTimeMs } from "../../identity-gateway/src/resolve/time.js";
import { chainFromJson, type VectorFile } from "../../identity-gateway/test/vectors/format.js";
import {
  coseSign1,
  envelopeSignature,
  issuerDid,
  keyUrl,
  protectedHeader,
  protectedHeaderDiagnostic,
  sha256Hex,
  sigStructure,
  sigStructureDiagnostic,
  type EnvelopeInput,
} from "./envelope.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const VECTOR_DIR = join(REPO_ROOT, "contracts/identity-marketplace/vectors");
export const GATEWAY_VECTOR_DIR = join(REPO_ROOT, "identity-gateway/test/vectors");

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

// ─── Identifiers (Part 1 §3.1, §3.2) ─────────────────────────────────────

export interface IdentifierVector {
  readonly txId: string;
  readonly outputIndex: number;
  /** `serialise(seed)`: Plutus Data CBOR of `Constr 0 [tx_id, output_index]`. */
  readonly serialisedSeed: string;
  readonly vectorId: string;
  /** RFC 4648 base32, lowercase, without padding. */
  readonly dnsSafe: string;
  readonly did: string;
  readonly legacyDid: string;
}

/**
 * The two seeds of Part 1 §3.1, then seeds whose output index crosses each
 * length of the CBOR integer head (23/24, 255/256, 65535/65536).
 */
export const IDENTIFIER_SEEDS: ReadonlyArray<readonly [string, number]> = [
  ["00".repeat(32), 0],
  ["ab".repeat(32), 24],
  ["01".repeat(32), 1],
  ["ff".repeat(32), 23],
  [sha256Hex("did:vector identifier vector: index 255"), 255],
  [sha256Hex("did:vector identifier vector: index 256"), 256],
  [sha256Hex("did:vector identifier vector: index 65535"), 65_535],
  [sha256Hex("did:vector identifier vector: index 65536"), 65_536],
];

export function identifierVectors(): IdentifierVector[] {
  return IDENTIFIER_SEEDS.map(([txId, outputIndex]) => {
    const vectorId = vectorIdFromSeed(txId, outputIndex);
    return {
      txId,
      outputIndex,
      serialisedSeed: hex(serialiseSeed(txId, outputIndex)),
      vectorId,
      dnsSafe: dnsSafe(vectorId),
      did: vectorDid(vectorId),
      legacyDid: legacyVectorDid(LEGACY_REGISTRY.policyId, vectorId),
    };
  });
}

// ─── Allowlist (Part 2 §3.4) ─────────────────────────────────────────────

export interface AllowlistTreeVector {
  readonly name: string;
  /** In the order given to the tree builder. */
  readonly ids: readonly string[];
  /** blake2b_256 of each identifier, in ascending byte order. */
  readonly leaves: readonly string[];
  readonly root: string;
  readonly proofs: ReadonlyArray<{ readonly id: string; readonly proof: readonly string[] }>;
}

export interface AllowlistRejection {
  readonly description: string;
  readonly root: string;
  readonly id: string;
  readonly proof: readonly string[];
}

export interface AllowlistVectors {
  readonly trees: readonly AllowlistTreeVector[];
  /** Proofs that must not verify. */
  readonly rejections: readonly AllowlistRejection[];
}

/** Tree sizes: one leaf, powers of two and odd counts (a last node moves up unchanged). */
export const ALLOWLIST_SIZES = [1, 2, 3, 5, 7, 8, 13] as const;

/** `size` identifiers derived from seeds of one test transaction. */
export const allowlistIds = (size: number): string[] =>
  Array.from({ length: size }, (_, index) => vectorIdFromSeed(sha256Hex(`did:vector allowlist vector: ${size} leaves`), index));

/** The node `s` with its last bit flipped. */
const flipped = (node: string): string => `${node.slice(0, -1)}${(Number.parseInt(node.slice(-1), 16) ^ 1).toString(16)}`;

export function allowlistVectors(): AllowlistVectors {
  const trees = ALLOWLIST_SIZES.map((size): AllowlistTreeVector => {
    const ids = allowlistIds(size);
    const tree = buildAllowlistTree(ids);
    return {
      name: `${size} ${size === 1 ? "leaf" : "leaves"}`,
      ids,
      leaves: [...tree.leaves],
      root: tree.root,
      proofs: ids.map((id) => ({ id, proof: tree.proof(id) })),
    };
  });
  const byName = (name: string): AllowlistTreeVector => trees.find((t) => t.name === name)!;
  const seven = byName("7 leaves");
  const thirteen = byName("13 leaves");
  const five = byName("5 leaves");
  const last = thirteen.proofs[12]!;
  const first = thirteen.proofs[0]!;
  const rejections: AllowlistRejection[] = [
    { description: "an identifier of another tree, with the proof of a member", root: thirteen.root, id: seven.ids[0]!, proof: first.proof },
    { description: "a member whose first proof node has one bit changed", root: thirteen.root, id: first.id, proof: [flipped(first.proof[0]!), ...first.proof.slice(1)] },
    { description: "a member whose last proof node has one bit changed", root: thirteen.root, id: first.id, proof: [...first.proof.slice(0, -1), flipped(first.proof.at(-1)!)] },
    { description: "a member against the root of another tree", root: five.root, id: first.id, proof: first.proof },
    { description: "a member with an extra proof node", root: thirteen.root, id: first.id, proof: [...first.proof, first.proof.at(-1)!] },
    { description: "a member without its last proof node", root: thirteen.root, id: first.id, proof: first.proof.slice(0, -1) },
    { description: "a member with its proof in reverse order", root: thirteen.root, id: first.id, proof: [...first.proof].reverse() },
    { description: "a member with an empty proof in a tree of 13 leaves", root: thirteen.root, id: first.id, proof: [] },
    { description: "the carried last leaf with the proof of the first leaf", root: thirteen.root, id: last.id, proof: first.proof },
    { description: "the root itself as identifier, with an empty proof", root: thirteen.root, id: thirteen.root, proof: [] },
  ];
  for (const r of rejections) {
    if (verifyAllowlistProof(r.root, r.id, r.proof)) throw new Error(`allowlist rejection verifies: ${r.description}`);
  }
  return { trees, rejections };
}

// ─── Attestation envelope (Part 2 §4.2) ──────────────────────────────────

/** RFC 8032, Section 7.1, TEST 1: a published key that controls nothing. */
export const ENVELOPE_TEST_KEY = {
  source: "RFC 8032, Section 7.1, TEST 1 (https://www.rfc-editor.org/rfc/rfc8032#section-7.1)",
  secretKey: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
} as const;

export const envelopeTestKey = (): KeyObject =>
  createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(ENVELOPE_TEST_KEY.secretKey, "hex")]), format: "der", type: "pkcs8" });

/** The attestation document of the vectors (UTF-8). */
export const ENVELOPE_DOCUMENT = '{"type":"software","name":"vector-agent-template","version":"1.4.0"}';

export interface EnvelopeVector {
  readonly name: string;
  readonly attestation: EnvelopeInput & { readonly attType: number };
  readonly document: string;
  readonly issuerDid: string;
  readonly kid: string;
  readonly protectedHeader: { readonly hex: string; readonly diagnostic: string };
  readonly sigStructure: { readonly hex: string; readonly diagnostic: string };
  readonly signature: string;
  readonly coseSign1: string;
}

/**
 * Two envelopes by the RFC 8032 test key: a registered issuer with a
 * content format (every header member), and an unregistered issuer (did:key)
 * without one. The subject and the issuer identifier are the identifiers of
 * Part 1 §3.1.
 */
export function envelopeVectors(): EnvelopeVector[] {
  const key = envelopeTestKey();
  const base = {
    issuer: ENVELOPE_TEST_KEY.publicKey,
    subject: "3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b",
    issuedAt: 1_793_578_200_000,
    digest: sha256Hex(ENVELOPE_DOCUMENT),
    attType: 2,
  };
  const inputs: Array<{ name: string; attestation: EnvelopeInput & { attType: number } }> = [
    {
      name: "registered issuer, with format",
      attestation: { ...base, issuerId: "a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9", format: 50 },
    },
    { name: "did:key issuer, without format", attestation: { ...base, issuerId: null, format: null } },
  ];
  return inputs.map(({ name, attestation }) => {
    const signature = envelopeSignature(attestation, key);
    return {
      name,
      attestation,
      document: ENVELOPE_DOCUMENT,
      issuerDid: issuerDid(attestation),
      kid: keyUrl(attestation),
      protectedHeader: { hex: hex(protectedHeader(attestation)), diagnostic: protectedHeaderDiagnostic(attestation) },
      sigStructure: { hex: hex(sigStructure(attestation)), diagnostic: sigStructureDiagnostic(attestation) },
      signature: hex(signature),
      coseSign1: hex(coseSign1(attestation, signature)),
    };
  });
}

// ─── Status lists (Part 2 §8.4, §8.6) ────────────────────────────────────

export interface StatusListEntry {
  readonly vectorId: string;
  readonly origin: string;
  /** Null until the first mint has 30 confirmations. */
  readonly statusListIndex: number | null;
  /** The effective status of the view without options. */
  readonly effective: string;
  readonly effectiveReason: string | null;
  /** List n and position p of the index. */
  readonly list?: number;
  readonly position?: number;
  /** Token Status List value: 0 valid, 1 invalid, 2 suspended. */
  readonly tokenStatusList?: number;
  readonly bitstringStatusList?: {
    readonly revocationIndex: number;
    readonly revocation: number;
    readonly suspensionIndex: number;
    readonly suspension: number;
  };
}

export interface StatusListVector {
  readonly name: string;
  /** The gateway vector file that holds the ledger. */
  readonly source: string;
  readonly tip: { readonly blockHeight: number; readonly slot: number };
  readonly entries: readonly StatusListEntry[];
  /** List 0, uncompressed: the bytes that hold the indexed entries. */
  readonly tokenStatusListBytes: string;
  readonly bitstringRevocationBytes: string;
  readonly bitstringSuspensionBytes: string;
}

/** The gateway's identifier in the status-list contexts (a label hash; it signs nothing that is published). */
const GATEWAY_ID = sha256Hex("did:vector status-list vectors: gateway");

function jwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (part === undefined) throw new Error("not a compact JWS");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function member(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, name) => {
    if (typeof current !== "object" || current === null || !(name in current)) throw new Error(`missing member ${path.join(".")}`);
    return (current as Record<string, unknown>)[name];
  }, value);
}

/** List 0 of the gateway's status-list service (`StatusLists`), decoded from its signed JWTs. */
async function decodedLists(file: VectorFile, resolver: VectorResolver): Promise<{ tsl: Buffer; bsl: Buffer }> {
  const now = blockTimeMs(file.ledger.tip.slot, file.settings.network);
  const ctx: M4Context = {
    settings: {
      baseUrl: "https://id.vector.apexfusion.org",
      gatewayId: GATEWAY_ID,
      trustDomain: "id.vector.apexfusion.org",
      delegation: null,
      statusListRefreshMs: 60_000,
    },
    keys: {
      ed25519: gatewayKey(generateKeyPairSync("ed25519").privateKey, GATEWAY_ID),
      p256: gatewayKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey, GATEWAY_ID),
    },
    records: resolver,
    chain: chainFromJson(file.ledger),
    now: () => now,
    log: (message) => {
      throw new Error(`${file.name}: ${message}`);
    },
  };
  const lists = new StatusLists(ctx);
  const tslJwt = await lists.tokenStatusList(0);
  const bslJwt = await lists.bitstringStatusList(0);
  if (tslJwt === null || bslJwt === null) throw new Error(`${file.name}: no status list 0`);
  const lst = member(jwtPayload(tslJwt), "status_list", "lst");
  const encoded = member(jwtPayload(bslJwt), "credentialSubject", "encodedList");
  if (typeof lst !== "string" || typeof encoded !== "string" || !encoded.startsWith("u")) throw new Error(`${file.name}: bad status list`);
  return { tsl: inflateSync(Buffer.from(lst, "base64url")), bsl: gunzipSync(Buffer.from(encoded.slice(1), "base64url")) };
}

/** Bits `[from, from + count)` of a bitstring whose bit 0 is the most significant bit of byte 0, packed the same way. */
function bitRange(bits: Buffer, from: number, count: number): string {
  const out = Buffer.alloc(Math.ceil(count / 8));
  for (let i = 0; i < count; i += 1) {
    const bit = (bits[(from + i) >> 3]! >> (7 - ((from + i) & 7))) & 1;
    if (bit) out[i >> 3]! |= 0x80 >> (i & 7);
  }
  return out.toString("hex");
}

export const gatewayVectorFiles = (): VectorFile[] =>
  readdirSync(GATEWAY_VECTOR_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(GATEWAY_VECTOR_DIR, f), "utf8")) as VectorFile);

export async function statusListVectors(): Promise<StatusListVector[]> {
  const out: StatusListVector[] = [];
  for (const file of gatewayVectorFiles()) {
    const resolver = new VectorResolver(chainFromJson(file.ledger), file.settings, {
      log: (message) => {
        throw new Error(`${file.name}: ${message}`);
      },
    });
    const { entries } = await resolver.listRecords();
    const { tsl, bsl } = await decodedLists(file, resolver);
    if (tsl.length !== (LIST_SIZE * 2) / 8 || bsl.length !== (LIST_SIZE * 2) / 8) throw new Error(`${file.name}: bad list length`);
    const indexed = entries.filter((e) => e.statusListIndex !== null).length;
    const rows: StatusListEntry[] = [];
    for (const entry of entries) {
      const lookup = await resolver.currentRecord(entry.vectorId);
      if (!lookup.found) throw new Error(`${file.name}: ${entry.vectorId} does not resolve`);
      const { status, reason } = lookup.record.effective;
      const base = { vectorId: entry.vectorId, origin: entry.origin, statusListIndex: entry.statusListIndex, effective: status, effectiveReason: reason };
      const i = entry.statusListIndex;
      if (i === null) {
        rows.push(base);
        continue;
      }
      rows.push({
        ...base,
        list: Math.floor(i / LIST_SIZE),
        position: i % LIST_SIZE,
        tokenStatusList: (tsl[i >> 2]! >> ((i & 3) * 2)) & 0b11,
        bitstringStatusList: {
          revocationIndex: i,
          revocation: (bsl[i >> 3]! >> (7 - (i & 7))) & 1,
          suspensionIndex: LIST_SIZE + i,
          suspension: (bsl[(LIST_SIZE + i) >> 3]! >> (7 - ((LIST_SIZE + i) & 7))) & 1,
        },
      });
    }
    out.push({
      name: file.name,
      source: `identity-gateway/test/vectors/${file.name}.json`,
      tip: { blockHeight: file.ledger.tip.blockHeight, slot: file.ledger.tip.slot },
      entries: rows,
      tokenStatusListBytes: tsl.subarray(0, Math.ceil(indexed / 4)).toString("hex"),
      bitstringRevocationBytes: bitRange(bsl, 0, indexed),
      bitstringSuspensionBytes: bitRange(bsl, LIST_SIZE, indexed),
    });
  }
  return out;
}

// ─── Vector files ────────────────────────────────────────────────────────

const FILE_HEADER = {
  identifiers: {
    description:
      "Identifier derivation and DNS-safe form. vector-id = hex(blake2b_256(serialise(seed))), where serialise(seed) is the Plutus Data CBOR of Constr 0 [tx_id, output_index]; the DNS-safe form is RFC 4648 base32 of the 32 bytes, lowercase, without padding. The first two vectors are those of Part 1 §3.1.",
    specification: "docs/did-vector-method.md §3, §3.1, §3.2",
  },
  allowlist: {
    description:
      "legacy_root membership proofs. Leaves: blake2b_256(id), sorted ascending; a node is blake2b_256(min(l, r) ++ max(l, r)); a last node without a pair moves up unchanged; a proof lists the paired nodes from the leaf upward. Every proof of `trees` verifies; no case of `rejections` verifies. Built with the TypeScript helper of @marketplace/shared/identity; lib/identity_marketplace/properties/published_vectors.ak checks them with allowlist.member.",
    specification: "docs/IDENTITY_REGISTRY.md §3.4",
  },
  envelope: {
    description:
      "Attestation envelopes: the protected header in RFC 8949 core deterministic encoding, Sig_structure = [\"Signature1\", protected, h'', digest] (RFC 9052 §4.4), the Ed25519 signature of the encoded Sig_structure (envelope_sig) and the COSE_Sign1 message (tag 18, empty unprotected header, the digest as payload). Header labels: 1 alg (-19 Ed25519, RFC 9864), 4 kid (UTF-8 key URL), 15 CWT claims (RFC 9597: 1 iss, 2 sub, 6 iat = floor(issued_at / 1000)), 258 payload hash algorithm (-16 SHA-256) and 259 preimage content type (RFC 9995).",
    specification: "docs/IDENTITY_REGISTRY.md §4.2",
  },
  statusLists: {
    description:
      "Status-list bits of the gateway's DID-document vector set, produced by the gateway's status-list service (identity-gateway/src/m4/status-lists.ts) and decoded from its signed lists. Index i of an identifier comes from the ledger order of its first mint (30 confirmations); it is in list floor(i / 131072) at position i mod 131072. Token Status List (2 bits, entry 0 in the least significant bits of byte 0): 0 valid (Active), 1 invalid (Revoked or Retired), 2 suspended. Bitstring Status List (bit 0 is the most significant bit of byte 0): the revocation bit at position p, the suspension bit at 131072 + p. The *Bytes members are the uncompressed bytes that hold the indexed entries of list 0.",
    specification: "docs/IDENTITY_REGISTRY.md §8.4, §8.6; docs/did-vector-method.md §7.3",
  },
} as const;

/** The text of a published vector file: two-space JSON and a final newline. */
export const vectorFileText = (content: unknown): string => `${JSON.stringify(content, null, 2)}\n`;

export const identifiersFile = (): string =>
  vectorFileText({ name: "identifiers", ...FILE_HEADER.identifiers, vectors: identifierVectors() });

export const allowlistFile = (): string => vectorFileText({ name: "allowlist", ...FILE_HEADER.allowlist, ...allowlistVectors() });

export const envelopeFile = (): string =>
  vectorFileText({
    name: "attestation-envelope",
    ...FILE_HEADER.envelope,
    testKey: ENVELOPE_TEST_KEY,
    issuerKeyHash: keyHash(ENVELOPE_TEST_KEY.publicKey),
    vectors: envelopeVectors(),
  });

export const statusListsFile = async (): Promise<string> =>
  vectorFileText({ name: "status-lists", ...FILE_HEADER.statusLists, vectors: await statusListVectors() });

/** The text of each vector file, by file name. */
export async function vectorFiles(): Promise<Record<string, string>> {
  return {
    "identifiers.json": identifiersFile(),
    "allowlist.json": allowlistFile(),
    "attestation-envelope.json": envelopeFile(),
    "status-lists.json": await statusListsFile(),
  };
}

/** The published text of a vector file. */
export const publishedFile = (name: string): string => readFileSync(join(VECTOR_DIR, name), "utf8");
