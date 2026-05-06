"""Buyer configuration -- loads .env and exposes typed settings."""
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


@dataclass
class BuyerConfig:
    ogmios_url: str
    submit_url: str
    buyer_mnemonic: str
    escrow_script_hash: str
    resolver_address: str
    supplier_urls: List[str] = field(default_factory=list)
    port: int = 8080


def get_config() -> BuyerConfig:
    raw_urls = os.getenv("SUPPLIER_URLS", "http://localhost:9000")
    supplier_urls = [u.strip() for u in raw_urls.split(",") if u.strip()]

    return BuyerConfig(
        ogmios_url=os.getenv("VECTOR_OGMIOS_URL", "https://ogmios.vector.testnet.apexfusion.org"),
        submit_url=os.getenv("VECTOR_SUBMIT_URL", "https://submit.vector.apexfusion.org/api/submit/tx"),
        buyer_mnemonic=os.getenv("BUYER_MNEMONIC", ""),
        escrow_script_hash=os.getenv("ESCROW_SCRIPT_HASH", ""),
        resolver_address=os.getenv("RESOLVER_ADDRESS", ""),
        supplier_urls=supplier_urls,
        port=int(os.getenv("BUYER_PORT", "8080")),
    )
