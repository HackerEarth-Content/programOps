"""Program analytics routes -- stage funnel, checklist completion, and
campaign/event breakdowns over core.orm.Program."""

from __future__ import annotations

import time
import uuid
from typing import Literal
from urllib.parse import quote
from collections import Counter
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer, load_only

from core.access import Access, require_permission
from core.database import get_session
from core.config import settings
from core.orm import (
    Program,
    ProgramDocument,
    ProgramRegistration,
    ProgramNote,
    ProgramStageHistory,
)
from core.permissions import Permission
from core import audit, internal_programs, redash_sync
from hubspot_client import pipeline
from hubspot_client.client import get_user_names
from hubspot_client.stage_checklist import (
    PROGRAM_STAGES,
    PROPERTY_LABELS,
    STAGE_CHECKLISTS,
    pending_items,
    resolve_history_value,
)
from hubspot_client import pipeline
from hubspot_client.weekly_brief import generate_weekly_brief

# Every route here requires a signed-in user -- router-level dependency
# gates the whole surface in one place instead of repeating it per route.
router = APIRouter(
    prefix="/programs",
    tags=["programs"],
    dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW))],
)

@router.post("/sync", status_code=202, dependencies=[Depends(require_permission(Permission.INTEGRATIONS_LINK))])
async def sync_now():
    """Start a HubSpot sync in the background (the same one the scheduler
    runs). Returns immediately -- poll GET /programs/sync/status for progress.
    One sync at a time, with a short cooldown after a manual one."""
    return {"status": pipeline.start_background_sync()}


@router.get("/sync/status")
async def sync_status():
    return pipeline.state


class InternalProgramIn(BaseModel):
    name: str = Field(min_length=1)
    campaign_type: Literal["Hackathon", "Coding Challenge"] = "Hackathon"  # "Coding Challenge" = a hiring challenge
    registration_start_date: date | None = None
    event_end_date: date | None = None


@router.post("/internal", status_code=201)
async def create_internal_program(
    body: InternalProgramIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.PROGRAM_CREATE)),
):
    """Start an internal program (a hackathon or a hiring challenge): no feasibility step, it starts at Onboarding. A real
    HubSpot ticket is created for it when write-back is on (502 `hubspot_scope_missing` / `hubspot_unavailable` if not)."""
    program = await internal_programs.create_internal(
        session, access.user, name=body.name, campaign_type=body.campaign_type,
        registration_start_date=body.registration_start_date, event_end_date=body.event_end_date,
    )
    return _serialize(program)


@router.post("/redash/sync", status_code=202, dependencies=[Depends(require_permission(Permission.INTEGRATIONS_LINK))])
async def redash_sync_now():
    """Reload registrations for every program in auto mode right now (override of the
    6-hourly job). Poll GET /programs/redash/sync/status."""
    return {"status": redash_sync.start_background()}


@router.get("/redash/sync/status")
async def redash_sync_status():
    return redash_sync.state


_STAGE_KEY_BY_LABEL = {v["label"]: k for k, v in PROGRAM_STAGES.items()}
_STAGE_CHECKLIST_COLUMN = {
    "pre_sales": Program.pre_sales_status,
    "onboarding": Program.onboarding_status,
    "ongoing": Program.ongoing_status,
    "post_campaign": Program.post_campaign_status,
}


@router.get("")
async def list_programs(session: AsyncSession = Depends(get_session)):
    # Only the columns _serialize reads -- not raw_properties / stage_timings /
    # the other big JSON fields, which would be loaded for every program.
    rows = await session.execute(
        select(Program)
        .options(
            load_only(
                Program.ticket_id,
                Program.origin,
                Program.subject,
                Program.stage_label,
                Program.campaign_type,
                Program.event_name,
                Program.other_event_name,
                Program.platform_details,
                Program.blackops_account_name,
                Program.company_name,
                Program.expected_deal_size,
                Program.owner_name,
                Program.account_manager_name,
                Program.csm_name,
                Program.content_poc_name,
                Program.created_at,
                Program.last_modified_at,
            )
        )
        .order_by(Program.last_modified_at.desc())
    )
    totals = dict(
        (await session.execute(
            select(ProgramRegistration.ticket_id, func.sum(ProgramRegistration.registrations))
            .group_by(ProgramRegistration.ticket_id)
        )).all()
    )
    return [{**_serialize(p), "registrations": totals.get(p.ticket_id)} for p in rows.scalars().all()]


