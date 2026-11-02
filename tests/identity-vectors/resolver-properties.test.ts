// Property tests of Part 2 §12.3 against the gateway resolver (identity-gateway):
// - a subagent has the earliest "invalid from" time of its ancestors and itself;
// - a record's datum, rendered to a DID document and read back, gives the same keys, relationships
//   and status.
// The ledgers are in-memory (the gateway's test LedgerBuilder); every version is confirmed.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { IdentityDatum, Key, Party, Signer, Status } from "../../identity-gateway/src/codec/identity-datum.js";
import { keyHash } from "../../identity-gateway/src/codec/keys.js";
import { formatTime } from "../../identity-gateway/src/resolve/time.js";
import { LedgerBuilder, idOf, identityDatum, keySigner, party, timeAt } from "../../identity-gateway/test/support/ledger.js";
import { ed25519Key, p256Key } from "../../identity-gateway/test/support/keys.js";
import { didOf, resolverFor, tombstoneOf } from "../../identity-gateway/test/support/resolve.js";

const RUNS = { numRuns: 100 };

// ─── Earliest "invalid from" time ────────────────────────────────────────

type Ending = "live" | "revokedWithInvalidFrom" | "revoked" | "retired";

interface Link {
  readonly ending: Ending;
  /** Where "invalid from" lies in [created_at, at], in thousandths. */
  readonly position: number;
}

const linkArb: fc.Arbitrary<Link> = fc.record({
  ending: fc.constantFrom<Ending>("live", "live", "revokedWithInvalidFrom", "revokedWithInvalidFrom", "revoked", "retired"),
  position: fc.integer({ min: 0, max: 1000 }),
});

/** A root and 0 to 4 subagents; record i is registered at height 100 + 10 i and ends at height 400 + 10 i. */
function chainLedger(links: readonly Link[]): { builder: LedgerBuilder; ids: string[]; invalidFrom: Array<number | null> } {
  const builder = new LedgerBuilder();
  const ids = links.map((_, i) => idOf(`invalid-from chain ${i}`));
  const invalidFrom: Array<number | null> = [];
  const datums = links.map((_, i): IdentityDatum => {
    const lineage = i === 0 ? ({ type: "Root" } as const) : ({ type: "Subagent", parent: ids[i - 1]!, parentEpoch: 0, depth: i } as const);
    return identityDatum({ lineage, endpoint: i === 0 ? identityDatum().endpoint : new Uint8Array(), createdAt: timeAt(100 + 10 * i) });
  });
  datums.forEach((d, i) => builder.register(ids[i]!, d, { height: 100 + 10 * i }));
  links.forEach((l, i) => {
    const d = datums[i]!;
    const at = timeAt(400 + 10 * i);
    const from = d.createdAt + Math.floor(((at - d.createdAt) * l.position) / 1000);
    invalidFrom.push(l.ending === "revokedWithInvalidFrom" ? from : null);
    const ended: Status | null =
      l.ending === "revokedWithInvalidFrom" || l.ending === "revoked"
        ? { type: "Revoked", by: keySigner(ed25519Key(5)), reason: l.ending === "revoked" ? 3 : 1, at, invalidFrom: invalidFrom[i]!, successor: null }
        : l.ending === "retired"
          ? { type: "Retired", at, successor: null }
          : null;
    if (ended !== null) builder.update(ids[i]!, tombstoneOf(d, ended), { height: 400 + 10 * i });
  });
  return { builder, ids, invalidFrom };
}

describe("resolver: a subagent has the earliest invalid-from time of its ancestors and itself", () => {
  test("for random chains of depth 0 to 4", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(linkArb, { minLength: 1, maxLength: 5 }), async (links) => {
        const { builder, ids, invalidFrom } = chainLedger(links);
        const resolver = resolverFor(builder);
        for (let i = 0; i < ids.length; i += 1) {
          const times = invalidFrom.slice(0, i + 1).filter((t): t is number => t !== null);
          const earliest = times.length ? Math.min(...times) : null;
          const lookup = await resolver.currentRecord(ids[i]!);
          if (!lookup.found) throw new Error(`record ${i} does not resolve`);
          expect(lookup.record.invalidFrom).toBe(earliest);
          const result = await resolver.resolveDid(didOf(ids[i]!));
          expect(result.didDocumentMetadata.vectorStatus?.invalidFrom).toBe(earliest === null ? undefined : formatTime(earliest));
          // Every "invalid from" time is before the tip: a live record under it is Revoked (Part 1 §7.3, rule 2).
          if (earliest !== null && links[i]!.ending === "live") {
            expect(lookup.record.effective).toEqual({ status: "revoked", reason: "parentRevoked" });
          }
        }
      }),
      RUNS,
    );
  });
});

// ─── Datum → DID document → read back ────────────────────────────────────

