"""Change management for the timeline: a recorded change to a planned date, with the original, the revised date, the
reason, who proposed it and who approved it. Approving applies the revised date to the round or activity and
opens the downstream tasks. The original date is never overwritten: it stays on the change record and in the audit trail.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone
from enum import StrEnum

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit, rounds
from core.communications import CommStatus
from core.errors import DomainError
from core.orm import (
    ParticipantComm,
    ProgramActivity,
    ProgramRound,
    TimelineChange,
    TimelineChangeTask,
    User,
)


class SubjectType(StrEnum):
    ROUND = "round"
    ACTIVITY = "activity"


class ChangeStatus(StrEnum):
    PROPOSED = "proposed"
    APPROVED = "approved"
    REJECTED = "rejected"


# Which date fields of each subject can be changed.
FIELDS: dict[SubjectType, frozenset[str]] = {
    SubjectType.ROUND: frozenset({"starts_on", "ends_on"}),
    SubjectType.ACTIVITY: frozenset({"planned_date"}),
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class _Subject:
    obj: ProgramRound | ProgramActivity
    label: str


async def _subject(session: AsyncSession, ticket_id: str, kind: SubjectType, subject_id: str) -> _Subject:
    missing = DomainError("subject_not_found", "That item isn't in this program.", 404)
    if kind == SubjectType.ROUND:
        row = await session.get(ProgramRound, int(subject_id)) if subject_id.isdigit() else None
        if row is None or row.ticket_id != ticket_id:
            raise missing
        return _Subject(row, row.name)
    row = await session.get(ProgramActivity, int(subject_id)) if subject_id.isdigit() else None
    if row is None or row.ticket_id != ticket_id:
        raise missing
    return _Subject(row, f"{row.code} {row.title}")


async def get(session: AsyncSession, ticket_id: str, change_id: int) -> TimelineChange:
    change = await session.get(TimelineChange, change_id)
    if change is None or change.ticket_id != ticket_id:
        raise DomainError("change_not_found", "Change not found.", 404)
    return change


async def tasks_of(session: AsyncSession, change_id: int) -> list[TimelineChangeTask]:
    rows = await session.scalars(select(TimelineChangeTask).where(TimelineChangeTask.change_id == change_id).order_by(TimelineChangeTask.id))
    return list(rows.all())


async def list_for(session: AsyncSession, ticket_id: str) -> list[tuple[TimelineChange, list[TimelineChangeTask]]]:
    changes = list(
        (await session.scalars(select(TimelineChange).where(TimelineChange.ticket_id == ticket_id).order_by(TimelineChange.id.desc()))).all()
    )
    return [(c, await tasks_of(session, c.id)) for c in changes]


async def propose(
    session: AsyncSession,
    actor: User,
    ticket_id: str,
    *,
    subject_type: SubjectType,
    subject_id: str,
    field: str,
    revised: date,
    reason: str,
    tasks: Sequence[str],
) -> TimelineChange:
    if field not in FIELDS[subject_type]:
        raise DomainError("field_not_changeable", f"A {subject_type.value}'s {field} can't be changed here.", 422)
    subject = await _subject(session, ticket_id, subject_type, subject_id)
    original = getattr(subject.obj, field)
    if original == revised:
        raise DomainError("change_is_noop", "The revised date is the same as the current one.", 422)
    change = TimelineChange(
        ticket_id=ticket_id, subject_type=subject_type.value, subject_id=subject_id, label=subject.label, field=field,
        original=original, revised=revised, reason=reason.strip(), proposed_by=actor.id,
        proposed_by_name=actor.name or actor.email,
    )
    session.add(change)
    await session.flush()
    session.add_all(TimelineChangeTask(change_id=change.id, label=t.strip()) for t in tasks if t.strip())
    audit.record(
        session, actor, entity="timeline_change", entity_id=str(change.id), ticket_id=ticket_id, action="change_proposed",
        old=original.isoformat() if original else None, new=revised.isoformat(), field=f"{subject_type.value}:{field}",
    )
    return change


async def _downstream_tasks(session: AsyncSession, change: TimelineChange) -> list[TimelineChangeTask]:
    """What a round's new dates put in question: its communications not yet sent."""
    if change.subject_type != SubjectType.ROUND:
        return []
    round_id = int(change.subject_id)
    tasks: list[TimelineChangeTask] = []
    for comm in (
        await session.scalars(
            select(ParticipantComm).where(ParticipantComm.round_id == round_id, ParticipantComm.status == CommStatus.PLANNED.value)
        )
    ).all():
        tasks.append(TimelineChangeTask(
            change_id=change.id, label=f"Re-time the {comm.kind} for {comm.audience}", ref_type="communication", ref_id=str(comm.id)))
    return tasks


async def approve(session: AsyncSession, actor: User, change: TimelineChange) -> TimelineChange:
    """Apply the revised date to its subject and open the downstream tasks."""
    if change.status != ChangeStatus.PROPOSED:
        raise DomainError("change_decided", f"This change was already {change.status}.")
    subject = await _subject(session, change.ticket_id, SubjectType(change.subject_type), change.subject_id)
    if isinstance(subject.obj, ProgramRound):
        ends = change.revised if change.field == "ends_on" else subject.obj.ends_on
        starts = change.revised if change.field == "starts_on" else subject.obj.starts_on
        rounds._check_dates(starts, ends)
    setattr(subject.obj, change.field, change.revised)
    if isinstance(subject.obj, ProgramActivity):
        subject.obj.updated_by, subject.obj.updated_at = actor.id, _now()  # an edited row is never dropped by a POA re-read
    session.add_all(await _downstream_tasks(session, change))
    change.status = ChangeStatus.APPROVED.value
    change.decided_by, change.decided_by_name, change.decided_at = actor.id, actor.name or actor.email, _now()
    audit.record(session, actor, entity="timeline_change", entity_id=str(change.id), ticket_id=change.ticket_id,
                 action="change_approved", new=change.revised.isoformat(), field=f"{change.subject_type}:{change.field}")
    return change


async def reject(session: AsyncSession, actor: User, change: TimelineChange) -> TimelineChange:
    if change.status != ChangeStatus.PROPOSED:
        raise DomainError("change_decided", f"This change was already {change.status}.")
    change.status = ChangeStatus.REJECTED.value
    change.decided_by, change.decided_by_name, change.decided_at = actor.id, actor.name or actor.email, _now()
    audit.record(session, actor, entity="timeline_change", entity_id=str(change.id), ticket_id=change.ticket_id,
                 action="change_rejected")
    return change


async def set_task(session: AsyncSession, actor: User, change: TimelineChange, task_id: int, *, done: bool) -> TimelineChangeTask:
    task = await session.get(TimelineChangeTask, task_id)
    if task is None or task.change_id != change.id:
        raise DomainError("task_not_found", "Task not found.", 404)
    task.done = done
    task.done_by_name, task.done_at = ((actor.name or actor.email), _now()) if done else (None, None)
    audit.record(session, actor, entity="timeline_change", entity_id=str(change.id), ticket_id=change.ticket_id,
                 action="task_done" if done else "task_reopened", field=task.label)
    return task
