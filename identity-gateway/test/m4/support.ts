// Shared setup of the M4 tests: throwaway gateway and agent keys, a gateway with the M4 routes on a
// FakeChain ledger, agent-signed JWTs, DPoP proofs and delegation records. No key here signs
// anything outside the tests.

import { blake2b } from "@noble/hashes/blake2b";
import { createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import type { Server } from "node:http";
import type { LedgerTx } from "../../src/chain/types.js";
import { keyHash } from "../../src/codec/keys.js";
import { gatewayKey, type GatewayKeys } from "../../src/keys/gateway-keys.js";
import { encodeDelegationDatum, type DelegationDatum } from "../../src/m4/delegation-datum.js";
import { createM4Services, type M4Services } from "../../src/m4/index.js";
import { jwkThumbprint, signJws, type PublicJwk } from "../../src/m4/jose.js";
import { VectorResolver } from "../../src/resolve/resolver.js";
import { registryOf } from "../../src/resolve/settings.js";
import { createResolverServer } from "../../src/server/http.js";
import { m4Routes } from "../../src/server/routes-m4.js";
import { LedgerBuilder, WALLET, blockHashAt, idOf, slotAt, timeAt } from "../support/ledger.js";

export const BASE = "https://id.vector.apexfusion.org";
export const TOKEN_URL = `${BASE}/token`;
export const TRUST_DOMAIN = "id.vector.apexfusion.org";
export const GATEWAY_ID = idOf("gateway");
/** A stand-in delegation contract: its policy ID is blake2b-224 of a label. */
export const DELEGATION = registryOf(Buffer.from(blake2b(Buffer.from("did:vector test delegation contract"), { dkLen: 28 })).toString("hex"));
/** The tests' clock: 10 s after the block time of the default tip (height 1000). */
export const NOW = timeAt(1000) + 10_000;
export const nowS = (ms = NOW): number => Math.floor(ms / 1000);

// ── keys ──

export interface TestKey {
  readonly kind: "Ed25519" | "P256";
  /** As a record stores it: 32 bytes, or the 33-byte compressed point. */
  readonly publicKey: string;
  readonly keyHash: string;
  readonly privateKey: KeyObject;
  readonly jwk: PublicJwk;
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** The P-256 `pop` over `did:vector:<id>#<key hash>`. */
  pop(vectorId: string): string;
}

function testKey(privateKey: KeyObject): TestKey {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const kind = jwk.kty === "OKP" ? "Ed25519" : "P256";
  const x = Buffer.from(jwk.x!, "base64url");
  const publicKey =
    kind === "Ed25519" ? x.toString("hex") : Buffer.concat([Buffer.from([Buffer.from(jwk.y!, "base64url")[31]! & 1 ? 3 : 2]), x]).toString("hex");
  const signBytes = (data: Uint8Array): Buffer => (kind === "Ed25519" ? sign(null, data, privateKey) : sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" }));
  return {
    kind,
    publicKey,
    keyHash: keyHash(publicKey),
    privateKey,
    jwk: kind === "Ed25519" ? { kty: "OKP", crv: "Ed25519", x: jwk.x! } : { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
    sign: async (data) => new Uint8Array(signBytes(data)),
    pop: (vectorId) => signBytes(Buffer.from(`did:vector:${vectorId}#${keyHash(publicKey)}`, "utf8")).toString("hex"),
  };
}

/** Ed25519 key from the 32-byte seed `seedByte` repeated (the derivation of test/support/keys.ts). */
export function edKey(seedByte: number): TestKey {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seedByte)]);
  return testKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }));
}

