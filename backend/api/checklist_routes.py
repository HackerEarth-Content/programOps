"""Checklist templates, special requests, item confirmation (any checklist), and the program lifecycle."""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import checklists
from core.access import Access, require_permission
from core.checklists import ChecklistKind, ChecklistStatus, ItemSpec, Phase, PhaseStatus, phase_title
from core.database import get_session
from core.deps import program_or_404
from core.orm import Checklist, ChecklistItem, ChecklistTemplate, ProgramPhase
from core.permissions import Permission

templates_router = APIRouter(
    prefix="/checklist-templates", tags=["checklists"], dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW))]
)
router = APIRouter(
    prefix="/programs/{ticket_id}",
    tags=["checklists"],
    dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW)), Depends(program_or_404)],
)


# ---- schemas ---------------------------------------------------------------


class TemplateItemIn(BaseModel):
    label: str = Field(min_length=1)
    instruction: str = ""
    required: bool = True
    needs_detail: bool = False

    def spec(self) -> ItemSpec:
        return ItemSpec(self.label.strip(), self.instruction.strip(), self.required, self.needs_detail)


class TemplateItemOut(TemplateItemIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    seq: int


class TemplateIn(BaseModel):
    name: str = Field(min_length=1)
    kind: ChecklistKind
    items: list[TemplateItemIn] = Field(min_length=1)


class TemplatePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    active: bool | None = None
    items: list[TemplateItemIn] | None = Field(default=None, min_length=1)


class TemplateOut(BaseModel):
    id: int
    key: str
    name: str
    kind: ChecklistKind
    active: bool
    items: list[TemplateItemOut]


class ItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    seq: int
    label: str
    instruction: str
    required: bool
    needs_detail: bool
    confirmed_by_name: str | None
    confirmed_at: dt.datetime | None
    detail: str | None


class ProgressOut(BaseModel):
    done: int
    total: int


class ChecklistOut(BaseModel):
    id: int
    kind: ChecklistKind
    title: str
    status: ChecklistStatus
    round_id: int | None
    phase: str | None
    owner_id: str | None
    owner_name: str | None
    due_at: dt.datetime | None
    requested_by_name: str | None
    detail: str | None
    resolution: str | None
    created_at: dt.datetime
    updated_at: dt.datetime
    progress: ProgressOut
    items: list[ItemOut]


class RequestIn(BaseModel):
    template_id: int
    title: str | None = Field(default=None, min_length=1)
    detail: str | None = None
    owner_id: str | None = None
    due_at: dt.datetime | None = None


class RequestPatch(BaseModel):
    """Only the fields present in the request are changed."""

    title: str | None = Field(default=None, min_length=1)
    detail: str | None = None
    owner_id: str | None = None
    due_at: dt.datetime | None = None
    resolution: str | None = None
    status: ChecklistStatus | None = None


class ConfirmIn(BaseModel):
    confirmed: bool = True  # false takes a confirmation back
    detail: str | None = None  # required for items marked needs_detail


class PhaseOut(BaseModel):
    phase: Phase
    title: str
    status: PhaseStatus
    starts_on: dt.date | None
    due_on: dt.date | None
    completed_at: dt.datetime | None
    completed_by_name: str | None
    skip_reason: str | None
    gate: ChecklistOut | None


class PhasePatch(BaseModel):
    status: PhaseStatus | None = None
    starts_on: dt.date | None = None
    due_on: dt.date | None = None
    skip_reason: str | None = None


def _checklist_out(checklist: Checklist, items: list[ChecklistItem]) -> ChecklistOut:
    p = checklists.progress(items)
    return ChecklistOut(
        id=checklist.id, kind=ChecklistKind(checklist.kind), title=checklist.title,
        status=ChecklistStatus(checklist.status), round_id=checklist.round_id, phase=checklist.phase,
        owner_id=checklist.owner_id, owner_name=checklist.owner_name, due_at=checklist.due_at,
        requested_by_name=checklist.requested_by_name, detail=checklist.detail, resolution=checklist.resolution,
        created_at=checklist.created_at, updated_at=checklist.updated_at, progress=ProgressOut(done=p.done, total=p.total),
        items=[ItemOut.model_validate(i) for i in items],
    )


async def _template_out(session: AsyncSession, template: ChecklistTemplate) -> TemplateOut:
    items = await checklists.template_items(session, template.id)
    return TemplateOut(
        id=template.id, key=template.key, name=template.name, kind=ChecklistKind(template.kind), active=template.active,
        items=[TemplateItemOut.model_validate(i) for i in items],
    )


# ---- templates -------------------------------------------------------------


@templates_router.get("", response_model=list[TemplateOut])
async def list_templates(
    kind: ChecklistKind | None = None, include_inactive: bool = False, session: AsyncSession = Depends(get_session)
) -> list[TemplateOut]:
    stmt = select(ChecklistTemplate).order_by(ChecklistTemplate.kind, ChecklistTemplate.name)
    if kind is not None:
        stmt = stmt.where(ChecklistTemplate.kind == kind.value)
    if not include_inactive:
        stmt = stmt.where(ChecklistTemplate.active)
    return [await _template_out(session, t) for t in (await session.scalars(stmt)).all()]


@templates_router.post("", status_code=201, response_model=TemplateOut)
async def create_template(
    body: TemplateIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REQUEST_TYPES_EDIT)),
) -> TemplateOut:
    template = await checklists.create_template(
        session, access.user, name=body.name, kind=body.kind, items=[i.spec() for i in body.items]
    )
    await session.commit()
    return await _template_out(session, template)


