// Delegation tokens (Part 2 Sections 5.1, 5.2 and 5.4): the whole chain passes the use checks off
// the ledger; the token carries the delegators in a nested `act` claim and the granted actions and
// resources in `authorization_details`.

import { afterEach, describe, expect, test } from "vitest";
import { DELEGATION_DETAILS_TYPE, covers, isActionPattern, isResourcePattern, narrower, patternCovers } from "../../src/m4/delegation.js";
import type { DelegationDatum } from "../../src/m4/delegation-datum.js";
import { LedgerBuilder, WALLET, identityDatum, idOf, timeAt } from "../support/ledger.js";
import {
  DELEGATION,
  NOW,
  agentJwt,
  bodyOf,
  clientAuth,
  decodeJwt,
  delegationIdOf,
  didOf,
  edKey,
  mintDelegation,
  nowS,
  p256TestKey,
  postForm,
  requestToken,
  startGateway,
  stopGateways,
  text,
  thumbprint,
  undelegate,
  utf8Hex,
  type Harness,
  type TestKey,
} from "./support.js";

const OWNER = idOf("m4 delegation owner");
const DELEGATE = idOf("m4 delegation delegate");
const OWNER_AUTH = edKey(81);
const OWNER_DELEGATION_KEY = edKey(82);
const DELEGATE_AUTH = edKey(83);
const DELEGATE_KEY = edKey(84);
const PRINCIPAL = edKey(85);
const OTHER = edKey(86);
const ESCROW = `script:${"ab".repeat(28)}`;
const ROOT = delegationIdOf("root");
const LEAF = delegationIdOf("leaf");

const hexList = (items: readonly string[]): string[] => items.map(utf8Hex);

function root(overrides: Partial<DelegationDatum> = {}): DelegationDatum {
  return {
    delegator: { type: "PrincipalKey", hash: PRINCIPAL.keyHash, organisation: utf8Hex("example.org") },
    parent: null,
    delegate: OWNER,
    delegateKey: OWNER_DELEGATION_KEY.keyHash,
    actions: hexList(["marketplace.*", "ocr.*"]),
    resources: hexList([ESCROW, "https://api.example.org/v1"]),
    notBefore: timeAt(0),
    notAfter: NOW + 7_200_000,
    depth: 1,
    remaining: 2,
    purpose: "cd".repeat(32),
    value: { perTx: 10_000_000n, total: 100_000_000n, periodMs: 86_400_000 },
    ...overrides,
  };
}

function leaf(overrides: Partial<DelegationDatum> = {}): DelegationDatum {
  return {
    delegator: { type: "Agent", id: OWNER },
    parent: ROOT,
    delegate: DELEGATE,
    delegateKey: DELEGATE_KEY.keyHash,
    actions: hexList(["marketplace.hire.v1"]),
    resources: hexList([ESCROW]),
    notBefore: timeAt(0),
    notAfter: NOW + 3_600_000,
    depth: 2,
    remaining: 0,
    purpose: null,
    value: { perTx: 5_000_000n, total: 50_000_000n, periodMs: 86_400_000 },
    ...overrides,
  };
}

interface Setup {
  readonly root?: DelegationDatum;
  readonly leaf?: DelegationDatum;
  readonly leafHeight?: number;
  readonly owner?: Parameters<typeof identityDatum>[0];
  readonly delegate?: Parameters<typeof identityDatum>[0];
}

function ledger(setup: Setup = {}): LedgerBuilder {
  const b = new LedgerBuilder();
  b.register(
    OWNER,
    identityDatum({
      keys: [
        { keyType: "Ed25519", key: OWNER_AUTH.publicKey, purposes: 1, pop: null },
        { keyType: "Ed25519", key: OWNER_DELEGATION_KEY.publicKey, purposes: 16, pop: null },
      ],
      ...setup.owner,
    }),
    { height: 100 },
  );
  b.register(
    DELEGATE,
    identityDatum({
      keys: [
        { keyType: "Ed25519", key: DELEGATE_AUTH.publicKey, purposes: 1, pop: null },
        { keyType: "Ed25519", key: DELEGATE_KEY.publicKey, purposes: 16, pop: null },
      ],
      ...setup.delegate,
    }),
    { height: 110 },
  );
  mintDelegation(b, ROOT, setup.root ?? root(), 200);
  mintDelegation(b, LEAF, setup.leaf ?? leaf(), setup.leafHeight ?? 300);
  return b;
}

afterEach(stopGateways);

