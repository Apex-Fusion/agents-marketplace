"""
Task runner — orchestrates the full supplier flow from request to on-chain settlement.
"""
import asyncio
import hashlib
import logging
import time

from pycardano import Address as PycAddress
from pycardano.hash import ScriptHash

from lib.blueprint import load_escrow_script
from lib.chain import wait_for_utxo
from lib.constants import TX_PROPAGATION_DELAY
from lib.protocol import TaskRequest, TaskResponse

from escrow_ops import verify_open_utxo, claim_escrow, submit_result
from llm import LLMProvider
from config import SupplierConfig

logger = logging.getLogger(__name__)


async def run_task(
    task_request: TaskRequest,
    supplier_agent,
    llm_provider: LLMProvider,
    config: SupplierConfig,
) -> TaskResponse:
    """Execute the full supplier workflow for a task request.

    Steps:
        1. Load script from blueprint
        2. Verify the Open UTxO on-chain
        3. Call LLM
        4. Claim escrow (Open -> Claimed)
        5. Wait for claim UTxO (sleep TX_PROPAGATION_DELAY, then wait_for_utxo)
        6. Submit result hash (Claimed -> Submitted)
        7. Return TaskResponse with all TX hashes
    """
    task_id = task_request.task_id
    prompt = task_request.prompt

    # Compute hashes
    task_hash = hashlib.sha256(f"{task_id}:{prompt}".encode()).hexdigest()

    try:
        # 1. Load script from blueprint
        script, script_hash_str = load_escrow_script()
        script_hash_val = ScriptHash(bytes.fromhex(script_hash_str))
        script_address = PycAddress(script_hash_val, network=supplier_agent.context.network)
        script_addr_str = str(script_address)

        logger.info(f"[{task_id}] Script address: {script_addr_str}")

        # Extract credentials
        supplier_vkh = supplier_agent._wallet.payment_verification_key.hash().payload

        buyer_addr = PycAddress.from_primitive(task_request.buyer_address)
        buyer_vkh = buyer_addr.payment_part.payload

        resolver_addr = PycAddress.from_primitive(config.resolver_address)
        resolver_cred = resolver_addr.payment_part.payload

        # 2. Verify the Open UTxO on-chain
        logger.info(f"[{task_id}] Verifying Open escrow UTxO...")
        utxo = await verify_open_utxo(
            supplier_agent.context, script_addr_str, task_request.escrow_tx
        )

        # 3. Call LLM
        logger.info(f"[{task_id}] Calling LLM...")
        start_time = time.time()
        llm_result = await llm_provider.complete(
            prompt=prompt,
            model_preference=[task_request.model_preference, "any"],
            max_tokens=task_request.max_tokens,
            temperature=task_request.temperature,
        )
        latency_ms = int((time.time() - start_time) * 1000)
        logger.info(
            f"[{task_id}] LLM response: model={llm_result.model}, "
            f"tokens={llm_result.input_tokens}+{llm_result.output_tokens}, "
            f"latency={latency_ms}ms"
        )

        response_text = llm_result.text
        result_hash = hashlib.sha256(f"{task_id}{response_text}".encode()).hexdigest()

        # 4. Claim escrow (Open -> Claimed)
        logger.info(f"[{task_id}] Claiming escrow...")
        claim_tx = await claim_escrow(
            context=supplier_agent.context,
            signer=supplier_agent,
            utxo=utxo,
            script=script,
            script_address=script_address,
            task_hash=task_hash,
            buyer_vkh=buyer_vkh,
            supplier_vkh=supplier_vkh,
            payment_dfm=task_request.payment_dfm,
            resolver_cred=resolver_cred,
            deadline_posix_ms=task_request.deadline_posix_ms,
            dispute_window_ms=task_request.dispute_window_ms,
        )
        logger.info(f"[{task_id}] Claim TX: {claim_tx}")

        # 5. Wait for claim UTxO
        logger.info(f"[{task_id}] Waiting for claim UTxO ({TX_PROPAGATION_DELAY}s)...")
        await asyncio.sleep(TX_PROPAGATION_DELAY)
        claimed_utxo = await wait_for_utxo(
            supplier_agent.context, script_addr_str, claim_tx
        )
        logger.info(f"[{task_id}] Claim UTxO confirmed")

        # 6. Submit result hash (Claimed -> Submitted)
        logger.info(f"[{task_id}] Submitting result hash...")
        submit_tx = await submit_result(
            context=supplier_agent.context,
            signer=supplier_agent,
            utxo=claimed_utxo,
            script=script,
            script_address=script_address,
            task_hash=task_hash,
            buyer_vkh=buyer_vkh,
            supplier_vkh=supplier_vkh,
            payment_dfm=task_request.payment_dfm,
            result_hash_hex=result_hash,
            resolver_cred=resolver_cred,
            deadline_posix_ms=task_request.deadline_posix_ms,
            dispute_window_ms=task_request.dispute_window_ms,
        )
        logger.info(f"[{task_id}] Submit TX: {submit_tx}")

        # 7. Return TaskResponse
        return TaskResponse(
            task_id=task_id,
            status="completed",
            response=response_text,
            result_hash=result_hash,
            model_used=llm_result.model,
            input_tokens=llm_result.input_tokens,
            output_tokens=llm_result.output_tokens,
            claim_tx=claim_tx,
            submit_tx=submit_tx,
        )

    except Exception as e:
        logger.error(f"[{task_id}] Task failed: {e}", exc_info=True)
        return TaskResponse(
            task_id=task_id,
            status="failed",
            response="",
            result_hash="",
            model_used="",
            input_tokens=0,
            output_tokens=0,
            claim_tx="",
            submit_tx="",
            error=str(e),
        )
