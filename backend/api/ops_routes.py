"""Program operations: client dependencies, participant communications, timeline changes, the report, closure,
health and who is assigned to a program."""

from __future__ import annotations

import datetime as dt
from dataclasses import asdict
from enum import StrEnum

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit, changes, checklists, communications, dependencies
from core.access import Access, require_permission
from core.changes import ChangeStatus, SubjectType
from core.checklists import Phase
from core.communications import CommKind, CommStatus
from core.database import get_session
from core.deps import program_or_404
from core.dependencies import DependencyKind, DependencyStatus
from core.errors import DomainError
from core.needs import NeedsItem, needs_for
from core.health import Health, evaluate, facts_for
from core.orm import (
    ClientDependency,
    ParticipantComm,
    Program,
    ProgramAssignment,
    TimelineChange,
    TimelineChangeTask,
    User,
)
from core.permissions import Permission
from core.report import ClosureOut, ReportOut, build_closure, build_report

router = APIRouter(
    prefix="/programs/{ticket_id}",
    tags=["operations"],
    dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW)), Depends(program_or_404)],
)

_MANAGE = Depends(require_permission(Permission.REQUEST_MANAGE))


# ---- client dependencies -----------------------------------------------------


class DependencyIn(BaseModel):
    title: str = Field(min_length=1)
    kind: DependencyKind = DependencyKind.INPUT
    client_owner: str | None = None
    owner_id: str | None = None
    due_on: dt.date | None = None
    blocks_phase: Phase | None = None
    blocks_round_id: int | None = None
    notes: str | None = None


class DependencyPatch(BaseModel):
    """Only the fields present in the request are changed."""

    title: str | None = Field(default=None, min_length=1)
    kind: DependencyKind | None = None
    client_owner: str | None = None
    owner_id: str | None = None
    due_on: dt.date | None = None
    status: DependencyStatus | None = None
    blocks_phase: Phase | None = None
    blocks_round_id: int | None = None
    notes: str | None = None


class DependencyOut(BaseModel):
    id: int
    title: str
    kind: DependencyKind
    client_owner: str | None
    owner_id: str | None
    owner_name: str | None
    due_on: dt.date | None
    status: DependencyStatus
    blocks_phase: str | None
    blocks_round_id: int | None
    notes: str | None
    received_at: dt.datetime | None
    overdue: bool  # derived from the due date and today
    delay_days: int  # derived; 0 unless open and past due


class ImpactOut(BaseModel):
    open: int
    overdue: int
    max_delay_days: int
    projected_slip_days: int
    blocked_phases: list[str]
    blocked_round_ids: list[int]


class DependenciesOut(BaseModel):
    items: list[DependencyOut]
    impact: ImpactOut


def _dep_out(dep: ClientDependency, today: dt.date) -> DependencyOut:
    delay = dependencies.delay_days(dep, today)
    return DependencyOut(
        id=dep.id, title=dep.title, kind=DependencyKind(dep.kind), client_owner=dep.client_owner, owner_id=dep.owner_id,
        owner_name=dep.owner_name, due_on=dep.due_on, status=DependencyStatus(dep.status), blocks_phase=dep.blocks_phase,
        blocks_round_id=dep.blocks_round_id, notes=dep.notes, received_at=dep.received_at, overdue=delay > 0, delay_days=delay,
    )


def _today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


@router.get("/dependencies", response_model=DependenciesOut)
async def list_dependencies(ticket_id: str, session: AsyncSession = Depends(get_session)) -> DependenciesOut:
    rows = await dependencies.list_for(session, ticket_id)
    today = _today()
    return DependenciesOut(
        items=[_dep_out(d, today) for d in rows], impact=ImpactOut(**asdict(dependencies.impact(rows, today)))
    )


@router.post("/dependencies", status_code=201, response_model=DependencyOut)
async def add_dependency(
    ticket_id: str, body: DependencyIn, session: AsyncSession = Depends(get_session), access: Access = _MANAGE
) -> DependencyOut:
    dep = await dependencies.create(session, access.user, ticket_id, **body.model_dump())
    await session.commit()
    return _dep_out(dep, _today())


@router.patch("/dependencies/{dependency_id}", response_model=DependencyOut)
async def patch_dependency(
    ticket_id: str, dependency_id: int, body: DependencyPatch,
    session: AsyncSession = Depends(get_session), access: Access = _MANAGE,
) -> DependencyOut:
    dep = await dependencies.get(session, ticket_id, dependency_id)
    await dependencies.update(session, access.user, dep, body.model_dump(exclude_unset=True))
    await session.commit()
    return _dep_out(dep, _today())


# ---- participant communications ----------------------------------------------------


class CommIn(BaseModel):
    kind: CommKind
    audience: str = Field(min_length=1)
    planned_for: dt.datetime
    round_id: int | None = None
    recipients: int | None = Field(default=None, ge=0)
    owner_id: str | None = None
    notes: str | None = None