const ED_KEYS = Array.from({ length: 10 }, (_, i) => ed25519Key(20 + i));
const P256_KEYS = Array.from({ length: 4 }, (_, i) => p256Key(40 + i));
const MODULE1_HASH = "31".repeat(28);
const PARTY_SIGNERS: Signer[] = [
  { type: "ControllerSet" },
  { type: "Script", hash: MODULE1_HASH },
  ...ED_KEYS.slice(0, 6).map((k) => keySigner(k)),
];
const RIGHTS_OF: Readonly<Record<Party["role"], readonly number[]>> = {
  Accountable: [0, 1, 2, 3],
  Responsible: [0, 1],
  Provider: [0, 1],
  Distributor: [0],
  Guardian: [0, 4],
};

/** A sum of purpose values: Ed25519 any non-empty subset of 1, 2, 8, 16; P-256 of 1, 2. */
const purposesArb = (values: readonly number[]): fc.Arbitrary<number> =>
  fc.subarray([...values], { minLength: 1 }).map((xs) => xs.reduce((a, b) => a + b, 0));

const timeArb = fc.integer({ min: timeAt(0), max: timeAt(3000) });

const partyArb: fc.Arbitrary<Party> = fc
  .record({
    role: fc.constantFrom<Party["role"]>("Accountable", "Responsible", "Provider", "Distributor", "Guardian"),
    signer: fc.constantFrom(...PARTY_SIGNERS),
    organisation: fc.option(fc.stringMatching(/^[a-z0-9.-]{1,40}$/), { nil: null }),
    notBefore: timeArb,
    span: fc.option(fc.integer({ min: 1, max: 10_000_000 }), { nil: null }),
    removalAfter: fc.option(timeArb, { nil: null }),
    rightsChoice: fc.nat(),
  })
  .filter((p) => p.signer.type === "KeyHash" || p.role === "Accountable" || p.role === "Responsible")
  .map((p): Party => {
    const rights = RIGHTS_OF[p.role];
    return party({
      role: p.role,
      signer: p.signer,
      organisation: p.organisation === null ? null : new TextEncoder().encode(p.organisation),
      notBefore: p.notBefore,
      notAfter: p.span === null ? null : p.notBefore + p.span,
      rights: rights[p.rightsChoice % rights.length]!,
      removalAfter: p.removalAfter,
    });
  });

const holdArb = fc.record({
  by: fc.constantFrom<Signer>(...PARTY_SIGNERS, keySigner(ED_KEYS[9]!)),
  reason: fc.constantFrom(0, 6, 9, 64, 65, 67, 68),
  since: timeArb,
  length: fc.integer({ min: 1, max: 30 * 86_400_000 }),
});

interface RecordCase {
  readonly vectorId: string;
  readonly datum: IdentityDatum;
}

const recordArb: fc.Arbitrary<RecordCase> = fc
  .record({
    label: fc.string({ minLength: 1, maxLength: 12 }),
    controller: fc.integer({ min: 0, max: ED_KEYS.length - 1 }),
    ed: fc.subarray(ED_KEYS.map((_, i) => i), { maxLength: 6 }),
    edPurposes: fc.array(purposesArb([1, 2, 8, 16]), { minLength: 6, maxLength: 6 }),
    p256: fc.subarray(P256_KEYS.map((_, i) => i), { maxLength: 2 }),
    p256Purposes: fc.array(purposesArb([1, 2]), { minLength: 2, maxLength: 2 }),
    parties: fc.uniqueArray(partyArb, { maxLength: 8, selector: (p) => `${p.role}:${JSON.stringify(p.signer)}` }),
    status: fc.constantFrom("active", "suspended", "revoked", "retired"),
    holds: fc.uniqueArray(holdArb, { minLength: 1, maxLength: 10, selector: (h) => JSON.stringify(h.by) }),
    reason: fc.constantFrom(0, 1, 3, 4, 5, 9, 65),
    successor: fc.boolean(),
  })
  .map((r): RecordCase => {
    const vectorId = idOf(`read back ${r.label}`);
    const keys: Key[] = [
      ...r.ed.map((i, n): Key => ({ keyType: "Ed25519", key: ED_KEYS[i]!, purposes: r.edPurposes[n]!, pop: null })),
      ...r.p256.map((i, n): Key => ({ keyType: "P256", key: P256_KEYS[i]!.publicKey, purposes: r.p256Purposes[n]!, pop: P256_KEYS[i]!.pop(vectorId) })),
    ];
    const live = identityDatum({ controller: ED_KEYS[r.controller]!, keys, parties: r.parties, createdAt: timeAt(100) });
    const at = timeAt(150);
    const successor = r.successor ? idOf("read back successor") : null;
    const status: Status =
      r.status === "active"
        ? { type: "Active" }
        : r.status === "suspended"
          ? { type: "Suspended", holds: r.holds.map((h) => ({ by: h.by, reason: h.reason, since: h.since, until: h.since + h.length })) }
          : r.status === "revoked"
            ? { type: "Revoked", by: { type: "ControllerSet" }, reason: r.reason, at, invalidFrom: r.reason === 1 ? at : null, successor }
            : { type: "Retired", at, successor };
    const datum = status.type === "Revoked" || status.type === "Retired" ? tombstoneOf(live, status) : { ...live, status };
    return { vectorId, datum };
  });

