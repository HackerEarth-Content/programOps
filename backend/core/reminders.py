"""Reminders: the CSM queue's items, posted to each program's Slack channel at the times the super admin set.

The rules are the queue's own (`core/csm_queue.py`), so a reminder and the queue can never disagree. This module only
decides *when* to speak: never while reminders are off, never outside working hours, once a day per item (the
`dedupe_key` carries the local date), and never for something that was only just raised.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core import csm_queue, settings_store, slack_outbox
from core.activities import ActivityStatus
from core.csm_queue import CsmItem, CsmKind, Severity
from core.orm import Program, ProgramActivity
from core.settings_store import ReminderSettings

logger = structlog.get_logger(__name__)

APPROVAL_GRACE = timedelta(hours=4)  # a fresh approval request isn't chased for this long

_MARK = {Severity.CRITICAL: ":rotating_light:", Severity.AMBER: ":warning:", Severity.INFO: ":information_source:"}


def is_working_time(settings: ReminderSettings, now: datetime) -> bool:
    local = now.astimezone(ZoneInfo(settings.timezone))
    return local.weekday() in settings.work_days and settings.work_start <= local.time() < settings.work_end


def local_date(settings: ReminderSettings, now: datetime) -> date:
    return now.astimezone(ZoneInfo(settings.timezone)).date()


def format_item(item: CsmItem) -> str:
    return f"{_MARK[item.severity]} *{item.program_name}* · {item.title}: {item.detail}"


async def collect(
    session: AsyncSession, program: Program, now: datetime, settings: ReminderSettings
) -> list[tuple[str, str, str]]:
    """(kind, dedupe key, message) for everything worth a reminder on this program right now."""
    today = local_date(settings, now)
    after_reminder_time = (
        settings.reminder_time is not None and now.astimezone(ZoneInfo(settings.timezone)).time() >= settings.reminder_time
    )
    out: list[tuple[str, str, str]] = []
    for item in await csm_queue.items_for(session, program, now):
        if item.kind == CsmKind.SLACK_UNLINKED:
            continue  # there is nowhere to post it
        if item.kind == CsmKind.UPDATE_DUE and not after_reminder_time:
            continue
        if item.kind == CsmKind.APPROVAL_WAITING and item.since and now - item.since < APPROVAL_GRACE:
            continue
        out.append((item.kind.value, f"{item.id}:{today}", format_item(item)))

    name = program.display_name
    for a in (
        await session.scalars(
            select(ProgramActivity).where(
                ProgramActivity.ticket_id == program.ticket_id,
                ProgramActivity.approved_at.is_not(None),
                ProgramActivity.status.in_([ActivityStatus.NOT_STARTED.value, ActivityStatus.WIP.value]),
                ProgramActivity.planned_date.is_not(None),
                ProgramActivity.planned_date <= today,
            )
        )
    ).all():
        out.append((
            "go_live_due", f"go_live_due:{a.id}:{today}",
            f":rocket: *{name}* · {a.code} {a.title}: approved and planned for {a.planned_date:%d %b}, ready to go live",
        ))
    return out


async def run(factory: async_sessionmaker[AsyncSession], now: datetime | None = None) -> int:
    """Queue today's reminders. Returns how many were queued. One program failing is logged, not fatal."""
    now = now or datetime.now(timezone.utc)
    queued = 0
    async with factory() as session:
        settings = (await settings_store.load(session)).reminders
        if settings.reminder_time is None or not is_working_time(settings, now):
            return 0
        programs = (await session.scalars(select(Program).where(Program.stage_label != "Closed"))).all()
        for program in programs:
            try:
                for kind, key, body in await collect(session, program, now, settings):
                    if await slack_outbox.enqueue(session, ticket_id=program.ticket_id, kind=kind, body=body, dedupe_key=key):
                        queued += 1
                await session.commit()
            except Exception:  # noqa: BLE001 -- keep going with the other programs
                logger.exception("reminder_failed", ticket_id=program.ticket_id)
                await session.rollback()
    return queued
