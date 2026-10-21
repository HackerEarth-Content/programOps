"""Participant communications: invitations, reminders, shortlist announcements, RSVP messages and other phase-wise
updates, planned and then sent. A record of what was planned against what went out. The portal never sends them."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit, checklists
from core.errors import DomainError
from core.orm import ParticipantComm, ProgramRound, User


class CommKind(StrEnum):
    INVITATION = "invitation"
    REMINDER = "reminder"
    SHORTLIST = "shortlist"
    RSVP = "rsvp"
    ANNOUNCEMENT = "announcement"
    OTHER = "other"


class CommStatus(StrEnum):
    PLANNED = "planned"
    SENT = "sent"
    SKIPPED = "skipped"


EDITABLE = frozenset(
    {"kind", "audience", "round_id", "planned_for", "sent_at", "recipients", "status", "owner_id", "notes"}
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: Any) -> Any:
    """A naive datetime from a client is read as UTC, so it can be compared with stored (aware) ones."""
    return value.replace(tzinfo=timezone.utc) if isinstance(value, datetime) and value.tzinfo is None else value


def is_overdue(comm: ParticipantComm, now: datetime | None = None) -> bool:
    """Planned time has passed and it hasn't been marked sent or skipped."""
    return comm.status == CommStatus.PLANNED and comm.planned_for < (now or _now())


async def _check_round(session: AsyncSession, ticket_id: str, round_id: int | None) -> None:
    if round_id is None:
        return
    row = await session.get(ProgramRound, round_id)
    if row is None or row.ticket_id != ticket_id:
        raise DomainError("round_not_found", "That round isn't in this program.", 422)


async def list_for(
    session: AsyncSession, ticket_id: str, *, round_id: int | None = None, status: CommStatus | None = None
) -> list[ParticipantComm]:
    stmt = select(ParticipantComm).where(ParticipantComm.ticket_id == ticket_id).order_by(
        ParticipantComm.planned_for, ParticipantComm.id
    )
    if round_id is not None:
        stmt = stmt.where(ParticipantComm.round_id == round_id)
    if status is not None:
        stmt = stmt.where(ParticipantComm.status == status.value)
    return list((await session.scalars(stmt)).all())


async def get(session: AsyncSession, ticket_id: str, comm_id: int) -> ParticipantComm:
    comm = await session.get(ParticipantComm, comm_id)
    if comm is None or comm.ticket_id != ticket_id:
        raise DomainError("communication_not_found", "Communication not found.", 404)
    return comm


async def create(
    session: AsyncSession,
    actor: User,
    ticket_id: str,
    *,
    kind: CommKind,
    audience: str,
    planned_for: datetime,
    round_id: int | None,
    recipients: int | None,
    owner_id: str | None,
    notes: str | None,
) -> ParticipantComm:
    await _check_round(session, ticket_id, round_id)
    comm = ParticipantComm(
        ticket_id=ticket_id, kind=kind.value, audience=audience.strip(), round_id=round_id, planned_for=_utc(planned_for),
        recipients=recipients, owner_id=owner_id, notes=notes, created_by=actor.id,
        owner_name=await checklists.user_name(session, owner_id) if owner_id else None,
    )
    session.add(comm)
    await session.flush()
    audit.record(session, actor, entity="communication", entity_id=str(comm.id), ticket_id=ticket_id,
                 action="communication_planned", new={"kind": comm.kind, "audience": comm.audience, "for": _utc(planned_for).isoformat()})
    return comm


async def update(session: AsyncSession, actor: User, comm: ParticipantComm, changes: Mapping[str, Any]) -> ParticipantComm:
    unknown = set(changes) - EDITABLE
    if unknown:
        raise DomainError("field_not_editable", f"Not editable here: {', '.join(sorted(unknown))}", 422)
    if "round_id" in changes:
        await _check_round(session, comm.ticket_id, changes["round_id"])
    for field, value in changes.items():
        value = _utc(value.value if isinstance(value, StrEnum) else value)
        if field == "owner_id":
            comm.owner_name = await checklists.user_name(session, value) if value else None
        old = getattr(comm, field)
        if old == value:
            continue
        audit.record(session, actor, entity="communication", entity_id=str(comm.id), ticket_id=comm.ticket_id,
                     action="communication_updated", field=field,
                     old=old.isoformat() if isinstance(old, datetime) else old,
                     new=value.isoformat() if isinstance(value, datetime) else value)
        setattr(comm, field, value)
        if field == "status" and value == CommStatus.SENT and "sent_at" not in changes:
            comm.sent_at = _now()
    comm.updated_at = _now()
    return comm
