"""Simple JSON file storage for task history."""
import json
from pathlib import Path
from typing import List, Optional

DATA_DIR = Path(__file__).parent / "data"
TASKS_FILE = DATA_DIR / "tasks.json"


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not TASKS_FILE.exists():
        TASKS_FILE.write_text("[]", encoding="utf-8")


def save_task(task_data: dict):
    """Append a task record to tasks.json."""
    _ensure_data_dir()
    tasks = load_tasks()
    tasks.append(task_data)
    TASKS_FILE.write_text(json.dumps(tasks, indent=2), encoding="utf-8")


def load_tasks() -> List[dict]:
    """Read all tasks from tasks.json."""
    _ensure_data_dir()
    try:
        raw = TASKS_FILE.read_text(encoding="utf-8")
        return json.loads(raw)
    except (json.JSONDecodeError, FileNotFoundError):
        return []


def get_task(task_id: str) -> Optional[dict]:
    """Find a task by its task_id."""
    tasks = load_tasks()
    for t in tasks:
        if t.get("task_id") == task_id:
            return t
    return None


def update_task(task_id: str, updates: dict):
    """Update fields of an existing task by task_id."""
    _ensure_data_dir()
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t.get("task_id") == task_id:
            tasks[i].update(updates)
            break
    TASKS_FILE.write_text(json.dumps(tasks, indent=2), encoding="utf-8")
