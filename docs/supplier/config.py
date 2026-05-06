"""Supplier configuration — loads .env and exposes typed settings."""
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


@dataclass
class SupplierConfig:
    ogmios_url: str
    submit_url: str
    supplier_mnemonic: str
    escrow_script_hash: str
    openrouter_api_key: str
    resolver_address: str
    port: int
    name: str


def get_config() -> SupplierConfig:
    return SupplierConfig(
        ogmios_url=os.getenv("VECTOR_OGMIOS_URL", "https://ogmios.vector.testnet.apexfusion.org"),
        submit_url=os.getenv("VECTOR_SUBMIT_URL", "https://submit.vector.apexfusion.org/api/submit/tx"),
        supplier_mnemonic=os.getenv("SUPPLIER_MNEMONIC", ""),
        escrow_script_hash=os.getenv("ESCROW_SCRIPT_HASH", ""),
        openrouter_api_key=os.getenv("OPENROUTER_API_KEY", ""),
        resolver_address=os.getenv("RESOLVER_ADDRESS", ""),
        port=int(os.getenv("SUPPLIER_PORT", "9000")),
        name=os.getenv("SUPPLIER_NAME", "default-supplier"),
    )
