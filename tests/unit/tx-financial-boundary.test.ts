import { CML } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import { buildAcceptTx } from "../../packages/shared/src/tx/escrow/accept.js";
import { buildClaimTx } from "../../packages/shared/src/tx/escrow/claim.js";
import { buildReclaimTx } from "../../packages/shared/src/tx/escrow/reclaim.js";
import { inspectSignedTransactionFinancials } from "../../packages/shared/src/tx/server.js";
import type { BuildResult } from "../../packages/shared/src/tx/types.js";
import { buildBuyerWalletKey } from "../fixtures/buyer-side/wallet-keys.js";
import { buildSupplierWalletKey } from "../fixtures/supplier-side/wallet-keys.js";
import {
  buildOpenEscrowUtxo,
  buildSubmittedEscrowUtxo,
  BUYER_BOND,
  DELIVER_BY,
  PAYMENT_LOVELACE,
  SUBMITTED_AT,
  SUPPLIER_BOND,
} from "../fixtures/buyer-side/sample-escrow-utxos.js";

function financialTransaction(totalCollateral: bigint | undefined): string {
  const owned: { free(): void }[] = [];
  const keep = <T extends { free(): void }>(value: T): T => {
    owned.push(value);
    return value;
  };
  try {
    const spending = keep(CML.TransactionInputList.new());
    spending.add(keep(CML.TransactionInput.new(
      keep(CML.TransactionHash.from_hex("12".repeat(32))), 1n,
    )));
    const collateral = keep(CML.TransactionInputList.new());
    collateral.add(keep(CML.TransactionInput.new(
      keep(CML.TransactionHash.from_hex("34".repeat(32))), 2n,
    )));
    const references = keep(CML.TransactionInputList.new());
    references.add(keep(CML.TransactionInput.new(
      keep(CML.TransactionHash.from_hex("56".repeat(32))), 3n,
    )));
    const outputs = keep(CML.TransactionOutputList.new());
    const buyerAddress = keep(CML.Address.from_bech32(buildBuyerWalletKey().address));
    const value = keep(CML.Value.from_coin(9_007_199_254_741_001n));
    const data = keep(CML.PlutusData.from_cbor_hex("d87980"));
    // TransactionOutput.new consumes its optional datum argument.
    const datum = CML.DatumOption.new_datum(data);
    outputs.add(keep(CML.TransactionOutput.new(buyerAddress, value, datum)));
    const body = keep(CML.TransactionBody.new(spending, outputs, 234_567n));
    body.set_collateral_inputs(collateral);
    body.set_reference_inputs(references);
    if (totalCollateral !== undefined) body.set_total_collateral(totalCollateral);
    const witnesses = keep(CML.TransactionWitnessSet.new());
    return keep(CML.Transaction.new(body, witnesses, true)).to_cbor_hex();
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) owned[i]!.free();
  }
}

describe("signed transaction financial evidence", () => {
  it("keeps exact integer amounts and does not count collateral or reference inputs as spending", () => {
    const financials = inspectSignedTransactionFinancials(financialTransaction(456_789n));
    const buyerOutputs = financials.outputs
      .filter((output) => output.address === buildBuyerWalletKey().address)
      .reduce((sum, output) => sum + output.lovelace, 0n);
    expect(buyerOutputs - financials.feeLovelace).toBe(9_007_199_254_506_434n);
    expect(financials.inputs).toEqual([{ txHash: "12".repeat(32), index: 1 }]);
    expect(financials.collateralInputs).toEqual([{ txHash: "34".repeat(32), index: 2 }]);
    expect(financials.totalCollateralLovelace).toBe(456_789n);
    expect(financials.outputs[0]?.datumHex).toBe("d87980");
  });

  it("does not report zero risk when collateral inputs have no declared total", () => {
    const financials = inspectSignedTransactionFinancials(financialTransaction(undefined));
    expect(financials.totalCollateralLovelace).toBeNull();
    expect(financials.collateralInputs).toEqual([{ txHash: "34".repeat(32), index: 2 }]);
  });

  it("rejects a corrupt signed transaction instead of reporting zero cost", () => {
    expect(() => inspectSignedTransactionFinancials("00")).toThrow();
  });
});

describe("escrow pre-broadcast financial boundary", () => {
  it.each(["claim", "accept", "reclaim"] as const)(
    "keeps the original escrow unspent when the %s journal rejects the transaction",
    async (operation) => {
      const chain = new MockChainProvider();
      const utxo = operation === "accept" ? buildSubmittedEscrowUtxo() : buildOpenEscrowUtxo();
      const time = operation === "claim" ? DELIVER_BY - 1_000
        : operation === "accept" ? SUBMITTED_AT + 1_000 : DELIVER_BY + 1_000;
      chain.advanceSlot(Math.floor(time / 1_000));
      chain.seed(utxo);
      const rejection = new Error("financial approval rejected");
      const beforeSubmit = async (_built: BuildResult): Promise<void> => {
        throw rejection;
      };
      const attempt = operation === "claim"
        ? buildClaimTx({ chain, supplierKey: buildSupplierWalletKey(), escrowRef: utxo.ref, beforeSubmit })
        : operation === "accept"
          ? buildAcceptTx({ chain, buyerKey: buildBuyerWalletKey(), escrowRef: utxo.ref, beforeSubmit })
          : buildReclaimTx({ chain, buyerKey: buildBuyerWalletKey(), escrowRef: utxo.ref, beforeSubmit });
      await expect(attempt).rejects.toBe(rejection);
      expect(await chain.queryUtxo(utxo.ref)).toEqual(utxo);
      expect(await chain.queryUtxosByAddress(buildSupplierWalletKey().address)).toEqual([]);
      expect(await chain.queryUtxosByAddress(buildBuyerWalletKey().address)).toEqual([]);
    },
  );

  it("waits for durable approval before paying and exposes the real payout amounts", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(Math.floor((SUBMITTED_AT + 1_000) / 1_000));
    const utxo = buildSubmittedEscrowUtxo();
    chain.seed(utxo);
    let enter!: (built: BuildResult) => void;
    const entered = new Promise<BuildResult>((resolve) => { enter = resolve; });
    let approve!: () => void;
    const approved = new Promise<void>((resolve) => { approve = resolve; });
    const operation = buildAcceptTx({
      chain,
      buyerKey: buildBuyerWalletKey(),
      escrowRef: utxo.ref,
      beforeSubmit: async (built) => {
        enter(built);
        await approved;
      },
    });
    try {
      const built = await entered;
      const financials = inspectSignedTransactionFinancials(built.txCborHex);
      expect(await chain.queryUtxo(utxo.ref)).toEqual(utxo);
      expect(financials.outputs.find((output) => output.address === buildSupplierWalletKey().address)?.lovelace)
        .toBe(PAYMENT_LOVELACE + SUPPLIER_BOND);
      expect(financials.outputs.find((output) => output.address === buildBuyerWalletKey().address)?.lovelace)
        .toBe(BUYER_BOND);
    } finally {
      approve();
      await operation;
    }
    expect(await chain.queryUtxo(utxo.ref)).toBeNull();
    const payout = await chain.queryUtxosByAddress(buildSupplierWalletKey().address);
    expect(payout.reduce((sum, output) => sum + output.lovelace, 0n))
      .toBe(PAYMENT_LOVELACE + SUPPLIER_BOND);
  });
});
