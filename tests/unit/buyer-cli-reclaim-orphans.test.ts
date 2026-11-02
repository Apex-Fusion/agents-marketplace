/**
 * buyer-cli-reclaim-orphans.test.ts — recoverEscrow of the reclaim-orphans
 * CLI (Part 2 §6.1, §9.6): RefundRevoked for a new escrow of a revoked or
 * retired agent, else Reclaim after deliver_by, in both layouts.
 */
import { describe, expect, it, vi } from "vitest";
import { MockChainProvider } from "../../packages/shared/src/chain/MockChainProvider.js";
import type { OutputReference } from "../../packages/shared/src/chain/ChainProvider.js";
import { encodeEscrowDatum } from "../../packages/shared/src/cbor/EscrowDatum.js";
import type { IdentityDatum } from "../../packages/shared/src/cbor/IdentityDatum.js";
import { TxConstructionError } from "../../packages/shared/src/tx/index.js";
import { recoverEscrow } from "../../buyer/src/cli/reclaim-orphans.js";
import { BuyerIdentity } from "../../buyer/src/sdk/identity.js";
import {
  activeRecord, buyer, identityBlueprint, newEscrow, recordOutput, seedNewEscrow, tombstone,
} from "../fixtures/buyer-side/identity-world.js";

const TIP_SLOT = 1_745_500_000;
const NOW_MS = TIP_SLOT * 1000;
const ESCROW_REF: OutputReference = { txHash: "e1".repeat(32), index: 0 };

const revoked = (invalidFrom: number | null): IdentityDatum => tombstone(activeRecord(), {
  type: "Revoked", by: { type: "ControllerSet" }, reason: 1, at: NOW_MS - 1, invalidFrom, successor: null,
});

function setup(record: IdentityDatum | null) {
  const chain = new MockChainProvider();
  chain.advanceSlot(TIP_SLOT);
  if (record !== null) chain.seed(recordOutput(record));
  const identity = new BuyerIdentity(chain, 0, { identityBlueprint }, async () => []);
  const submit = vi.spyOn(chain, "submitTx");
  const redeemer = (): string => {
    const tx = submit.mock.calls[0]![0];
    return JSON.parse(Buffer.from(tx.slice(8, 8 + 2 * parseInt(tx.slice(0, 8), 16)), "hex").toString("utf8")).redeemer;
  };
  return { chain, identity, submit, redeemer, recover: () => recoverEscrow({ chain, walletKey: buyer, escrowRef: ESCROW_REF, identity }) };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TxConstructionError);
    return (error as TxConstructionError).reason;
  }
  throw new Error("expected a TxConstructionError");
}

describe("recoverEscrow", () => {
  it("refunds an Open new escrow of a revoked agent before deliver_by", async () => {
    const s = setup(revoked(null));
    seedNewEscrow(s.chain, newEscrow({ deliver_by: NOW_MS + 60_000 }), ESCROW_REF);
    expect((await s.recover()).action).toBe("RefundRevoked");
    expect(s.redeemer()).toBe("RefundRevoked");
  });

  it("refunds a Submitted new escrow when invalid_from ≤ submitted_at", async () => {
    const s = setup(revoked(NOW_MS - 5_000));
    seedNewEscrow(s.chain, newEscrow({
      state: "Submitted", submitted_at: NOW_MS - 5_000, result_receipt_hash: "d4".repeat(32), deliver_by: NOW_MS + 60_000,
    }), ESCROW_REF);
    expect((await s.recover()).action).toBe("RefundRevoked");
  });

  it("refuses a Submitted new escrow of a live agent", async () => {
    const s = setup(activeRecord());
    seedNewEscrow(s.chain, newEscrow({
      state: "Submitted", submitted_at: NOW_MS - 5_000, result_receipt_hash: "d4".repeat(32), deliver_by: NOW_MS + 60_000,
    }), ESCROW_REF);
    expect(await reason(s.recover())).toBe("refund not allowed");
    expect(s.submit).not.toHaveBeenCalled();
  });

  it("reclaims a new escrow of a live agent after deliver_by, and waits before it", async () => {
    const late = setup(activeRecord());
    seedNewEscrow(late.chain, newEscrow({ deliver_by: NOW_MS - 1_000 }), ESCROW_REF);
    expect((await late.recover()).action).toBe("Reclaim");
    expect(late.redeemer()).toBe("Reclaim");

    const early = setup(activeRecord());
    seedNewEscrow(early.chain, newEscrow({ deliver_by: NOW_MS + 60_000 }), ESCROW_REF);
    expect(await reason(early.recover())).toBe("reclaim before deliver_by");
  });

  it("reclaims a legacy escrow after deliver_by without reading a record", async () => {
    const s = setup(null);
    const { agent_id: _agent, refund: _refund, ...legacy } = newEscrow({ deliver_by: NOW_MS - 1_000 });
    s.chain.seed({
      ref: ESCROW_REF, address: "addr_test1wfakeescrow", lovelace: 4_500_000n, assets: {}, datumHex: encodeEscrowDatum(legacy), scriptRef: null,
    });
    expect((await s.recover()).action).toBe("Reclaim");
  });

  it("reclaims a new escrow whose record is gone after deliver_by", async () => {
    const s = setup(null);
    seedNewEscrow(s.chain, newEscrow({ deliver_by: NOW_MS - 1_000 }), ESCROW_REF);
    expect((await s.recover()).action).toBe("Reclaim");
  });
});
