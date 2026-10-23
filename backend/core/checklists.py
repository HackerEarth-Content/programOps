"""One checklist engine behind special requests.

A template's items are copied (snapshotted) into a checklist when it is created, so editing a template later never
changes a checklist already in use. Each item records who confirmed it, when, and the detail ("what exactly was
confirmed"). A checklist is `ready` only when every required item is confirmed.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit
from core.errors import DomainError
from core.orm import (
    Checklist,
    ChecklistItem,
    ChecklistTemplate,
    ChecklistTemplateItem,
    User,
)


class ChecklistKind(StrEnum):
    REQUEST = "request"


class ChecklistStatus(StrEnum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    READY = "ready"  # every required item confirmed
    DONE = "done"
    DECLINED = "declined"


@dataclass(frozen=True)
class ItemSpec:
    label: str
    instruction: str = ""
    required: bool = True
    needs_detail: bool = False  # confirming it requires a note on what was confirmed


@dataclass(frozen=True)
class TemplateSpec:
    key: str
    name: str
    kind: ChecklistKind
    items: tuple[ItemSpec, ...]


# Starter wording, editable by CSMs and super admins without a release. Seeded once; never overwritten.
DEFAULT_TEMPLATES: tuple[TemplateSpec, ...] = (
    TemplateSpec(
        "content_to_marketing", "Content to marketing", ChecklistKind.REQUEST,
        (
            ItemSpec("Image quality meets the spec", "Resolution, aspect ratio and file format checked against the spec.", needs_detail=True),
            ItemSpec("Client has approved the copy", "Link or note of the client's sign-off.", needs_detail=True),
            ItemSpec("Logos and brand assets received", "Client logo and brand guidelines are in hand and usable."),
            ItemSpec("Eligibility and dates verified", "Checked against the SOW."),
        ),
    ),
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---- templates -----------------------------------------------------------------


async def ensure_default_templates(session: AsyncSession) -> None:
    """Seed the starter templates that don't exist yet. Idempotent and never overwrites an edited template."""
    have = set((await session.scalars(select(ChecklistTemplate.key))).all())
    for spec in DEFAULT_TEMPLATES:
        if spec.key in have:
            continue
        template = ChecklistTemplate(key=spec.key, name=spec.name, kind=spec.kind.value)
        session.add(template)
        await session.flush()
        _add_template_items(session, template.id, spec.items)


def _add_template_items(session: AsyncSession, template_id: int, items: Sequence[ItemSpec]) -> None:
    session.add_all(
        ChecklistTemplateItem(
            template_id=template_id, seq=seq, label=item.label, instruction=item.instruction,
            required=item.required, needs_detail=item.needs_detail,
        )
        for seq, item in enumerate(items, start=1)
    )


async def get_template(session: AsyncSession, template_id: int) -> ChecklistTemplate:
    template = await session.get(ChecklistTemplate, template_id)
    if template is None:
        raise DomainError("template_not_found", "Template not found.", 404)
    return template


async def template_by_key(session: AsyncSession, key: str) -> ChecklistTemplate | None:
    return await session.scalar(
        select(ChecklistTemplate).where(ChecklistTemplate.key == key, ChecklistTemplate.active)
    )


async def template_items(session: AsyncSession, template_id: int) -> list[ChecklistTemplateItem]:
    rows = await session.scalars(
        select(ChecklistTemplateItem).where(ChecklistTemplateItem.template_id == template_id).order_by(ChecklistTemplateItem.seq)
    )
    return list(rows.all())


