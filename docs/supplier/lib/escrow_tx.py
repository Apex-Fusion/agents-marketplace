"""
Build, evaluate, and submit script transactions for escrow state transitions.
"""
import json
import os

import httpx
from pycardano import (
    Redeemer,
    Transaction,
    TransactionBuilder,
    TransactionOutput,
    VerificationKeyWitness,
)
from pycardano.plutus import ExecutionUnits, RawPlutusData


async def build_and_submit_script_tx(
    context, signer, utxo, script, script_address,
    redeemer_obj, output_value, output_datum_obj,
    task_id, step_name, validity_start_slot=None,
    extra_outputs=None,
) -> str:
    await context.async_protocol_param()
    change_address = signer._wallet.payment_address

    try:
        tx_hash = await _build_direct(
            context, signer, utxo, script, script_address,
            redeemer_obj, output_value, output_datum_obj,
            change_address, validity_start_slot, extra_outputs,
        )
        print(f"[{step_name}] TX submitted (direct): {tx_hash}")
        return tx_hash
    except ValueError as e:
        if "collateral" not in str(e).lower():
            raise
        print(f"[{step_name}] Collateral check failed, falling back to Ogmios evaluate...")

    tx_hash = await _build_with_ogmios_evaluate(
        context, signer, utxo, script, script_address,
        redeemer_obj, output_value, output_datum_obj,
        change_address, validity_start_slot, step_name, extra_outputs,
    )
    print(f"[{step_name}] TX submitted (ogmios): {tx_hash}")
    return tx_hash


def _make_builder(
    context, signer, utxo, script, script_address,
    redeemer_obj, output_value, output_datum_obj,
    validity_start_slot, ex_units=None, skip_estimate=False,
    extra_outputs=None,
):
    builder = TransactionBuilder(context)
    builder.add_input_address(signer._wallet.payment_address)
    builder.fee_buffer = 10_000

    if skip_estimate:
        builder._should_estimate_execution_units = False

    redeemer = Redeemer(RawPlutusData(redeemer_obj))
    if ex_units:
        redeemer.ex_units = ex_units
    builder.add_script_input(utxo, script=script, datum=None, redeemer=redeemer)

    if output_datum_obj is not None and output_value > 0:
        builder.add_output(
            TransactionOutput(script_address, output_value, datum=RawPlutusData(output_datum_obj))
        )

    # Add extra outputs (e.g. supplier payment in Accept TX)
    if extra_outputs:
        for out in extra_outputs:
            builder.add_output(out)

    builder.required_signers = [signer._wallet.payment_verification_key.hash()]

    if validity_start_slot is not None:
        builder.validity_start = validity_start_slot

    return builder


def _sign_tx(signer, tx_body, witness_set):
    sig = signer._wallet.payment_signing_key.sign(tx_body.hash())
    vk_witness = VerificationKeyWitness(
        signer._wallet.payment_verification_key, sig
    )
    witness_set.vkey_witnesses = [vk_witness]
    return Transaction(tx_body, witness_set)


async def _build_direct(
    context, signer, utxo, script, script_address,
    redeemer_obj, output_value, output_datum_obj,
    change_address, validity_start_slot, extra_outputs=None,
):
    builder = _make_builder(
        context, signer, utxo, script, script_address,
        redeemer_obj, output_value, output_datum_obj,
        validity_start_slot, extra_outputs=extra_outputs,
    )
    tx_body = builder.build(change_address=change_address)
    witness_set = builder.build_witness_set(True)
    tx = _sign_tx(signer, tx_body, witness_set)
    tx_cbor = tx.to_cbor()
    if isinstance(tx_cbor, bytes):
        tx_cbor = tx_cbor.hex()
    await context.async_submit_tx_cbor(tx_cbor)
    return str(tx.id)


async def _build_with_ogmios_evaluate(
    context, signer, utxo, script, script_address,
    redeemer_obj, output_value, output_datum_obj,
    change_address, validity_start_slot, step_name, extra_outputs=None,
):
    ogmios_url = os.getenv("VECTOR_OGMIOS_URL")
    if not ogmios_url:
        raise RuntimeError("VECTOR_OGMIOS_URL not set")

    dummy_ex_units = ExecutionUnits(500_000, 200_000_000)
    builder = _make_builder(
        context, signer, utxo, script, script_address,
        redeemer_obj, output_value, output_datum_obj,
        validity_start_slot, ex_units=dummy_ex_units, skip_estimate=True,
        extra_outputs=extra_outputs,
    )

    orig_set = builder._set_collateral_return
    def _patched(*a, **k):
        try:
            return orig_set(*a, **k)
        except ValueError:
            return
    builder._set_collateral_return = _patched

    tx_body = builder.build(change_address=change_address)
    witness_set = builder.build_witness_set(True)
    dummy_tx = _sign_tx(signer, tx_body, witness_set)

    tx_cbor = dummy_tx.to_cbor()
    if isinstance(tx_cbor, bytes):
        tx_cbor = tx_cbor.hex()

    evaluate_payload = {
        "jsonrpc": "2.0",
        "method": "evaluateTransaction",
        "params": {"transaction": {"cbor": tx_cbor}},
        "id": 1,
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(ogmios_url, json=evaluate_payload, timeout=30)
        result = resp.json()

    if "error" in result:
        err_data = result["error"]
        traces = ""
        if isinstance(err_data.get("data"), list):
            for item in err_data["data"]:
                if "error" in item and "data" in item["error"]:
                    traces = str(item["error"]["data"].get("traces", ""))
        raise RuntimeError(
            f"[{step_name}] Validator failed: {err_data.get('message', '')} traces={traces}"
        )

    budget = result["result"][0]["budget"]
    real_mem = int(budget["memory"] * 1.2)
    real_cpu = int(budget["cpu"] * 1.2)
    print(f"[{step_name}] Ogmios ex_units: mem={real_mem}, cpu={real_cpu}")

    builder2 = _make_builder(
        context, signer, utxo, script, script_address,
        redeemer_obj, output_value, output_datum_obj,
        validity_start_slot, ex_units=ExecutionUnits(real_mem, real_cpu),
        skip_estimate=True, extra_outputs=extra_outputs,
    )

    orig_set2 = builder2._set_collateral_return
    def _patched2(*a, **k):
        try:
            return orig_set2(*a, **k)
        except ValueError:
            return
    builder2._set_collateral_return = _patched2

    tx_body2 = builder2.build(change_address=change_address)
    witness_set2 = builder2.build_witness_set(True)
    real_tx = _sign_tx(signer, tx_body2, witness_set2)

    real_cbor = real_tx.to_cbor()
    if isinstance(real_cbor, bytes):
        real_cbor = real_cbor.hex()
    await context.async_submit_tx_cbor(real_cbor)
    return str(real_tx.id)
