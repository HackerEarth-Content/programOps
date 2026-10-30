"""Internal hackathons: programs run by HackerEarth itself, so there is no HubSpot ticket and no feasibility step.

They live in the same `programs` table (`origin = "internal"`) and start at Onboarding. With HubSpot write-back on, a real
ticket (subject prefixed "[Internal]") is created in the pipeline and its id is the program's id, so HubSpot stays the
reference and the sync keeps the row current (it never deletes an internal row). With write-back off the program gets a
local `INT-` id and its stage move and checklist ticks are saved here instead, with the same conflict check and audit events.
"""

from __future__ import annotations

import secrets
from collections.abc import Sequence
from datetime import date, datetime, timezone
from typing import Any, Protocol

import aiohttp
import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit
from core.config import settings
from core.errors import DomainError
from core.orm import Program, User
from hubspot_client.client import HubSpotClient
from hubspot_client.stage_checklist import CHECKLIST_PROPERTY_TO_COLUMN, PROGRAM_STAGES, STAGE_CHECKLISTS

ORIGIN_HUBSPOT = "hubspot"
ORIGIN_INTERNAL = "internal"
# Feasibility is a sales step: an internal hackathon starts after it.
INTERNAL_STAGES = ("onboarding", "ongoing", "post_campaign", "closed")
LOCAL_PREFIX = "INT-"  # a program created without a HubSpot ticket
INTERNAL_PREFIX = "[Internal]"  # on the ticket subject, so people in HubSpot can tell it apart
INTERNAL_COMPANY = "HackerEarth (internal)"
logger = structlog.get_logger(__name__)
_PIPELINE_ID = "internal"
_PIPELINE_LABEL = "Internal hackathons"


def is_internal(program: Program) -> bool:
    return program.origin == ORIGIN_INTERNAL


class TicketCreator(Protocol):
    async def create_ticket(self, properties: dict[str, str]) -> str: ...
    async def delete_ticket(self, ticket_id: str) -> None: ...
    async def fetch_owner_emails(self) -> dict[str, str]: ...


def is_local_only(program: Program) -> bool:
    """An internal program created while HubSpot write-back was off: no ticket, so its stage and checklist live here."""
    return is_internal(program) and program.ticket_id.startswith(LOCAL_PREFIX)


async def _create_ticket(gateway: TicketCreator, actor: User, **p: Any) -> str:
    """The internal program's ticket in HubSpot, at Onboarding in the same pipeline, so HubSpot stays the reference."""
    owners = await gateway.fetch_owner_emails()
    csm_id = next((owner for owner, email in owners.items() if email.lower() == actor.email.lower()), None)
    properties = {
        "subject": f"{INTERNAL_PREFIX} {p['name']}", "program_name": p["name"], "campaign_type": p["campaign_type"],
        "company_name": INTERNAL_COMPANY, "hs_pipeline": settings.PROGRAM_PIPELINE_ID,
        "hs_pipeline_stage": PROGRAM_STAGES["onboarding"]["stage_id"],
    }
    if p["registration_start_date"]:
        properties["registration_start_date_skip_if_undefined"] = p["registration_start_date"].isoformat()
    if p["event_end_date"]:
        properties["event_end_date_skip_if_undefined"] = p["event_end_date"].isoformat()
    if csm_id:  # a creator who isn't a HubSpot owner just leaves the field empty
        properties["csm_for_the_deal"] = csm_id
    try:
        return await gateway.create_ticket(properties)
    except aiohttp.ClientResponseError as error:
        if error.status in (401, 403):
            raise DomainError("hubspot_scope_missing", "The HubSpot token isn't allowed to create tickets.", 502) from error
        raise DomainError("hubspot_unavailable", f"HubSpot refused the new ticket ({error.status}).", 502) from error
    except (aiohttp.ClientError, TimeoutError) as error:
        raise DomainError("hubspot_unavailable", f"Couldn't reach HubSpot: {error}", 502) from error