@router.get("/{ticket_id}")
async def get_program(ticket_id: str, session: AsyncSession = Depends(get_session)):
    p = await session.get(Program, ticket_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Program not found")
    return _serialize(p)


@router.get("/{ticket_id}/history")
async def get_program_history(ticket_id: str, session: AsyncSession = Depends(get_session)):
    """The audit log of every stage/checklist change for this program,
    sourced from HubSpot's own property-history API -- who changed it, when,
    and how (CRM_UI/API/INTEGRATION/WORKFLOW/MIGRATION)."""
    rows = await session.execute(
        select(ProgramStageHistory)
        .where(ProgramStageHistory.ticket_id == ticket_id)
        .order_by(ProgramStageHistory.changed_at.desc())  # newest first
    )
    user_names = await get_user_names()
    return [
        {
            "property_name": h.property_name,
            "property_label": PROPERTY_LABELS.get(h.property_name, h.property_name),
            "old_value": h.old_value,
            "new_value": h.new_value,
            "old_value_label": resolve_history_value(h.property_name, h.old_value),
            "new_value_label": resolve_history_value(h.property_name, h.new_value),
            "changed_at": h.changed_at,
            "source_type": h.source_type,
            "changed_by_user_id": h.changed_by_user_id,
            "changed_by_name": user_names.get(h.changed_by_user_id),
        }
        for h in rows.scalars().all()
    ]


@router.get("/{ticket_id}/notes")
async def get_program_notes(ticket_id: str, session: AsyncSession = Depends(get_session)):
    """Comments logged against this program -- HubSpot Notes mirrored in by
    the sync (source="hubspot") plus any written directly in ProgramOps
    (source="programops"), in one chronological list."""
    rows = await session.execute(
        select(ProgramNote)
        .where(ProgramNote.ticket_id == ticket_id)
        .order_by(ProgramNote.created_at.desc())  # newest first
    )
    user_names = await get_user_names()
    return [_serialize_note(n, user_names) for n in rows.scalars().all()]


class CreateNoteRequest(BaseModel):
    body: str = Field(min_length=1)  # the author is always the signed-in user, never taken from the body


@router.post("/{ticket_id}/notes", status_code=201)
async def create_program_note(
    ticket_id: str,
    payload: CreateNoteRequest,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.COMMENT_ADD)),
):
    """Add a note directly in ProgramOps -- local only, not written back to
    HubSpot (write-back needs a HubSpot token scope that isn't set yet)."""
    program = await session.get(Program, ticket_id)
    if program is None:
        raise HTTPException(status_code=404, detail="Program not found")

    note = ProgramNote(
        note_id=f"local-{uuid.uuid4()}",
        ticket_id=ticket_id,
        body=payload.body.strip(),
        author_user_id=None,
        author_name=access.user.name or access.user.email,
        author_id=access.user.id,
        source="programops",
        created_at=datetime.now(timezone.utc),
    )
    session.add(note)
    audit.record(
        session, access.user, entity="note", entity_id=note.note_id, ticket_id=ticket_id,
        action="note_added", new={"length": len(note.body)},
    )
    await session.commit()
    return _serialize_note(note)


def _serialize_note(n: ProgramNote, user_names: dict[int, str] | None = None) -> dict:
    return {
        "note_id": n.note_id,
        "body": n.body,
        "author_user_id": n.author_user_id,
        "author_name": n.author_name
        or (user_names or {}).get(n.author_user_id),  # HubSpot notes: resolved user name
        "source": n.source,
        "kind": n.kind,
        "health": n.health,
        "blockers": n.blockers,
        "created_at": n.created_at,
    }