class CommPatch(BaseModel):
    """Only the fields present in the request are changed. Setting status to sent stamps sent_at unless given."""

    kind: CommKind | None = None
    audience: str | None = Field(default=None, min_length=1)
    planned_for: dt.datetime | None = None
    sent_at: dt.datetime | None = None
    round_id: int | None = None
    recipients: int | None = Field(default=None, ge=0)
    status: CommStatus | None = None
    owner_id: str | None = None
    notes: str | None = None


class CommOut(BaseModel):
    id: int
    kind: CommKind
    audience: str
    round_id: int | None
    planned_for: dt.datetime
    sent_at: dt.datetime | None
    recipients: int | None
    status: CommStatus
    owner_name: str | None
    notes: str | None
    overdue: bool


def _comm_out(comm: ParticipantComm) -> CommOut:
    return CommOut(
        id=comm.id, kind=CommKind(comm.kind), audience=comm.audience, round_id=comm.round_id, planned_for=comm.planned_for,
        sent_at=comm.sent_at, recipients=comm.recipients, status=CommStatus(comm.status), owner_name=comm.owner_name,
        notes=comm.notes, overdue=communications.is_overdue(comm),
    )


@router.get("/communications", response_model=list[CommOut])
async def list_communications(
    ticket_id: str, round_id: int | None = None, status: CommStatus | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[CommOut]:
    return [_comm_out(c) for c in await communications.list_for(session, ticket_id, round_id=round_id, status=status)]


@router.post("/communications", status_code=201, response_model=CommOut)
async def plan_communication(
    ticket_id: str, body: CommIn, session: AsyncSession = Depends(get_session), access: Access = _MANAGE
) -> CommOut:
    comm = await communications.create(session, access.user, ticket_id, **body.model_dump())
    await session.commit()
    return _comm_out(comm)


@router.patch("/communications/{comm_id}", response_model=CommOut)
async def patch_communication(
    ticket_id: str, comm_id: int, body: CommPatch, session: AsyncSession = Depends(get_session), access: Access = _MANAGE
) -> CommOut:
    comm = await communications.get(session, ticket_id, comm_id)
    await communications.update(session, access.user, comm, body.model_dump(exclude_unset=True))
    await session.commit()
    return _comm_out(comm)


# ---- timeline changes ----------------------------------------------------------------


class ChangeIn(BaseModel):
    subject_type: SubjectType
    subject_id: str  # a round id, a phase key (e.g. "launch_readiness") or an activity id
    field: str  # starts_on, ends_on, due_on or planned_date
    revised: dt.date
    reason: str = Field(min_length=1)
    tasks: list[str] = []  # downstream tasks to open once approved, besides the ones found automatically


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    label: str
    ref_type: str | None
    ref_id: str | None
    done: bool
    done_by_name: str | None
    done_at: dt.datetime | None


class ChangeOut(BaseModel):
    id: int
    subject_type: SubjectType
    subject_id: str
    label: str
    field: str
    original: dt.date | None
    revised: dt.date
    reason: str
    status: ChangeStatus
    proposed_by_name: str
    decided_by_name: str | None
    decided_at: dt.datetime | None
    created_at: dt.datetime
    tasks: list[TaskOut]


class TaskPatch(BaseModel):
    done: bool


def _change_out(change: TimelineChange, tasks: list[TimelineChangeTask]) -> ChangeOut:
    return ChangeOut(
        id=change.id, subject_type=SubjectType(change.subject_type), subject_id=change.subject_id, label=change.label,
        field=change.field, original=change.original, revised=change.revised, reason=change.reason,
        status=ChangeStatus(change.status), proposed_by_name=change.proposed_by_name,
        decided_by_name=change.decided_by_name, decided_at=change.decided_at, created_at=change.created_at,
        tasks=[TaskOut.model_validate(t) for t in tasks],
    )


@router.get("/timeline-changes", response_model=list[ChangeOut])
async def list_changes(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[ChangeOut]:
    return [_change_out(c, t) for c, t in await changes.list_for(session, ticket_id)]


@router.post("/timeline-changes", status_code=201, response_model=ChangeOut)
async def propose_change(
    ticket_id: str,
    body: ChangeIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REQUEST_CREATE)),
) -> ChangeOut:
    """Anyone internal can propose; only a CSM approves."""
    change = await changes.propose(session, access.user, ticket_id, **body.model_dump())
    await session.commit()
    return _change_out(change, await changes.tasks_of(session, change.id))


@router.post("/timeline-changes/{change_id}/approve", response_model=ChangeOut)
async def approve_change(
    ticket_id: str, change_id: int, session: AsyncSession = Depends(get_session), access: Access = _MANAGE
) -> ChangeOut:
    change = await changes.approve(session, access.user, await changes.get(session, ticket_id, change_id))
    await session.commit()
    return _change_out(change, await changes.tasks_of(session, change.id))