async def create_internal(
    session: AsyncSession,
    actor: User,
    *,
    name: str,
    campaign_type: str,
    registration_start_date: date | None,
    event_end_date: date | None,
    gateway: TicketCreator | None = None,
) -> Program:
    """Create the program. With HubSpot write-back on, a real ticket is created first and its id becomes the program's id;
    if saving here then fails, the ticket is archived again. With it off, the program gets a local `INT-` id."""
    if registration_start_date and event_end_date and event_end_date < registration_start_date:
        raise DomainError("program_dates_invalid", "The event can't end before registration starts.", 422)
    name = name.strip()
    remote = settings.HUBSPOT_WRITEBACK_ENABLED
    gateway = gateway or HubSpotClient()
    ticket_id = (
        await _create_ticket(
            gateway, actor, name=name, campaign_type=campaign_type,
            registration_start_date=registration_start_date, event_end_date=event_end_date,
        )
        if remote else f"{LOCAL_PREFIX}{secrets.token_hex(4).upper()}"
    )
    stage = PROGRAM_STAGES["onboarding"]
    now = datetime.now(timezone.utc)
    try:
        # merge, not add: the HubSpot sync may have picked the new ticket up before this save
        program = await session.merge(Program(
            ticket_id=ticket_id, origin=ORIGIN_INTERNAL, subject=f"{INTERNAL_PREFIX} {name}", event_name=name,
            pipeline_id=settings.PROGRAM_PIPELINE_ID if remote else _PIPELINE_ID,
            pipeline_label=_PIPELINE_LABEL, stage_id=stage["stage_id"], stage_label=stage["label"],
            campaign_type=campaign_type, company_name=INTERNAL_COMPANY, registration_start_date=registration_start_date,
            event_end_date=event_end_date, csm_name=actor.name or actor.email, csm_email=actor.email.lower(),
            created_at=now, last_modified_at=now,
        ))
        await session.flush()
        audit.record(
            session, actor, entity="program", entity_id=ticket_id, ticket_id=ticket_id,
            action="internal_program_created", new={"name": name, "campaign_type": campaign_type, "hubspot_ticket": remote},
        )
        await session.commit()
    except Exception:
        await session.rollback()
        if remote:
            try:
                await gateway.delete_ticket(ticket_id)
            except Exception:  # noqa: BLE001 -- nothing more to do, but make the orphan findable
                logger.error("internal_ticket_orphaned", ticket_id=ticket_id)
        raise
    return program


def _selected(program: Program, prop: str) -> list[str]:
    return list(getattr(program, CHECKLIST_PROPERTY_TO_COLUMN[prop]) or [])


def set_checklist_item(
    session: AsyncSession, actor: User, program: Program, *, stage_key: str, item: str, done: bool, expected: Sequence[str]
) -> list[str]:
    """Tick or untick a checklist item. `expected` is what the caller last saw: if it differs, nothing changes (409)."""
    spec = STAGE_CHECKLISTS.get(stage_key)
    if spec is None:
        raise DomainError("stage_has_no_checklist", "That stage has no checklist.", 422)
    prop, items = spec
    labels = [label for label, _ in items]
    if item not in labels:
        raise DomainError("unknown_checklist_item", f"'{item}' isn't an item of the {stage_key} checklist.", 422)
    current = _selected(program, prop)
    if sorted(current) != sorted(expected):
        raise DomainError(
            "program_conflict", "This checklist changed since you opened it. Review it and try again.", 409, current=current
        )
    if (item in current) == done:
        return current
    updated = [label for label in labels if (label in current) != (label == item)]  # canonical order, item toggled
    setattr(program, CHECKLIST_PROPERTY_TO_COLUMN[prop], updated)
    program.last_modified_at = datetime.now(timezone.utc)
    audit.record(
        session, actor, entity="program_checklist", entity_id=program.ticket_id, ticket_id=program.ticket_id,
        action="checklist_item_set", field=item, old=current, new=updated,
    )
    return updated


def move_stage(session: AsyncSession, actor: User, program: Program, *, stage_key: str, expected_stage_key: str) -> str:
    """Move an internal program to a later stage. `expected_stage_key` is the stage the caller last saw."""
    if stage_key not in INTERNAL_STAGES:
        raise DomainError("unknown_stage", "An internal hackathon goes from Onboarding to Closed.", 422)
    current = next((k for k, s in PROGRAM_STAGES.items() if s["stage_id"] == program.stage_id), None)
    if current != expected_stage_key:
        raise DomainError("program_conflict", "This program moved to another stage since you opened it.", 409, current_stage=current)
    if current == stage_key:
        return stage_key
    target = PROGRAM_STAGES[stage_key]
    program.stage_id, program.stage_label = target["stage_id"], target["label"]
    program.last_modified_at = datetime.now(timezone.utc)
    audit.record(
        session, actor, entity="program_stage", entity_id=program.ticket_id, ticket_id=program.ticket_id,
        action="stage_moved", old=expected_stage_key, new=stage_key,
    )
    return stage_key
