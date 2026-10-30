"""A program's marketing plan: list, edit, add a channel, CSM approval, go-live, re-read the POA."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, ConfigDict, Field, computed_field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dataclasses import asdict

from core import activities, metrics, slack_outbox
from core.access import Access, require_permission
from core.activities import ActivitySource, ActivityStatus
from core.database import get_session
from core.deps import program_or_404 as _program
from core.errors import DomainError
from core.orm import ProgramActivity, ProgramAssignment, ProgramDocument, User
from core.permissions import Permission

router = APIRouter(
    prefix="/programs/{ticket_id}",
    tags=["marketing"],
    dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW))],
)


class ActivityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    ticket_id: str
    source: ActivitySource
    week: int | None
    channel: str
    title: str
    action: str | None
    audience: str | None
    outcome: str | None
    hook: str | None
    target_note: str | None
    planned_date: date | None
    status: ActivityStatus
    approved_by_name: str | None
    approved_at: datetime | None
    go_live_at: datetime | None
    comes_off_at: datetime | None
    utm: str | None
    creative_proof_url: str | None
    tracker_ref: str | None
    updated_at: datetime  # send back as If-Match to detect a concurrent edit

    @computed_field  # type: ignore[prop-decorator]
    @property
    def breach(self) -> bool:
        return self.status == ActivityStatus.LIVE and self.approved_at is None


class SummaryOut(BaseModel):
    total: int
    live: int
    approved: int
    awaiting_approval: int
    breaches: int
    ramp_pct: float


class SeedOut(BaseModel):
    added: int
    removed: int
    edits_kept: int


class ChannelIn(BaseModel):
    channel: str = Field(min_length=1)
    title: str = Field(min_length=1)
    week: int | None = None
    action: str | None = None
    audience: str | None = None
    outcome: str | None = None
    hook: str | None = None
    target_note: str | None = None
    planned_date: date | None = None


class ActivityPatch(BaseModel):
    """Only the fields present in the request are changed."""

    title: str | None = Field(default=None, min_length=1)
    action: str | None = None
    audience: str | None = None
    outcome: str | None = None
    hook: str | None = None
    target_note: str | None = None
    planned_date: date | None = None
    status: ActivityStatus | None = None
    go_live_at: datetime | None = None
    comes_off_at: datetime | None = None
    utm: str | None = None
    creative_proof_url: str | None = None
    tracker_ref: str | None = None


class GoLiveIn(BaseModel):
    go_live_at: datetime | None = None  # default: now


IfMatch = Annotated[datetime | None, Header(description="The activity's updated_at, to detect a concurrent edit")]


@router.get("/activities", response_model=list[ActivityOut], dependencies=[Depends(_program)])
async def list_activities(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[ProgramActivity]:
    return await activities.list_for(session, ticket_id)


@router.get("/activities/summary", response_model=SummaryOut, dependencies=[Depends(_program)])
async def activities_summary(ticket_id: str, session: AsyncSession = Depends(get_session)) -> SummaryOut:
    return SummaryOut(**vars(activities.summarize(await activities.list_for(session, ticket_id))))


@router.post("/activities", status_code=201, response_model=ActivityOut, dependencies=[Depends(_program)])
async def add_channel(
    ticket_id: str,
    body: ChannelIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ACTIVITY_ADD_CHANNEL)),
) -> ProgramActivity:
    activity = await activities.add_channel(
        session, access.user, ticket_id,
        channel=body.channel, title=body.title, fields=body.model_dump(exclude={"channel", "title"}),
    )
    await session.commit()
    return activity


@router.patch("/activities/{activity_id}", response_model=ActivityOut)
async def patch_activity(
    ticket_id: str,
    activity_id: int,
    body: ActivityPatch,
    if_match: IfMatch = None,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ACTIVITY_EDIT)),
) -> ProgramActivity:
    activity = await activities.get(session, ticket_id, activity_id)
    await activities.update(
        session, access.user, activity, body.model_dump(exclude_unset=True), expected_updated_at=if_match
    )
    await session.commit()
    return activity


@router.post("/activities/{activity_id}/go-live", response_model=ActivityOut)
async def go_live(
    ticket_id: str,
    activity_id: int,
    body: GoLiveIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ACTIVITY_EDIT)),
) -> ProgramActivity:
    """Same rules as PATCH status=live: an approval and a UTM are required."""
    activity = await activities.get(session, ticket_id, activity_id)
    changes: dict[str, object] = {"status": ActivityStatus.LIVE}
    if body.go_live_at is not None:
        changes["go_live_at"] = body.go_live_at
    await activities.update(session, access.user, activity, changes)
    await session.commit()
    return activity


class NudgeOut(BaseModel):
    queued: bool  # false when the program has no Slack channel (the message is recorded as skipped)
    recipients: list[str]


@router.post("/activities/nudge-approvals", status_code=202, response_model=NudgeOut)
async def nudge_all_for_approval(
    ticket_id: str,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ACTIVITY_EDIT)),
) -> NudgeOut:
    """One Slack message asking the program's CSM(s) to approve everything still waiting (not one per activity).
    At most one per program per hour."""
    # Only what marketing has marked ready (WIP) is waiting on the CSM: the same rule as the CSM queue and reminders.
    waiting = [
        a for a in await activities.list_for(session, ticket_id)
        if a.approved_at is None and a.status == activities.ActivityStatus.WIP
    ]
    if not waiting:
        raise DomainError("nothing_to_nudge", "Nothing is marked ready for approval yet. Set an activity to WIP first.", 409)
    csms = (
        await session.scalars(
            select(User.name).join(ProgramAssignment, ProgramAssignment.user_id == User.id)
            .where(ProgramAssignment.ticket_id == ticket_id, ProgramAssignment.role == "csm")
        )
    ).all()
    who = list(csms) or ["the CSM"]
    plural = "activity is" if len(waiting) == 1 else "activities are"
    message = await slack_outbox.enqueue(
        session, ticket_id=ticket_id, kind="nudge",
        body=f":bell: {', '.join(who)}: {len(waiting)} marketing {plural} waiting for your approval (nudged by {access.user.name or access.user.email})",
        dedupe_key=f"nudge:all:{ticket_id}:{datetime.now(timezone.utc):%Y%m%d%H}",
    )
    if message is None:
        raise DomainError("nudge_too_soon", "The CSM was already nudged this hour.", 429)
    await session.commit()
    return NudgeOut(queued=message.status == "queued", recipients=who)


@router.post("/activities/{activity_id}/nudge", status_code=202, response_model=NudgeOut)
async def nudge_for_approval(
    ticket_id: str,
    activity_id: int,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ACTIVITY_EDIT)),
) -> NudgeOut:
    """Ask the program's CSM(s) in Slack to approve this activity. At most one nudge per activity per hour."""
    activity = await activities.get(session, ticket_id, activity_id)
    if activity.approved_at is not None:
        raise DomainError("nothing_to_nudge", "This activity is already approved.", 409)
    if activity.status != activities.ActivityStatus.WIP:
        raise DomainError("nothing_to_nudge", "Set the activity to WIP (ready for review) before asking for approval.", 409)
    csms = (
        await session.scalars(
            select(User.name).join(ProgramAssignment, ProgramAssignment.user_id == User.id)
            .where(ProgramAssignment.ticket_id == ticket_id, ProgramAssignment.role == "csm")
        )
    ).all()
    who = list(csms) or ["the CSM"]
    message = await slack_outbox.enqueue(
        session, ticket_id=ticket_id, kind="nudge",
        body=f":bell: {', '.join(who)}: *{activity.code} {activity.title}* is waiting for your approval (nudged by {access.user.name or access.user.email})",
        dedupe_key=f"nudge:{activity.id}:{datetime.now(timezone.utc):%Y%m%d%H}",
    )
    if message is None:
        raise DomainError("nudge_too_soon", "This activity was already nudged this hour.", 429)
    await session.commit()
    return NudgeOut(queued=message.status == "queued", recipients=who)


