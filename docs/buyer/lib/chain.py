import asyncio
from .constants import MAX_UTXO_WAIT


def slot_to_posix_ms(context, slot):
    gp = context.genesis_param
    return (gp.system_start + slot * gp.slot_length) * 1000


async def wait_for_utxo(context, script_address, tx_hash, output_index=0):
    elapsed = 0
    while elapsed < MAX_UTXO_WAIT:
        utxos = await context.async_utxos(str(script_address))
        for utxo in utxos:
            if (
                str(utxo.input.transaction_id) == str(tx_hash)
                and utxo.input.index == output_index
            ):
                return utxo
        await asyncio.sleep(4)
        elapsed += 4
    raise TimeoutError(
        f"UTxO {tx_hash}#{output_index} not found at {script_address} "
        f"after {MAX_UTXO_WAIT}s"
    )


async def find_script_utxo(context, script_address, tx_hash):
    utxos = await context.async_utxos(str(script_address))
    for utxo in utxos:
        if str(utxo.input.transaction_id) == str(tx_hash):
            return utxo
    return None
