// The attestations that the resolver shows (Part 2 Section 4): the filter of resolve/provenance.ts, the read of the
// outputs (chain/koios-ogmios-source.ts and resolve/attestation-index.ts) with real rows of Vector mainnet, and the
// member of the DID document metadata.

import { expect, test, vi } from "vitest";
import { KoiosOgmiosChainSource } from "../src/chain/koios-ogmios-source.js";
import { KoiosClient } from "../src/chain/koios.js";
import type { ChainTip, UnspentOutput } from "../src/chain/types.js";
import type { AttestationDatum } from "../src/codec/attestation-datum.js";
import { AttestationIndex } from "../src/resolve/attestation-index.js";
import type { VectorProvenance } from "../src/resolve/metadata.js";
import type { ProvenanceTime } from "../src/resolve/provenance.js";
import { VectorResolver } from "../src/resolve/resolver.js";
import { VECTOR_MAINNET } from "../src/resolve/settings.js";
import { formatTime } from "../src/resolve/time.js";
import { ATTESTATION, DOCUMENT_DIGEST, ISSUER_ID, LOCATOR, NOW, SUBJECT, attestationDatum, attestationOutput, tokenName } from "./support/attestations.js";
import { LedgerBuilder, identityDatum, idOf, timeAt, utf8 } from "./support/ledger.js";
import { didOf } from "./support/resolve.js";

/** The tip of these tests: its block time is `NOW`. */
const TIP: ChainTip = { blockHeight: 1000, blockHash: "ee".repeat(32), slot: NOW / 1000 - VECTOR_MAINNET.systemStart };
const AT: ProvenanceTime = { tipHeight: 1000, timeMs: NOW };

/** What the resolver shows for SUBJECT after a read of these outputs. */
async function shownFor(outputs: UnspentOutput[], at: ProvenanceTime = AT): Promise<VectorProvenance | undefined> {
  const index = new AttestationIndex({ tip: async () => TIP, policyOutputs: async () => outputs }, ATTESTATION, VECTOR_MAINNET, { log: () => undefined });
  await index.refresh();
  return index.provenance(SUBJECT, at);
}

const SHOWN = {
  id: tokenName(1),
  type: "software",
  issuer: `did:vector:${ISSUER_ID}`,
  issuedAt: formatTime(NOW - 3_600_000),
  validUntil: formatTime(NOW + 86_400_000),
  solicited: true,
  digest: DOCUMENT_DIGEST,
  locator: LOCATOR,
  envelope: true,
};

/** One attestation in the block `height`; the tip is at 1000. */
const one = (overrides: Partial<AttestationDatum> = {}, height = 900, output: Partial<UnspentOutput> = {}): UnspentOutput[] => [
  attestationOutput(attestationDatum(overrides), height, tokenName(1), output),
];
const reply = { uri: utf8("https://subject.example.org/reply.json"), sha256: idOf("reply") };
/** Nine solicited attestations of the types software and environment, the first one the newest. */
const nine = Array.from({ length: 9 }, (_, i) => attestationOutput(attestationDatum({ attType: i % 2 === 0 ? 2 : 3, issuedAt: NOW - 60_000 * (i + 1) }), 900, tokenName(i + 1)));
const OTHER_ADDRESS = "addr1wx7uz6vshpz23ps09rz3hv8x535usjlte4tak6vuugz8sks9wdc5c";
const policyToken = (n: number) => ({ policyId: ATTESTATION.policyId, assetName: tokenName(n), quantity: 1n });

