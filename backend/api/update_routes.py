"""Daily updates and comments on a program. Append-only: there is no edit or delete, a correction is a new entry.
The author is always the signed-in user."""

from __future__ import annotations

import datetime as dt
import uuid
from enum import StrEnum

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit, slack_outbox
from core.access import Access, require_permission
from core.database import get_session
from core.deps import program_or_404
from core.health import Health
from core.orm import Program, ProgramNote
from core.permissions import Permission

router = APIRouter(
    prefix="/programs/{ticket_id}",
    tags=["updates"],
    dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW)), Depends(program_or_404)],
)


class NoteKind(StrEnum):
    NOTE = "note"
    COMMENT = "comment"
    UPDATE = "update"


class UpdateIn(BaseModel):
    health: Health
    summary: str = Field(min_length=1)
    blockers: str | None = None


class CommentIn(BaseModel):
    body: str = Field(min_length=1)


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    note_id: str
    kind: NoteKind
    body: str
    health: Health | None
    blockers: str | None
    author_name: str | None
    source: str
    created_at: dt.datetime


class NotePage(BaseModel):
    items: list[NoteOut]
    next_before: dt.datetime | None  # pass as `before` for the next page


async def _post(
    session: AsyncSession, access: Access, ticket_id: str, *, kind: NoteKind, body: str,
    health: Health | None = None, blockers: str | None = None,
) -> ProgramNote:
    note = ProgramNote(
        note_id=f"local-{uuid.uuid4()}", ticket_id=ticket_id, body=body.strip(), kind=kind.value,
        health=health.value if health else None, blockers=(blockers or "").strip() or None,
        author_name=access.user.name or access.user.email, author_id=access.user.id,
        source="programops", created_at=dt.datetime.now(dt.timezone.utc),
    )
    session.add(note)
    audit.record(
        session, access.user, entity=kind.value, entity_id=note.note_id, ticket_id=ticket_id,
        action=f"{kind.value}_posted", new={"health": note.health} if health else None,
    )
    if kind == NoteKind.UPDATE and (program := await session.get(Program, ticket_id)):
        blockers = f"\nBlockers: {note.blockers}" if note.blockers else ""
        await slack_outbox.enqueue(
            session, ticket_id=ticket_id, kind="daily_update",
            body=f":memo: *{program.display_name}* · daily update from {note.author_name} [{note.health}]\n{note.body}{blockers}",
        )
    await session.commit()
    return note


@router.get("/updates", response_model=NotePage)
async def list_updates(
    ticket_id: str,
    kind: NoteKind | None = None,
    before: dt.datetime | None = None,
    limit: int = Query(30, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
) -> NotePage:
    """Newest first. Without `kind`, everything written in the portal (updates, comments and notes)."""
    stmt = (
        select(ProgramNote).where(ProgramNote.ticket_id == ticket_id, ProgramNote.source == "programops")
        .order_by(ProgramNote.created_at.desc()).limit(limit + 1)
    )
    if kind is not None:
        stmt = stmt.where(ProgramNote.kind == kind.value)
    if before is not None:
        stmt = stmt.where(ProgramNote.created_at < before)
    rows = list((await session.scalars(stmt)).all())
    page = rows[:limit]
    return NotePage(items=[NoteOut.model_validate(r) for r in page], next_before=page[-1].created_at if len(rows) > limit else None)


@router.post("/updates", status_code=201, response_model=NoteOut)
async def post_update(
    ticket_id: str,
    body: UpdateIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.UPDATE_POST)),
) -> ProgramNote:
    """The daily update: health, a summary and any blockers."""
    return await _post(session, access, ticket_id, kind=NoteKind.UPDATE, body=body.summary, health=body.health, blockers=body.blockers)


@router.post("/comments", status_code=201, response_model=NoteOut)
async def post_comment(
    ticket_id: str,
    body: CommentIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.COMMENT_ADD)),
) -> ProgramNote:
    return await _post(session, access, ticket_id, kind=NoteKind.COMMENT, body=body.body)
