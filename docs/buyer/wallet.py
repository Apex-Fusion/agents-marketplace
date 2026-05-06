"""Buyer wallet -- initializes VectorAgent from mnemonic."""
from vector_agent import VectorAgent

from config import get_config


def get_buyer_agent() -> VectorAgent:
    """Create and return a VectorAgent from the configured buyer mnemonic."""
    config = get_config()
    agent = VectorAgent(
        ogmios_url=config.ogmios_url,
        submit_url=config.submit_url,
        mnemonic=config.buyer_mnemonic,
    )
    return agent