test.each<[string, UnspentOutput[], unknown]>([
  ["accepted: a solicited software attestation of a registered issuer", one(), { attestations: [SHOWN] }],
  [
    "accepted: no registered issuer (a did:key), the reply of the subject's controller, no envelope, no end of validity, the type provenance",
    one({ issuerId: null, contested: reply, envelopeSig: null, validUntil: null, attType: 1 }),
    { attestations: [{ ...SHOWN, type: "provenance", issuer: expect.stringMatching(/^did:key:z6Mk/), contested: true, envelope: undefined, validUntil: undefined }] },
  ],
  [
    "accepted: eight of nine newest first, the ninth in othersCount",
    nine,
    {
      attestations: Array.from({ length: 8 }, (_, i) => ({ ...SHOWN, id: tokenName(i + 1), type: i % 2 === 0 ? "software" : "environment", issuedAt: formatTime(NOW - 60_000 * (i + 1)) })),
      othersCount: 1,
    },
  ],
  ["accepted: 30 confirmations", one({}, 970), { attestations: [SHOWN] }],
  ["accepted: at the second of valid_until", one({ validUntil: NOW }), { attestations: [{ ...SHOWN, validUntil: formatTime(NOW) }] }],
  ["an unsolicited attestation is only counted", one({ solicited: false }), { othersCount: 1 }],
  ["an attestation of another type is only counted", one({ attType: 15 }), { othersCount: 1 }],
  ["a revoked attestation", one({ status: { type: "Revoked", at: NOW - 1000, reason: 0n } }), undefined],
  ["before valid_from", one({ validFrom: NOW + 1000 }), undefined],
  ["after valid_until", one({ validUntil: NOW - 1000 }), undefined],
  ["29 confirmations", one({}, 971), undefined],
  ["an output at another address", one({}, 900, { address: OTHER_ADDRESS }), undefined],
  ["an output with two tokens of the policy", one({}, 900, { assets: [policyToken(1), policyToken(2)] }), undefined],
  ["an output without an inline datum", one({}, 900, { inlineDatum: null }), undefined],
  ["a datum of another layout", one({}, 900, { inlineDatum: "d87980" }), undefined],
  ["a locator that is not an https URL is left out", one({ locator: utf8("http://attestations.example.org/a.json") }), { attestations: [{ ...SHOWN, locator: undefined }] }],
  ["a locator with credentials is left out", one({ locator: utf8("https://user:secret@attestations.example.org/a.json") }), { attestations: [{ ...SHOWN, locator: undefined }] }],
])("the list that an agent shows: %s", async (_name, outputs, expected) => {
  expect(await shownFor(outputs)).toEqual(expected);
});

// Two outputs of the attestation contract on Vector mainnet, as Koios lists them: an active attestation of the type
// "other" (token f2628f73…) and a revoked attestation of the type "identity" (token 8a4af9db…).
const ACTIVE_SUBJECT = "f873bba44679119e217741edb413ad5f8c97c1917e1ba3ab8a34e14c1fdf7748";
const REVOKED_SUBJECT = "96f147f41d1c4cca8dc926befd2198bbed0d37b74417d29333ea8e98d4edddfc";
const REAL_ROWS = [
  {
    tx_hash: "21ffca35bdff6612c97e53ce6c1003b84b6de75f9da531b89f0d2ab91bc608be",
    tx_index: 0,
    block_height: 9210723,
    address: "addr1w8c8cezwqsh26z2vc5qlgslq82y4thqlf5xu6kec0p37qssut0y3q",
    asset_list: [
      {
        decimals: 0,
        quantity: "1",
        policy_id: "f07c644e042ead094cc501f443e03a8955dc1f4d0dcd5b387863e042",
        asset_name: "f2628f739c71ade40d91b89722e1e1d6b0247fddc99e4e0f1247d3f736ec60d6",
        fingerprint: "asset1ntl9zjsptsp9jvd25ddtnmd6ytmx8fhmdspeh6",
      },
    ],
    inline_datum: {
      bytes:
        "d8799f5820f873bba44679119e217741edb413ad5f8c97c1917e1ba3ab8a34e14c1fdf774858206acb06fd616405d974b145448418e3f70b36af440da81cc094f0e93c02379cffd87a800fd87a80d87a80582096acdd37124de8b6cf082ec21d5f00c94be1cb6f16dd5ce55e1f9f7058c1c3e0d87a80d87a801b000001a1a8753cd0d87a80d87a80d87980d87980d87a8080ff",
    },
  },
  {
    tx_hash: "df57da06219f591aea40d084dd16ddeca5586618d32ed26ed8432a276798e104",
    tx_index: 0,
    block_height: 9184019,
    address: "addr1w8c8cezwqsh26z2vc5qlgslq82y4thqlf5xu6kec0p37qssut0y3q",
    asset_list: [
      {
        decimals: 0,
        quantity: "1",
        policy_id: "f07c644e042ead094cc501f443e03a8955dc1f4d0dcd5b387863e042",
        asset_name: "8a4af9dbe4c2a356da2279391d3ed6a5717ca542bdbc86da0c5a0b3b361f1cb4",
        fingerprint: "asset18vczy9p5qgpz424gdnnmpu2new7rt4kdxp6y27",
      },
    ],
    inline_datum: {
      bytes:
        "d8799f582096f147f41d1c4cca8dc926befd2198bbed0d37b74417d29333ea8e98d4edddfc5820bb89a3ec2ca5a3abbcf33fa349b7ec40f3bd7b09a4da22498da813d23484e5c7d8799f5820c103c19dd5453de6d53b86eda1e26a29ef617ccf4c70d7e6aab411d918ff80bfff00d8799f1832ffd87a8058206c623218e867bd911f60e1f213b9c64c1f7fe7ab6755cbb99e9b233cdb83357ad87a80d87a801b000001a1a22fa978d87a80d87a80d87980d87a9f1b000001a1a21756e800ffd87a8080ff",
    },
  },
];

