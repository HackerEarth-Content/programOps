"""Change a ticket's stage or checklist from the portal (written to HubSpot). Off until the token is allowed to."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit, internal_programs
from core.access import Access, require_permission
from core.database import get_session
from core.deps import program_or_404
from core.errors import DomainError
from core.orm import Program
from core.permissions import Permission
from hubspot_client import writer
from hubspot_client.stage_checklist import PROGRAM_STAGES

logger = structlog.get_logger(__name__)


async def _refused(session: AsyncSession, access: Access, ticket_id: str, action: str, error: DomainError, **detail) -> None:
    """A HubSpot change that was asked for but not made (switched off, conflict, token refused): log it and keep it in the audit trail."""
    logger.warning("hubspot_write_refused", ticket_id=ticket_id, user=access.user.email, action=action, code=error.code, **detail)
    audit.record(
        session, access.user, entity="hubspot_write", entity_id=ticket_id, ticket_id=ticket_id,
        action=f"{action}_refused", new={"code": error.code, **detail},
    )
    await session.commit()


router = APIRouter(
    prefix="/programs/{ticket_id}/hubspot",
    tags=["hubspot"],
    dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW)), Depends(program_or_404)],
)


class ChecklistIn(BaseModel):
    stage_key: str  # e.g. "onboarding"
    item: str  # the checklist item's label
    done: bool
    expected: list[str]  # the items selected when the caller loaded the page: HubSpot wins if it differs now


class ChecklistOut(BaseModel):
    selected: list[str]


class StageIn(BaseModel):
    stage_key: str
    expected_stage_key: str  # the stage when the caller loaded the page


class StageOut(BaseModel):
    stage_key: str
    stage_label: str


@router.post("/checklist", response_model=ChecklistOut)
async def set_checklist_item(
    ticket_id: str,
    body: ChecklistIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.HUBSPOT_WRITE)),
) -> ChecklistOut:
    """Tick or untick a checklist item on the HubSpot ticket. 409 `hubspot_conflict` (with `current`) if it changed there.
    An internal hackathon with no HubSpot ticket: the change is saved in the portal instead (409 `program_conflict`)."""
    program = await session.get(Program, ticket_id)
    if program is not None and internal_programs.is_local_only(program):
        selected = internal_programs.set_checklist_item(
            session, access.user, program, stage_key=body.stage_key, item=body.item, done=body.done, expected=body.expected
        )
        await session.commit()
        return ChecklistOut(selected=selected)
    logger.info("hubspot_write_requested", ticket_id=ticket_id, user=access.user.email, action="checklist_item_set",
                stage=body.stage_key, item=body.item, done=body.done)
    try:
        selected = await writer.set_checklist_item(
            session, access.user, ticket_id, stage_key=body.stage_key, item=body.item, done=body.done, expected=body.expected
        )
    except DomainError as error:
        await _refused(session, access, ticket_id, "checklist_item_set", error, stage=body.stage_key, item=body.item, done=body.done)
        raise
    await session.commit()
    logger.info("hubspot_write_done", ticket_id=ticket_id, user=access.user.email, action="checklist_item_set", item=body.item, done=body.done)
    return ChecklistOut(selected=selected)


@router.post("/stage", response_model=StageOut)
async def move_stage(
    ticket_id: str,
    body: StageIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.HUBSPOT_WRITE)),
) -> StageOut:
    """Move the HubSpot ticket to another stage. 409 `hubspot_conflict` (with `current_stage`) if it moved there.
    An internal hackathon with no HubSpot ticket: the move is saved in the portal instead (409 `program_conflict`)."""
    program = await session.get(Program, ticket_id)
    if program is not None and internal_programs.is_local_only(program):
        stage_key = internal_programs.move_stage(
            session, access.user, program, stage_key=body.stage_key, expected_stage_key=body.expected_stage_key
        )
        await session.commit()
        return StageOut(stage_key=stage_key, stage_label=PROGRAM_STAGES[stage_key]["label"])
    logger.info("hubspot_write_requested", ticket_id=ticket_id, user=access.user.email, action="stage_moved",
                old=body.expected_stage_key, new=body.stage_key)
    try:
        stage_key = await writer.move_stage(
            session, access.user, ticket_id, stage_key=body.stage_key, expected_stage_key=body.expected_stage_key
        )
    except DomainError as error:
        await _refused(session, access, ticket_id, "stage_moved", error, old=body.expected_stage_key, new=body.stage_key)
        raise
    await session.commit()
    logger.info("hubspot_write_done", ticket_id=ticket_id, user=access.user.email, action="stage_moved", new=stage_key)
    return StageOut(stage_key=stage_key, stage_label=PROGRAM_STAGES[stage_key]["label"])
