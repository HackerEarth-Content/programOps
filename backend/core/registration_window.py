"""The expected registration window of a program: when it opens, when it closes, and how sure we are.

One definition shared by the registrations tab and by the "needs you today" checks, so both always agree.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.orm import Program, ProgramDocument, ProgramRegistration, ProgramRegistrationSettings


def estimate_window(
    start: date | None, end: date | None, weeks_min: int | None, weeks_max: int | None, target: int | None
) -> dict:
    """The expected registration window. `end` is the real event end when known
    (Redash), otherwise start + the SOW's stated weeks; `end_min` is the optimistic end."""
    end_est = end or (start + timedelta(weeks=weeks_max) if start and weeks_max else None)
    return {
        "start": start,
        "end": end_est,
        "end_min": start + timedelta(weeks=weeks_min) if start and weeks_min else None,
        "end_is_actual": bool(end),
        "weeks_min": weeks_min,
        "weeks_max": weeks_max,
        "target": target,
    }


def program_estimate(
    program: Program,
    cfg: ProgramRegistrationSettings | None,
    entry_dates: Iterable[date],
    sow: dict[str, Any],
    poa: dict[str, Any],
) -> dict:
    """The window with where its start came from. Order of trust: the CSM's override, the linked HackerEarth event,
    the HubSpot start date, the first daily entry, then the campaign window the POA itself states."""
    poa_start = date.fromisoformat(poa["window_start"]) if poa.get("window_start") else None
    linked = bool(cfg and cfg.redash_auto and cfg.redash_event_start)
    first_entry = min(entry_dates, default=None)
    start = (
        (cfg.campaign_start if cfg else None)
        or (cfg.redash_event_start if linked else None)
        or program.registration_start_date
        or first_entry
        or poa_start
    )
    estimate = estimate_window(
        start,
        (cfg.campaign_end if cfg else None) or (cfg.redash_event_end if linked else None),
        sow.get("registration_window_weeks_min"),
        sow.get("registration_window_weeks_max"),
        (cfg.target if cfg and cfg.target else None) or sow.get("registration_target"),
    )
    estimate["start_source"] = (
        "override" if cfg and cfg.campaign_start  # set by the CSM
        else "event" if linked
        else "hubspot" if program.registration_start_date
        else "first entry" if first_entry
        else "POA window" if start else None
    )
    return estimate


async def load_estimate(session: AsyncSession, program: Program) -> dict:
    """`program_estimate` with its inputs read from the database."""
    cfg = await session.get(ProgramRegistrationSettings, program.ticket_id)
    dates = (
        await session.scalars(select(ProgramRegistration.date).where(ProgramRegistration.ticket_id == program.ticket_id))
    ).all()
    docs = {
        kind: details or {}
        for kind, details in (
            await session.execute(
                select(ProgramDocument.kind, ProgramDocument.details).where(
                    ProgramDocument.ticket_id == program.ticket_id, ProgramDocument.status == "ok",
                    ProgramDocument.kind.in_(("sow", "poa")),
                )
            )
        ).all()
    }
    return program_estimate(program, cfg, dates, docs.get("sow", {}), docs.get("poa", {}))
