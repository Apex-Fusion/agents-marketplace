from typing import List, Optional
from pydantic import BaseModel


class TaskRequest(BaseModel):
    task_id: str
    prompt: str
    escrow_tx: str
    escrow_script_hash: str
    payment_dfm: int
    task_hash: str
    buyer_address: str
    model_preference: str = "nemotron"
    max_tokens: int = 2048
    temperature: float = 0.7
    deadline_posix_ms: int = 9_999_999_999_999
    dispute_window_ms: int = 600_000


class TaskResponse(BaseModel):
    task_id: str
    status: str
    response: str
    result_hash: str
    model_used: str
    input_tokens: int
    output_tokens: int
    claim_tx: str
    submit_tx: str
    error: str = ""


class SupplierInfo(BaseModel):
    name: str
    address: str
    endpoint: str
    models: List[str]
    min_payment_dfm: int = 1_000_000