/** P-256 key with the private scalar `scalarByte` repeated 32 times. */
export function p256TestKey(scalarByte: number): TestKey {
  const d = Buffer.alloc(32, scalarByte);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return testKey(
    createPrivateKey({
      key: { kty: "EC", crv: "P-256", d: d.toString("base64url"), x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
      format: "jwk",
    }),
  );
}

let cachedGatewayKeys: GatewayKeys | null = null;
export function gatewayKeys(): GatewayKeys {
  cachedGatewayKeys ??= {
    ed25519: gatewayKey(generateKeyPairSync("ed25519").privateKey, GATEWAY_ID),
    p256: gatewayKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey, GATEWAY_ID),
  };
  return cachedGatewayKeys;
}

// ── gateway ──

export interface Harness {
  readonly builder: LedgerBuilder;
  readonly services: M4Services;
  readonly resolver: VectorResolver;
  readonly url: string;
  readonly logs: string[];
  /** The services' clock (POSIX ms); tests may move it. */
  now: number;
}

const servers: Server[] = [];

export async function startGateway(builder: LedgerBuilder, options: { delegations?: boolean; refreshMs?: number } = {}): Promise<Harness> {
  const logs: string[] = [];
  const resolver = new VectorResolver(builder.chain, builder.settings, { log: (m) => logs.push(m) });
  const harness = { builder, resolver, logs, now: NOW } as Harness;
  const services = createM4Services({
    settings: {
      baseUrl: BASE,
      gatewayId: GATEWAY_ID,
      trustDomain: TRUST_DOMAIN,
      delegation: options.delegations === false ? null : DELEGATION,
      statusListRefreshMs: options.refreshMs ?? 60_000,
    },
    keys: gatewayKeys(),
    records: resolver,
    chain: builder.chain,
    now: () => harness.now,
    log: (m) => logs.push(m),
  });
  const server = createResolverServer(resolver, { log: (m) => logs.push(m), routes: [m4Routes(services)] });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server has no TCP address");
  Object.assign(harness, { services, url: `http://127.0.0.1:${address.port}` });
  return harness;
}

export async function stopGateways(): Promise<void> {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
}

// ── JWTs ──

export const didOf = (vectorId: string): string => `did:vector:${vectorId}`;
export const jti = (): string => randomBytes(12).toString("base64url");

export interface JwtOptions {
  readonly claims?: Record<string, unknown>;
  readonly header?: Record<string, unknown>;
  /** Signs with this key but names `key` in kid. */
  readonly signWith?: TestKey;
  readonly now?: number;
}

/** A JWT that an agent signs: iss = sub = its DID, aud = the token endpoint, 2 minutes. */
export function agentJwt(key: TestKey, vectorId: string, options: JwtOptions = {}): Promise<string> {
  const iat = nowS(options.now);
  const header = { alg: key.kind === "Ed25519" ? "EdDSA" : "ES256", kid: `${didOf(vectorId)}#${key.keyHash}`, ...options.header };
  const claims = { iss: didOf(vectorId), sub: didOf(vectorId), aud: TOKEN_URL, iat, exp: iat + 120, jti: jti(), ...options.claims };
  return signJws(header, claims, options.signWith ?? key);
}

/** A DPoP proof (RFC 9449 Section 4.2) for POST /token. */
export function dpopProof(key: TestKey, options: { claims?: Record<string, unknown>; header?: Record<string, unknown>; now?: number } = {}): Promise<string> {
  return signJws(
    { typ: "dpop+jwt", alg: key.kind === "Ed25519" ? "EdDSA" : "ES256", jwk: key.jwk, ...options.header },
    { jti: jti(), htm: "POST", htu: TOKEN_URL, iat: nowS(options.now), ...options.claims },
    key,
  );
}

export const thumbprint = (key: TestKey): string => jwkThumbprint(key.jwk);

/** Header and claims of a compact JWS, without verification. */
export function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h!, "base64url").toString("utf8")), payload: JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) };
}

