"""What needs a person on one program today: one merged, grouped, ordered list.

The Overview's "Needs you today" and the one-sentence health reason in the program header read this. The counts on
the directory, the nav badge and the CSM queue are the queue's own items (core.csm_queue), and the rules here that
overlap with it use the same definitions (an activity "waits for approval" only once marketing has marked it ready). Items are deduplicated by what they are about
(a type plus a round, activity or request id), never by their title, and several like items collapse into one
("18 marketing activities waiting for approval"). It also surfaces contradictions in the data (a campaign that
runs after registration closed, a round marked done that has not started) instead of rendering them silently.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import activities, csm_queue, rounds
from core.activities import ActivityStatus
from core.health import health_of
from core.orm import Program, ProgramNote
from core.registration_window import load_estimate

NeedSeverity = Literal["danger", "warn", "neutral"]
_ORDER: dict[NeedSeverity, int] = {"danger": 0, "warn": 1, "neutral": 2}
_FROM_QUEUE: dict[csm_queue.Severity, NeedSeverity] = {
    csm_queue.Severity.CRITICAL: "danger",
    csm_queue.Severity.AMBER: "warn",
    csm_queue.Severity.INFO: "neutral",
}
_HEALTH_NAME = {"good": "Good", "warning": "At risk", "critical": "Critical"}
# Contradictions in the data rather than work somebody is waiting to do.
_CHECKS = frozenset({"window_conflict", "round_conflict", "health_mismatch", "untitled_program"})


class NeedsItem(BaseModel):
    id: str  # what it is about, e.g. "counts_missing:round:12": unique per program
    type: str
    severity: NeedSeverity
    title: str
    detail: str
    action: str | None  # the one secondary button, if there is something to open
    tab: str  # program tab where it gets resolved
    group: Literal["action", "check"] = "action"  # "check": the data contradicts itself, nobody is waiting on it


def _day(d: date) -> str:
    return f"{d.day} {d:%b}"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


async def needs_for(session: AsyncSession, program: Program, now: datetime | None = None) -> list[NeedsItem]:
    now = now or datetime.now(timezone.utc)
    today = now.date()
    tid = program.ticket_id
    out: list[NeedsItem] = []

    def add(id: str, type: str, severity: NeedSeverity, title: str, detail: str, action: str | None, tab: str) -> None:
        out.append(NeedsItem(id=id, type=type, severity=severity, title=title, detail=detail, action=action, tab=tab))

    # ---- marketing plan -------------------------------------------------------------------------------------
    plan = await activities.list_for(session, tid)
    live_unapproved = [a for a in plan if activities.is_breach(a)]
    if live_unapproved:
        add("breach:activities", "control_breach", "danger",
            f"{_plural(len(live_unapproved), 'activity', 'activities')} live without approval",
            "Approve them or take them off", "Review", "marketing")
    # Only what marketing has marked ready (WIP) is waiting on the CSM, the same rule as the CSM queue. Activities that
    # haven't been started aren't waiting on anybody yet.
    waiting = [a for a in plan if a.approved_at is None and a.status == ActivityStatus.WIP]
    if waiting:
        no_utm = sum(not a.utm for a in waiting)
        who = program.csm_name or "a CSM"
        add("approvals:activities", "approval_waiting", "warn",
            f"{len(waiting)} marketing {'activity' if len(waiting) == 1 else 'activities'} waiting for approval",
            f"Marketing has marked them ready. Nothing can go live until {who} approves"
            + (f" and a UTM is set ({no_utm} still need one)" if no_utm else ""),
            "Review", "marketing")
    due = [
        a for a in plan
        if a.approved_at is not None and a.status in (ActivityStatus.NOT_STARTED, ActivityStatus.WIP)
        and a.planned_date is not None and a.planned_date <= today
    ]
    if due:
        add("go_live_due:activities", "go_live_due", "danger",
            f"{_plural(len(due), 'approved activity', 'approved activities')} past the planned go-live date",
            "Take them live or move the date", "Go live", "marketing")

    # ---- registration window vs the plan (a contradiction worth showing) --------------------------------------
    window = await load_estimate(session, program)
    end: date | None = window["end"]
    if end is not None:
        late = [a for a in plan if a.status != ActivityStatus.OFF and a.planned_date and a.planned_date > end]
        if late:
            last = max(a.planned_date for a in late if a.planned_date)
            verb = "closed" if window["end_is_actual"] and end < today else "is due to close"
            add("window:marketing_after_close", "window_conflict", "warn",
                f"Registration {verb} {_day(end)}, but marketing runs to {_day(last)}",
                "Extend the registration window or move the campaign dates", "Fix dates", "registrations")

    # ---- rounds ----------------------------------------------------------------------------------------------
    program_rounds = await rounds.list_rounds(session, tid)
    for r in program_rounds:
        if r.ends_on and r.ends_on < today and not await rounds.standing_counts(session, r.id):
            add(f"counts_missing:round:{r.id}", "counts_missing", "warn",
                f"{r.name} ended {_day(r.ends_on)} with no counts", f"Round {r.seq} · enter the round counts", "Enter counts", "rounds")
        if r.status == "done" and r.starts_on and r.starts_on > today:
            add(f"round_conflict:round:{r.id}", "round_conflict", "warn",
                f"{r.name} is marked done but starts {_day(r.starts_on)}",
                f"Round {r.seq} · fix the round status or its dates", "Open rounds", "rounds")

    # ---- the CSM queue's rules, grouped where several items say the same thing ---------------------------------
    grouped: dict[csm_queue.CsmKind, list[csm_queue.CsmItem]] = {}
    for item in await csm_queue.items_for(session, program, now):
        grouped.setdefault(item.kind, []).append(item)
    requests = grouped.get(csm_queue.CsmKind.REQUEST_DUE, [])
    if requests:
        late_req = any(i.severity == csm_queue.Severity.CRITICAL for i in requests)
        add("requests:due", "request_due", "danger" if late_req else "warn",
            f"{_plural(len(requests), 'request')} {'overdue' if late_req else 'due today'}",
            " · ".join(i.title for i in requests[:2]) + (" …" if len(requests) > 2 else ""), "Open requests", "requests")
    for dep in grouped.get(csm_queue.CsmKind.DEPENDENCY_OVERDUE, []):
        add(f"dependency:{dep.ref_id}", "dependency_overdue", _FROM_QUEUE[dep.severity], dep.title, dep.detail,
            "Open requests", "requests")
    comms = grouped.get(csm_queue.CsmKind.COMM_OVERDUE, [])
    if comms:
        add("communications:overdue", "comm_overdue", "warn",
            f"{_plural(len(comms), 'participant communication')} overdue", comms[0].title, "Open requests", "requests")
    changes = grouped.get(csm_queue.CsmKind.CHANGE_AWAITING_APPROVAL, [])
    if changes:
        add("changes:awaiting", "change_awaiting_approval", "warn",
            f"{_plural(len(changes), 'timeline change')} waiting for approval", changes[0].title, "Review", "requests")
    for item in grouped.get(csm_queue.CsmKind.UPDATE_DUE, []):
        add("update:due", "update_due", _FROM_QUEUE[item.severity], "Daily update is due", item.detail, "Post update", "requests")
    if grouped.get(csm_queue.CsmKind.SLACK_UNLINKED):
        add("slack:unlinked", "slack_unlinked", "neutral", "No Slack channel connected",
            "Updates and reminders stay in ProgramOps only", "Connect", "registrations")

    # ---- the numbers contradict each other --------------------------------------------------------------------
    latest = await session.scalar(
        select(ProgramNote).where(ProgramNote.ticket_id == tid, ProgramNote.kind == "update")
        .order_by(ProgramNote.created_at.desc()).limit(1)
    )
    computed = (await health_of(session, tid)).health.value
    if latest is not None and latest.health and latest.health != computed:
        add("health:mismatch", "health_mismatch", "warn",
            f"Health reads {_HEALTH_NAME[computed]}, but the latest update says {_HEALTH_NAME.get(latest.health, latest.health)}",
            "Post a fresh update so the two agree", "Post update", "requests")
    if program.is_untitled:
        add("program:untitled", "untitled_program", "neutral", "This program has no name yet",
            "Set the program name on the HubSpot ticket", None, "overview")

    out = [i.model_copy(update={"group": "check"}) if i.type in _CHECKS else i for i in out]
    out.sort(key=lambda i: (i.group == "check", _ORDER[i.severity], i.id))
    return out
