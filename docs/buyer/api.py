"""FastAPI router -- buyer API endpoints."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import get_config
from wallet import get_buyer_agent
from task_manager import submit_task, accept_task
from discovery import discover_suppliers
import storage

router = APIRouter()


class SubmitRequest(BaseModel):
    prompt: str
    payment_apex: float = 5.0
    supplier_url: str = ""


@router.post("/api/submit")
async def api_submit(req: SubmitRequest):
    """Submit a new task: post escrow, send to supplier, return result."""
    config = get_config()
    buyer_agent = get_buyer_agent()

    supplier_url = req.supplier_url or (config.supplier_urls[0] if config.supplier_urls else "")
    if not supplier_url:
        raise HTTPException(status_code=400, detail="No supplier URL provided")

    try:
        result = await submit_task(
            prompt=req.prompt,
            payment_apex=req.payment_apex,
            supplier_url=supplier_url,
            buyer_agent=buyer_agent,
            config=config,
        )
        storage.save_task(result)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/accept/{task_id}")
async def api_accept(task_id: str):
    """Accept a completed task result and release payment."""
    config = get_config()
    buyer_agent = get_buyer_agent()

    try:
        accept_tx = await accept_task(task_id, buyer_agent, config)
        storage.update_task(task_id, {"accept_tx": accept_tx, "status": "accepted"})
        return {"accept_tx": accept_tx}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/tasks")
async def api_tasks():
    """Return task history from local storage."""
    tasks = storage.load_tasks()
    return {"tasks": tasks, "total": len(tasks)}


@router.get("/api/suppliers")
async def api_suppliers():
    """Discover reachable suppliers and return their info."""
    config = get_config()
    suppliers = await discover_suppliers(config)
    return {
        "suppliers": [s.model_dump() for s in suppliers],
        "total": len(suppliers),
    }


@router.get("/api/balance")
async def api_balance():
    """Return the buyer wallet balance."""
    try:
        buyer_agent = get_buyer_agent()
        balance = await buyer_agent.get_balance()
        return {
            "address": balance.address,
            "ada": balance.ada,
            "lovelace": balance.lovelace,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
