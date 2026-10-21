"""Registrations by source: a stored snapshot of Redash query 6170, how its rows attribute to the program's
marketing activities, and the registrations lift around each go-live.

Query 6170 is slow (it reads request logs), so it never runs inside a page request: it runs in the background
(on demand and daily) and the page reads the latest good snapshot together with its age.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from enum import StrEnum
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core import redash, redash_sync
from core.config import settings
from core.database import db_manager
from core.errors import DomainError
from core.orm import ChannelSnapshot, ProgramRegistrationSettings

logger = structlog.get_logger(__name__)

_SOURCE, _CAMPAIGN, _USERS = "Source/Medium", "Campaign", "NumUsers_with_source_as_Latest_visit_before_registration"
STALE_AFTER = timedelta(hours=36)


class SourceBucket(StrEnum):
    ORGANIC = "organic"
    ORGANIC_EARLIER = "organic_registered_before"  # already registered before the campaign
    REFERRAL = "referral"  # HackerEarth's own pages (challenges, jobs, practice, leaderboard)
    ACTIVITY = "activity"  # matched to a marketing activity by its UTM
    UNMATCHED = "unmatched"  # shown on its own line, never dropped


@dataclass(frozen=True)
class ActivityRef:
    id: int
    code: str
    utm: str | None


@dataclass(frozen=True)
class SourceLine:
    source_medium: str
    campaign: str
    users: int
    share_pct: float
    bucket: SourceBucket
    activity_id: int | None
    activity_code: str | None


@dataclass(frozen=True)
class SourcesReport:
    total: int
    lines: list[SourceLine]
    reconciles: bool  # the lines add up to the source's own Total row
    organic_pct: float  # organic plus registered-before, as a share of the total
    matched_users: int
    unmatched_users: int


def _bucket(source: str, campaign: str, activities: Sequence[ActivityRef]) -> tuple[SourceBucket, ActivityRef | None]:
    if campaign == "Organic_But_RegisteredBefore":
        return SourceBucket.ORGANIC_EARLIER, None
    if campaign == "Organic":
        return SourceBucket.ORGANIC, None
    if campaign.startswith("Referrer-"):
        return SourceBucket.REFERRAL, None
    text = f"{source} {campaign}".lower()
    for activity in sorted((a for a in activities if a.utm), key=lambda a: -len(a.utm or "")):  # longest UTM wins
        if (activity.utm or "").strip().lower() in text:
            return SourceBucket.ACTIVITY, activity
    return SourceBucket.UNMATCHED, None


def classify(rows: Sequence[Mapping[str, Any]], activities: Sequence[ActivityRef]) -> SourcesReport:
    """Turn query 6170's rows into attributed lines. Pure."""
    declared_total: int | None = None
    parsed: list[tuple[str, str, int]] = []
    for row in rows:
        source, campaign, users = (row.get(_SOURCE) or "").strip(), (row.get(_CAMPAIGN) or "").strip(), int(row.get(_USERS) or 0)
        if source == "Total":
            declared_total = users
        else:
            parsed.append((source, campaign, users))
    summed = sum(users for *_, users in parsed)
    total = declared_total if declared_total is not None else summed

    lines: list[SourceLine] = []
    for source, campaign, users in parsed:
        bucket, activity = _bucket(source, campaign, activities)
        lines.append(
            SourceLine(
                source, campaign, users, round(100 * users / total, 1) if total else 0.0, bucket,
                activity.id if activity else None, activity.code if activity else None,
            )
        )
    lines.sort(key=lambda line: -line.users)
    by_bucket = Counter()
    for line in lines:
        by_bucket[line.bucket] += line.users
    organic = by_bucket[SourceBucket.ORGANIC] + by_bucket[SourceBucket.ORGANIC_EARLIER]
    return SourcesReport(
        total=total,
        lines=lines,
        reconciles=summed == total,
        organic_pct=round(100 * organic / total, 1) if total else 0.0,
        matched_users=by_bucket[SourceBucket.ACTIVITY],
        unmatched_users=by_bucket[SourceBucket.UNMATCHED],
    )


# ---- lift ---------------------------------------------------------------------


@dataclass(frozen=True)
class Lift:
    before_avg: float
    after_avg: float
    lift_pct: float | None  # None when there was nothing before to compare with


