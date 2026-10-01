"""Extraction pipeline: fetch HubSpot programs, normalize, and persist.

run_incremental is the one entry point (scheduler and the "Sync now" button
both go through run_tracked). Only one sync runs at a time: an in-process
lock plus a Postgres advisory lock, so extra API workers can't overlap either.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import func, select

from core.config import settings
from core.database import db_manager
from hubspot_client import cursor as cursor_store
from hubspot_client.client import HubSpotClient
from hubspot_client.db_writer import (
    delete_missing_programs,
    upsert_notes,
    upsert_programs,
    upsert_stage_history,
)
from hubspot_client.documents import apply_sow_deal_value, sync_documents
from hubspot_client.models import ProgramNoteModel, ProgramTicket, StageHistoryEvent

logger = structlog.get_logger(__name__)

# First incremental run has no cursor yet; seed it with this lookback.
_DEFAULT_LOOKBACK_DAYS = 365
_INDEX_LAG = timedelta(minutes=5)
_ADVISORY_LOCK_KEY = 872_001
_MANUAL_COOLDOWN = timedelta(seconds=20)


async def extract(since_ms: int) -> tuple[list[ProgramTicket], list[str]]:
    """Fetch and normalize all programs modified since `since_ms`. Returns
    (programs, skipped_ticket_ids): one malformed ticket is logged and skipped
    instead of failing (and forever blocking) the whole sync."""
    client = HubSpotClient()
    pipeline = await client.fetch_pipeline()
    owners = await client.fetch_owners()

    programs: list[ProgramTicket] = []
    skipped: list[str] = []
    async for raw in client.fetch_programs(since_ms):
        try:
            programs.append(
                ProgramTicket.from_raw(raw, pipeline, settings.PROGRAM_PIPELINE_ID, owners)
            )
        except Exception:
            logger.exception("ticket_skipped", ticket_id=raw.get("id"))
            skipped.append(str(raw.get("id")))
    return programs, skipped


async def extract_history_and_notes(
    ticket_ids: list[str],
) -> tuple[list[StageHistoryEvent], list[ProgramNoteModel]]:
    """Fetch HubSpot's own property-change log and any associated Notes for
    the given programs -- the audit trail (program_stage_history,
    program_notes)."""
    client = HubSpotClient()
    history_by_ticket = await client.fetch_property_history(ticket_ids)
    notes_by_ticket = await client.fetch_notes(ticket_ids)

    events = [
        event
        for ticket_id, property_history in history_by_ticket.items()
        for event in StageHistoryEvent.from_property_history(ticket_id, property_history)
    ]
    notes = [
        ProgramNoteModel.from_raw(ticket_id, raw)
        for ticket_id, raw_notes in notes_by_ticket.items()
        for raw in raw_notes
    ]
    return events, notes


async def _sync() -> dict:
    since = await cursor_store.get_cursor()
    since_ms = (
        int(since.timestamp() * 1000)
        if since
        else int((time.time() - _DEFAULT_LOOKBACK_DAYS * 86400) * 1000)
    )
    # Capture the cursor before fetching, not after, so programs modified
    # mid-run aren't skipped by the next sync (a small re-fetch overlap is
    # fine since upserts are idempotent).
    started_at = datetime.now(timezone.utc)

    programs, skipped = await extract(since_ms)
    await upsert_programs(programs)

    ticket_ids = [p.ticket_id for p in programs]
    events, notes = await extract_history_and_notes(ticket_ids)
    await upsert_stage_history(events)
    await upsert_notes(notes)

    # Documents and deletions are reconciled against the whole table, not just
    # this run's tickets, so earlier failures heal on their own.
    documents = await sync_documents()
    await apply_sow_deal_value()
    deleted = await _reconcile_deleted()

    # Back the cursor off: HubSpot's search index lags edits by up to a few
    # minutes, so a change made just before this run may not be visible yet and
    # would otherwise fall behind the cursor and never sync.
    await cursor_store.set_cursor(started_at - _INDEX_LAG)

    stats = summarize(programs)
    stats.update(
        stage_history_events=len(events),
        notes=len(notes),
        documents=documents,
        deleted=deleted,
        skipped=skipped,
    )
    return stats


async def _reconcile_deleted() -> list[str]:
    """Drop programs that were deleted (or moved out of the pipeline) in
    HubSpot. A failure here never fails the sync."""
    try:
        ids = await HubSpotClient().fetch_pipeline_ticket_ids()
        deleted = await delete_missing_programs(ids)
        if deleted:
            logger.info("programs_removed", ticket_ids=deleted)
        return deleted
    except Exception:
        logger.exception("reconcile_failed")
        return []


async def run_incremental() -> dict:
    """Sync since the last cursor (or a default lookback on first run), write
    to the DB, and advance the cursor. Returns {"skipped": ...} if another
    sync -- in this process or another -- already holds the lock."""
    session_factory = db_manager.session_factory()
    async with session_factory() as lock_session:
        got = (
            await lock_session.execute(select(func.pg_try_advisory_lock(_ADVISORY_LOCK_KEY)))
        ).scalar()
        if not got:
            return {"skipped": "another sync is already running"}
        try:
            return await _sync()
        finally:
            await lock_session.execute(select(func.pg_advisory_unlock(_ADVISORY_LOCK_KEY)))
            await lock_session.commit()


# ---- Tracked runs (scheduler + "Sync now") -----------------------------------

_local_lock = asyncio.Lock()
_task: asyncio.Task | None = None
state: dict = {"running": False, "started_at": None, "finished_at": None, "result": None, "error": None}


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def run_tracked() -> dict:
    """run_incremental with status recorded in `state` (for the UI). Never
    raises: failures land in state["error"] and the returned dict."""
    if _local_lock.locked():
        return {"skipped": "another sync is already running"}
    async with _local_lock:
        state.update(running=True, started_at=_now(), error=None)
        try:
            result = await run_incremental()
            state["result"] = result
            return result
        except Exception as e:
            logger.exception("program_sync_failed")
            state["error"] = f"{type(e).__name__}: {e}"[:300]
            return {"error": state["error"]}
        finally:
            state.update(running=False, finished_at=_now())


def start_background_sync() -> str:
    """Kick off a sync without holding the HTTP request open. Returns
    "started", "already_running", or "cooldown" (a manual sync just finished)."""
    global _task
    if state["running"] or _local_lock.locked():
        return "already_running"
    finished = state["finished_at"]
    if finished and _now() - finished < _MANUAL_COOLDOWN:
        return "cooldown"
    _task = asyncio.create_task(run_tracked())  # keep a reference so it isn't GC'd
    return "started"


def summarize(programs: list[ProgramTicket]) -> dict:
    """Aggregate counts used to sanity-check an extraction run."""
    return {
        "total": len(programs),
        "by_stage": dict(Counter(p.stage_label for p in programs)),
        "by_campaign_type": dict(Counter(p.campaign_type or "Unset" for p in programs)),
    }
