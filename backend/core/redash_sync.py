"""Registrations from HackerEarth via Redash (he-metrics), for programs in auto mode.

Query 6123 (REDASH_REGISTRATIONS_QUERY_ID, param `event_slug`) returns one row per
event whose "Registration Daily JSON" is [{"date", "count"}, ...]: the date and that
day's relevant registration count (no role split). Each day is stored with role ''
and registrations = relevant = count. Query 6142 (REDASH_EVENTS_QUERY_ID) lists the
active events, for the slug picker.
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timezone

import structlog
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from core import redash
from core.config import settings
from core.database import db_manager
from core.orm import ProgramRegistration, ProgramRegistrationSettings

logger = structlog.get_logger(__name__)


def days_from_row(row: dict) -> dict[date, int]:
    """'Registration Daily JSON' -> {date: count}. Empty/absent = no registrations yet."""
    raw = row.get("Registration Daily JSON") or "[]"
    try:
        return {date.fromisoformat(str(d["date"])[:10]): int(d["count"]) for d in json.loads(raw)}
    except (ValueError, KeyError, TypeError) as e:
        raise redash.RedashError(f"Unexpected 'Registration Daily JSON' from Redash: {e.__class__.__name__}") from e


async def fetch_event(slug: str) -> tuple[dict, dict[date, int]]:
    """(event info, {date: count}). Raises RedashError (user-safe message) if
    unconfigured, unreachable or the slug is unknown."""
    if not settings.REDASH_REGISTRATIONS_QUERY_ID:
        raise redash.RedashError("Redash registrations query isn't configured (REDASH_REGISTRATIONS_QUERY_ID).")
    result = await redash.run_query(settings.REDASH_REGISTRATIONS_QUERY_ID, {"event_slug": slug})
    row = next((r for r in result["rows"] if r.get("Event Slug") == slug), None)
    if row is None:
        raise redash.RedashError(f"No HackerEarth event found for slug '{slug}'.")
    info = {
        "slug": slug, "name": row.get("Event Name"), "type": row.get("Event Type"),
        "company": row.get("Company"), "start": row.get("Start"), "end": row.get("End"),
        "live": row.get("Is Live") == "Yes",
    }
    return info, days_from_row(row)


async def fetch_days(slug: str) -> dict[date, int]:
    return (await fetch_event(slug))[1]


async def active_events() -> list[dict]:
    """Active events (hackathons and hiring challenges) for the picker, live first."""
    if not settings.REDASH_EVENTS_QUERY_ID:
        raise redash.RedashError("Redash events query isn't configured (REDASH_EVENTS_QUERY_ID).")
    result = await redash.run_query(settings.REDASH_EVENTS_QUERY_ID, max_age=600)
    events = [
        {
            "slug": r.get("Event Slug"), "name": r.get("Event Name"), "type": r.get("Event Type"),
            "company": r.get("Company"), "start": r.get("Start"), "end": r.get("End"),
            "live": r.get("Is Live") == "Yes",
        }
        for r in result["rows"]
        if r.get("Event Slug")
    ]
    return sorted(events, key=lambda e: (not e["live"], e["name"] or ""))


async def apply_days(session: AsyncSession, ticket_id: str, days: dict[date, int]) -> list[dict]:
    """Upsert days whose count is new or changed; returns those rows (for the Slack summary)."""
    existing = {
        d: n
        for d, n in (
            await session.execute(
                select(ProgramRegistration.date, ProgramRegistration.registrations)
                .where(ProgramRegistration.ticket_id == ticket_id, ProgramRegistration.role == "")
            )
        ).all()
    }
    changed = {d: n for d, n in days.items() if existing.get(d) != n}
    if changed:
        stmt = insert(ProgramRegistration).values(
            [
                {"ticket_id": ticket_id, "date": d, "role": "", "registrations": n, "relevant": n, "extra": {}}
                for d, n in changed.items()
            ]
        )
        await session.execute(
            stmt.on_conflict_do_update(
                constraint="uq_program_registrations",
                set_={"registrations": stmt.excluded.registrations, "relevant": stmt.excluded.relevant},
            )
        )
    await session.commit()  # also persists any event title/dates the caller set on the settings row
    return [
        {"date": d, "role": "", "registrations": n, "relevant": n, "extra": {}}
        for d, n in sorted(changed.items())
    ]


# ---- Scheduled / manual run ----------------------------------------------------

REFRESH_HOURS = 6  # scheduler cadence (core/scheduler.py); the Reload button overrides it
_MANUAL_COOLDOWN = 20  # seconds
state: dict = {"running": False, "started_at": None, "finished_at": None, "programs": 0, "failed": 0, "error": None}
_lock = asyncio.Lock()
_task: asyncio.Task | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def event_dates(info: dict) -> tuple[date | None, date | None]:
    """'2026-09-21 16:30:00' -> date (the portion before the time)."""
    def d(v):
        try:
            return date.fromisoformat(str(v)[:10])
        except ValueError:
            return None
    return d(info.get("start")), d(info.get("end"))


async def run_all() -> None:
    """Refresh every program in auto mode, one at a time (each Redash query can take
    ~30s). Silent -- Slack summaries only go out from a program's Fetch button. One
    program failing is logged and counted, not fatal. Single-flight."""
    if _lock.locked():
        return
    async with _lock:
        state.update(running=True, started_at=_now(), programs=0, failed=0, error=None)
        try:
            factory = db_manager.session_factory()
            async with factory() as session:
                targets = (
                    await session.execute(
                        select(ProgramRegistrationSettings.ticket_id, ProgramRegistrationSettings.redash_event_slug).where(
                            ProgramRegistrationSettings.redash_auto,
                            ProgramRegistrationSettings.redash_event_slug.is_not(None),
                        )
                    )
                ).all()
            for ticket_id, slug in targets:
                try:
                    info, days = await fetch_event(slug)
                    async with factory() as session:
                        cfg = await session.get(ProgramRegistrationSettings, ticket_id)
                        cfg.redash_event_title = info["name"]
                        cfg.redash_event_start, cfg.redash_event_end = event_dates(info)
                        changed = await apply_days(session, ticket_id, days)  # commits
                    logger.info("redash_auto_sync", ticket_id=ticket_id, slug=slug, changed_days=len(changed))
                    state["programs"] += 1
                except Exception as e:  # noqa: BLE001 -- keep going with the other programs
                    logger.exception("redash_auto_sync_failed", ticket_id=ticket_id, slug=slug)
                    state["failed"] += 1
                    state["error"] = str(e)[:200]
        finally:
            state.update(running=False, finished_at=_now())


def start_background() -> str:
    """Manual reload without holding the request open: "started", "already_running"
    or "cooldown" (one just finished)."""
    global _task
    if state["running"] or _lock.locked():
        return "already_running"
    finished = state["finished_at"]
    if finished and (_now() - finished).total_seconds() < _MANUAL_COOLDOWN:
        return "cooldown"
    _task = asyncio.create_task(run_all())  # keep a reference so it isn't GC'd
    return "started"


if __name__ == "__main__":
    assert days_from_row({"Registration Daily JSON": '[{"date": "2026-09-21", "count": 40}]'}) == {date(2026, 9, 21): 40}
    assert days_from_row({}) == {} and days_from_row({"Registration Daily JSON": ""}) == {}
    try:
        days_from_row({"Registration Daily JSON": "not json"})
        raise SystemExit("should have raised")
    except redash.RedashError:
        pass
    print("ok")
