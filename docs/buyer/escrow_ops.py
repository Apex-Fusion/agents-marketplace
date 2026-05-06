"""Buyer-side escrow operations -- post, accept, and reclaim."""
from cbor2 import CBORTag

from pycardano import (
    Address,
    RawPlutusData,
    Transaction,
    TransactionBuilder,
    TransactionOutput,
    VerificationKeyWitness,
)
from pycardano.hash import ScriptHash
from pycardano.transaction import TransactionWitnessSet

from lib.datum import build_open_datum
from lib.escrow_tx import build_and_submit_script_tx
from lib.constants import BUYER_BOND, SUPPLIER_BOND, DISPUTE_WINDOW_MS


async def post_escrow(
    context,
    signer,
    script_hash,
    task_hash,
    payment_dfm,
    deadline_posix_ms,
    resolver_cred,
) -> str:
    """Post escrow on-chain in the Open state.

    Locks payment + buyer_bond + 2M lovelace at the script address.
    Uses manual signing (NOT build_and_sign) to avoid extended key issues.

    Returns the transaction hash as a string.
    """
    script_hash_obj = ScriptHash.from_primitive(script_hash)
    script_address = Address(script_hash_obj, network=context.network)

    buyer_vkh = bytes(signer._wallet.payment_verification_key.hash())

    datum = build_open_datum(
        task_hash_hex=task_hash,
        buyer_vkh=buyer_vkh,
        payment_dfm=payment_dfm,
        buyer_bond=BUYER_BOND,
        supplier_bond=SUPPLIER_BOND,
        deadline_posix_ms=deadline_posix_ms,
        dispute_window_ms=DISPUTE_WINDOW_MS,
        resolver_cred=bytes.fromhex(resolver_cred),
    )

    total_lovelace = payment_dfm + BUYER_BOND + 2_000_000
    datum_obj = RawPlutusData(datum)

    await context.async_protocol_param()

    builder = TransactionBuilder(context)
    builder.add_input_address(signer._wallet.payment_address)
    builder.add_output(
        TransactionOutput(script_address, total_lovelace, datum=datum_obj)
    )

    tx_body = builder.build(change_address=signer._wallet.payment_address)
    sig = signer._wallet.payment_signing_key.sign(tx_body.hash())
    vk_witness = VerificationKeyWitness(signer._wallet.payment_verification_key, sig)
    witness_set = TransactionWitnessSet(vkey_witnesses=[vk_witness])
    tx = Transaction(tx_body, witness_set)

    tx_cbor = tx.to_cbor()
    if isinstance(tx_cbor, bytes):
        tx_cbor = tx_cbor.hex()
    await context.async_submit_tx_cbor(tx_cbor)
    return str(tx.id)


async def accept_result(
    context,
    signer,
    utxo,
    script,
    script_address,
    supplier_address,
    payment_dfm,
) -> str:
    """Accept a submitted result -- Accept redeemer (CBORTag 123, []).

    Pays the supplier: payment + supplier_bond + buyer_bond.
    The buyer gets back the remaining lovelace (min UTxO overhead) as change.

    Returns the transaction hash as a string.
    """
    from pycardano import Address as PycAddress

    supplier_addr = PycAddress.from_primitive(supplier_address)
    supplier_payout = payment_dfm + SUPPLIER_BOND + BUYER_BOND

    redeemer_obj = CBORTag(123, [])
    tx_hash = await build_and_submit_script_tx(
        context=context,
        signer=signer,
        utxo=utxo,
        script=script,
        script_address=script_address,
        redeemer_obj=redeemer_obj,
        output_value=0,
        output_datum_obj=None,
        task_id="accept",
        step_name="Accept",
        extra_outputs=[
            TransactionOutput(supplier_addr, supplier_payout),
        ],
    )
    return tx_hash


async def reclaim_escrow(
    context,
    signer,
    utxo,
    script,
    script_address,
) -> str:
    """Reclaim escrow funds -- Reclaim redeemer (CBORTag 126, []).

    Returns the transaction hash as a string.
    """
    redeemer_obj = CBORTag(126, [])
    tx_hash = await build_and_submit_script_tx(
        context=context,
        signer=signer,
        utxo=utxo,
        script=script,
        script_address=script_address,
        redeemer_obj=redeemer_obj,
        output_value=0,
        output_datum_obj=None,
        task_id="reclaim",
        step_name="Reclaim",
    )
    return tx_hash
