"""The CSM queue: everything across programs that needs a CSM today, in one prioritised list.

Each rule below is one `kind`. An item carries a severity and the time it has been waiting; the list is sorted by
severity, then by how long it has waited.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from enum import StrEnum

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import dependencies, rounds
from core.activities import ActivityStatus
from core.checklists import ChecklistKind, ChecklistStatus
from core.communications import CommStatus
from core.health import CRITICAL_DEPENDENCY_DELAY_DAYS, READINESS_LOOKAHEAD_DAYS, STALE_UPDATE_DAYS
from core.orm import (
    Checklist,
    ParticipantComm,
    Program,
    ProgramActivity,
    ProgramNote,
    ProgramRegistrationSettings,
    TimelineChange,
)

ACTIVE_STAGES = frozenset({"Onboarding", "Ongoing", "Post Campaign"})  # a daily update and a Slack channel are expected


class Severity(StrEnum):
    CRITICAL = "critical"
    AMBER = "amber"
    INFO = "info"


SEVERITY_ORDER = {Severity.CRITICAL: 0, Severity.AMBER: 1, Severity.INFO: 2}


class CsmKind(StrEnum):
    CONTROL_BREACH = "control_breach"
    APPROVAL_WAITING = "approval_waiting"
    REQUEST_DUE = "request_due"
    COUNTS_MISSING = "counts_missing"
    UPDATE_DUE = "update_due"
    SLACK_UNLINKED = "slack_unlinked"
    DEPENDENCY_OVERDUE = "dependency_overdue"
    COMM_OVERDUE = "comm_overdue"
    READINESS_INCOMPLETE = "readiness_incomplete"
    CHANGE_AWAITING_APPROVAL = "change_awaiting_approval"


class CsmItem(BaseModel):
    id: str
    kind: CsmKind
    severity: Severity
    ticket_id: str
    program_name: str
    client: str | None
    title: str
    detail: str
    since: datetime | None
    ref_type: str | None  # activity, checklist, round, dependency, communication, change
    ref_id: int | None


def _name(program: Program) -> str:
    return program.display_name


async def items_for(session: AsyncSession, program: Program, now: datetime) -> list[CsmItem]:
    today: date = now.date()
    end_of_today = datetime.combine(today, time.max, tzinfo=timezone.utc)
    tid = program.ticket_id
    out: list[CsmItem] = []

    def add(kind: CsmKind, severity: Severity, title: str, detail: str, since: datetime | None, ref_type: str | None, ref_id: int | None) -> None:
        out.append(
            CsmItem(
                id=f"{kind.value}:{ref_type or 'program'}:{ref_id or tid}", kind=kind, severity=severity, ticket_id=tid,
                program_name=_name(program), client=program.company_name, title=title, detail=detail, since=since,
                ref_type=ref_type, ref_id=ref_id,
            )
        )

    for a in (await session.scalars(select(ProgramActivity).where(ProgramActivity.ticket_id == tid))).all():
        if a.status == ActivityStatus.LIVE and a.approved_at is None:
            add(CsmKind.CONTROL_BREACH, Severity.CRITICAL, f"{a.code} {a.title}", "Live without a CSM approval", a.updated_at, "activity", a.id)
        elif a.status == ActivityStatus.WIP and a.approved_at is None:
            add(CsmKind.APPROVAL_WAITING, Severity.AMBER, f"{a.code} {a.title}", "Marketing is waiting for your approval", a.updated_at, "activity", a.id)

    for c in (
        await session.scalars(
            select(Checklist).where(
                Checklist.ticket_id == tid, Checklist.kind == ChecklistKind.REQUEST.value,
                Checklist.status.in_([ChecklistStatus.OPEN.value, ChecklistStatus.IN_PROGRESS.value, ChecklistStatus.READY.value]),
                Checklist.due_at.is_not(None), Checklist.due_at <= end_of_today,
            )
        )
    ).all():
        late = c.due_at < now
        add(CsmKind.REQUEST_DUE, Severity.CRITICAL if late else Severity.AMBER, c.title,
            "Overdue" if late else "Due today", c.due_at, "checklist", c.id)

    for r in await rounds.list_rounds(session, tid):
        if r.ends_on and r.ends_on < today and not await rounds.standing_counts(session, r.id):
            add(CsmKind.COUNTS_MISSING, Severity.AMBER, r.name, f"Ended {r.ends_on:%d %b} with no counts entered", None, "round", r.id)
        if r.starts_on and today <= r.starts_on <= today + timedelta(days=READINESS_LOOKAHEAD_DAYS):
            gate = await session.scalar(select(Checklist).where(Checklist.round_id == r.id, Checklist.kind == "readiness"))
            if gate is not None and gate.status not in (ChecklistStatus.READY.value, ChecklistStatus.DONE.value):
                add(CsmKind.READINESS_INCOMPLETE, Severity.AMBER, f"{r.name} readiness",
                    f"Starts {r.starts_on:%d %b} and the readiness checklist isn't ready", gate.updated_at, "checklist", gate.id)

    if program.stage_label in ACTIVE_STAGES:
        latest = await session.scalar(
            select(ProgramNote.created_at).where(ProgramNote.ticket_id == tid, ProgramNote.kind == "update")
            .order_by(ProgramNote.created_at.desc()).limit(1)
        )
        if latest is None or latest.date() < today:
            age = (today - latest.date()).days if latest else None
            add(CsmKind.UPDATE_DUE, Severity.AMBER if age is None or age > STALE_UPDATE_DAYS else Severity.INFO,
                "Daily update", "No update has been posted" if age is None else f"Last update {age} day(s) ago", latest, None, None)
        cfg = await session.get(ProgramRegistrationSettings, tid)
        if cfg is None or not cfg.slack_channel_id:
            add(CsmKind.SLACK_UNLINKED, Severity.INFO, "No Slack channel linked", "Reminders and summaries can't be posted", None, None, None)

    for dep in await dependencies.list_for(session, tid):
        delay = dependencies.delay_days(dep, today)
        if delay > 0:
            add(CsmKind.DEPENDENCY_OVERDUE, Severity.CRITICAL if delay > CRITICAL_DEPENDENCY_DELAY_DAYS else Severity.AMBER,
                dep.title, f"{delay} day(s) overdue" + (f", owed by {dep.client_owner}" if dep.client_owner else ""),
                None, "dependency", dep.id)

    for comm in (
        await session.scalars(
            select(ParticipantComm).where(
                ParticipantComm.ticket_id == tid, ParticipantComm.status == CommStatus.PLANNED.value, ParticipantComm.planned_for < now
            )
        )
    ).all():
        add(CsmKind.COMM_OVERDUE, Severity.AMBER, f"{comm.kind.capitalize()} for {comm.audience}",
            f"Planned for {comm.planned_for:%d %b %H:%M} and not marked sent", comm.planned_for, "communication", comm.id)

    for change in (
        await session.scalars(select(TimelineChange).where(TimelineChange.ticket_id == tid, TimelineChange.status == "proposed"))
    ).all():
        add(CsmKind.CHANGE_AWAITING_APPROVAL, Severity.AMBER, f"{change.label}: {change.field.replace('_', ' ')} to {change.revised:%d %b}",
            f"Proposed by {change.proposed_by_name}: {change.reason}", change.created_at, "change", change.id)

    return out


def sort_items(items: list[CsmItem]) -> list[CsmItem]:
    far = datetime.max.replace(tzinfo=timezone.utc)
    return sorted(items, key=lambda i: (SEVERITY_ORDER[i.severity], i.since or far))