test("the read of real mainnet outputs through Koios: the active attestation counts, the revoked one does not; two calls for a new tip, one for the same tip; no more than 5,000 outputs", async () => {
  const state = { hash: "aa".repeat(32), total: REAL_ROWS.length };
  const calls: string[] = [];
  const koiosStub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes("credential_utxos")) {
      calls.push("tip");
      return new Response(JSON.stringify([{ hash: state.hash, abs_slot: TIP.slot, block_height: 10_000_000 }]));
    }
    calls.push("credential_utxos");
    const offset = Number(/offset=(\d+)/.exec(url)![1]);
    const page = state.total === REAL_ROWS.length ? REAL_ROWS : Array.from({ length: Math.max(0, Math.min(1000, state.total - offset)) }, () => REAL_ROWS[0]);
    return new Response(JSON.stringify(page));
  }) as typeof fetch;
  const chain = new KoiosOgmiosChainSource({ koios: new KoiosClient({ baseUrl: "https://koios.test/api/v1", fetch: koiosStub }), ogmiosUrl: "ws://unused.invalid" });
  const index = new AttestationIndex(chain, ATTESTATION, VECTOR_MAINNET, { log: () => undefined });
  const at: ProvenanceTime = { tipHeight: 10_000_000, timeMs: NOW };

  await index.refresh();
  expect(index.provenance(ACTIVE_SUBJECT, at)).toEqual({ othersCount: 1 });
  expect(index.provenance(REVOKED_SUBJECT, at)).toBeUndefined();
  await index.refresh();
  expect(calls).toEqual(["tip", "credential_utxos", "tip"]);

  state.hash = "bb".repeat(32);
  state.total = 5001;
  await expect(index.refresh()).rejects.toThrow("more than 5000");
  expect(index.provenance(ACTIVE_SUBJECT, at)).toEqual({ othersCount: 1 });
});

test("a result without options has vectorProvenance at the tip of the request, and a result for a version option has none", async () => {
  const agent = idOf("attested record");
  const ledger = new LedgerBuilder();
  ledger.register(agent, identityDatum(), { height: 100 });
  const provenance = vi.fn((_vectorId: string, _at?: ProvenanceTime) => ({ othersCount: 2 }));
  const resolver = new VectorResolver(ledger.chain, ledger.settings, { provenance: { provenance }, log: () => undefined });
  const metadata = async (options?: Record<string, string>) => (await resolver.resolveDid(didOf(agent), options)).didDocumentMetadata;

  expect((await metadata()).vectorProvenance).toEqual({ othersCount: 2 });
  expect((await metadata({ versionId: "0" })).vectorProvenance).toBeUndefined();
  expect((await metadata({ versionTime: formatTime(timeAt(900)) })).vectorProvenance).toBeUndefined();
  expect(provenance.mock.calls).toEqual([[agent, { tipHeight: 1000, timeMs: timeAt(1000) }]]);
});
