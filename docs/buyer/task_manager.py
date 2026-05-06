"""Orchestrates the full buyer flow: escrow -> task -> accept."""
import hashlib
import time
from uuid import uuid4

from pycardano import Address
from pycardano.hash import ScriptHash

from lib.blueprint import load_escrow_script
from lib.chain import find_script_utxo, wait_for_utxo
from lib.constants import DEFAULT_DEADLINE_OFFSET_MS, DISPUTE_WINDOW_MS
from lib.protocol import TaskRequest

from escrow_ops import post_escrow, accept_result
from supplier_client import send_task, check_supplier_health
from storage import get_task


async def submit_task(prompt, payment_apex, supplier_url, buyer_agent, config) -> dict:
    """Execute the full buyer flow:

    1. Load script from blueprint
    2. Compute task_hash = sha256(f"{task_id}:{prompt}")
    3. Compute deadline_posix_ms = current_posix_ms + DEFAULT_DEADLINE_OFFSET_MS
    4. Post escrow on-chain (Open state)
    5. Send TaskRequest to supplier via HTTP
    6. Return combined result dict

    Args:
        prompt: The user's prompt text.
        payment_apex: Payment amount in APEX (float).
        supplier_url: URL of the supplier to use.
        buyer_agent: VectorAgent instance for the buyer.
        config: BuyerConfig instance.

    Returns:
        dict with escrow_tx, response data, supplier info, etc.
    """
    context = buyer_agent.context
    task_id = f"task-{uuid4().hex[:8]}"
    payment_dfm = int(payment_apex * 1_000_000)

    # 1. Load script from blueprint
    script, script_hash_str = load_escrow_script()

    # 2. Compute task hash
    task_hash = hashlib.sha256(f"{task_id}:{prompt}".encode()).hexdigest()

    # 3. Compute deadline
    current_posix_ms = int(time.time() * 1000)
    deadline_posix_ms = current_posix_ms + DEFAULT_DEADLINE_OFFSET_MS

    # 4. Extract resolver credential from resolver address
    resolver_addr = Address.from_primitive(config.resolver_address)
    resolver_cred = bytes(resolver_addr.payment_part).hex()

    # 5. Post escrow on-chain
    escrow_tx = await post_escrow(
        context=context,
        signer=buyer_agent,
        script_hash=config.escrow_script_hash,
        task_hash=task_hash,
        payment_dfm=payment_dfm,
        deadline_posix_ms=deadline_posix_ms,
        resolver_cred=resolver_cred,
    )

    print(f"[Buyer] Escrow posted: {escrow_tx}")

    # 6. Send task to supplier
    task_request = TaskRequest(
        task_id=task_id,
        prompt=prompt,
        escrow_tx=escrow_tx,
        escrow_script_hash=config.escrow_script_hash,
        payment_dfm=payment_dfm,
        task_hash=task_hash,
        buyer_address=buyer_agent.address,
        model_preference="nemotron",
        max_tokens=2048,
        temperature=0.7,
        deadline_posix_ms=deadline_posix_ms,
        dispute_window_ms=DISPUTE_WINDOW_MS,
    )

    start_time = time.time()
    response = await send_task(supplier_url, task_request)
    latency_ms = int((time.time() - start_time) * 1000)

    print(f"[Buyer] Supplier response: status={response.status}")

    return {
        "task_id": task_id,
        "prompt": prompt,
        "payment_apex": payment_apex,
        "payment_dfm": payment_dfm,
        "escrow_tx": escrow_tx,
        "task_hash": task_hash,
        "supplier_url": supplier_url,
        "buyer_address": buyer_agent.address,
        "deadline_posix_ms": deadline_posix_ms,
        "status": response.status,
        "response": response.response,
        "result_hash": response.result_hash,
        "model_used": response.model_used,
        "input_tokens": response.input_tokens,
        "output_tokens": response.output_tokens,
        "claim_tx": response.claim_tx,
        "submit_tx": response.submit_tx,
        "latency_ms": latency_ms,
        "completed_at": time.time(),
        "error": response.error,
    }


async def accept_task(task_id, buyer_agent, config) -> str:
    """Accept a submitted task result by spending the escrow UTxO.

    Loads the task from local storage, finds the Submit UTxO on-chain,
    and calls accept_result.

    Args:
        task_id: The task identifier.
        buyer_agent: VectorAgent instance for the buyer.
        config: BuyerConfig instance.

    Returns:
        The accept transaction hash as a string.
    """
    task_data = get_task(task_id)
    if not task_data:
        raise ValueError(f"Task {task_id} not found in storage")

    submit_tx_hash = task_data.get("submit_tx")
    if not submit_tx_hash:
        raise ValueError(f"Task {task_id} has no submit_tx recorded")

    context = buyer_agent.context
    script, script_hash_str = load_escrow_script()

    script_hash_obj = ScriptHash.from_primitive(config.escrow_script_hash)
    script_address = Address(script_hash_obj, network=context.network)

    # Find the UTxO at the script address
    utxo = await find_script_utxo(context, str(script_address), submit_tx_hash)
    if not utxo:
        # Try waiting for it
        utxo = await wait_for_utxo(context, str(script_address), submit_tx_hash)

    # Get the supplier's wallet address
    supplier_url = task_data.get("supplier_url", "")
    supplier_info = await check_supplier_health(supplier_url) if supplier_url else None
    if not supplier_info or not supplier_info.address:
        raise ValueError(f"Cannot resolve supplier address from {supplier_url}")

    accept_tx = await accept_result(
        context=context,
        signer=buyer_agent,
        utxo=utxo,
        script=script,
        script_address=script_address,
        supplier_address=supplier_info.address,
        payment_dfm=task_data.get("payment_dfm", 0),
    )

    print(f"[Buyer] Accepted task {task_id}: {accept_tx}")
    return accept_tx
