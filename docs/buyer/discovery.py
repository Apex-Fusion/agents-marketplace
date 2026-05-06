"""Simple supplier discovery -- checks health of known supplier URLs."""
import asyncio
from typing import List

from lib.protocol import SupplierInfo
from supplier_client import check_supplier_health


async def discover_suppliers(config) -> List[SupplierInfo]:
    """Check health of each URL in config.supplier_urls and return reachable suppliers.

    Args:
        config: BuyerConfig with supplier_urls list.

    Returns:
        List of SupplierInfo for reachable suppliers.
    """
    tasks = [check_supplier_health(url) for url in config.supplier_urls]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    suppliers = []
    for i, result in enumerate(results):
        if isinstance(result, SupplierInfo):
            # Ensure the endpoint field reflects the URL we queried
            if not result.endpoint:
                result.endpoint = config.supplier_urls[i]
            suppliers.append(result)

    return suppliers
