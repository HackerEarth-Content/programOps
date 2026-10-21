"""Guarded write-back of stage and checklist changes to a HubSpot ticket.

HubSpot wins on a conflict: the caller says what it last saw, the writer reads the ticket's current value first, and if
the two differ it changes nothing and returns the current value (409 `hubspot_conflict`) so the person can look and
retry. Everything is behind `HUBSPOT_WRITEBACK_ENABLED` (off until the token has the ticket-update scope).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

import aiohttp
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit
from core.config import settings
from core.errors import DomainError
from core.orm import Program, User
from hubspot_client.client import HubSpotClient
from hubspot_client.stage_checklist import CHECKLIST_PROPERTY_TO_COLUMN, PROGRAM_STAGES, STAGE_CHECKLISTS

_STAGE_PROPERTY = "hs_pipeline_stage"


class TicketGateway(Protocol):
    async def read_ticket_properties(self, ticket_id: str, names: list[str]) -> dict[str, str | None]: ...
    async def update_ticket_properties(self, ticket_id: str, properties: dict[str, str]) -> None: ...


def _require_enabled() -> None:
    if not settings.HUBSPOT_WRITEBACK_ENABLED:
        raise DomainError(
            "hubspot_writeback_disabled", "Changing HubSpot from the portal isn't switched on yet.", 503
        )


def _selected(raw: str | None) -> list[str]:
    return [part for part in (raw or "").split(";") if part]


async def _read(gateway: TicketGateway, ticket_id: str, name: str) -> str | None:
    try:
        return (await gateway.read_ticket_properties(ticket_id, [name])).get(name)
    except (aiohttp.ClientError, TimeoutError) as error:
        raise DomainError("hubspot_unavailable", f"Couldn't read the ticket from HubSpot: {error}", 502) from error


async def _write(gateway: TicketGateway, ticket_id: str, properties: dict[str, str]) -> None:
    try:
        await gateway.update_ticket_properties(ticket_id, properties)
    except aiohttp.ClientResponseError as error:
        if error.status in (401, 403):
            raise DomainError("hubspot_scope_missing", "The HubSpot token isn't allowed to update tickets.", 502) from error
        raise DomainError("hubspot_unavailable", f"HubSpot refused the change ({error.status}).", 502) from error
    except (aiohttp.ClientError, TimeoutError) as error:
        raise DomainError("hubspot_unavailable", f"Couldn't reach HubSpot: {error}", 502) from error


async def set_checklist_item(
    session: AsyncSession,
    actor: User,
    ticket_id: str,
    *,
    stage_key: str,
    item: str,
    done: bool,
    expected: Sequence[str],
    gateway: TicketGateway | None = None,
) -> list[str]:
    """Tick or untick one checklist item on the ticket. `expected` is the selected items the caller last saw."""
    _require_enabled()
    spec = STAGE_CHECKLISTS.get(stage_key)
    if spec is None:
        raise DomainError("stage_has_no_checklist", "That stage has no checklist.", 422)
    prop, items = spec
    labels = [label for label, _ in items]
    if item not in labels:
        raise DomainError("unknown_checklist_item", f"'{item}' isn't an item of the {stage_key} checklist.", 422)

    gateway = gateway or HubSpotClient()
    current = _selected(await _read(gateway, ticket_id, prop))
    if sorted(current) != sorted(expected):
        raise DomainError(
            "hubspot_conflict", "This checklist changed in HubSpot since you opened it. Review it and try again.", 409,
            current=current,
        )
    if (item in current) == done:
        return current  # already the way the caller wants it: nothing to write

    updated = [label for label in labels if (label in current) != (label == item)]  # canonical order, item toggled
    await _write(gateway, ticket_id, {prop: ";".join(updated)})
    program = await session.get(Program, ticket_id)
    if program is not None:
        setattr(program, CHECKLIST_PROPERTY_TO_COLUMN[prop], updated)  # shown at once; the next sync confirms it
    audit.record(
        session, actor, entity="hubspot_checklist", entity_id=ticket_id, ticket_id=ticket_id,
        action="checklist_item_set", field=item, old=current, new=updated,
    )
    return updated


async def move_stage(
    session: AsyncSession,
    actor: User,
    ticket_id: str,
    *,
    stage_key: str,
    expected_stage_key: str,
    gateway: TicketGateway | None = None,
) -> str:
    """Move the ticket to another pipeline stage. `expected_stage_key` is the stage the caller last saw."""
    _require_enabled()
    if stage_key not in PROGRAM_STAGES or expected_stage_key not in PROGRAM_STAGES:
        raise DomainError("unknown_stage", "That isn't a stage of the Programs Feasibility Support pipeline.", 422)
    gateway = gateway or HubSpotClient()
    current_id = await _read(gateway, ticket_id, _STAGE_PROPERTY)
    if current_id != PROGRAM_STAGES[expected_stage_key]["stage_id"]:
        current_key = next((k for k, s in PROGRAM_STAGES.items() if s["stage_id"] == current_id), None)
        raise DomainError(
            "hubspot_conflict", "This ticket moved to another stage in HubSpot since you opened it.", 409,
            current_stage=current_key,
        )
    target = PROGRAM_STAGES[stage_key]
    if current_id == target["stage_id"]:
        return stage_key
    await _write(gateway, ticket_id, {_STAGE_PROPERTY: target["stage_id"]})
    program = await session.get(Program, ticket_id)
    if program is not None:
        program.stage_id, program.stage_label = target["stage_id"], target["label"]
    audit.record(
        session, actor, entity="hubspot_stage", entity_id=ticket_id, ticket_id=ticket_id,
        action="stage_moved", old=expected_stage_key, new=stage_key,
    )
    return stage_key