def lift(daily: Mapping[date, int], go_live: date, window: int = 3) -> Lift | None:
    """Average daily registrations in the `window` days before a go-live against the go-live day and the days
    after it. A change that happened alongside the activity, not proof that it caused it. None when either
    side has no data."""
    before = [daily[d] for k in range(1, window + 1) if (d := go_live - timedelta(days=k)) in daily]
    after = [daily[d] for k in range(window) if (d := go_live + timedelta(days=k)) in daily]
    if not before or not after:
        return None
    before_avg, after_avg = sum(before) / len(before), sum(after) / len(after)
    return Lift(
        round(before_avg, 1), round(after_avg, 1),
        round(100 * (after_avg - before_avg) / before_avg, 1) if before_avg else None,
    )


# ---- fetching and storing ------------------------------------------------------


async def fetch_rows(slug: str) -> list[dict[str, Any]]:
    """Run query 6170 for an event. The slug is validated first: the query interpolates it into Python source."""
    redash_sync.check_slug(slug)
    if not settings.REDASH_CHANNELS_QUERY_ID:
        raise redash.RedashError("Redash channels query isn't configured (REDASH_CHANNELS_QUERY_ID).")
    result = await redash.run_query(settings.REDASH_CHANNELS_QUERY_ID, {"Event - Title or Slug": slug}, max_age=3600)
    return list(result["rows"])


def _total(rows: Sequence[Mapping[str, Any]]) -> int | None:
    return next((int(r.get(_USERS) or 0) for r in rows if (r.get(_SOURCE) or "").strip() == "Total"), None)


async def refresh(factory: async_sessionmaker[AsyncSession], ticket_id: str) -> ChannelSnapshot:
    """Fetch and store a snapshot. A failure is stored as a failed snapshot, not raised."""
    async with factory() as session:
        cfg = await session.get(ProgramRegistrationSettings, ticket_id)
        slug = cfg.redash_event_slug if cfg else None
    if not slug:
        raise DomainError("no_event_linked", "Link this program to its HackerEarth event first.", 409)
    try:
        rows = await fetch_rows(slug)
        snapshot = ChannelSnapshot(ticket_id=ticket_id, status="ok", rows=rows, total=_total(rows))
    except redash.RedashError as error:
        snapshot = ChannelSnapshot(ticket_id=ticket_id, status="failed", error=str(error)[:300], rows=[])
    async with factory() as session:
        session.add(snapshot)
        await session.commit()
    return snapshot


async def latest(session: AsyncSession, ticket_id: str) -> tuple[ChannelSnapshot | None, str | None]:
    """(the last good snapshot, the error of a newer failed refresh if there is one)."""
    good = await session.scalar(
        select(ChannelSnapshot).where(ChannelSnapshot.ticket_id == ticket_id, ChannelSnapshot.status == "ok")
        .order_by(ChannelSnapshot.id.desc()).limit(1)
    )
    newest = await session.scalar(
        select(ChannelSnapshot).where(ChannelSnapshot.ticket_id == ticket_id).order_by(ChannelSnapshot.id.desc()).limit(1)
    )
    error = newest.error if newest is not None and newest.status == "failed" else None
    return good, error


def is_stale(snapshot: ChannelSnapshot) -> bool:
    return datetime.now(timezone.utc) - snapshot.fetched_at > STALE_AFTER


_running: set[str] = set()
_tasks: set[asyncio.Task[None]] = set()


def is_running(ticket_id: str) -> bool:
    return ticket_id in _running


async def _run(ticket_id: str) -> None:
    try:
        await refresh(db_manager.session_factory(), ticket_id)
    except Exception:  # noqa: BLE001 -- a background run must never raise into the loop
        logger.exception("channel_refresh_failed", ticket_id=ticket_id)
    finally:
        _running.discard(ticket_id)


def start_refresh(ticket_id: str) -> str:
    """Refresh in the background: "started" or "already_running"."""
    if ticket_id in _running:
        return "already_running"
    _running.add(ticket_id)
    task = asyncio.create_task(_run(ticket_id))
    _tasks.add(task)  # keep a reference so it isn't garbage collected
    task.add_done_callback(_tasks.discard)
    return "started"


async def refresh_all() -> None:
    """Daily job: refresh every program linked to a HackerEarth event, one at a time. Failures are stored and logged."""
    factory = db_manager.session_factory()
    async with factory() as session:
        tickets = (
            await session.scalars(
                select(ProgramRegistrationSettings.ticket_id).where(ProgramRegistrationSettings.redash_event_slug.is_not(None))
            )
        ).all()
    for ticket_id in tickets:
        if ticket_id in _running:
            continue
        _running.add(ticket_id)
        await _run(ticket_id)