const details = (overrides: Record<string, unknown> = {}) => ({ type: DELEGATION_DETAILS_TYPE, identifier: LEAF, ...overrides });

async function delegatedToken(
  h: Harness,
  detail: unknown = details(),
  options: { dpopKey?: TestKey; subjectKey?: TestKey; subjectId?: string; raw?: string } = {},
): Promise<Response> {
  const subject = await agentJwt(options.subjectKey ?? DELEGATE_AUTH, options.subjectId ?? DELEGATE, { now: h.now });
  return requestToken(h, subject, options.dpopKey ?? DELEGATE_KEY, { authorization_details: options.raw ?? JSON.stringify([detail]) });
}

describe("delegation tokens", () => {
  test("a two-hop chain: act names the delegators, authorization_details the leaf's actions and resources", async () => {
    const h = await startGateway(ledger());
    const res = await delegatedToken(h);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const granted = [{ type: DELEGATION_DETAILS_TYPE, identifier: LEAF, actions: ["marketplace.hire.v1"], locations: [ESCROW] }];
    expect(body.authorization_details).toEqual(granted);
    expect(body.expires_in).toBe(300);
    const { payload } = decodeJwt(text(body.access_token));
    expect(payload).toMatchObject({
      sub: didOf(DELEGATE),
      cnf: { jkt: thumbprint(DELEGATE_KEY) },
      act: { sub: didOf(OWNER), act: { sub: PRINCIPAL.keyHash, organisation: "example.org" } },
      authorization_details: granted,
    });
  });

  test("a one-hop delegation from a principal key, with its purpose", async () => {
    const b = ledger({ root: root({ delegate: DELEGATE, delegateKey: DELEGATE_KEY.keyHash }) });
    const h = await startGateway(b);
    const res = await delegatedToken(h, details({ identifier: ROOT }));
    expect(res.status).toBe(200);
    const { payload } = decodeJwt(text((await bodyOf(res)).access_token));
    expect(payload.act).toEqual({ sub: PRINCIPAL.keyHash, organisation: "example.org" });
    expect(payload.authorization_details).toEqual([
      {
        type: DELEGATION_DETAILS_TYPE,
        identifier: ROOT,
        actions: ["marketplace.*", "ocr.*"],
        locations: [ESCROW, "https://api.example.org/v1"],
        purpose: "cd".repeat(32),
      },
    ]);
  });

  test("a request can narrow the actions and resources", async () => {
    const b = ledger({ root: root({ delegate: DELEGATE, delegateKey: DELEGATE_KEY.keyHash }) });
    const h = await startGateway(b);
    const res = await delegatedToken(h, details({ identifier: ROOT, actions: ["ocr.extract.*", "marketplace.hire.v1"], locations: ["https://api.example.org/v1"] }));
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).authorization_details).toEqual([
      expect.objectContaining({ actions: ["ocr.extract.*", "marketplace.hire.v1"], locations: ["https://api.example.org/v1"] }),
    ]);
  });

  test("the token expires at the end of the delegation period when that comes first", async () => {
    const h = await startGateway(ledger({ leaf: leaf({ notAfter: NOW + 100_000 }) }));
    const res = await delegatedToken(h);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.expires_in).toBe(100);
    expect(decodeJwt(text(body.access_token)).payload.exp).toBe(nowS(NOW + 100_000));
  });

  test("a chain that a later Undelegate breaks: introspection answers inactive", async () => {
    const b = ledger();
    const h = await startGateway(b);
    const token = text((await bodyOf(await delegatedToken(h))).access_token);
    const introspect = async () => bodyOf(await postForm(h, "/introspect", { token, ...(await clientAuth(OWNER_AUTH, OWNER, h.now)) }));
    expect((await introspect()).active).toBe(true);
    const rootMint = b.chain.txs.find((t) => t.mint.some((a) => a.policyId === DELEGATION.policyId && a.assetName === ROOT && a.quantity > 0n))!;
    undelegate(b, rootMint, ROOT, 1000);
    expect(await introspect()).toEqual({ active: false });
  });
});

