"""Relevant registrations: the CSM's per-day count of registrations that matter for the program's goal.

Separate from the Redash totals and never added into them. Append-only: correcting an entry adds a new
row that supersedes the old one, so the history of who said what stays intact.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit
from core.errors import DomainError
from core.orm import RelevantRegistration, User


async def current(session: AsyncSession, ticket_id: str) -> list[RelevantRegistration]:
    """The entries that stand: every row that no later row supersedes. Newest day first."""
    superseded = select(RelevantRegistration.supersedes_id).where(
        RelevantRegistration.ticket_id == ticket_id, RelevantRegistration.supersedes_id.is_not(None)
    )
    rows = await session.scalars(
        select(RelevantRegistration)
        .where(RelevantRegistration.ticket_id == ticket_id, RelevantRegistration.id.not_in(superseded))
        .order_by(RelevantRegistration.date.desc(), RelevantRegistration.id.desc())
    )
    return list(rows.all())


def total(entries: list[RelevantRegistration]) -> int:
    return sum(e.count for e in entries)


async def add(
    session: AsyncSession, actor: User, ticket_id: str, *, day: date, count: int, criteria: str | None, note: str | None
) -> RelevantRegistration:
    entry = RelevantRegistration(
        ticket_id=ticket_id, date=day, count=count, criteria=criteria, note=note,
        entered_by=actor.id, entered_by_name=actor.name or actor.email,
    )
    session.add(entry)
    await session.flush()
    audit.record(
        session, actor, entity="relevant_registrations", entity_id=str(entry.id), ticket_id=ticket_id,
        action="relevant_added", new={"date": day.isoformat(), "count": count},
    )
    return entry


async def supersede(
    session: AsyncSession, actor: User, ticket_id: str, entry_id: int, *, count: int, criteria: str | None, note: str | None
) -> RelevantRegistration:
    old = await session.get(RelevantRegistration, entry_id)
    if old is None or old.ticket_id != ticket_id:
        raise DomainError("entry_not_found", "Entry not found.", 404)
    if await session.scalar(select(RelevantRegistration.id).where(RelevantRegistration.supersedes_id == old.id)):
        raise DomainError("entry_superseded", "That entry was already corrected. Correct the newer one.")
    entry = RelevantRegistration(
        ticket_id=ticket_id, date=old.date, count=count,
        criteria=criteria if criteria is not None else old.criteria,
        note=note if note is not None else old.note,
        entered_by=actor.id, entered_by_name=actor.name or actor.email, supersedes_id=old.id,
    )
    session.add(entry)
    await session.flush()
    audit.record(
        session, actor, entity="relevant_registrations", entity_id=str(entry.id), ticket_id=ticket_id,
        action="relevant_corrected", old={"count": old.count}, new={"count": count},
    )
    return entry
