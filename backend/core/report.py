"""The program report (one view across registration, participation, shortlisting and operational health) and the
closure view. Everything here is derived from data held elsewhere; nothing is stored twice."""

from __future__ import annotations

import datetime as dt
from enum import StrEnum

from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import activities, channel_sync, checklists, communications, dependencies, relevant, rounds
from core.channel_sync import ActivityRef
from core.checklists import ChecklistKind, ChecklistStatus, Phase, PhaseStatus
from core.health import Health, health_of
from core.needs import needs_for
from core.registration_window import load_estimate
from core.orm import (
    ParticipantComm,
    Program,
    ProgramDocument,
    ProgramRegistration,
    ProgramRegistrationSettings,
    TimelineChange,
)


class FunnelStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    round_id: int
    name: str
    seq: int
    status: str
    as_of: dt.date | None
    invited: int | None
    attempted: int | None
    submitted: int | None
    cleared: int | None
    shortlisted: int | None
    participation_pct: float | None
    clearance_pct: float | None
    shortlist_pct: float | None
    drop_off: int | None


class RegistrationsPart(BaseModel):
    raw_total: int  # Redash and manual daily counts
    relevant_total: int  # the CSM's own number, never part of raw_total
    relevant_pct: float | None  # relevant as a share of raw
    target: int | None
    pct_of_target: float | None


class FunnelSummary(BaseModel):
    participants: int | None  # attempted in the first round
    final_shortlisted: int | None  # shortlisted in the last round that has counts
    registered_to_shortlist_pct: float | None


class SourcesPart(BaseModel):
    fetched_at: dt.datetime | None
    organic_pct: float | None
    matched_users: int | None
    unmatched_users: int | None


class MarketingPart(BaseModel):
    total: int
    live: int
    approved: int
    awaiting_approval: int
    breaches: int


class OperationsPart(BaseModel):
    health: Health
    reasons: list[str]
    open_requests: int
    dependencies_open: int
    dependencies_overdue: int
    projected_slip_days: int
    communications_planned: int
    communications_overdue: int
    phases_done: int  # done or skipped
    phases_total: int
    changes_proposed: int
    changes_approved: int


class ReportOut(BaseModel):
    registrations: RegistrationsPart
    funnel: list[FunnelStepOut]
    funnel_summary: FunnelSummary
    sources: SourcesPart
    marketing: MarketingPart
    operations: OperationsPart
    generated_at: dt.datetime


def _pct(part: int | None, whole: int | None) -> float | None:
    return round(100 * part / whole, 1) if part is not None and whole else None


