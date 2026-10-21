"""Program health, computed from facts and never stored. `evaluate` is a pure function so the rules are easy to
read and test; `facts_for` gathers the facts for one program."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from enum import StrEnum

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import dependencies, rounds
from core.activities import ActivityStatus
from core.checklists import ChecklistKind, ChecklistStatus
from core.communications import CommStatus
from core.orm import (
    Checklist,
    ParticipantComm,
    ProgramActivity,
    ProgramNote,
    ProgramRound,
    TimelineChange,
)

CRITICAL_DEPENDENCY_DELAY_DAYS = 3  # a client dependency this far overdue makes the program critical
STALE_UPDATE_DAYS = 2  # no daily update for longer than this is a warning
READINESS_LOOKAHEAD_DAYS = 3  # a round starting this soon needs its readiness checklist ready


class Health(StrEnum):
    GOOD = "good"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass(frozen=True)
class HealthFacts:
    breaches: int = 0
    latest_update_health: str | None = None
    update_age_days: int | None = None  # None: no update has ever been posted (not counted against the program)
    overdue_requests: int = 0
    rounds_missing_counts: int = 0
    overdue_dependencies: int = 0
    max_dependency_delay_days: int = 0
    overdue_communications: int = 0
    changes_awaiting: int = 0
    readiness_incomplete: int = 0


@dataclass(frozen=True)
class HealthResult:
    health: Health
    reasons: tuple[str, ...]  # stable codes, critical ones first, for the UI to explain the colour


def evaluate(f: HealthFacts) -> HealthResult:
    critical = [
        code
        for code, hit in (
            ("control_breach", f.breaches > 0),
            ("update_critical", f.latest_update_health == "critical"),
            ("dependency_badly_overdue", f.max_dependency_delay_days > CRITICAL_DEPENDENCY_DELAY_DAYS),
        )
        if hit
    ]
    warning = [
        code
        for code, hit in (
            ("update_stale", f.update_age_days is not None and f.update_age_days > STALE_UPDATE_DAYS),
            ("update_warning", f.latest_update_health == "warning"),
            ("request_overdue", f.overdue_requests > 0),
            ("round_counts_missing", f.rounds_missing_counts > 0),
            ("dependency_overdue", f.overdue_dependencies > 0 and f.max_dependency_delay_days <= CRITICAL_DEPENDENCY_DELAY_DAYS),
            ("communication_overdue", f.overdue_communications > 0),
            ("readiness_incomplete", f.readiness_incomplete > 0),
            ("change_awaiting_approval", f.changes_awaiting > 0),
        )
        if hit
    ]
    health = Health.CRITICAL if critical else Health.WARNING if warning else Health.GOOD
    return HealthResult(health, tuple(critical + warning))


async def facts_for(session: AsyncSession, ticket_id: str, now: datetime | None = None) -> HealthFacts:
    now = now or datetime.now(timezone.utc)
    today: date = now.date()

    breaches = await session.scalar(
        select(func.count()).select_from(ProgramActivity).where(
            ProgramActivity.ticket_id == ticket_id,
            ProgramActivity.status == ActivityStatus.LIVE.value,
            ProgramActivity.approved_at.is_(None),
        )
    ) or 0

    latest = await session.scalar(
        select(ProgramNote).where(ProgramNote.ticket_id == ticket_id, ProgramNote.kind == "update")
        .order_by(ProgramNote.created_at.desc()).limit(1)
    )

    overdue_requests = await session.scalar(
        select(func.count()).select_from(Checklist).where(
            Checklist.ticket_id == ticket_id,
            Checklist.kind == ChecklistKind.REQUEST.value,
            Checklist.status.in_([ChecklistStatus.OPEN.value, ChecklistStatus.IN_PROGRESS.value, ChecklistStatus.READY.value]),
            Checklist.due_at.is_not(None),
            Checklist.due_at < now,
        )
    ) or 0

    program_rounds = await rounds.list_rounds(session, ticket_id)
    missing_counts = 0
    incomplete = 0
    for r in program_rounds:
        if r.ends_on and r.ends_on < today and not await rounds.standing_counts(session, r.id):
            missing_counts += 1
        if r.starts_on and today <= r.starts_on <= today + timedelta(days=READINESS_LOOKAHEAD_DAYS):
            gate = await session.scalar(select(Checklist).where(Checklist.round_id == r.id, Checklist.kind == "readiness"))
            if gate is not None and gate.status not in (ChecklistStatus.READY.value, ChecklistStatus.DONE.value):
                incomplete += 1

    deps = dependencies.impact(await dependencies.list_for(session, ticket_id), today)

    overdue_comms = await session.scalar(
        select(func.count()).select_from(ParticipantComm).where(
            ParticipantComm.ticket_id == ticket_id,
            ParticipantComm.status == CommStatus.PLANNED.value,
            ParticipantComm.planned_for < now,
        )
    ) or 0

    changes = await session.scalar(
        select(func.count()).select_from(TimelineChange).where(
            TimelineChange.ticket_id == ticket_id, TimelineChange.status == "proposed"
        )
    ) or 0

    return HealthFacts(
        breaches=breaches,
        latest_update_health=latest.health if latest else None,
        update_age_days=(today - latest.created_at.date()).days if latest else None,
        overdue_requests=overdue_requests,
        rounds_missing_counts=missing_counts,
        overdue_dependencies=deps.overdue,
        max_dependency_delay_days=deps.max_delay_days,
        overdue_communications=overdue_comms,
        changes_awaiting=changes,
        readiness_incomplete=incomplete,
    )


async def health_of(session: AsyncSession, ticket_id: str) -> HealthResult:
    return evaluate(await facts_for(session, ticket_id))