@router.get("/analytics/stage-funnel")
async def stage_funnel(session: AsyncSession = Depends(get_session)):
    """Count of programs currently in each stage, in pipeline order."""
    rows = await session.execute(
        select(Program.stage_label, func.count()).group_by(Program.stage_label)
    )
    counts = dict(rows.all())
    return [
        {"stage": s["label"], "count": counts.get(s["label"], 0)}
        for s in PROGRAM_STAGES.values()
    ]


@router.get("/analytics/checklist-status")
async def checklist_status(session: AsyncSession = Depends(get_session)):
    """For each program: the items HubSpot has ticked vs. still pending for its current stage ("what is it pending
    on"), and `stages`: how far each stage's HubSpot checklist is (done / total), for the stage progress bar.
    HubSpot's ticket properties are the only source."""
    rows = await session.execute(
        select(
            Program.ticket_id,
            Program.subject,
            Program.stage_label,
            Program.pre_sales_status,
            Program.onboarding_status,
            Program.ongoing_status,
            Program.post_campaign_status,
        )
    )
    results = []
    for ticket_id, subject, stage_label, *ticked in rows.all():
        by_stage = dict(zip(("pre_sales", "onboarding", "ongoing", "post_campaign"), ticked))
        stage_key = _STAGE_KEY_BY_LABEL.get(stage_label)
        selected = by_stage.get(stage_key) or []
        stages = []
        for key, stage in PROGRAM_STAGES.items():
            labels = [label for label, _ in STAGE_CHECKLISTS[key][1]] if key in STAGE_CHECKLISTS else []
            done = len(set(labels) & set(by_stage.get(key) or []))
            stages.append({"key": key, "label": stage["label"], "done": done, "total": len(labels)})
        results.append(
            {
                "ticket_id": ticket_id,
                "subject": subject,
                "stage": stage_label,
                "completed_items": selected,
                "pending_items": pending_items(stage_key, selected) if stage_key else [],
                "stages": stages,
            }
        )
    return results


_BRIEF_TTL_SECONDS = 30 * 60
_brief_cache: dict[int, tuple[float, dict]] = {}  # ponytail: per process; a shared cache if the API ever runs several workers


@router.get("/analytics/weekly-brief")
async def weekly_brief(
    days: int = Query(7, ge=1, le=90), refresh: bool = False, session: AsyncSession = Depends(get_session)
):
    """AI-generated executive summary of program activity over the last `days` days (stage/checklist changes plus
    internal notes), per program. Each generation costs OpenAI tokens, so the result is kept for 30 minutes;
    `refresh=true` generates a new one."""
    hit = _brief_cache.get(days)
    if hit and not refresh and time.monotonic() - hit[0] < _BRIEF_TTL_SECONDS:
        return hit[1]
    result = await generate_weekly_brief(session, days=days)
    _brief_cache[days] = (time.monotonic(), result)
    return result


@router.get("/analytics/campaign-types")
async def campaign_types(session: AsyncSession = Depends(get_session)):
    """How many active (not Closed) programs of each campaign type
    (Hackathon/Hiring Challenge/etc)."""
    rows = await session.execute(
        select(Program.campaign_type, func.count())
        .where(Program.stage_label != "Closed")
        .group_by(Program.campaign_type)
    )
    return [{"campaign_type": ct or "Unset", "count": c} for ct, c in rows.all()]


@router.get("/analytics/events")
async def events(session: AsyncSession = Depends(get_session)):
    """Named hackathons/hiring challenges and which stage each is in."""
    rows = await session.execute(
        select(Program.event_name, Program.other_event_name, Program.stage_label)
    )
    counter: Counter[tuple[str, str]] = Counter()
    for event_name, other_event_name, stage_label in rows.all():
        name = event_name or other_event_name or "Unnamed"
        counter[(name, stage_label)] += 1
    return [
        {"event_name": name, "stage": stage, "count": count}
        for (name, stage), count in counter.items()
    ]


