"""In-process auto-sync -- runs the HubSpot incremental sync inside the API
server's own event loop via APScheduler, so the DB reflects HubSpot without
needing a manual `python -m hubspot_client.run --incremental` invocation or
an external crontab.

Only safe with a single server process -- multiple uvicorn workers/replicas
would each start their own scheduler, causing redundant concurrent syncs.
Fine today (see main.py, plain `uvicorn main:app`, no --workers); revisit
with a lock (e.g. a Postgres advisory lock) if that ever changes.
"""

from __future__ import annotations

from datetime import datetime, timezone

import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from core.redash_sync import REFRESH_HOURS, run_all as redash_run_all
from hubspot_client import pipeline

logger = structlog.get_logger(__name__)

_INTERVAL_MINUTES = 10
_JOB_ID = "program_incremental_sync"


async def _sync_once() -> None:
    """run_tracked never raises; APScheduler just needs the log line."""
    result = await pipeline.run_tracked()
    logger.info("program_sync_complete" if "error" not in result else "program_sync_errored", **result)


def start_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        _sync_once,
        IntervalTrigger(minutes=_INTERVAL_MINUTES),
        id=_JOB_ID,
        next_run_time=datetime.now(
            timezone.utc
        ),  # run immediately on startup, not after the first interval
        max_instances=1,  # don't overlap if a sync ever runs long
        coalesce=True,  # if we fall behind, run once on catch-up, not once per missed interval
    )
    scheduler.add_job(
        redash_run_all, IntervalTrigger(hours=REFRESH_HOURS), id="redash_registrations_sync",
        max_instances=1, coalesce=True,
    )
    scheduler.start()
    return scheduler