@router.post("/activities/{activity_id}/approve", response_model=ActivityOut)
async def approve_activity(
    ticket_id: str,
    activity_id: int,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ACTIVITY_APPROVE)),
) -> ProgramActivity:
    activity = await activities.approve(session, access.user, await activities.get(session, ticket_id, activity_id))
    await session.commit()
    return activity


@router.delete("/activities/{activity_id}/approve", response_model=ActivityOut)
async def withdraw_approval(
    ticket_id: str,
    activity_id: int,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ACTIVITY_APPROVE)),
) -> ProgramActivity:
    activity = await activities.withdraw(session, access.user, await activities.get(session, ticket_id, activity_id))
    await session.commit()
    return activity


@router.post(
    "/plan/reread",
    response_model=SeedOut,
    dependencies=[Depends(_program), Depends(require_permission(Permission.INTEGRATIONS_LINK))],
)
async def reread_plan(ticket_id: str, session: AsyncSession = Depends(get_session)) -> SeedOut:
    """Re-seed the plan from the POA already extracted for this program. Nobody's edits are touched."""
    details = await session.scalar(
        select(ProgramDocument.details).where(ProgramDocument.ticket_id == ticket_id, ProgramDocument.kind == "poa")
    )
    if not details:
        raise DomainError("poa_missing", "This program has no extracted plan of action yet.", 404)
    result = await activities.seed_from_poa(session, ticket_id, details)
    await session.commit()
    return SeedOut(**vars(result))


