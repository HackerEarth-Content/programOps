"""Work queues: what needs a person's attention, across programs."""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta, timezone
from enum import StrEnum

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import csm_queue
from core.access import Access, current_access, require_permission
from core.activities import ActivityStatus
from core.csm_queue import CsmItem, CsmKind, Severity
from core.database import get_session
from core.orm import ActivityMetric, Program, ProgramActivity, ProgramAssignment
from core.permissions import Permission

router = APIRouter(
    prefix="/queues", tags=["queues"], dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW))]
)


class MarketingKind(StrEnum):
    GO_LIVE_DUE = "go_live_due"  # approved, and its planned date is today or past
    READY_TO_GO_LIVE = "ready_to_go_live"  # approved, UTM in place, not due yet
    MISSING_UTM_OR_PROOF = "missing_utm_or_proof"
    AWAITING_APPROVAL = "awaiting_approval"  # marketing marked it WIP: ready for the CSM to review
    RESULTS_TO_RECORD = "results_to_record"  # live, and yesterday's views and clicks aren't logged
    TO_PREPARE = "to_prepare"  # not started, still needs a UTM or go-live date; info only, so it never inflates a badge


class QueueItem(BaseModel):
    id: str
    kind: MarketingKind
    severity: Severity
    ticket_id: str
    program_name: str
    client: str | None
    title: str
    detail: str
    since: datetime | None
    activity_id: int


class QueueOut(BaseModel):
    counts: dict[MarketingKind, int]
    items: list[QueueItem]


_SEVERITY_ORDER = csm_queue.SEVERITY_ORDER


class CsmQueueOut(BaseModel):
    counts: dict[CsmKind, int]
    items: list[CsmItem]


def _kinds(activity: ProgramActivity, today: date, logged_yesterday: bool) -> list[tuple[MarketingKind, Severity, str]]:
    """Every queue an activity belongs to. An activity can sit in more than one (e.g. waiting for
    approval and missing its UTM)."""
    if activity.status == ActivityStatus.OFF:
        return []
    found: list[tuple[MarketingKind, Severity, str]] = []
    yesterday = today - timedelta(days=1)
    if (
        activity.status == ActivityStatus.LIVE and not logged_yesterday
        and activity.go_live_at is not None and activity.go_live_at.date() <= yesterday
    ):
        found.append((MarketingKind.RESULTS_TO_RECORD, Severity.AMBER, f"Log views and clicks for {yesterday:%d %b}"))
    waiting = activity.status in (ActivityStatus.NOT_STARTED, ActivityStatus.WIP)
    if activity.approved_at is not None and waiting:
        if activity.planned_date is not None and activity.planned_date <= today:
            found.append(
                (MarketingKind.GO_LIVE_DUE, Severity.CRITICAL, f"Planned for {activity.planned_date:%d %b}; approved, not live")
            )
        elif activity.utm:
            found.append((MarketingKind.READY_TO_GO_LIVE, Severity.INFO, f"Approved by {activity.approved_by_name}"))
    if activity.approved_at is None and activity.status == ActivityStatus.WIP:
        found.append((MarketingKind.AWAITING_APPROVAL, Severity.AMBER, "Waiting for a CSM to approve"))
    missing = [
        name for name, value in (("UTM", activity.utm), ("go-live date", activity.planned_date), ("creative proof", activity.creative_proof_url)) if not value
    ]
    in_motion = activity.status != ActivityStatus.NOT_STARTED or activity.approved_at is not None
    if missing and in_motion:  # a plan row nobody has touched yet isn't a blocker; it would flood the queue
        found.append((MarketingKind.MISSING_UTM_OR_PROOF, Severity.AMBER, f"Missing {' and '.join(missing)}"))
    elif not in_motion and (setup := [n for n in missing if n != "creative proof"]):
        found.append((MarketingKind.TO_PREPARE, Severity.INFO, f"Needs {' and '.join(setup)} before it can start"))
    return found


@router.get("/marketing", response_model=QueueOut)
async def marketing_queue(program: str | None = None, session: AsyncSession = Depends(get_session)) -> QueueOut:
    """Marketing work across active programs. Optional `program` (ticket id) narrows it to one."""
    stmt = (
        select(ProgramActivity, Program)
        .join(Program, Program.ticket_id == ProgramActivity.ticket_id)
        .where(Program.stage_label != "Closed")
    )
    if program is not None:
        stmt = stmt.where(ProgramActivity.ticket_id == program)

    today = datetime.now(timezone.utc).date()
    logged = set(
        (await session.scalars(select(ActivityMetric.activity_id).where(ActivityMetric.date == today - timedelta(days=1)))).all()
    )
    items: list[QueueItem] = []
    for activity, prog in (await session.execute(stmt)).all():
        for kind, severity, detail in _kinds(activity, today, activity.id in logged):
            items.append(
                QueueItem(
                    id=f"{kind.value}:{activity.id}",
                    kind=kind,
                    severity=severity,
                    ticket_id=prog.ticket_id,
                    program_name=prog.display_name,
                    client=prog.company_name,
                    title=f"{activity.code} {activity.title}",
                    detail=detail,
                    since=activity.updated_at,
                    activity_id=activity.id,
                )
            )
    items.sort(key=lambda i: (_SEVERITY_ORDER[i.severity], i.since or datetime.max.replace(tzinfo=timezone.utc)))
    counts = Counter(i.kind for i in items)
    return QueueOut(counts={kind: counts.get(kind, 0) for kind in MarketingKind}, items=items)


class Scope(StrEnum):
    MINE = "mine"  # programs the signed-in user is assigned to as a CSM
    ALL = "all"


@router.get("/csm", response_model=CsmQueueOut)
async def csm_queue_view(
    scope: Scope = Scope.MINE,
    kind: CsmKind | None = None,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(current_access),
) -> CsmQueueOut:
    """What needs a CSM today. `scope=mine` is the programs where you are the CSM on the HubSpot ticket (matched by email) or are assigned as CSM (PUT /programs/{id}/assignments);
    `scope=all` is every program that isn't closed."""
    stmt = select(Program).where(Program.stage_label != "Closed")
    if scope == Scope.MINE:
        stmt = stmt.where(
            or_(
                Program.ticket_id.in_(
                    select(ProgramAssignment.ticket_id).where(ProgramAssignment.user_id == access.user.id, ProgramAssignment.role == "csm")
                ),
                # the CSM named on the HubSpot ticket, matched by email, so nobody has to assign themselves first
                func.lower(Program.csm_email) == access.user.email.lower(),
            )
        )
    now = datetime.now(timezone.utc)
    items: list[CsmItem] = []
    for program in (await session.scalars(stmt)).all():
        items.extend(await csm_queue.items_for(session, program, now))
    counts = Counter(i.kind for i in items)
    shown = csm_queue.sort_items([i for i in items if kind is None or i.kind == kind])
    return CsmQueueOut(counts={k: counts.get(k, 0) for k in CsmKind}, items=shown)
