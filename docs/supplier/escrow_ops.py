"""
Supplier-side escrow operations — verify, claim, and submit on-chain.
"""
import logging

from cbor2 import CBORTag
from pycardano import RawPlutusData, Address as PycAddress

from lib.chain import find_script_utxo, slot_to_posix_ms, wait_for_utxo
from lib.constants import BUYER_BOND, SUPPLIER_BOND
from lib.datum import build_claimed_datum, build_submitted_datum
from lib.escrow_tx import build_and_submit_script_tx

logger = logging.getLogger(__name__)


async def verify_open_utxo(context, script_address, escrow_tx):
    """Find the Open UTxO, waiting for propagation if needed.

    Args:
        context: Chain context.
        script_address: The escrow script address.
        escrow_tx: The transaction hash that created the escrow UTxO.

    Returns:
        The UTxO if found and valid.

    Raises:
        ValueError: If the UTxO is not found after waiting.
    """
    # First try a quick lookup
    utxo = await find_script_utxo(context, script_address, escrow_tx)
    if utxo is not None:
        logger.info(f"Found Open escrow UTxO: {utxo.input.transaction_id}#{utxo.input.index}")
        return utxo

    # Wait for propagation
    logger.info(f"UTxO not found yet, waiting for propagation...")
    try:
        utxo = await wait_for_utxo(context, script_address, escrow_tx)
        logger.info(f"Found Open escrow UTxO: {utxo.input.transaction_id}#{utxo.input.index}")
        return utxo
    except TimeoutError:
        raise ValueError(f"Open escrow UTxO not found for tx {escrow_tx} after waiting")


async def claim_escrow(
    context,
    signer,
    utxo,
    script,
    script_address,
    task_hash,
    buyer_vkh,
    supplier_vkh,
    payment_dfm,
    resolver_cred,
    deadline_posix_ms,
    dispute_window_ms,
):
    """Build Claimed datum, Claim redeemer, and submit the Claim transaction.

    Transitions the escrow from Open -> Claimed.

    Returns:
        str: The claim transaction hash.
    """
    # Build the Claimed datum
    claimed_datum = build_claimed_datum(
        task_hash_hex=task_hash,
        buyer_vkh=buyer_vkh,
        supplier_vkh=supplier_vkh,
        payment_dfm=payment_dfm,
        buyer_bond=BUYER_BOND,
        supplier_bond=SUPPLIER_BOND,
        deadline_posix_ms=deadline_posix_ms,
        dispute_window_ms=dispute_window_ms,
        resolver_cred=resolver_cred,
    )

    # Redeemer: Claim { supplier_cred } — constructor 0 = CBORTag(121, [...])
    claim_redeemer = CBORTag(121, [
        CBORTag(121, [supplier_vkh]),
    ])

    total_value = payment_dfm + BUYER_BOND + SUPPLIER_BOND + 2_000_000

    claim_tx = await build_and_submit_script_tx(
        context=context,
        signer=signer,
        utxo=utxo,
        script=script,
        script_address=script_address,
        redeemer_obj=claim_redeemer,
        output_value=total_value,
        output_datum_obj=claimed_datum,
        task_id=task_hash[:8],
        step_name="Claim",
    )

    logger.info(f"Claim TX submitted: {claim_tx}")
    return claim_tx


async def submit_result(
    context,
    signer,
    utxo,
    script,
    script_address,
    task_hash,
    buyer_vkh,
    supplier_vkh,
    payment_dfm,
    result_hash_hex,
    resolver_cred,
    deadline_posix_ms,
    dispute_window_ms,
):
    """Build Submitted datum, Submit redeemer, and submit the Submit transaction.

    Transitions the escrow from Claimed -> Submitted.

    Returns:
        str: The submit transaction hash.
    """
    # Compute submitted_posix_ms from validity_start
    current_slot = await context.async_last_block_slot()
    validity_start_slot = current_slot - 1000
    submitted_posix_ms = slot_to_posix_ms(context, validity_start_slot)

    logger.info(
        f"Submit: slot={current_slot}, validity_start={validity_start_slot}, "
        f"posix_ms={submitted_posix_ms}"
    )

    # Build the Submitted datum
    submitted_datum = build_submitted_datum(
        task_hash_hex=task_hash,
        buyer_vkh=buyer_vkh,
        supplier_vkh=supplier_vkh,
        payment_dfm=payment_dfm,
        buyer_bond=BUYER_BOND,
        supplier_bond=SUPPLIER_BOND,
        deadline_posix_ms=deadline_posix_ms,
        dispute_window_ms=dispute_window_ms,
        result_hash_hex=result_hash_hex,
        submitted_posix_ms=submitted_posix_ms,
        resolver_cred=resolver_cred,
    )

    # Redeemer: Submit { result_hash } — constructor 1 = CBORTag(122, [...])
    submit_redeemer = CBORTag(122, [
        bytes.fromhex(result_hash_hex),
    ])

    total_value = payment_dfm + BUYER_BOND + SUPPLIER_BOND + 2_000_000

    submit_tx = await build_and_submit_script_tx(
        context=context,
        signer=signer,
        utxo=utxo,
        script=script,
        script_address=script_address,
        redeemer_obj=submit_redeemer,
        output_value=total_value,
        output_datum_obj=submitted_datum,
        task_id=task_hash[:8],
        step_name="Submit",
        validity_start_slot=validity_start_slot,
    )

    logger.info(f"Submit TX submitted: {submit_tx}")
    return submit_tx