async def build_report(session: AsyncSession, ticket_id: str) -> ReportOut:
    now = dt.datetime.now(dt.timezone.utc)

    raw_total = int(
        await session.scalar(select(func.coalesce(func.sum(ProgramRegistration.registrations), 0)).where(ProgramRegistration.ticket_id == ticket_id)) or 0
    )
    relevant_total = relevant.total(await relevant.current(session, ticket_id))
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    sow = await session.scalar(
        select(ProgramDocument.details).where(
            ProgramDocument.ticket_id == ticket_id, ProgramDocument.kind == "sow", ProgramDocument.status == "ok"
        )
    ) or {}
    target = (cfg.target if cfg and cfg.target else None) or sow.get("registration_target")

    program_rounds = await rounds.list_rounds(session, ticket_id)
    steps = rounds.funnel(program_rounds, await rounds.latest_counts(session, [r.id for r in program_rounds]))
    with_counts = [s for s in steps if s.as_of is not None]
    final_shortlisted = next((s.shortlisted for s in reversed(with_counts) if s.shortlisted is not None), None)

    plan = await activities.list_for(session, ticket_id)
    summary = activities.summarize(plan)

    snapshot, _ = await channel_sync.latest(session, ticket_id)
    sources = channel_sync.classify(snapshot.rows, [ActivityRef(a.id, a.code, a.utm) for a in plan]) if snapshot else None

    deps = dependencies.impact(await dependencies.list_for(session, ticket_id), now.date())
    comms = await communications.list_for(session, ticket_id)
    phases = await checklists.lifecycle(session, ticket_id)
    health = await health_of(session, ticket_id)
    changes = (await session.scalars(select(TimelineChange.status).where(TimelineChange.ticket_id == ticket_id))).all()
    open_requests = len(
        [
            c for c, _ in await checklists.list_checklists(session, ticket_id, kind=ChecklistKind.REQUEST)
            if c.status in (ChecklistStatus.OPEN, ChecklistStatus.IN_PROGRESS, ChecklistStatus.READY)
        ]
    )

    return ReportOut(
        registrations=RegistrationsPart(
            raw_total=raw_total, relevant_total=relevant_total, relevant_pct=_pct(relevant_total, raw_total),
            target=target, pct_of_target=_pct(raw_total, target),
        ),
        funnel=[FunnelStepOut.model_validate(s) for s in steps],
        funnel_summary=FunnelSummary(
            participants=with_counts[0].attempted if with_counts else None,
            final_shortlisted=final_shortlisted,
            registered_to_shortlist_pct=_pct(final_shortlisted, raw_total),
        ),
        sources=SourcesPart(
            fetched_at=snapshot.fetched_at if snapshot else None,
            organic_pct=sources.organic_pct if sources else None,
            matched_users=sources.matched_users if sources else None,
            unmatched_users=sources.unmatched_users if sources else None,
        ),
        marketing=MarketingPart(
            total=summary.total, live=summary.live, approved=summary.approved,
            awaiting_approval=summary.awaiting_approval, breaches=summary.breaches,
        ),
        operations=OperationsPart(
            health=health.health, reasons=list(health.reasons), open_requests=open_requests,
            dependencies_open=deps.open, dependencies_overdue=deps.overdue, projected_slip_days=deps.projected_slip_days,
            communications_planned=sum(c.status == communications.CommStatus.PLANNED for c in comms),
            communications_overdue=sum(communications.is_overdue(c, now) for c in comms),
            phases_done=sum(p.phase.status in (PhaseStatus.DONE, PhaseStatus.SKIPPED) for p in phases),
            phases_total=len(phases),
            changes_proposed=sum(s == "proposed" for s in changes),
            changes_approved=sum(s == "approved" for s in changes),
        ),
        generated_at=now,
    )


# ---- closure -------------------------------------------------------------------


class OutstandingKind(StrEnum):
    GATE_ITEM = "gate_item"  # a required closure checklist item not yet confirmed
    REQUEST = "request"
    DEPENDENCY = "dependency"


class OutstandingItem(BaseModel):
    kind: OutstandingKind
    title: str
    detail: str | None = None
    ref_id: int | None = None


class ClosureOut(BaseModel):
    ready_to_close: bool
    gate_ready: bool
    outstanding: list[OutstandingItem]


async def build_closure(session: AsyncSession, ticket_id: str) -> ClosureOut:
    """Ready to close when the closure gate is ready, no client dependency is open and no request is open."""
    await checklists.ensure_lifecycle(session, ticket_id)
    outstanding: list[OutstandingItem] = []

    closure = next((p for p in await checklists.lifecycle(session, ticket_id) if p.phase.phase == Phase.CLOSURE.value), None)
    gate_ready = True
    if closure and closure.checklist is not None and closure.phase.status != PhaseStatus.SKIPPED:
        for item in closure.items:
            if item.required and item.confirmed_at is None:
                outstanding.append(OutstandingItem(kind=OutstandingKind.GATE_ITEM, title=item.label, detail=item.instruction or None, ref_id=item.id))
        gate_ready = closure.checklist.status in (ChecklistStatus.READY, ChecklistStatus.DONE) or not any(
            i.required for i in closure.items
        )

    for checklist, _items in await checklists.list_checklists(session, ticket_id, kind=ChecklistKind.REQUEST):
        if checklist.status in (ChecklistStatus.OPEN, ChecklistStatus.IN_PROGRESS, ChecklistStatus.READY):
            outstanding.append(OutstandingItem(kind=OutstandingKind.REQUEST, title=checklist.title, detail=checklist.status, ref_id=checklist.id))
    for dep in await dependencies.list_for(session, ticket_id):
        if dep.status == dependencies.DependencyStatus.OPEN:
            outstanding.append(OutstandingItem(kind=OutstandingKind.DEPENDENCY, title=dep.title, detail=dep.client_owner, ref_id=dep.id))

    return ClosureOut(ready_to_close=gate_ready and not outstanding, gate_ready=gate_ready, outstanding=outstanding)