def _serialize(p: Program) -> dict:
    return {
        "ticket_id": p.ticket_id,
        "origin": p.origin,
        "subject": p.subject,
        "stage": p.stage_label,
        "campaign_type": p.campaign_type,
        "event_name": p.event_name or p.other_event_name,
        "display_name": p.display_name,
        "untitled": p.is_untitled,
        "platform_details": p.platform_details,
        "blackops_account_name": p.blackops_account_name,
        "company_name": p.company_name,
        "expected_deal_size": p.expected_deal_size,
        "owner_name": p.owner_name,
        "account_manager_name": p.account_manager_name,
        "csm_name": p.csm_name,
        "content_poc_name": p.content_poc_name,
        "created_at": p.created_at,
        "last_modified_at": p.last_modified_at,
    }


# ---- SOW / POA documents ---------------------------------------------------

_KINDS = ("sow", "poa")


def _check_kind(kind: str) -> None:
    if kind not in _KINDS:
        raise HTTPException(status_code=404, detail="Unknown document kind")


def _serialize_document(d: ProgramDocument) -> dict:
    return {
        "file": {
            "file_name": d.file_name,
            "url": f"{settings.API_BASE_URL}/programs/{d.ticket_id}/documents/{d.kind}/file",
            "size_bytes": d.size_bytes,
            "uploaded_at": d.uploaded_at,
            "hubspot_property": d.hubspot_property,
        },
        "status": d.status,
        "error": d.error,
        "details": d.details,
    }


@router.get("/{ticket_id}/documents")
async def get_program_documents(ticket_id: str, session: AsyncSession = Depends(get_session)):
    """The ticket's SOW and POA: file info, extraction status, the validated
    extracted details."""
    docs = (
        await session.execute(
            select(ProgramDocument)
            .options(defer(ProgramDocument.content))  # the PDF bytes aren't needed for JSON
            .where(ProgramDocument.ticket_id == ticket_id)
        )
    ).scalars().all()
    by_kind = {d.kind: _serialize_document(d) for d in docs}
    return {"sow": by_kind.get("sow"), "poa": by_kind.get("poa")}


@router.get("/{ticket_id}/documents/{kind}/file")
async def get_program_document_file(
    ticket_id: str,
    kind: str,
    download: bool = False,
    session: AsyncSession = Depends(get_session),
):
    _check_kind(kind)
    doc = await session.get(ProgramDocument, (ticket_id, kind))
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    disposition = "attachment" if download else "inline"
    return Response(
        content=doc.content,
        media_type=doc.mime_type,
        headers={"Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(doc.file_name)}"},
    )


def due_items(kind: str, details: dict, on: str) -> list[dict]:
    """Dated items of a document that fall on ISO date `on` (a range counts on
    every day it covers)."""
    if kind == "sow":
        return [
            {"title": m["task"], "date": m["start"], "owner": m["owner"]}
            for m in details.get("timeline", [])
            if m.get("start") and m["start"] <= on <= (m.get("end") or m["start"])
        ]
    return [
        {"title": a["activity"], "date": a["date"], "owner": a["channel"]}
        for a in details.get("activities", [])
        if a.get("date") == on
    ]


@router.get("/analytics/due-today")
async def due_today(on: str, session: AsyncSession = Depends(get_session)):
    """Everything across programs scheduled for date `on` (YYYY-MM-DD, the
    viewer's local today) """
    rows = (
        await session.execute(
            select(ProgramDocument, Program.subject)
            .options(defer(ProgramDocument.content))
            .join(Program, Program.ticket_id == ProgramDocument.ticket_id)
            .where(ProgramDocument.status == "ok")
        )
    ).all()
    out = []
    for doc, subject in rows:
        for item in due_items(doc.kind, doc.details or {}, on):
            out.append({**item, "ticket_id": doc.ticket_id, "subject": subject, "kind": doc.kind})
    return out


if __name__ == "__main__":
    sow = {"timeline": [{"task": "Assess", "start": "2026-03-13", "end": "2026-03-14", "owner": "HE"}]}
    assert due_items("sow", sow, "2026-03-14") and not due_items("sow", sow, "2026-03-15")
    poa = {"activities": [{"activity": "Email 1", "date": "2026-06-30", "channel": "Email"}]}
    assert due_items("poa", poa, "2026-06-30")[0]["owner"] == "Email"
    print("ok")