/** base58btc (Bitcoin alphabet) decoding. */
function base58Decode(text: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(alphabet.indexOf(c));
  const hex = n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Uint8Array.from([...Array(zeros).fill(0), ...body]);
}

/** A Multikey value as key type and key bytes (hex). */
function readMultikey(value: string): { keyType: Key["keyType"]; key: string } {
  expect(value.startsWith("z")).toBe(true);
  const bytes = base58Decode(value.slice(1));
  if (bytes[0] === 0xed && bytes[1] === 0x01) return { keyType: "Ed25519", key: Buffer.from(bytes.subarray(2)).toString("hex") };
  if (bytes[0] === 0x80 && bytes[1] === 0x24) return { keyType: "P256", key: Buffer.from(bytes.subarray(2)).toString("hex") };
  throw new Error(`unknown multicodec ${Buffer.from(bytes.subarray(0, 2)).toString("hex")}`);
}

const PURPOSE_BITS: Readonly<Record<string, number>> = { authentication: 1, assertion: 2, transaction: 8, delegation: 16 };
const signerName = (s: Signer): string => (s.type === "ControllerSet" ? "controller" : s.type === "Script" ? `script:${s.hash}` : s.hash);
const RIGHT_NAMES: ReadonlyArray<readonly [string, number]> = [
  ["suspend", 1],
  ["revoke", 2],
  ["recover", 4],
];

describe("resolver: datum → DID document → read back", () => {
  test("gives the same keys, relationships and status", async () => {
    await fc.assert(
      fc.asyncProperty(recordArb, async ({ vectorId, datum }) => {
        const builder = new LedgerBuilder();
        builder.register(vectorId, datum, { height: 100 });
        const result = await resolverFor(builder).resolveDid(didOf(vectorId));
        const meta = result.didDocumentMetadata;
        const vectorStatus = meta.vectorStatus!;

        // Status: the status of the record, its holds or its tombstone fields.
        const status = datum.status;
        expect(vectorStatus.status).toBe(status.type.toLowerCase());
        if (status.type === "Suspended") {
          expect(vectorStatus.holds?.map((h) => [h.by, h.since, h.until])).toEqual(
            status.holds.map((h) => [signerName(h.by), formatTime(h.since), formatTime(h.until)]),
          );
        }
        if (status.type === "Revoked" || status.type === "Retired") {
          expect(meta.deactivated).toBe(true);
          expect(result.didDocument).toBeNull();
          expect(vectorStatus.at).toBe(formatTime(status.at));
          expect(vectorStatus.successor).toBe(status.successor === null ? undefined : `did:vector:${status.successor}`);
          expect(meta.vectorKeys).toBeUndefined();
          return;
        }

        // Keys: the verification methods with the purposes of vectorKeys give the datum's keys.
        const document = result.didDocument!;
        const methods = new Map((document.verificationMethod ?? []).map((m) => [m.id.slice(m.id.indexOf("#")), readMultikey(m.publicKeyMultibase)]));
        const readBack = (meta.vectorKeys ?? []).map((k) => ({
          ...methods.get(k.id)!,
          purposes: (k.purposes ?? []).reduce((sum, p) => sum + PURPOSE_BITS[p]!, 0),
        }));
        expect(readBack).toEqual(datum.keys.map((k) => ({ keyType: k.keyType, key: k.key, purposes: k.purposes })));

        // Relationships: the controller invokes; each listed key is in the relationships of its purposes.
        expect(document.capabilityInvocation).toEqual([`#${keyHash(datum.controller)}`]);
        expect(methods.get(`#${keyHash(datum.controller)}`)).toEqual({ keyType: "Ed25519", key: datum.controller });
        const withPurpose = (bit: number): string[] | undefined => {
          const refs = datum.keys.filter((k) => k.purposes & bit).map((k) => `#${keyHash(k.key)}`);
          return refs.length ? refs : undefined;
        };
        expect(document.authentication).toEqual(withPurpose(1));
        expect(document.assertionMethod).toEqual(withPurpose(2));
        expect(document.capabilityDelegation).toEqual(withPurpose(16));

        // Parties, in datum order.
        expect(
          (meta.vectorParties ?? []).map((p) => [p.role, p.signer, p.organisation ?? null, (p.rights ?? []).join(","), p.notBefore, p.notAfter ?? null, p.removalAfter ?? null]),
        ).toEqual(
          datum.parties.map((p) => [
            p.role.toLowerCase(),
            signerName(p.signer),
            p.organisation === null ? null : new TextDecoder().decode(p.organisation),
            RIGHT_NAMES.filter(([, bit]) => p.rights & bit).map(([name]) => name).join(","),
            formatTime(p.notBefore),
            p.notAfter === null ? null : formatTime(p.notAfter),
            p.removalAfter === null ? null : formatTime(p.removalAfter),
          ]),
        );
      }),
      RUNS,
    );
  });
});
