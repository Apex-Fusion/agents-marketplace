"""
FastAPI router -- HTTP endpoints for the supplier service.
Includes task processing, health checks, and dashboard API.
"""
import logging
import time

from fastapi import APIRouter, HTTPException

from lib.protocol import TaskRequest, TaskResponse, SupplierInfo

from config import get_config
from wallet import get_supplier_agent
from llm import LLMProvider
from task_runner import run_task
import storage

logger = logging.getLogger(__name__)

router = APIRouter()

# Lazy-initialized singletons
_agent = None
_llm_provider = None
_config = None


def _get_agent():
    global _agent
    if _agent is None:
        _agent = get_supplier_agent()
    return _agent


def _get_llm_provider():
    global _llm_provider
    if _llm_provider is None:
        config = _get_config()
        _llm_provider = LLMProvider(
            openrouter_api_key=config.openrouter_api_key,
        )
    return _llm_provider


def _get_config():
    global _config
    if _config is None:
        _config = get_config()
    return _config


@router.post("/task", response_model=TaskResponse)
async def handle_task(task_request: TaskRequest):
    """Receive a task request from a buyer, fulfill it, and settle on-chain."""
    config = _get_config()
    agent = _get_agent()
    llm = _get_llm_provider()

    logger.info(f"Received task {task_request.task_id} -- escrow_tx={task_request.escrow_tx}")

    start_time = time.time()
    response = await run_task(task_request, agent, llm, config)
    latency_ms = int((time.time() - start_time) * 1000)

    # Save to local storage regardless of success/failure
    task_record = {
        "task_id": task_request.task_id,
        "prompt": task_request.prompt,
        "buyer_address": task_request.buyer_address,
        "payment_dfm": task_request.payment_dfm,
        "escrow_tx": task_request.escrow_tx,
        "task_hash": task_request.task_hash,
        "model_preference": task_request.model_preference,
        "status": response.status,
        "response": response.response,
        "result_hash": response.result_hash,
        "model_used": response.model_used,
        "input_tokens": response.input_tokens,
        "output_tokens": response.output_tokens,
        "claim_tx": response.claim_tx,
        "submit_tx": response.submit_tx,
        "error": response.error,
        "latency_ms": latency_ms,
        "completed_at": time.time(),
    }
    storage.save_task(task_record)

    if response.status == "failed":
        logger.error(f"Task {task_request.task_id} failed: {response.error}")
        raise HTTPException(status_code=500, detail=response.error)

    return response


@router.get("/health")
async def health():
    """Health check endpoint."""
    config = _get_config()
    try:
        agent = _get_agent()
        address = str(agent.address)
    except Exception:
        address = "not initialized"

    return {
        "status": "ok",
        "name": config.name,
        "address": address,
    }


@router.get("/info", response_model=SupplierInfo)
async def info():
    """Return supplier metadata."""
    config = _get_config()
    try:
        agent = _get_agent()
        address = str(agent.address)
    except Exception:
        address = "not initialized"

    return SupplierInfo(
        name=config.name,
        address=address,
        endpoint=f"http://localhost:{config.port}",
        models=[
            "nvidia/nemotron-3-super-120b-a12b",
            "nvidia/nemotron-3-nano-30b-a3b",
            "anthropic/claude-sonnet-4-6",
            "anthropic/claude-haiku-4-5-20251001",
        ],
    )


@router.get("/api/dashboard")
async def dashboard():
    """Return dashboard data: wallet info, stats, and task history."""
    config = _get_config()

    # Wallet info
    wallet_info = {"address": "not initialized", "ada": "0", "lovelace": 0}
    try:
        agent = _get_agent()
        balance = await agent.get_balance()
        wallet_info = {
            "address": balance.address,
            "ada": balance.ada,
            "lovelace": balance.lovelace,
        }
    except Exception as e:
        logger.warning(f"Could not fetch balance: {e}")

    # Task history
    tasks = storage.load_tasks()

    # Compute stats
    completed_tasks = [t for t in tasks if t.get("status") == "completed"]
    total_earnings_dfm = sum(t.get("payment_dfm", 0) for t in completed_tasks)
    tasks_completed = len(completed_tasks)
    total_tokens = sum(
        t.get("input_tokens", 0) + t.get("output_tokens", 0)
        for t in completed_tasks
    )
    avg_latency_ms = 0
    if completed_tasks:
        latencies = [t.get("latency_ms", 0) for t in completed_tasks if t.get("latency_ms")]
        avg_latency_ms = int(sum(latencies) / len(latencies)) if latencies else 0

    return {
        "wallet": wallet_info,
        "stats": {
            "total_earnings_dfm": total_earnings_dfm,
            "tasks_completed": tasks_completed,
            "avg_latency_ms": avg_latency_ms,
            "total_tokens": total_tokens,
        },
        "tasks": list(reversed(tasks)),  # Most recent first
        "name": config.name,
    }


@router.get("/api/tasks")
async def api_tasks():
    """Return task history."""
    tasks = storage.load_tasks()
    return {"tasks": list(reversed(tasks)), "total": len(tasks)}
