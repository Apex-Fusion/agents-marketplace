import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LiveOgmiosProvider } from "../../packages/shared/src/chain/LiveOgmiosProvider.js";
import type { WalletKey } from "../../packages/shared/src/tx/types.js";

const mocks = vi.hoisted(() => ({
  createLucidContext: vi.fn(),
  providerConstructor: vi.fn(),
}));

vi.mock(
  "../../packages/shared/src/chain/OgmiosLucidProvider.js",
  () => ({
    OgmiosLucidProvider: class {
      constructor(options: unknown) {
        mocks.providerConstructor(options);
      }
    },
  }),
);

vi.mock(
  "../../packages/shared/src/tx/internal/lucidContext.js",
  () => ({ createLucidContext: mocks.createLucidContext }),
);

import {
  buildAnchorMetadataTx,
  SURPLUS_SALE_PROOF_METADATA_LABEL,
  SURPLUS_SALE_PROOF_PROTOCOL,
  type SurplusSaleProofAnchorMetadata,
} from "../../packages/shared/src/tx/wallet/anchorMetadata.js";

const walletKey: WalletKey = {
  address: "addr1wallet",
  pubKeyHash: "1".repeat(56),
  pubKeyHex: "2".repeat(64),
  privateKeyHex: "3".repeat(64),
};

function validMetadata(): SurplusSaleProofAnchorMetadata {
  return {
    p: SURPLUS_SALE_PROOF_PROTOCOL,
    root: "a".repeat(64),
    count: 1_000,
    first: "sale-000001",
    last: "sale-001000",
  };
}

interface LucidHarness {
  chain: LiveOgmiosProvider;
  submitTx: Mock;
  getUtxos: Mock;
  newTx: Mock;
  attachMetadata: Mock;
  addSignerKey: Mock;
  setMinFee: Mock;
  completeTx: Mock;
  withWallet: Mock;
  completeSignature: Mock;
  payToAddress: Mock;
}