def _key_for(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "template"


async def create_template(
    session: AsyncSession, actor: User, *, name: str, kind: ChecklistKind, items: Sequence[ItemSpec]
) -> ChecklistTemplate:
    if not items:
        raise DomainError("items_required", "A template needs at least one item.", 422)
    taken = set((await session.scalars(select(ChecklistTemplate.key))).all())
    base, key, n = _key_for(name), _key_for(name), 1
    while key in taken:
        n += 1
        key = f"{base}_{n}"
    template = ChecklistTemplate(key=key, name=name.strip(), kind=kind.value)
    session.add(template)
    await session.flush()
    _add_template_items(session, template.id, items)
    audit.record(
        session, actor, entity="checklist_template", entity_id=str(template.id), action="template_created",
        new={"key": key, "kind": kind.value, "items": len(items)},
    )
    return template


async def update_template(
    session: AsyncSession,
    actor: User,
    template: ChecklistTemplate,
    *,
    name: str | None = None,
    active: bool | None = None,
    items: Sequence[ItemSpec] | None = None,
) -> ChecklistTemplate:
    """Rename, switch on or off, or replace the items. Checklists already created keep their own copy."""
    if name is not None and name.strip() != template.name:
        audit.record(session, actor, entity="checklist_template", entity_id=str(template.id),
                     action="template_updated", field="name", old=template.name, new=name.strip())
        template.name = name.strip()
    if active is not None and active != template.active:
        audit.record(session, actor, entity="checklist_template", entity_id=str(template.id),
                     action="template_updated", field="active", old=template.active, new=active)
        template.active = active
    if items is not None:
        if not items:
            raise DomainError("items_required", "A template needs at least one item.", 422)
        for old in await template_items(session, template.id):
            await session.delete(old)
        await session.flush()
        _add_template_items(session, template.id, items)
        audit.record(session, actor, entity="checklist_template", entity_id=str(template.id),
                     action="template_updated", field="items", new=[i.label for i in items])
    return template


# ---- checklists ----------------------------------------------------------------


async def items_of(session: AsyncSession, checklist_id: int) -> list[ChecklistItem]:
    rows = await session.scalars(select(ChecklistItem).where(ChecklistItem.checklist_id == checklist_id).order_by(ChecklistItem.seq))
    return list(rows.all())


@dataclass(frozen=True)
class Progress:
    done: int  # required items confirmed
    total: int  # required items


def progress(items: Sequence[ChecklistItem]) -> Progress:
    required = [i for i in items if i.required]
    return Progress(done=sum(i.confirmed_at is not None for i in required), total=len(required))


def all_required_done(items: Sequence[ChecklistItem]) -> bool:
    return all(i.confirmed_at is not None for i in items if i.required)


async def get(session: AsyncSession, ticket_id: str, checklist_id: int) -> Checklist:
    checklist = await session.get(Checklist, checklist_id)
    if checklist is None or checklist.ticket_id != ticket_id:
        raise DomainError("checklist_not_found", "Checklist not found.", 404)
    return checklist


async def user_name(session: AsyncSession, user_id: str) -> str:
    user = await session.get(User, user_id)
    if user is None:
        raise DomainError("owner_not_found", "That owner isn't a portal user.", 422)
    return user.name or user.email


async def create_checklist(
    session: AsyncSession,
    actor: User | None,
    *,
    ticket_id: str,
    template: ChecklistTemplate,
    title: str | None = None,
    owner_id: str | None = None,
    due_at: datetime | None = None,
    detail: str | None = None,
) -> Checklist:
    """Create a checklist from a template, snapshotting its items."""
    checklist = Checklist(
        ticket_id=ticket_id, template_id=template.id, kind=template.kind, title=(title or template.name).strip(),
        owner_id=owner_id,
        owner_name=await user_name(session, owner_id) if owner_id else None, due_at=due_at, detail=detail,
        requested_by=actor.id if actor else None, requested_by_name=(actor.name or actor.email) if actor else None,
    )
    session.add(checklist)
    await session.flush()
    session.add_all(
        ChecklistItem(
            checklist_id=checklist.id, seq=item.seq, label=item.label, instruction=item.instruction,
            required=item.required, needs_detail=item.needs_detail,
        )
        for item in await template_items(session, template.id)
    )
    await session.flush()
    audit.record(
        session, actor, entity="checklist", entity_id=str(checklist.id), ticket_id=ticket_id,
        action="checklist_created", new={"kind": checklist.kind, "title": checklist.title},
    )
    return checklist


async def confirm_item(
    session: AsyncSession, actor: User, checklist: Checklist, item_id: int, *, confirmed: bool, detail: str | None
) -> ChecklistItem:
    """Confirm (or take back) one item and move the checklist along: ready once every required item is confirmed."""
    if checklist.status in (ChecklistStatus.DONE, ChecklistStatus.DECLINED):
        raise DomainError("checklist_closed", "This checklist is closed. Reopen it first.")
    item = await session.get(ChecklistItem, item_id)
    if item is None or item.checklist_id != checklist.id:
        raise DomainError("item_not_found", "Item not found.", 404)
    detail = (detail or "").strip() or None
    if confirmed and item.needs_detail and detail is None:
        raise DomainError("detail_required", f"Say what was confirmed for: {item.label}", 422)
    if confirmed:
        item.confirmed_by, item.confirmed_by_name, item.confirmed_at = actor.id, actor.name or actor.email, _now()
        item.detail = detail
    else:
        item.confirmed_by = item.confirmed_by_name = item.confirmed_at = item.detail = None
    items = await items_of(session, checklist.id)
    old = checklist.status
    if all_required_done(items) and any(i.required for i in items):
        checklist.status = ChecklistStatus.READY
    elif any(i.confirmed_at for i in items):
        checklist.status = ChecklistStatus.IN_PROGRESS
    else:
        checklist.status = ChecklistStatus.OPEN
    checklist.updated_at = _now()
    audit.record(
        session, actor, entity="checklist", entity_id=str(checklist.id), ticket_id=checklist.ticket_id,
        action="item_confirmed" if confirmed else "item_unconfirmed", field=item.label,
        old=old, new=checklist.status,
    )
    return item


async def set_status(
    session: AsyncSession, actor: User, checklist: Checklist, status: ChecklistStatus, *, resolution: str | None = None
) -> Checklist:
    if status in (ChecklistStatus.READY, ChecklistStatus.DONE) and not all_required_done(await items_of(session, checklist.id)):
        raise DomainError("checklist_incomplete", "Confirm every required item first.")
    if resolution is not None:
        checklist.resolution = resolution.strip() or None
    if status != checklist.status:
        audit.record(
            session, actor, entity="checklist", entity_id=str(checklist.id), ticket_id=checklist.ticket_id,
            action="status_changed", old=checklist.status, new=status.value,
        )
        checklist.status = status.value
    checklist.updated_at = _now()
    return checklist


# ---- requests ------------------------------------------------------------------


async def create_request(
    session: AsyncSession,
    actor: User,
    ticket_id: str,
    *,
    template_id: int,
    title: str | None,
    detail: str | None,
    owner_id: str | None,
    due_at: datetime | None,
    slack_channel_id: str | None = None,
    slack_channel_name: str | None = None,
) -> Checklist:
    template = await get_template(session, template_id)
    if template.kind != ChecklistKind.REQUEST or not template.active:
        raise DomainError("template_not_a_request_type", "Pick an active request type.", 422)
    checklist = await create_checklist(
        session, actor, ticket_id=ticket_id, template=template, title=title, owner_id=owner_id, due_at=due_at, detail=detail
    )
    checklist.slack_channel_id, checklist.slack_channel_name = slack_channel_id, slack_channel_name
    return checklist


REQUEST_EDITABLE = frozenset(
    {"title", "detail", "owner_id", "due_at", "resolution", "status", "slack_channel_id", "slack_channel_name"}
)


async def update_request(session: AsyncSession, actor: User, checklist: Checklist, changes: dict[str, Any]) -> Checklist:
    if checklist.kind != ChecklistKind.REQUEST:
        raise DomainError("not_a_request", "Only a request can be edited here.", 422)
    unknown = set(changes) - REQUEST_EDITABLE
    if unknown:
        raise DomainError("field_not_editable", f"Not editable here: {', '.join(sorted(unknown))}", 422)
    if "status" in changes:
        await set_status(session, actor, checklist, ChecklistStatus(changes.pop("status")), resolution=changes.get("resolution"))
    for field, value in changes.items():
        if field == "owner_id":
            checklist.owner_name = await user_name(session, value) if value else None
        old = getattr(checklist, field)
        if old != value:
            audit.record(session, actor, entity="checklist", entity_id=str(checklist.id), ticket_id=checklist.ticket_id,
                         action="request_updated", field=field, old=str(old) if old is not None else None,
                         new=str(value) if value is not None else None)
            setattr(checklist, field, value)
    checklist.updated_at = _now()
    return checklist


async def list_checklists(
    session: AsyncSession, ticket_id: str, *, kind: ChecklistKind | None = None
) -> list[tuple[Checklist, list[ChecklistItem]]]:
    stmt = select(Checklist).where(Checklist.ticket_id == ticket_id).order_by(Checklist.created_at.desc(), Checklist.id.desc())
    if kind is not None:
        stmt = stmt.where(Checklist.kind == kind.value)
    lists = list((await session.scalars(stmt)).all())
    by_list: dict[int, list[ChecklistItem]] = {c.id: [] for c in lists}
    if lists:
        for item in (
            await session.scalars(select(ChecklistItem).where(ChecklistItem.checklist_id.in_(by_list)).order_by(ChecklistItem.seq))
        ).all():
            by_list[item.checklist_id].append(item)
    return [(c, by_list[c.id]) for c in lists]
