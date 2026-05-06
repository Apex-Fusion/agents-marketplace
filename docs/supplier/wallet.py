"""Supplier wallet -- initializes VectorAgent from mnemonic."""
from vector_agent import VectorAgent

from config import get_config


def get_supplier_agent() -> VectorAgent:
    """Create and return a VectorAgent from the configured supplier mnemonic."""
    config = get_config()
    return VectorAgent(
        mnemonic=config.supplier_mnemonic,
        ogmios_url=config.ogmios_url,
        submit_url=config.submit_url,
    )
