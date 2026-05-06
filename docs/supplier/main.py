"""
Supplier service entry point.
Serves the API and the web dashboard.
"""
import sys
import os

# Make the supplier folder the root for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent / ".env")

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from api import router
from config import get_config

app = FastAPI(title="Vector Supplier Service")
app.include_router(router)
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")


@app.get("/")
async def index():
    return FileResponse(str(Path(__file__).parent / "static" / "dashboard.html"))


if __name__ == "__main__":
    config = get_config()
    print(f"Starting Vector Supplier Node '{config.name}' on port {config.port}")
    print(f"Dashboard: http://localhost:{config.port}")
    uvicorn.run(app, host="0.0.0.0", port=config.port)
