"""CLI entry point for the Programs Feasibility Support extraction pipeline.

Usage:
    python -m hubspot_client.run --days 7      # extract + print stats only
    python -m hubspot_client.run --incremental # sync from cursor, write to DB
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time

from core.database import db_manager
from hubspot_client import pipeline


async def _main(since_ms: int, incremental: bool) -> None:
    await db_manager.initialize()
    try:
        if incremental:
            stats = await pipeline.run_incremental()
        else:
            programs = await pipeline.extract(since_ms)
            stats = pipeline.summarize(programs)
    finally:
        await db_manager.close()
    print(json.dumps(stats, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Programs Feasibility Support extraction pipeline"
    )
    parser.add_argument(
        "--days", type=int, default=365, help="Look back N days (default: 365)"
    )
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Sync from the last cursor, write to DB, and advance the cursor",
    )
    args = parser.parse_args()

    since_ms = int((time.time() - args.days * 86400) * 1000)
    asyncio.run(_main(since_ms=since_ms, incremental=args.incremental))


if __name__ == "__main__":
    main()