@router.post("/timeline-changes/{change_id}/reject", response_model=ChangeOut)
async def reject_change(
    ticket_id: str, change_id: int, session: AsyncSession = Depends(get_session), access: Access = _MANAGE
) -> ChangeOut:
    change = await changes.reject(session, access.user, await changes.get(session, ticket_id, change_id))
    await session.commit()
    return _change_out(change, await changes.tasks_of(session, change.id))


@router.patch("/timeline-changes/{change_id}/tasks/{task_id}", response_model=ChangeOut)
async def patch_change_task(
    ticket_id: str, change_id: int, task_id: int, body: TaskPatch,
    session: AsyncSession = Depends(get_session), access: Access = _MANAGE,
) -> ChangeOut:
    change = await changes.get(session, ticket_id, change_id)
    await changes.set_task(session, access.user, change, task_id, done=body.done)
    await session.commit()
    return _change_out(change, await changes.tasks_of(session, change.id))


# ---- report, closure, health ---------------------------------------------------------


@router.get("/report", response_model=ReportOut)
async def get_report(ticket_id: str, session: AsyncSession = Depends(get_session)) -> ReportOut:
    """One view: registrations, relevant registrations, participation, submissions, shortlisting conversion,
    drop-offs, marketing control and operational health."""
    await checklists.ensure_lifecycle(session, ticket_id)
    await session.commit()
    return await build_report(session, ticket_id)


@router.get("/closure", response_model=ClosureOut)
async def get_closure(ticket_id: str, session: AsyncSession = Depends(get_session)) -> ClosureOut:
    """What is still outstanding before the program can close."""
    closure = await build_closure(session, ticket_id)
    await session.commit()
    return closure


class HealthOut(BaseModel):
    health: Health
    reasons: list[str]
    facts: dict[str, int | str | None]


@router.get("/needs", response_model=list[NeedsItem])
async def get_needs(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[NeedsItem]:
    """What needs a person on this program today: merged, grouped and ordered by urgency."""
    program = await session.get(Program, ticket_id)
    return await needs_for(session, program) if program else []


@router.get("/health", response_model=HealthOut)
async def get_health(ticket_id: str, session: AsyncSession = Depends(get_session)) -> HealthOut:
    facts = await facts_for(session, ticket_id)
    result = evaluate(facts)
    return HealthOut(health=result.health, reasons=list(result.reasons), facts=asdict(facts))


# ---- assignments ------------------------------------------------------------------


class AssignmentRole(StrEnum):
    CSM = "csm"
    MARKETING = "marketing"
    ACCOUNT_MANAGER = "account_manager"


class AssignmentIn(BaseModel):
    user_id: str
    role: AssignmentRole


class AssignmentOut(BaseModel):
    user_id: str
    name: str
    role: AssignmentRole


async def _assignments(session: AsyncSession, ticket_id: str) -> list[AssignmentOut]:
    rows = await session.execute(
        select(ProgramAssignment.user_id, ProgramAssignment.role, User.name, User.email)
        .join(User, User.id == ProgramAssignment.user_id)
        .where(ProgramAssignment.ticket_id == ticket_id)
        .order_by(ProgramAssignment.role, User.email)
    )
    return [AssignmentOut(user_id=u, name=name or email, role=AssignmentRole(role)) for u, role, name, email in rows.all()]


@router.get("/assignments", response_model=list[AssignmentOut])
async def list_assignments(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[AssignmentOut]:
    return await _assignments(session, ticket_id)


@router.put("/assignments", response_model=list[AssignmentOut])
async def put_assignments(
    ticket_id: str,
    body: list[AssignmentIn],
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.USERS_MANAGE)),
) -> list[AssignmentOut]:
    """Replace who works this program (super admin). Adds to the HubSpot CSM match in "my programs" in the queues."""
    for user_id in {a.user_id for a in body}:
        if await session.get(User, user_id) is None:
            raise DomainError("user_not_found", "One of those people isn't a portal user.", 422)
    before = await _assignments(session, ticket_id)
    await session.execute(delete(ProgramAssignment).where(ProgramAssignment.ticket_id == ticket_id))
    session.add_all(
        ProgramAssignment(ticket_id=ticket_id, user_id=user_id, role=role)
        for user_id, role in sorted({(a.user_id, a.role.value) for a in body})
    )
    audit.record(
        session, access.user, entity="assignments", entity_id=ticket_id, ticket_id=ticket_id, action="assignments_changed",
        old=[{"user": a.name, "role": a.role.value} for a in before], new=[{"user_id": a.user_id, "role": a.role.value} for a in body],
    )
    await session.commit()
    return await _assignments(session, ticket_id)
