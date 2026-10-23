"""Checklist templates, special requests, and item confirmation (any checklist)."""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import checklists, slack, slack_outbox
from core.access import Access, require_permission
from core.checklists import ChecklistKind, ChecklistStatus, ItemSpec
from core.database import get_session
from core.deps import program_or_404
from core.errors import DomainError
from core.orm import Checklist, ChecklistItem, ChecklistTemplate, Program
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
    owner_id: str | None
    owner_name: str | None
    due_at: dt.datetime | None
    requested_by_name: str | None
    detail: str | None
    resolution: str | None
    slack_channel_id: str | None
    slack_channel_name: str | None
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
    slack_channel_id: str | None = None  # updates for this request are posted there


class RequestPatch(BaseModel):
    """Only the fields present in the request are changed."""

    title: str | None = Field(default=None, min_length=1)
    detail: str | None = None
    owner_id: str | None = None
    due_at: dt.datetime | None = None
    resolution: str | None = None
    status: ChecklistStatus | None = None
    slack_channel_id: str | None = None  # empty clears it


class ConfirmIn(BaseModel):
    confirmed: bool = True  # false takes a confirmation back
    detail: str | None = None  # required for items marked needs_detail


def _checklist_out(checklist: Checklist, items: list[ChecklistItem]) -> ChecklistOut:
    p = checklists.progress(items)
    return ChecklistOut(
        id=checklist.id, kind=ChecklistKind(checklist.kind), title=checklist.title,
        status=ChecklistStatus(checklist.status),
        owner_id=checklist.owner_id, owner_name=checklist.owner_name, due_at=checklist.due_at,
        requested_by_name=checklist.requested_by_name, detail=checklist.detail, resolution=checklist.resolution,
        slack_channel_id=checklist.slack_channel_id, slack_channel_name=checklist.slack_channel_name,
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


async def _resolve_channel(channel_id: str | None) -> tuple[str | None, str | None]:
    """The channel id and its name as Slack reports it; nothing is saved against an id Slack doesn't know."""
    channel_id = (channel_id or "").strip()
    if not channel_id:
        return None, None
    ok, value = await slack.channel_name(channel_id)
    if not ok:
        raise DomainError("slack_channel_invalid", value, 422)
    return channel_id, value


async def _notify(session: AsyncSession, checklist: Checklist, text: str, key: str) -> None:
    """Post to the request's own channel. Nothing is posted for a request with no channel."""
    if not checklist.slack_channel_id:
        return
    program = await session.get(Program, checklist.ticket_id)
    await slack_outbox.enqueue(
        session, ticket_id=checklist.ticket_id, kind="request", body=f"{text}\nProgram: {program.display_name if program else checklist.ticket_id}",
        dedupe_key=f"request:{checklist.id}:{key}", channel_id=checklist.slack_channel_id,
    )


@router.post("/requests", status_code=201, response_model=ChecklistOut)
async def create_request(
    ticket_id: str,
    body: RequestIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REQUEST_CREATE)),
) -> ChecklistOut:
    channel_id, channel_name = await _resolve_channel(body.slack_channel_id)
    checklist = await checklists.create_request(
        session, access.user, ticket_id, template_id=body.template_id, title=body.title, detail=body.detail,
        owner_id=body.owner_id, due_at=body.due_at, slack_channel_id=channel_id, slack_channel_name=channel_name,
    )
    due = f"\nDue: {checklist.due_at:%d %b %Y}" if checklist.due_at else ""
    await _notify(
        session, checklist, f"New special request: {checklist.title}{due}\nRaised by {access.user.name or access.user.email}"
        + (f"\n{checklist.detail}" if checklist.detail else ""), "created",
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
    changes = body.model_dump(exclude_unset=True)
    if "slack_channel_id" in changes:
        changes["slack_channel_id"], changes["slack_channel_name"] = await _resolve_channel(changes["slack_channel_id"])
    before = checklist.status
    await checklists.update_request(session, access.user, checklist, changes)
    if checklist.status != before:
        await _notify(
            session, checklist,
            f"Special request {checklist.title} is now {checklist.status.replace('_', ' ')}"
            + (f"\n{checklist.resolution}" if checklist.resolution else ""),
            f"status:{checklist.status}:{checklist.updated_at.isoformat()}",
        )
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
    """Confirm (or take back) one item of any checklist: a special request's."""
    checklist = await checklists.get(session, ticket_id, checklist_id)
    await checklists.confirm_item(session, access.user, checklist, item_id, confirmed=body.confirmed, detail=body.detail)
    await session.commit()
    return _checklist_out(checklist, await checklists.items_of(session, checklist.id))
