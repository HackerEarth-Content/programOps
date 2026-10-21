"""Append-only audit trail. Callers add the event in the same transaction as the change it describes,
so a change and its record are committed together or not at all."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from core.orm import ProgramEvent, User


def record(
    session: AsyncSession,
    actor: User | None,
    *,
    entity: str,
    entity_id: str,
    action: str,
    ticket_id: str | None = None,
    field: str | None = None,
    old: Any = None,
    new: Any = None,
) -> None:
    """Queue one event on `session`. The caller commits. `actor=None` means the system."""
    session.add(
        ProgramEvent(
            ticket_id=ticket_id,
            entity=entity,
            entity_id=entity_id,
            action=action,
            field=field,
            old=old,
            new=new,
            actor_id=actor.id if actor else None,
            actor_name=(actor.name or actor.email) if actor else "system",
        )
    )
