"""Registrations beyond the daily Redash count: relevant registrations, targets and dates, registrations by
source, and the lift around each go-live."""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from typing import Literal

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import activities, audit, candidates, channel_sync, relevant, settings_store, slack
from core.access import Access, require_permission
from core.channel_sync import ActivityRef, SourceBucket
from core.database import get_session
from core.deps import program_or_404
from core.errors import DomainError
from core.orm import Program, ProgramRegistration, ProgramRegistrationSettings, RelevantRegistration
from core.permissions import Permission

logger = structlog.get_logger(__name__)

router = APIRouter(
    prefix="/programs/{ticket_id}",
    tags=["registrations"],
    dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW)), Depends(program_or_404)],
)


# ---- relevant registrations ----------------------------------------------------


class RelevantIn(BaseModel):
    date: dt.date
    count: int = Field(ge=0)
    criteria: str | None = None
    note: str | None = None


class RelevantCorrection(BaseModel):
    count: int = Field(ge=0)
    criteria: str | None = None
    note: str | None = None


class RelevantEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    date: dt.date
    count: int
    criteria: str | None
    note: str | None
    source: str
    entered_by_name: str
    entered_at: dt.datetime
    supersedes_id: int | None


class RelevantOut(BaseModel):
    total: int  # the sum of the entries that stand; never part of the Redash total
    entries: list[RelevantEntryOut]


async def _notify_relevant(session: AsyncSession, ticket_id: str, entry: RelevantRegistration) -> None:
    """Post the CSM's relevant count to the program's Slack channel (when notify is on). A Slack failure
    never fails the save, so the entry stays and the error is only logged."""
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    program = await session.get(Program, ticket_id)
    if not (cfg and cfg.notify_slack and cfg.slack_channel_id and program):
        return
    if not await settings_store.slack_allowed(session, "csm_updates"):
        return
    total = relevant.total(await relevant.current(session, ticket_id))
    text = (
        f":calendar: *{entry.date:%d %b %Y}* | {program.display_name}\n"
        f"Relevant registrations update\n- {entry.count:,} relevant\n\nRelevant so far: *{total:,}*"
    )
    ok, err = await slack.post_message(cfg.slack_channel_id, text)
    if not ok:
        logger.warning("slack_notify_failed", ticket_id=ticket_id, error=err)


@router.get("/relevant-registrations", response_model=RelevantOut)
async def list_relevant(ticket_id: str, session: AsyncSession = Depends(get_session)) -> RelevantOut:
    entries = await relevant.current(session, ticket_id)
    return RelevantOut(total=relevant.total(entries), entries=[RelevantEntryOut.model_validate(e) for e in entries])


@router.post("/relevant-registrations", status_code=201, response_model=RelevantEntryOut)
async def add_relevant(
    ticket_id: str,
    body: RelevantIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.RELEVANT_ENTER)),
) -> RelevantRegistration:
    entry = await relevant.add(
        session, access.user, ticket_id, day=body.date, count=body.count, criteria=body.criteria, note=body.note
    )
    await session.commit()
    await _notify_relevant(session, ticket_id, entry)
    return entry


@router.post("/relevant-registrations/{entry_id}/supersede", status_code=201, response_model=RelevantEntryOut)
async def correct_relevant(
    ticket_id: str,
    entry_id: int,
    body: RelevantCorrection,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.RELEVANT_ENTER)),
) -> RelevantRegistration:
    entry = await relevant.supersede(
        session, access.user, ticket_id, entry_id, count=body.count, criteria=body.criteria, note=body.note
    )
    await session.commit()
    await _notify_relevant(session, ticket_id, entry)
    return entry


# ---- target and campaign dates ---------------------------------------------------


class TargetsIn(BaseModel):
    target: int | None = Field(default=None, ge=1)
    campaign_start: dt.date | None = None
    campaign_end: dt.date | None = None

    @model_validator(mode="after")
    def _end_after_start(self) -> TargetsIn:
        if self.campaign_start and self.campaign_end and self.campaign_end < self.campaign_start:
            raise ValueError("The campaign can't end before it starts.")
        return self


@router.put("/registrations/targets", response_model=TargetsIn)
async def put_targets(
    ticket_id: str,
    body: TargetsIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REGISTRATIONS_MANAGE)),
) -> TargetsIn:
    """The CSM's override of the registration target and campaign window (else the SOW's and Redash's)."""
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    if cfg is None:
        cfg = ProgramRegistrationSettings(ticket_id=ticket_id, roles=[], fields=[], notify_slack=True)
        session.add(cfg)
    old = {"target": cfg.target, "campaign_start": cfg.campaign_start, "campaign_end": cfg.campaign_end}
    cfg.target, cfg.campaign_start, cfg.campaign_end = body.target, body.campaign_start, body.campaign_end
    audit.record(
        session, access.user, entity="registration_targets", entity_id=ticket_id, ticket_id=ticket_id,
        action="targets_changed",
        old={k: v.isoformat() if isinstance(v, dt.date) else v for k, v in old.items()},
        new=body.model_dump(mode="json"),
    )
    await session.commit()
    return body


# ---- registrations by source ------------------------------------------------------


class SourceLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    source_medium: str
    campaign: str
    users: int
    share_pct: float
    bucket: SourceBucket
    activity_id: int | None
    activity_code: str | None


class SourcesReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    total: int
    lines: list[SourceLineOut]
    reconciles: bool
    organic_pct: float
    matched_users: int
    unmatched_users: int


class SourcesOut(BaseModel):
    fetched_at: dt.datetime | None
    stale: bool
    running: bool
    error: str | None  # why the newest refresh failed; the report is then the last good one
    report: SourcesReportOut | None


@router.get("/sources", response_model=SourcesOut)
async def get_sources(ticket_id: str, session: AsyncSession = Depends(get_session)) -> SourcesOut:
    snapshot, error = await channel_sync.latest(session, ticket_id)
    refs = [ActivityRef(a.id, a.code, a.utm) for a in await activities.list_for(session, ticket_id)]
    report = channel_sync.classify(snapshot.rows, refs) if snapshot else None
    return SourcesOut(
        fetched_at=snapshot.fetched_at if snapshot else None,
        stale=channel_sync.is_stale(snapshot) if snapshot else False,
        running=channel_sync.is_running(ticket_id),
        error=error,
        report=SourcesReportOut.model_validate(report) if report else None,
    )


@router.post(
    "/sources/refresh", status_code=202, dependencies=[Depends(require_permission(Permission.INTEGRATIONS_LINK))]
)
async def refresh_sources(ticket_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, str]:
    """Run query 6170 in the background. Poll GET /sources: `running` turns false when it is done."""
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    if cfg is None or not cfg.redash_event_slug:
        raise DomainError("no_event_linked", "Link this program to its HackerEarth event first.", 409)
    return {"status": channel_sync.start_refresh(ticket_id)}


# ---- candidates: who registered (experience and city) and who meets the requirement ----------------


@router.get("/candidates")
async def get_candidates(ticket_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    """The latest candidates snapshot with its requirement. `running` is true while a refresh is in flight."""
    return candidates.view(await session.get(ProgramRegistrationSettings, ticket_id), ticket_id)


@router.put("/candidates/requirement")
async def put_requirement(
    ticket_id: str,
    body: candidates.RequirementIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.REGISTRATIONS_MANAGE)),
) -> dict:
    """Set who counts as relevant. Validated here because the values end up inside the Redash query's source."""
    try:
        yoe, cities = candidates.check_yoe(body.yoe), candidates.check_cities(body.cities)
    except candidates.InvalidRequirement as e:
        raise DomainError("invalid_requirement", str(e), 422) from e
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    if cfg is None:
        cfg = ProgramRegistrationSettings(ticket_id=ticket_id, roles=[], fields=[], notify_slack=True)
        session.add(cfg)
    old = {"yoe": cfg.required_yoe, "cities": list(cfg.required_cities or [])}
    changed = old != {"yoe": yoe, "cities": cities}
    cfg.required_yoe, cfg.required_cities = yoe, cities
    if changed:
        await candidates.reset_relevant(session, cfg)  # what each day's relevant meant no longer holds
        audit.record(
            session, access.user, entity="candidates_requirement", entity_id=ticket_id, ticket_id=ticket_id,
            action="candidates_requirement_changed", old=old, new={"yoe": yoe, "cities": cities},
        )
    await session.commit()
    if changed and cfg.redash_event_slug:
        candidates.start_refresh(ticket_id, cfg)  # about a minute; the page polls `running` / `progress`
    return candidates.view(cfg, ticket_id)


@router.post(
    "/candidates/refresh", status_code=202, dependencies=[Depends(require_permission(Permission.INTEGRATIONS_LINK))]
)
async def refresh_candidates(ticket_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, str]:
    """Run query 6182 in the background. Poll GET /candidates: `running` turns false when it is done. Status:
    started, already_running, or fresh (a snapshot for the current requirement is only minutes old: nothing to do)."""
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    if cfg is None or not cfg.redash_event_slug:
        raise DomainError("no_event_linked", "Link this program to its HackerEarth event first.", 409)
    return {"status": candidates.start_refresh(ticket_id, cfg)}


# ---- lift ----------------------------------------------------------------------


class LiftOut(BaseModel):
    kind: Literal["lift"] = "lift"  # a change seen alongside the activity, never claimed as its cause
    activity_id: int
    code: str
    title: str
    go_live_on: dt.date
    before_avg: float
    after_avg: float
    lift_pct: float | None


@router.get("/lift", response_model=list[LiftOut])
async def get_lift(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[LiftOut]:
    """Registrations per day before and after each go-live, from the daily counts we already hold."""
    daily: dict[dt.date, int] = defaultdict(int)
    for day, count in (
        await session.execute(
            select(ProgramRegistration.date, func.sum(ProgramRegistration.registrations))
            .where(ProgramRegistration.ticket_id == ticket_id)
            .group_by(ProgramRegistration.date)
        )
    ).all():
        daily[day] = int(count)
    out: list[LiftOut] = []
    for activity in await activities.list_for(session, ticket_id):
        if activity.go_live_at is None:
            continue
        result = channel_sync.lift(daily, activity.go_live_at.date())
        if result:
            out.append(
                LiftOut(
                    activity_id=activity.id, code=activity.code, title=activity.title,
                    go_live_on=activity.go_live_at.date(), before_avg=result.before_avg,
                    after_avg=result.after_avg, lift_pct=result.lift_pct,
                )
            )
    return out
