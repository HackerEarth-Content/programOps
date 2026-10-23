"""Client dependencies and blockers: what the program is waiting on from the client, who owes it, who follows it
up, what it blocks, and how late it is. Overdue and delay days are derived from the due date and today's date and
are never stored, so they can't go stale."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone
from enum import StrEnum
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit, checklists
from core.errors import DomainError
from core.orm import ClientDependency, ProgramRound, User


class DependencyKind(StrEnum):
    INPUT = "input"
    APPROVAL = "approval"
    ASSET = "asset"
    DECISION = "decision"
    OTHER = "other"


class DependencyStatus(StrEnum):
    OPEN = "open"
    RECEIVED = "received"
    WAIVED = "waived"


EDITABLE = frozenset(
    {"title", "kind", "client_owner", "owner_id", "due_on", "status", "blocks_round_id", "notes"}
)


def delay_days(dep: ClientDependency, today: date) -> int:
    """Days past the due date while still open; 0 otherwise."""
    if dep.status != DependencyStatus.OPEN or dep.due_on is None or today <= dep.due_on:
        return 0
    return (today - dep.due_on).days


@dataclass(frozen=True)
class Impact:
    open: int
    overdue: int
    max_delay_days: int
    projected_slip_days: int  # the program slips at least as far as its most overdue open dependency
    blocked_round_ids: list[int]


def impact(deps: Sequence[ClientDependency], today: date) -> Impact:
    open_deps = [d for d in deps if d.status == DependencyStatus.OPEN]
    late = [d for d in open_deps if delay_days(d, today) > 0]
    worst = max((delay_days(d, today) for d in late), default=0)
    return Impact(
        open=len(open_deps),
        overdue=len(late),
        max_delay_days=worst,
        projected_slip_days=worst,
        blocked_round_ids=sorted({d.blocks_round_id for d in late if d.blocks_round_id}),
    )


async def list_for(session: AsyncSession, ticket_id: str) -> list[ClientDependency]:
    """Open ones first, then by due date (undated last)."""
    rows = await session.scalars(
        select(ClientDependency)
        .where(ClientDependency.ticket_id == ticket_id)
        .order_by(
            (ClientDependency.status != DependencyStatus.OPEN.value),
            ClientDependency.due_on.asc().nulls_last(),
            ClientDependency.id,
        )
    )
    return list(rows.all())


async def get(session: AsyncSession, ticket_id: str, dependency_id: int) -> ClientDependency:
    dep = await session.get(ClientDependency, dependency_id)
    if dep is None or dep.ticket_id != ticket_id:
        raise DomainError("dependency_not_found", "Dependency not found.", 404)
    return dep


async def _check_blocks(session: AsyncSession, ticket_id: str, blocks_round_id: int | None) -> None:
    if blocks_round_id is None:
        return
    row = await session.get(ProgramRound, blocks_round_id)
    if row is None or row.ticket_id != ticket_id:
        raise DomainError("round_not_found", "That round isn't in this program.", 422)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def create(
    session: AsyncSession,
    actor: User,
    ticket_id: str,
    *,
    title: str,
    kind: DependencyKind,
    client_owner: str | None,
    owner_id: str | None,
    due_on: date | None,
    blocks_round_id: int | None,
    notes: str | None,
) -> ClientDependency:
    await _check_blocks(session, ticket_id, blocks_round_id)
    dep = ClientDependency(
        ticket_id=ticket_id, title=title.strip(), kind=kind.value, client_owner=client_owner, owner_id=owner_id,
        owner_name=await checklists.user_name(session, owner_id) if owner_id else None, due_on=due_on,
        blocks_round_id=blocks_round_id, notes=notes,
        created_by=actor.id,
    )
    session.add(dep)
    await session.flush()
    audit.record(session, actor, entity="dependency", entity_id=str(dep.id), ticket_id=ticket_id,
                 action="dependency_added", new={"title": dep.title, "due_on": due_on.isoformat() if due_on else None})
    return dep


async def update(session: AsyncSession, actor: User, dep: ClientDependency, changes: Mapping[str, Any]) -> ClientDependency:
    unknown = set(changes) - EDITABLE
    if unknown:
        raise DomainError("field_not_editable", f"Not editable here: {', '.join(sorted(unknown))}", 422)
    if "blocks_round_id" in changes:
        await _check_blocks(session, dep.ticket_id, changes["blocks_round_id"])
    for field, value in changes.items():
        value = value.value if isinstance(value, StrEnum) else value
        if field == "owner_id":
            dep.owner_name = await checklists.user_name(session, value) if value else None
        old = getattr(dep, field)
        if old == value:
            continue
        audit.record(session, actor, entity="dependency", entity_id=str(dep.id), ticket_id=dep.ticket_id,
                     action="dependency_updated", field=field,
                     old=old.isoformat() if isinstance(old, date) else old,
                     new=value.isoformat() if isinstance(value, date) else value)
        setattr(dep, field, value)
        if field == "status":
            dep.received_at = _now() if value == DependencyStatus.RECEIVED else None
    dep.updated_at = _now()
    return dep
