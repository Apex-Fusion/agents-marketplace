// JOSE, DER and single-use stores of the M4 services, against the published test vectors.

import { createPrivateKey } from "node:crypto";
import { describe, expect, test } from "vitest";
import { gatewayKey } from "../../src/keys/gateway-keys.js";
import { NO_EXPIRY, children, decode, decodeOid, ecdsaSignatureDer, oid, time, unsignedInteger } from "../../src/m4/der.js";
import { htuForm } from "../../src/m4/dpop.js";
import { JoseError, fromB64url, jwkThumbprint, parseJws, publicJwkKey, verifyJws } from "../../src/m4/jose.js";
import { CapacityError, NonceStore, SingleUseStore } from "../../src/m4/replay.js";
import { GATEWAY_ID } from "./support.js";

/** RFC 8037 Appendix A.1 and A.4. */
const RFC8037_KEY = { kty: "OKP", crv: "Ed25519", d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };
const RFC8037_SIGNING_INPUT = "eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc";
const RFC8037_SIGNATURE = "hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg";

/** RFC 7515 Appendix A.3. */
const RFC7515_ES256_JWS =
  "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q";
const RFC7515_ES256_KEY = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" };

describe("JOSE", () => {
  test("RFC 8037 A.3: the JWK thumbprint of the Ed25519 example key", () => {
    expect(jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: RFC8037_KEY.x })).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  test("RFC 8037 A.4 and A.5: the gateway signer gives the example Ed25519 signature, and it verifies", async () => {
    const key = gatewayKey(createPrivateKey({ key: RFC8037_KEY, format: "jwk" }), GATEWAY_ID);
    expect(Buffer.from(await key.sign(Buffer.from(RFC8037_SIGNING_INPUT, "ascii"))).toString("base64url")).toBe(RFC8037_SIGNATURE);
    expect(key.publicJwk.x).toBe(RFC8037_KEY.x);
    const { key: publicKey } = publicJwkKey({ kty: "OKP", crv: "Ed25519", x: RFC8037_KEY.x });
    const jws = { header: {}, payload: {}, signingInput: Buffer.from(RFC8037_SIGNING_INPUT, "ascii"), signature: fromB64url(RFC8037_SIGNATURE, "signature") };
    expect(verifyJws(jws, "Ed25519", publicKey)).toBe(true);
    expect(verifyJws({ ...jws, signingInput: Buffer.from(`${RFC8037_SIGNING_INPUT}x`) }, "Ed25519", publicKey)).toBe(false);
  });

  test("RFC 7515 A.3: the ES256 example verifies", () => {
    const jws = parseJws(RFC7515_ES256_JWS);
    expect(jws.header).toEqual({ alg: "ES256" });
    expect(jws.payload).toEqual({ iss: "joe", exp: 1300819380, "http://example.com/is_root": true });
    expect(verifyJws(jws, "P256", publicJwkKey(RFC7515_ES256_KEY).key)).toBe(true);
    expect(verifyJws(jws, "Ed25519", publicJwkKey({ kty: "OKP", crv: "Ed25519", x: RFC8037_KEY.x }).key)).toBe(false);
  });

  test("base64url is decoded strictly", () => {
    expect(fromB64url("AQAB", "x").toString("hex")).toBe("010001");
    for (const bad of ["AQAB=", "AQ+B", "AQ/B", "A", "AR"]) expect(() => fromB64url(bad, "x")).toThrow(JoseError);
  });

  test("a JWS needs three parts, JSON objects, and no extension header", () => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const sig = Buffer.alloc(64).toString("base64url");
    expect(() => parseJws(`${part({ alg: "ES256" })}.${part({})}`)).toThrow(/compact serialisation/);
    expect(() => parseJws(`${part([1])}.${part({})}.${sig}`)).toThrow(/not a JSON object/);
    expect(() => parseJws(`${part({ alg: "ES256" })}.${part("text")}.${sig}`)).toThrow(/not a JSON object/);
    expect(() => parseJws(`${part({ alg: "ES256", crit: ["b64"], b64: false })}.${part({})}.${sig}`)).toThrow(/extension/);
    expect(() => parseJws(`${Buffer.from([0xff, 0xfe]).toString("base64url")}.${part({})}.${sig}`)).toThrow(/UTF-8 JSON/);
    expect(() => parseJws("a".repeat(20_000))).toThrow(/too long/);
    expect(() => parseJws(undefined)).toThrow(/missing/);
  });

  test("only public Ed25519 and P-256 JWKs are accepted", () => {
    expect(publicJwkKey(RFC7515_ES256_KEY).publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(() => publicJwkKey({ ...RFC7515_ES256_KEY, d: "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI" })).toThrow(/private key/);
    expect(() => publicJwkKey({ kty: "RSA", n: "AQAB", e: "AQAB" })).toThrow(/not an Ed25519/);
    expect(() => publicJwkKey({ kty: "EC", crv: "P-384", x: RFC7515_ES256_KEY.x, y: RFC7515_ES256_KEY.y })).toThrow(/not an Ed25519/);
    expect(() => publicJwkKey({ ...RFC7515_ES256_KEY, y: RFC7515_ES256_KEY.x })).toThrow(/not a valid public key/);
    expect(() => publicJwkKey({ kty: "OKP", crv: "Ed25519", x: "AQAB" })).toThrow(/32 bytes/);
    expect(() => publicJwkKey("jwk")).toThrow(/not a JSON object/);
  });

  test("htu comparison form (RFC 9449 Section 4.3)", () => {
    expect(htuForm("https://ID.Vector.apexfusion.org:443/token?a=b#c")).toBe("https://id.vector.apexfusion.org/token");
    expect(htuForm("https://id.vector.apexfusion.org:8443/token")).toBe("https://id.vector.apexfusion.org:8443/token");
    expect(htuForm("ftp://x/token")).toBeNull();
    expect(htuForm("token")).toBeNull();
  });
});

