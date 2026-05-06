/**
 * ogmios-lucid-provider.test.ts — RED phase tests for OgmiosLucidProvider
 *
 * Verifies that OgmiosLucidProvider satisfies the lucid-evolution Provider
 * interface by issuing the correct Ogmios JSON-RPC calls and parsing
 * responses into the shapes lucid expects.
 *
 * All network calls are mocked via injected fetch. No real Ogmios.
 *
 * Coverage:
 *   A. getProtocolParameters
 *   B. getUtxos(address)
 *   C. getUtxosByOutRef([{txHash, outputIndex}])
 *   D. submitTx
 *   E. awaitTx
 *   F. getDatum
 *   G. Stubbed: getDelegation, getUtxosWithUnit, getUtxoByUnit
 *   H. Adversarial: HTTP 5xx, JSON-RPC error, malformed response
 *
 * M1-F-4 RED — tests fail until Catherine implements OgmiosLucidProvider.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OgmiosLucidProvider,
  NotSupportedInM1F4Error,
} from "../../packages/shared/src/chain/OgmiosLucidProvider.js";

// ─── fetch mock setup ──────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
});

const TEST_URL = "http://localhost:1337";
const DUMMY_TX_HASH = "a".repeat(64);
const DUMMY_TX_CBOR = "84a500818258200000000000000000000000000000000000000000000000000000000000000000000d80a0f5f6";
const DUMMY_ADDRESS = "addr_test1vrmee5s2tqcxcgnhel8ddyjta77s76xftcsc0qcdwpajpdgjdd5nn";

function rpcOk<T>(result: T) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", result }),
  };
}

function rpcError(code: number, message: string, data?: unknown) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", error: { code, message, data } }),
  };
}

function makeOgmiosProtocolParams() {
  return {
    minFeeCoefficient: 44,
    minFeeConstant: { ada: { lovelace: 155381 } },
    maxTransactionSize: { bytes: 16384 },
    maxValueSize: { bytes: 5000 },
    stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
    stakePoolDeposit: { ada: { lovelace: 500000000 } },
    monetaryExpansion: "0.003",
    treasuryExpansion: "0.2",
    minStakePoolCost: { ada: { lovelace: 340000000 } },
    prices: { memory: "0.0577", steps: "0.0000721" },
    maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
    coinsPerUtxoByte: { ada: { lovelace: 4310 } },
    collateralPercentage: 150,
    maxCollateralInputs: 3,
    plutusCostModels: {
      "plutus:v1": {},
      "plutus:v2": {},
      "plutus:v3": {},
    },
    minFeeReferenceScripts: { base: 15 },
    governanceActionDeposit: { ada: { lovelace: 100000000000 } },
    delegateRepresentativeDeposit: { ada: { lovelace: 500000000 } },
  };
}

function makeOgmiosUtxo(txId = DUMMY_TX_HASH, index = 0, lovelace = 5_000_000) {
  return {
    transaction: { id: txId },
    index,
    address: DUMMY_ADDRESS,
    value: { ada: { lovelace } },
    datum: null,
    datumHash: null,
    script: null,
  };
}

// ─── A. getProtocolParameters ──────────────────────────────────────────────────

describe("OgmiosLucidProvider — getProtocolParameters()", () => {
  it("posts queryLedgerState/protocolParameters to ogmiosUrl", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.getProtocolParameters().catch(() => {});

    expect(mockFetch).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("queryLedgerState/protocolParameters");
  });

  it("returns a ProtocolParameters with minFeeA as a number", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.minFeeA).toBe("number");
  });

  it("returns a ProtocolParameters with minFeeB as a number", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.minFeeB).toBe("number");
  });

  it("returns coinsPerUtxoByte as bigint", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.coinsPerUtxoByte).toBe("bigint");
  });

  it("returns priceMem and priceStep as numbers", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.priceMem).toBe("number");
    expect(typeof params.priceStep).toBe("number");
  });

  it("returns maxTxSize as a number", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(typeof params.maxTxSize).toBe("number");
  });

  it("returns costModels as a non-null object", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk(makeOgmiosProtocolParams()));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const params = await provider.getProtocolParameters();

    expect(params.costModels).toBeDefined();
    expect(typeof params.costModels).toBe("object");
  });

  it("throws on HTTP 5xx", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" });
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.getProtocolParameters()).rejects.toThrow();
  });
});

// ─── B. getUtxos(address) ─────────────────────────────────────────────────────

describe("OgmiosLucidProvider — getUtxos(address)", () => {
  it("posts queryLedgerState/utxo with addresses param", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.getUtxos(DUMMY_ADDRESS).catch(() => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("queryLedgerState/utxo");
    expect(JSON.stringify(body.params)).toContain(DUMMY_ADDRESS);
  });

  it("returns empty array when no UTxOs at address", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(result).toEqual([]);
  });

  it("returns UTxO array with txHash as string", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(result).toHaveLength(1);
    expect(result[0].txHash).toBe(DUMMY_TX_HASH);
  });

  it("returns UTxO with outputIndex as number", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 2)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(result[0].outputIndex).toBe(2);
  });

  it("returns UTxO with assets.lovelace as bigint", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0, 3_000_000)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(typeof result[0].assets.lovelace).toBe("bigint");
    expect(result[0].assets.lovelace).toBe(3_000_000n);
  });

  it("returns UTxO with address matching the queried address", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxos(DUMMY_ADDRESS);

    expect(result[0].address).toBe(DUMMY_ADDRESS);
  });
});

// ─── C. getUtxosByOutRef ──────────────────────────────────────────────────────

describe("OgmiosLucidProvider — getUtxosByOutRef()", () => {
  it("posts queryLedgerState/utxo with outputReferences param", async () => {
    const ref = { txHash: DUMMY_TX_HASH, outputIndex: 0 };
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.getUtxosByOutRef([ref]).catch(() => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("queryLedgerState/utxo");
    expect(JSON.stringify(body.params)).toContain(DUMMY_TX_HASH);
  });

  it("returns empty array when outRef not on chain", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxosByOutRef([{ txHash: DUMMY_TX_HASH, outputIndex: 0 }]);

    expect(result).toEqual([]);
  });

  it("returns the matching UTxO when found", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 1)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.getUtxosByOutRef([{ txHash: DUMMY_TX_HASH, outputIndex: 1 }]);

    expect(result).toHaveLength(1);
    expect(result[0].outputIndex).toBe(1);
  });
});

// ─── D. submitTx ──────────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — submitTx()", () => {
  it("posts submitTransaction with the cbor in params", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.submitTx(DUMMY_TX_CBOR).catch(() => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe("submitTransaction");
    expect(JSON.stringify(body.params)).toContain(DUMMY_TX_CBOR);
  });

  it("returns the txHash from result.transaction.id", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: { id: DUMMY_TX_HASH } }));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const hash = await provider.submitTx(DUMMY_TX_CBOR);

    expect(hash).toBe(DUMMY_TX_HASH);
  });

  it("throws on Ogmios JSON-RPC error (invalid transaction)", async () => {
    mockFetch.mockResolvedValueOnce(rpcError(3005, "Invalid transaction"));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.submitTx(DUMMY_TX_CBOR)).rejects.toThrow();
  });

  it("throws on HTTP 503", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.submitTx(DUMMY_TX_CBOR)).rejects.toThrow();
  });
});

// ─── E. awaitTx ───────────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — awaitTx()", () => {
  it("returns true when UTxO with matching txHash found on first poll", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    const result = await provider.awaitTx(DUMMY_TX_HASH, 500);

    expect(result).toBe(true);
  });

  it("polls queryLedgerState/utxo with the txHash as outputReference", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk([makeOgmiosUtxo(DUMMY_TX_HASH, 0)]));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await provider.awaitTx(DUMMY_TX_HASH, 500).catch(() => {});

    if (mockFetch.mock.calls.length > 0) {
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.method).toBe("queryLedgerState/utxo");
      expect(JSON.stringify(body.params)).toContain(DUMMY_TX_HASH);
    } else {
      // RED: stub didn't reach fetch
      expect(mockFetch).toHaveBeenCalled();
    }
  });
});

// ─── F. getDatum ───────────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — getDatum()", () => {
  it("throws when datum hash cannot be resolved (no inline datum lookup)", async () => {
    // getDatum is rarely called by lucid; we stub it to throw a descriptive error
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(
      provider.getDatum("a".repeat(64)),
    ).rejects.toThrow();
  });
});

// ─── G. Stubbed methods ────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — stubbed methods (NotSupportedInM1F4Error)", () => {
  it("getDelegation throws NotSupportedInM1F4Error", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(
      provider.getDelegation("stake_test1up8r5n4v2cqk3c2fqmwepn98a2w0u6fyc8xvzy8qejnkj8sg0wfzv"),
    ).rejects.toThrow(NotSupportedInM1F4Error);
  });

  it("getUtxosWithUnit throws NotSupportedInM1F4Error", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(
      provider.getUtxosWithUnit(DUMMY_ADDRESS, "lovelace"),
    ).rejects.toThrow(NotSupportedInM1F4Error);
  });

  it("getUtxoByUnit throws NotSupportedInM1F4Error", async () => {
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(
      provider.getUtxoByUnit("policy.asset"),
    ).rejects.toThrow(NotSupportedInM1F4Error);
  });
});

// ─── H. Adversarial ──────────────────────────────────────────────────────────

describe("OgmiosLucidProvider — adversarial responses", () => {
  it("getProtocolParameters throws on malformed (null) response body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0" }),  // no result
    });
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.getProtocolParameters()).rejects.toThrow();
  });

  it("getUtxos throws on JSON-RPC error response", async () => {
    mockFetch.mockResolvedValueOnce(rpcError(3001, "queryLedgerState error"));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.getUtxos(DUMMY_ADDRESS)).rejects.toThrow();
  });

  it("submitTx throws on malformed result (missing transaction.id)", async () => {
    mockFetch.mockResolvedValueOnce(rpcOk({ transaction: {} }));
    const provider = new OgmiosLucidProvider({ ogmiosUrl: TEST_URL, fetch: mockFetch });

    await expect(provider.submitTx(DUMMY_TX_CBOR)).rejects.toThrow();
  });
});