/** Verifies a gateway ES256 JWS with the gateway's public P-256 JWK. */
export function verifiedByGateway(jwt: string): boolean {
  const [h, p, s] = jwt.split(".");
  const key = createPublicKey({ key: { ...gatewayKeys().p256.publicJwk }, format: "jwk" });
  return verify("sha256", Buffer.from(`${h}.${p}`, "ascii"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
}

// ── requests ──

export function postForm(h: Harness, path: string, params: Record<string, string | readonly string[]>, headers: Record<string, string> = {}): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) for (const v of typeof value === "string" ? [value] : value) body.append(name, v);
  return fetch(`${h.url}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: body.toString() });
}

export function postJson(h: Harness, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${h.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/** A JSON object response body. */
export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await res.text());
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("the body is not a JSON object");
  return value as Record<string, unknown>;
}

/** A value that must be a string (a token in a response). */
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

/** The member at a path of parsed JSON (object members or array positions); throws when a step is missing. */
export function at(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const step of path) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, step)) throw new Error(`the JSON value has no member ${String(step)}`);
    current = Reflect.get(current, step);
  }
  return current;
}

/** A value that must be a JSON array. */
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  return value;
}

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** A token exchange request with the subject token and a DPoP proof by `dpopKey`. */
export async function requestToken(
  h: Harness,
  subjectToken: string,
  dpopKey: TestKey,
  extra: Record<string, string | readonly string[]> = {},
): Promise<Response> {
  return postForm(
    h,
    "/token",
    { grant_type: TOKEN_EXCHANGE, subject_token: subjectToken, subject_token_type: JWT_TYPE, audience: "https://rs.example.org", ...extra },
    { dpop: await dpopProof(dpopKey, { now: h.now }) },
  );
}

/** A client assertion (RFC 7523) by an agent's authentication key. */
export async function clientAuth(key: TestKey, vectorId: string, now?: number): Promise<Record<string, string>> {
  return { client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: await agentJwt(key, vectorId, { now }) };
}

// ── delegation records ──

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const utf8Hex = (text: string): string => Buffer.from(text, "utf8").toString("hex");
export const delegationIdOf = (label: string): string => sha256(`delegation:${label}`);

let delegationTxCount = 0;

function pushTx(builder: LedgerBuilder, height: number, tx: Omit<LedgerTx, "txHash" | "blockHash" | "blockHeight" | "slot" | "txIndex">): LedgerTx {
  const full: LedgerTx = { txHash: sha256(`delegation tx ${delegationTxCount++}`), blockHash: blockHashAt(height), blockHeight: height, txIndex: 5, slot: slotAt(height), ...tx };
  builder.chain.txs.push(full);
  return full;
}

/** Mints a delegation: one output at the delegation address with the token and the inline datum. */
export function mintDelegation(builder: LedgerBuilder, id: string, datum: DelegationDatum, height: number, options: { address?: string } = {}): LedgerTx {
  const token = { policyId: DELEGATION.policyId, assetName: id, quantity: 1n };
  return pushTx(builder, height, {
    inputs: [{ txHash: sha256(`delegation seed ${id}`), outputIndex: 0, address: WALLET, assets: [] }],
    outputs: [
      {
        outputIndex: 0,
        address: options.address ?? DELEGATION.address,
        lovelace: 2_000_000n,
        assets: [token],
        inlineDatum: Buffer.from(encodeDelegationDatum(datum)).toString("hex"),
        datumHash: null,
        hasReferenceScript: false,
      },
    ],
    mint: [token],
  });
}

/** Undelegate: spends the delegation output and burns its token. */
export function undelegate(builder: LedgerBuilder, mint: LedgerTx, id: string, height: number): LedgerTx {
  return pushTx(builder, height, {
    inputs: [{ txHash: mint.txHash, outputIndex: 0, address: DELEGATION.address, assets: [{ policyId: DELEGATION.policyId, assetName: id, quantity: 1n }] }],
    outputs: [{ outputIndex: 0, address: WALLET, lovelace: 2_000_000n, assets: [], inlineDatum: null, datumHash: null, hasReferenceScript: false }],
    mint: [{ policyId: DELEGATION.policyId, assetName: id, quantity: -1n }],
  });
}