describe("delegation tokens: refused chains", () => {
  const OTHER_AGENT = idOf("m4 delegation other agent");
  test.each<[string, Setup, Parameters<typeof delegatedToken>[2], RegExp]>([
    ["the DPoP key is not the delegate key", {}, { dpopKey: OTHER }, /DPoP proof key is not the delegate_key/],
    ["a P-256 DPoP key", {}, { dpopKey: p256TestKey(87) }, /DPoP proof key is not the delegate_key/],
    ["the subject is not the delegate", {}, { subjectKey: OWNER_AUTH, subjectId: OWNER, dpopKey: DELEGATE_KEY }, /not the delegate of the delegation/],
    ["the leaf has fewer than 30 confirmations", { leafHeight: 990 }, {}, /fewer than 30 confirmations/],
    ["a link names another delegator", { leaf: leaf({ delegator: { type: "Agent", id: OTHER_AGENT } }) }, {}, /not made by the delegate of its parent/],
    ["a principal key below the root", { leaf: leaf({ delegator: { type: "PrincipalKey", hash: PRINCIPAL.keyHash, organisation: null } }) }, {}, /not made by the delegate of its parent/],
    ["a wrong depth", { leaf: leaf({ depth: 3 }) }, {}, /wrong depth/],
    ["the root has depth 2", { root: root({ depth: 2 }), leaf: leaf({ depth: 3 }) }, {}, /root delegation does not have depth 1/],
    ["more hops than the parent allows", { root: root({ remaining: 0 }) }, {}, /hops/],
    ["a leaf wider than its parent", { leaf: leaf({ actions: hexList(["db.*"]) }) }, {}, /not narrower than its parent/],
    ["`oc.*` does not cover `ocr.*`", { root: root({ actions: hexList(["oc.*"]) }), leaf: leaf({ actions: hexList(["ocr.*"]) }) }, {}, /not narrower than its parent/],
    ["a leaf period outside its parent's", { leaf: leaf({ notAfter: NOW + 9_000_000 }) }, {}, /outside the period of its parent/],
    ["a leaf value limit above its parent's", { leaf: leaf({ value: { perTx: 20_000_000n, total: 50_000_000n, periodMs: 86_400_000 } }) }, {}, /value limit/],
    ["a leaf without a value limit under a limited parent", { leaf: leaf({ value: null }) }, {}, /value limit/],
    ["a period that has not started", { leaf: leaf({ notBefore: NOW + 60_000 }) }, {}, /outside the period of delegation/],
    ["a period that has ended", { leaf: leaf({ notAfter: NOW - 1000 }) }, {}, /outside the period of delegation/],
    ["a delegator agent that is not Active", { owner: { parties: [] } }, {}, /delegator agent .* effective status suspended/],
    [
      "a delegate key without the delegation purpose",
      { delegate: { keys: [{ keyType: "Ed25519", key: DELEGATE_AUTH.publicKey, purposes: 1, pop: null }, { keyType: "Ed25519", key: DELEGATE_KEY.publicKey, purposes: 2, pop: null }] } },
      {},
      /not a listed Ed25519 key of the delegate with the delegation purpose/,
    ],
  ])("%s", async (_name, setup, options, message) => {
    const h = await startGateway(ledger(setup));
    const res = await delegatedToken(h, details(), options);
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toBe("invalid_authorization_details");
    expect(body.error_description).toMatch(message);
  });

  test.each<[string, Record<string, unknown>, RegExp]>([
    ["an action that the leaf does not cover", { actions: ["ocr.extract"] }, /does not cover the requested actions/],
    ["a prefix under a concrete action", { actions: ["marketplace.*"] }, /does not cover the requested actions/],
    ["a resource that the leaf does not cover", { locations: ["https://api.example.org/v1"] }, /does not cover the requested resources/],
    ["an unknown delegation", { identifier: delegationIdOf("nothing") }, /does not exist/],
  ])("refused request: %s", async (_name, change, message) => {
    const h = await startGateway(ledger());
    const res = await delegatedToken(h, details(change));
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error_description).toMatch(message);
  });

  test("an undelegated parent or leaf", async () => {
    for (const id of [ROOT, LEAF]) {
      const b = ledger();
      const mint = b.chain.txs.find((t) => t.mint.some((a) => a.policyId === DELEGATION.policyId && a.assetName === id && a.quantity > 0n))!;
      undelegate(b, mint, id, 900);
      const h = await startGateway(b);
      const res = await delegatedToken(h);
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error_description).toBe(`delegation ${id} was undelegated`);
    }
  });

  test("a delegation output at another address, or with an unreadable datum, is not authentic", async () => {
    const b = ledger();
    b.chain.txs.splice(b.chain.txs.findIndex((t) => t.mint.some((a) => a.assetName === LEAF)), 1);
    mintDelegation(b, LEAF, leaf(), 300, { address: WALLET });
    const h = await startGateway(b);
    expect((await bodyOf(await delegatedToken(h))).error_description).toBe(`delegation ${LEAF} is not authentic`);

    const garbled = ledger();
    const tx = garbled.chain.txs.find((t) => t.mint.some((a) => a.assetName === LEAF))!;
    garbled.chain.txs.splice(garbled.chain.txs.indexOf(tx), 1, { ...tx, outputs: [{ ...tx.outputs[0]!, inlineDatum: "d87980" }] });
    const h2 = await startGateway(garbled);
    expect((await bodyOf(await delegatedToken(h2))).error_description).toBe(`delegation ${LEAF} has an invalid datum`);
  });

  test("a chain deeper than 4", async () => {
    const b = ledger();
    const ids = [1, 2, 3, 4, 5].map((i) => delegationIdOf(`deep ${i}`));
    ids.forEach((id, i) => mintDelegation(b, id, leaf({ parent: i === 0 ? null : ids[i - 1]! }), 200 + i));
    const h = await startGateway(b);
    const res = await delegatedToken(h, details({ identifier: ids[4] }));
    expect((await bodyOf(res)).error_description).toBe("the delegation chain is deeper than 4");
  });

  test.each<[string, string]>([
    ["not JSON", "[{"],
    ["an empty list", "[]"],
    ["two objects", JSON.stringify([details(), details()])],
    ["another type", JSON.stringify([details({ type: "payment_initiation" })])],
    ["an unknown member", JSON.stringify([details({ privileges: ["admin"] })])],
    ["a bad identifier", JSON.stringify([details({ identifier: "ABC" })])],
    ["an action that is not a pattern", JSON.stringify([details({ actions: ["Ocr.*"] })])],
    ["an empty action list", JSON.stringify([details({ actions: [] })])],
    ["a resource that is not a pattern", JSON.stringify([details({ locations: ["ftp://x"] })])],
  ])("malformed authorization_details: %s", async (_name, raw) => {
    const h = await startGateway(ledger());
    const res = await delegatedToken(h, null, { raw });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("invalid_authorization_details");
  });

  test("a gateway without a delegation contract refuses delegation requests", async () => {
    const h = await startGateway(ledger(), { delegations: false });
    const res = await delegatedToken(h);
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: "invalid_authorization_details", error_description: "this gateway has no delegation contract configured" });
  });
});

