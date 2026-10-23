"""Internal hackathons: programs run by HackerEarth itself, so there is no HubSpot ticket and no feasibility step.

They live in the same `programs` table (`origin = "internal"`), start at Onboarding and move through the later stages
of the pipeline. The HubSpot sync never touches them (it neither updates nor deletes them). A stage move or a checklist
tick is saved here, in the portal, instead of being written to HubSpot, with the same conflict check and audit events.
"""

from __future__ import annotations

import secrets
from collections.abc import Sequence
from datetime import date, datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from core import audit
from core.errors import DomainError
from core.orm import Program, User
from hubspot_client.stage_checklist import CHECKLIST_PROPERTY_TO_COLUMN, PROGRAM_STAGES, STAGE_CHECKLISTS

ORIGIN_HUBSPOT = "hubspot"
ORIGIN_INTERNAL = "internal"
# Feasibility is a sales step: an internal hackathon starts after it.
INTERNAL_STAGES = ("onboarding", "ongoing", "post_campaign", "closed")
_PIPELINE_ID = "internal"
_PIPELINE_LABEL = "Internal hackathons"


def is_internal(program: Program) -> bool:
    return program.origin == ORIGIN_INTERNAL


async def create_internal(
    session: AsyncSession,
    actor: User,
    *,
    name: str,
    campaign_type: str,
    registration_start_date: date | None,
    event_end_date: date | None,
) -> Program:
    if registration_start_date and event_end_date and event_end_date < registration_start_date:
        raise DomainError("program_dates_invalid", "The event can't end before registration starts.", 422)
    stage = PROGRAM_STAGES["onboarding"]
    now = datetime.now(timezone.utc)
    program = Program(
        ticket_id=f"INT-{secrets.token_hex(4).upper()}", origin=ORIGIN_INTERNAL, subject=name.strip(),
        event_name=name.strip(), pipeline_id=_PIPELINE_ID, pipeline_label=_PIPELINE_LABEL,
        stage_id=stage["stage_id"], stage_label=stage["label"], campaign_type=campaign_type,
        company_name="HackerEarth (internal)", registration_start_date=registration_start_date,
        event_end_date=event_end_date, csm_name=actor.name or actor.email, csm_email=actor.email.lower(),
        created_at=now, last_modified_at=now,
    )
    session.add(program)
    await session.flush()
    audit.record(
        session, actor, entity="program", entity_id=program.ticket_id, ticket_id=program.ticket_id,
        action="internal_program_created", new={"name": program.event_name, "campaign_type": campaign_type},
    )
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