# ---- portfolio (the programs directory) --------------------------------------------


class PortfolioProgram(BaseModel):
    ticket_id: str
    name: str
    client: str | None
    stage: str
    health: Health
    reasons: list[str]
    marketing_live: int
    marketing_total: int
    awaiting_approval: int
    registrations: int
    target: int | None
    on_target: bool | None  # None: no target set; otherwise at or above the pace the window asks for
    needs: int  # how many items the program's "needs you today" list holds


class ActionItems(BaseModel):
    control_breaches: int
    pending_approvals: int  # activities marketing marked ready that no CSM has approved yet
    missing_utm: int  # live or ready activities with no UTM


class PortfolioOut(BaseModel):
    active_programs: int
    health: dict[Health, int]
    registrations_total: int
    target_total: int | None  # None when no active program has a target
    stage_distribution: dict[str, int]
    programs_with_target: int
    programs_on_target: int
    escalations: int  # the sum of every program's needs items, so it always matches the per-program lists
    action_items: ActionItems
    programs: list[PortfolioProgram]


def _on_target(registrations: int, target: int | None, window: dict, today: dt.date) -> bool | None:
    """At or above the pace the registration window asks for (the full target once the window is over)."""
    if not target:
        return None
    start, end = window.get("start"), window.get("end")
    if not start or not end or today >= end or end <= start:
        return registrations >= target
    elapsed = (today - start).days + 1
    return registrations >= target * max(0.0, min(1.0, elapsed / ((end - start).days + 1)))


async def build_portfolio(session: AsyncSession) -> PortfolioOut:
    """Every program that isn't closed, with the numbers the directory header and cards show. One health evaluation
    per program: fine for hundreds of programs; cache it if that ever stops being true."""
    programs = (await session.scalars(select(Program).where(Program.stage_label != "Closed").order_by(Program.created_at.desc()))).all()
    cards: list[PortfolioProgram] = []
    stages: dict[str, int] = {}
    health_counts: dict[Health, int] = {h: 0 for h in Health}
    breaches = pending = missing_utm = escalations = 0
    for program in programs:
        plan = await activities.list_for(session, program.ticket_id)
        summary = activities.summarize(plan)
        health = await health_of(session, program.ticket_id)
        cfg = await session.get(ProgramRegistrationSettings, program.ticket_id)
        sow = await session.scalar(
            select(ProgramDocument.details).where(
                ProgramDocument.ticket_id == program.ticket_id, ProgramDocument.kind == "sow", ProgramDocument.status == "ok"
            )
        ) or {}
        registrations = int(
            await session.scalar(select(func.coalesce(func.sum(ProgramRegistration.registrations), 0)).where(ProgramRegistration.ticket_id == program.ticket_id)) or 0
        )
        stages[program.stage_label] = stages.get(program.stage_label, 0) + 1
        health_counts[health.health] += 1
        breaches += summary.breaches
        pending += sum(a.status == activities.ActivityStatus.WIP and a.approved_at is None for a in plan)
        missing_utm += sum(a.utm is None and a.status in (activities.ActivityStatus.WIP, activities.ActivityStatus.LIVE) for a in plan)
        target = (cfg.target if cfg and cfg.target else None) or sow.get("registration_target")
        needs = await needs_for(session, program)
        escalations += len(needs)
        cards.append(
            PortfolioProgram(
                ticket_id=program.ticket_id, name=program.display_name, client=program.company_name,
                stage=program.stage_label, health=health.health, reasons=list(health.reasons),
                marketing_live=summary.live, marketing_total=summary.total, awaiting_approval=summary.awaiting_approval,
                registrations=registrations, target=target,
                on_target=_on_target(registrations, target, await load_estimate(session, program), dt.datetime.now(dt.timezone.utc).date()),
                needs=len(needs),
            )
        )
    targets = [c.target for c in cards if c.target]
    return PortfolioOut(
        active_programs=len(cards), health=health_counts, registrations_total=sum(c.registrations for c in cards),
        target_total=sum(targets) if targets else None, stage_distribution=stages,
        programs_with_target=len(targets), programs_on_target=sum(c.on_target is True for c in cards), escalations=escalations,
        action_items=ActionItems(control_breaches=breaches, pending_approvals=pending, missing_utm=missing_utm),
        programs=cards,
    )