@templates_router.patch("/{template_id}", response_model=TemplateOut)
async def patch_template(
    template_id: int,
    body: TemplatePatch,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REQUEST_TYPES_EDIT)),
) -> TemplateOut:
    """Edits never change checklists already created from the template."""
    template = await checklists.get_template(session, template_id)
    await checklists.update_template(
        session, access.user, template, name=body.name, active=body.active,
        items=[i.spec() for i in body.items] if body.items is not None else None,
    )
    await session.commit()
    return await _template_out(session, template)


# ---- requests and item confirmation --------------------------------------------


@router.get("/requests", response_model=list[ChecklistOut])
async def list_requests(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[ChecklistOut]:
    return [_checklist_out(c, i) for c, i in await checklists.list_checklists(session, ticket_id, kind=ChecklistKind.REQUEST)]


@router.post("/requests", status_code=201, response_model=ChecklistOut)
async def create_request(
    ticket_id: str,
    body: RequestIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REQUEST_CREATE)),
) -> ChecklistOut:
    checklist = await checklists.create_request(
        session, access.user, ticket_id, template_id=body.template_id, title=body.title, detail=body.detail,
        owner_id=body.owner_id, due_at=body.due_at,
    )
    await session.commit()
    return _checklist_out(checklist, await checklists.items_of(session, checklist.id))


@router.patch("/requests/{checklist_id}", response_model=ChecklistOut)
async def patch_request(
    ticket_id: str,
    checklist_id: int,
    body: RequestPatch,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REQUEST_MANAGE)),
) -> ChecklistOut:
    checklist = await checklists.get(session, ticket_id, checklist_id)
    await checklists.update_request(session, access.user, checklist, body.model_dump(exclude_unset=True))
    await session.commit()
    return _checklist_out(checklist, await checklists.items_of(session, checklist.id))


@router.put("/checklists/{checklist_id}/items/{item_id}", response_model=ChecklistOut)
async def confirm_item(
    ticket_id: str,
    checklist_id: int,
    item_id: int,
    body: ConfirmIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REQUEST_MANAGE)),
) -> ChecklistOut:
    """Confirm (or take back) one item of any checklist: a request, a phase gate or a round's readiness."""
    checklist = await checklists.get(session, ticket_id, checklist_id)
    await checklists.confirm_item(session, access.user, checklist, item_id, confirmed=body.confirmed, detail=body.detail)
    await session.commit()
    return _checklist_out(checklist, await checklists.items_of(session, checklist.id))


# ---- lifecycle ---------------------------------------------------------------


def _phase_out(view: checklists.PhaseView) -> PhaseOut:
    phase: ProgramPhase = view.phase
    return PhaseOut(
        phase=Phase(phase.phase), title=phase_title(Phase(phase.phase)), status=PhaseStatus(phase.status),
        starts_on=phase.starts_on, due_on=phase.due_on, completed_at=phase.completed_at,
        completed_by_name=phase.completed_by_name, skip_reason=phase.skip_reason,
        gate=_checklist_out(view.checklist, view.items) if view.checklist else None,
    )


@router.get("/lifecycle", response_model=list[PhaseOut])
async def get_lifecycle(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[PhaseOut]:
    """The seven phases in order, each with its gate checklist. The first call creates them."""
    await checklists.ensure_lifecycle(session, ticket_id)
    await session.commit()
    return [_phase_out(v) for v in await checklists.lifecycle(session, ticket_id)]


@router.patch("/lifecycle/{phase}", response_model=PhaseOut)
async def patch_phase(
    ticket_id: str,
    phase: Phase,
    body: PhasePatch,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REQUEST_MANAGE)),
) -> PhaseOut:
    await checklists.ensure_lifecycle(session, ticket_id)
    await checklists.update_phase(session, access.user, ticket_id, phase, body.model_dump(exclude_unset=True))
    await session.commit()
    return next(_phase_out(v) for v in await checklists.lifecycle(session, ticket_id) if v.phase.phase == phase.value)