function lucidHarness(): LucidHarness {
  const submitTx = vi.fn().mockResolvedValue("submitted-hash");
  const chain = {
    url: "http://ogmios.test",
    fetchImpl: undefined,
    submitTx,
  } as unknown as LiveOgmiosProvider;
  const realWalletUtxos = [
    { txHash: "f".repeat(64), outputIndex: 0, assets: { lovelace: 25_000_000n } },
  ];
  const getUtxos = vi.fn().mockResolvedValue(realWalletUtxos);
  const completeSignature = vi.fn().mockResolvedValue({
    toCBOR: () => "signed-anchor-cbor",
    toHash: () => "b".repeat(64),
  });
  const withWallet = vi.fn(() => ({ complete: completeSignature }));
  const completeTx = vi.fn().mockResolvedValue({ sign: { withWallet } });
  const payToAddress = vi.fn();
  const txBuilder: Record<string, unknown> = {
    pay: { ToAddress: payToAddress },
  };
  const attachMetadata = vi.fn(() => txBuilder);
  const addSignerKey = vi.fn(() => txBuilder);
  const setMinFee = vi.fn(() => txBuilder);
  Object.assign(txBuilder, {
    attachMetadata,
    addSignerKey,
    setMinFee,
    complete: completeTx,
  });
  const newTx = vi.fn(() => txBuilder);
  const lucid = {
    wallet: vi.fn(() => ({ getUtxos })),
    newTx,
  };
  mocks.createLucidContext.mockResolvedValue({ lucid });

  return {
    chain,
    submitTx,
    getUtxos,
    newTx,
    attachMetadata,
    addSignerKey,
    setMinFee,
    completeTx,
    withWallet,
    completeSignature,
    payToAddress,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildAnchorMetadataTx", () => {
  it("signs label-674 metadata with real wallet inputs and submits once", async () => {
    const harness = lucidHarness();
    const metadata = validMetadata();

    const result = await buildAnchorMetadataTx({
      chain: harness.chain,
      walletKey,
      metadata,
    });

    expect(mocks.providerConstructor).toHaveBeenCalledWith({
      ogmiosUrl: "http://ogmios.test",
      fetch: undefined,
    });
    expect(mocks.createLucidContext).toHaveBeenCalledWith(
      expect.anything(),
      walletKey,
      { networkId: 1, systemStartUnix: 0, slotLengthMs: 1000 },
      { usePresetProtocolParameters: true },
    );
    expect(harness.getUtxos).toHaveBeenCalledOnce();
    expect(harness.newTx).toHaveBeenCalledOnce();
    expect(harness.attachMetadata).toHaveBeenCalledWith(
      SURPLUS_SALE_PROOF_METADATA_LABEL,
      metadata,
    );
    expect(harness.addSignerKey).toHaveBeenCalledWith(walletKey.pubKeyHash);
    expect(harness.setMinFee).toHaveBeenCalledWith(500_000n);
    expect(harness.completeTx).toHaveBeenCalledWith({
      presetWalletInputs: expect.arrayContaining([
        expect.objectContaining({ assets: { lovelace: 25_000_000n } }),
      ]),
      localUPLCEval: false,
    });
    expect(harness.withWallet).toHaveBeenCalledOnce();
    expect(harness.completeSignature).toHaveBeenCalledOnce();
    expect(harness.payToAddress).not.toHaveBeenCalled();
    expect(harness.submitTx).toHaveBeenCalledOnce();
    expect(harness.submitTx).toHaveBeenCalledWith("signed-anchor-cbor");
    expect(result).toEqual({
      txCborHex: "signed-anchor-cbor",
      expectedTxHash: "b".repeat(64),
    });
  });

  it.each([
    ["wrong protocol", { ...validMetadata(), p: "surplus-sale-proof-v2" }],
    ["short root", { ...validMetadata(), root: "a".repeat(63) }],
    ["uppercase root", { ...validMetadata(), root: "A".repeat(64) }],
    ["non-hex root", { ...validMetadata(), root: "z".repeat(64) }],
    ["zero count", { ...validMetadata(), count: 0 }],
    ["fractional count", { ...validMetadata(), count: 1.5 }],
    ["unsafe count", { ...validMetadata(), count: Number.MAX_SAFE_INTEGER + 1 }],
    ["empty first ID", { ...validMetadata(), first: "" }],
    ["control character in last ID", { ...validMetadata(), last: "sale\n2" }],
    ["non-ASCII first ID", { ...validMetadata(), first: "salé-1" }],
    ["extra field", { ...validMetadata(), extra: true }],
  ])("rejects %s before initializing Lucid", async (_case, metadata) => {
    const harness = lucidHarness();

    await expect(
      buildAnchorMetadataTx({
        chain: harness.chain,
        walletKey,
        metadata: metadata as SurplusSaleProofAnchorMetadata,
      }),
    ).rejects.toMatchObject({ reason: "anchor_metadata_invalid" });

    expect(mocks.providerConstructor).not.toHaveBeenCalled();
    expect(mocks.createLucidContext).not.toHaveBeenCalled();
    expect(harness.submitTx).not.toHaveBeenCalled();
  });

  it("rejects metadata text over 64 UTF-8 bytes before initializing Lucid", async () => {
    const harness = lucidHarness();

    await expect(
      buildAnchorMetadataTx({
        chain: harness.chain,
        walletKey,
        metadata: { ...validMetadata(), last: "x".repeat(65) },
      }),
    ).rejects.toMatchObject({ reason: "anchor_metadata_oversized" });

    expect(mocks.providerConstructor).not.toHaveBeenCalled();
    expect(mocks.createLucidContext).not.toHaveBeenCalled();
    expect(harness.submitTx).not.toHaveBeenCalled();
  });

  it("does not submit when transaction construction fails", async () => {
    const harness = lucidHarness();
    harness.completeTx.mockRejectedValueOnce(new Error("coin selection failed"));

    await expect(
      buildAnchorMetadataTx({
        chain: harness.chain,
        walletKey,
        metadata: validMetadata(),
      }),
    ).rejects.toMatchObject({
      reason: "anchor_metadata_build_failed",
      message: "coin selection failed",
    });

    expect(harness.submitTx).not.toHaveBeenCalled();
  });
});