describe("DER", () => {
  test("object identifiers, integers and times", () => {
    expect(oid("1.2.840.10045.4.3.2").toString("hex")).toBe("06082a8648ce3d040302");
    expect(oid("2.5.29.56").toString("hex")).toBe("0603551d38");
    expect(decodeOid(decode(oid("1.3.6.1.5.5.7.3.2")))).toBe("1.3.6.1.5.5.7.3.2");
    expect(unsignedInteger(Uint8Array.of(0x80)).toString("hex")).toBe("02020080");
    expect(unsignedInteger(Uint8Array.of(0, 0, 1)).toString("hex")).toBe("020101");
    expect(unsignedInteger(Uint8Array.of(0)).toString("hex")).toBe("020100");
    expect(time(Date.UTC(2026, 10, 2, 16, 30, 5)).toString("ascii").slice(2)).toBe("261102163005Z");
    expect(time(Date.UTC(2050, 0, 1)).toString("ascii").slice(2)).toBe("20500101000000Z");
    expect(NO_EXPIRY.toString("ascii").slice(2)).toBe("99991231235959Z");
  });

  test("the decoder is strict about lengths", () => {
    expect(() => decode(Buffer.from("3081050500", "hex"))).toThrow(/shortest form/);
    expect(() => decode(Buffer.from("3080", "hex"))).toThrow(/indefinite/);
    expect(() => decode(Buffer.from("300500", "hex"))).toThrow(/truncated/);
    expect(() => decode(Buffer.from("30000000", "hex"))).toThrow(/trailing/);
    expect(children(decode(Buffer.from("3006020101020102", "hex"))).map((c) => c.content.toString("hex"))).toEqual(["01", "02"]);
  });

  test("an ES256 signature r || s becomes an ECDSA-Sig-Value", () => {
    const sig = Buffer.concat([Buffer.alloc(32, 0x80), Buffer.concat([Buffer.alloc(1), Buffer.alloc(31, 1)])]);
    const der = ecdsaSignatureDer(sig);
    const [r, s] = children(decode(der));
    expect(r!.content.toString("hex")).toBe(`00${"80".repeat(32)}`);
    expect(s!.content.toString("hex")).toBe("01".repeat(31));
  });
});

describe("single-use stores", () => {
  test("a value is refused while it is kept, and the store fails closed when full", () => {
    const store = new SingleUseStore(2);
    expect(store.use("a", 1000, 0)).toBe(true);
    expect(store.use("a", 1000, 500)).toBe(false);
    expect(store.use("b", 1000, 500)).toBe(true);
    expect(() => store.use("c", 1000, 500)).toThrow(CapacityError);
    expect(store.use("c", 3000, 1000)).toBe(true);
  });

  test("a nonce is used once and expires after its lifetime", () => {
    const nonces = new NonceStore(300_000, 2);
    const a = nonces.issue(0);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonces.consume(a, 300_000)).toBe("ok");
    expect(nonces.consume(a, 300_000)).toBe("unknown");
    const b = nonces.issue(0);
    expect(nonces.consume(b, 300_001)).toBe("expired");
    nonces.issue(0);
    nonces.issue(0);
    expect(() => nonces.issue(1)).toThrow(CapacityError);
    expect(typeof nonces.issue(300_001)).toBe("string");
  });
});
