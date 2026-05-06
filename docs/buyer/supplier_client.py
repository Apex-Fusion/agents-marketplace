"""HTTP client for communicating with suppliers."""
from typing import Optional

import httpx

from lib.protocol import SupplierInfo, TaskRequest, TaskResponse


async def send_task(supplier_url: str, task_request: TaskRequest) -> TaskResponse:
    """POST a task to a supplier and return the parsed response.

    Args:
        supplier_url: Base URL of the supplier (e.g. http://localhost:9000).
        task_request: The task request payload.

    Returns:
        TaskResponse parsed from the supplier's JSON response.
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{supplier_url.rstrip('/')}/task",
            json=task_request.model_dump(),
        )
        resp.raise_for_status()
        return TaskResponse(**resp.json())


async def check_supplier_health(supplier_url: str) -> Optional[SupplierInfo]:
    """GET supplier info endpoint and return parsed SupplierInfo, or None on failure.

    Args:
        supplier_url: Base URL of the supplier.

    Returns:
        SupplierInfo if reachable, None otherwise.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{supplier_url.rstrip('/')}/info")
            resp.raise_for_status()
            data = resp.json()
            return SupplierInfo(**data)
    except Exception:
        return None