describe("Section 5.1 patterns", () => {
  test("action and resource patterns follow the ABNF", () => {
    for (const p of ["*", "ocr", "ocr.extract.v1", "ocr.*", "a-b.c-d.*", "oauth:x", "mcp:tool/a", "https://x.example/y"]) expect(isActionPattern(p)).toBe(true);
    for (const p of ["", "Ocr", "ocr.", ".ocr", "ocr..x", "ocr.*.x", "*.ocr", "http://x", "mcp:", "ocr x"]) expect(isActionPattern(p)).toBe(false);
    for (const p of ["*", ESCROW, "oauth:x", "https://x"]) expect(isResourcePattern(p)).toBe(true);
    for (const p of ["ocr.*", "script:AB", `script:${"ab".repeat(27)}`, "ocr"]) expect(isResourcePattern(p)).toBe(false);
  });

  test("a pattern covers a value: *, itself, or x.* for values that start with x.", () => {
    expect(covers("*", "anything")).toBe(true);
    expect(covers("ocr.*", "ocr.extract.v1")).toBe(true);
    expect(covers("ocr.*", "ocr")).toBe(false);
    expect(covers("oc.*", "ocr.extract")).toBe(false);
    expect(covers(ESCROW, ESCROW)).toBe(true);
    expect(covers("mcp:tool.*", "mcp:tool.a")).toBe(false);
  });

  test("a parent pattern covers a child pattern; `oc.*` does not cover `ocr.*`", () => {
    expect(patternCovers("*", "*")).toBe(true);
    expect(patternCovers("ocr.*", "*")).toBe(false);
    expect(patternCovers("*", "ocr.*")).toBe(true);
    expect(patternCovers("ocr.*", "ocr.*")).toBe(true);
    expect(patternCovers("ocr.*", "ocr.extract.*")).toBe(true);
    expect(patternCovers("oc.*", "ocr.*")).toBe(false);
    expect(patternCovers("ocr.extract", "ocr.*")).toBe(false);
    expect(patternCovers("ocr.*", "ocr.extract")).toBe(true);
    expect(narrower(["ocr.*", ESCROW], ["ocr.a", ESCROW])).toBe(true);
    expect(narrower(["ocr.*"], ["ocr.a", ESCROW])).toBe(false);
    expect(narrower(["ocr.*"], [])).toBe(true);
  });
});