# ---- views, clicks and sends ---------------------------------------------------


class MetricsIn(BaseModel):
    date: date
    views: int | None = Field(default=None, ge=0)
    clicks: int | None = Field(default=None, ge=0)
    sent: int | None = Field(default=None, ge=0)  # for email-style activities
    opens: int | None = Field(default=None, ge=0)


class MetricTotalsOut(BaseModel):
    views: int
    clicks: int
    sent: int
    opens: int
    ctr: float | None  # clicks over views, or over sends when there are no views
    open_rate: float | None


class MetricDayOut(BaseModel):
    date: date
    views: int | None
    clicks: int | None
    sent: int | None
    opens: int | None
    ctr: float | None
    open_rate: float | None
    entered_by_name: str
    entered_at: datetime


class MetricsOut(BaseModel):
    days: list[MetricDayOut]
    totals: MetricTotalsOut


class SeriesPointOut(BaseModel):
    date: date
    views: int
    clicks: int
    sent: int
    opens: int
    ctr: float | None


class ChannelMetricsOut(BaseModel):
    channel: str
    activities: int
    totals: MetricTotalsOut
    series: list[SeriesPointOut]


def _metrics_out(rows: list) -> MetricsOut:
    return MetricsOut(
        days=[
            MetricDayOut(
                date=r.date, views=r.views, clicks=r.clicks, sent=r.sent, opens=r.opens,
                ctr=metrics.ctr(r.views, r.sent, r.clicks), open_rate=metrics.open_rate(r.sent, r.opens),
                entered_by_name=r.entered_by_name, entered_at=r.entered_at,
            )
            for r in rows
        ],
        totals=MetricTotalsOut(**asdict(metrics.totals(rows))),
    )


@router.get("/activities/{activity_id}/metrics", response_model=MetricsOut)
async def get_metrics(ticket_id: str, activity_id: int, session: AsyncSession = Depends(get_session)) -> MetricsOut:
    await activities.get(session, ticket_id, activity_id)
    return _metrics_out(await metrics.list_for(session, activity_id))


@router.put("/activities/{activity_id}/metrics", response_model=MetricsOut)
async def put_metrics(
    ticket_id: str,
    activity_id: int,
    body: MetricsIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.METRICS_ENTER)),
) -> MetricsOut:
    """Record (or replace) one day's views, clicks, sends and opens. Only for an activity that has gone live."""
    activity = await activities.get(session, ticket_id, activity_id)
    await metrics.put_day(
        session, access.user, activity, day=body.date, views=body.views, clicks=body.clicks, sent=body.sent, opens=body.opens
    )
    await session.commit()
    return _metrics_out(await metrics.list_for(session, activity_id))


@router.get("/metrics/channels", response_model=list[ChannelMetricsOut], dependencies=[Depends(_program)])
async def channel_metrics(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[ChannelMetricsOut]:
    """Totals and a daily trend per channel (email, social, community...), across the program's activities."""
    out: list[ChannelMetricsOut] = []
    for channel, (count, rows) in (await metrics.by_channel(session, ticket_id)).items():
        by_day: dict[date, list] = {}
        for r in rows:
            by_day.setdefault(r.date, []).append(r)
        series = []
        for day, day_rows in sorted(by_day.items()):
            t = metrics.totals(day_rows)
            series.append(SeriesPointOut(date=day, views=t.views, clicks=t.clicks, sent=t.sent, opens=t.opens, ctr=t.ctr))
        out.append(ChannelMetricsOut(channel=channel, activities=count, totals=MetricTotalsOut(**asdict(metrics.totals(rows))), series=series))
    return out
