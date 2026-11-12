"""The marketing plan of action: seeding from the extracted POA, edits, CSM approval and the go-live rule.

Rules enforced here (the live-needs-approval rule is also a database trigger):
  - nothing goes Live without a CSM approval and a UTM;
  - withdrawing an approval on a Live activity does not block it; it becomes a control breach;
  - re-reading the POA never overwrites or deletes anything a person has touched.
"""

from __future__ import annotations

import hashlib
from urllib.parse import urlparse
import re
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from enum import StrEnum
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit, slack_outbox
from core.errors import DomainError
from core.orm import ProgramActivity, User


class ActivityStatus(StrEnum):
    NOT_STARTED = "not_started"
    WIP = "wip"  # marketing sets this when the activity is ready for the CSM to review
    LIVE = "live"
    OFF = "off"


class ActivitySource(StrEnum):
    POA = "poa"
    MANUAL = "manual"  # added by hand: shown with an "ADDED" badge


# What the CSM approves. Editing any of these on an approved activity that is not live clears the approval.
APPROVED_CONTENT = frozenset({"title", "action", "audience", "outcome", "hook", "target_note", "creative_proof_url"})

# The fields a PATCH may change. Approval has its own functions (a different permission).
EDITABLE_FIELDS = frozenset(
    {
        "title", "action", "audience", "outcome", "hook", "target_note", "planned_date",
        "status", "go_live_at", "comes_off_at", "utm", "creative_proof_url", "tracker_ref",
    }
)


@dataclass(frozen=True)
class SeedResult:
    added: int
    removed: int
    edits_kept: int  # rows people have edited, left exactly as they are
    updated: int = 0  # unedited rows refreshed from the new POA (date, action, outcome)
    flagged: int = 0  # edited rows the POA no longer lists: kept, marked `not_in_poa` for a person to resolve


@dataclass(frozen=True)
class ActivitySummary:
    total: int
    live: int
    approved: int
    awaiting_approval: int
    breaches: int
    ramp_pct: float  # live / total, one decimal


def _now() -> datetime:
    return datetime.now(timezone.utc)


def is_breach(activity: ProgramActivity) -> bool:
    """Live without an approval: the state a withdrawn approval on a live activity leaves behind."""
    return activity.status == ActivityStatus.LIVE and activity.approved_at is None


def _jsonable(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value.value if isinstance(value, StrEnum) else value


def _week_number(label: str) -> int | None:
    match = re.search(r"\d+", label or "")
    return int(match.group()) if match else None


def _poa_key(week: int | None, channel: str, title: str, seen: Counter[str]) -> str:
    """Stable id for a POA row, so a re-read recognises it. A repeated row gets a -2, -3 ... suffix."""
    base = hashlib.sha1(f"{week}|{channel}|{title.strip().lower()}".encode()).hexdigest()[:12]
    seen[base] += 1
    return base if seen[base] == 1 else f"{base}-{seen[base]}"


def _next_code(prefix: str, taken: set[str]) -> str:
    number = 1
    while f"{prefix}-{number:02d}" in taken:
        number += 1
    code = f"{prefix}-{number:02d}"
    taken.add(code)
    return code


async def _codes(session: AsyncSession, ticket_id: str) -> set[str]:
    return set((await session.scalars(select(ProgramActivity.code).where(ProgramActivity.ticket_id == ticket_id))).all())


async def get(session: AsyncSession, ticket_id: str, activity_id: int) -> ProgramActivity:
    activity = await session.get(ProgramActivity, activity_id)
    if activity is None or activity.ticket_id != ticket_id:
        raise DomainError("activity_not_found", "Activity not found.", 404)
    return activity


async def list_for(session: AsyncSession, ticket_id: str) -> list[ProgramActivity]:
    rows = await session.scalars(
        select(ProgramActivity)
        .where(ProgramActivity.ticket_id == ticket_id)
        .order_by(ProgramActivity.week.asc().nulls_last(), ProgramActivity.id)
    )
    return list(rows.all())


def summarize(activities: list[ProgramActivity]) -> ActivitySummary:
    total = len(activities)
    live = sum(a.status == ActivityStatus.LIVE for a in activities)
    approved = sum(a.approved_at is not None for a in activities)
    return ActivitySummary(
        total=total,
        live=live,
        approved=approved,
        awaiting_approval=total - approved,
        breaches=sum(is_breach(a) for a in activities),
        ramp_pct=round(100 * live / total, 1) if total else 0.0,
    )


_POA_FOLLOWED = ("planned_date", "action", "outcome")  # what a new POA may change on a row nobody edited


async def follow_week_changes(
    session: AsyncSession, ticket_id: str, old: Mapping[str, Any], new: Mapping[str, Any]
) -> None:
    """The same POA rows, re-labelled with corrected weeks: move each plan row to its new week and key in place,
    so its approval, UTM, dates and edits stay with it (a plain re-seed would see an edited row as gone and add a
    twin). `old` and `new` are the POA details before and after; they must list the same rows in the same order.

    The corrected key may already belong to another row: the original activity, edited by someone and then flagged
    "not in POA" when an earlier misreading of the weeks made it look gone, with an untouched twin added in its
    place. The original is the one to keep (the re-seed that follows un-flags it), so the untouched twin is deleted;
    a twin someone has edited as well is left where it is for a person to resolve."""
    before, after = (list(d.get("activities") or []) for d in (old, new))
    if len(before) != len(after):
        return
    seen_before: Counter[str] = Counter()
    seen_after: Counter[str] = Counter()
    moves: dict[str, tuple[str, int | None]] = {}
    for was, now in zip(before, after):
        week = _week_number(now.get("week", ""))
        old_key = _poa_key(_week_number(was.get("week", "")), was["channel"], was["activity"], seen_before)
        new_key = _poa_key(week, now["channel"], now["activity"], seen_after)
        if old_key != new_key:
            moves[old_key] = (new_key, week)
    if not moves:
        return
    plan = (
        await session.scalars(
            select(ProgramActivity).where(
                ProgramActivity.ticket_id == ticket_id, ProgramActivity.source == ActivitySource.POA
            )
        )
    ).all()
    staying = {row.poa_key for row in plan if row.poa_key not in moves}
    rows = []
    for row in plan:
        if row.poa_key not in moves:
            continue
        if moves[row.poa_key][0] not in staying:
            rows.append(row)
        elif row.updated_by is None:
            await session.delete(row)  # the untouched twin of an original that already holds the corrected key
    targets = {row.id: moves[row.poa_key] for row in rows}
    for row in rows:  # keys are unique per program: step aside first, so two rows can swap
        row.poa_key = f"~{row.id}"
    await session.flush()
    for row in rows:
        row.poa_key, row.week = targets[row.id]
    await session.flush()


async def seed_from_poa(session: AsyncSession, ticket_id: str, details: Mapping[str, Any] | None) -> SeedResult:
    """Make the program's plan match the extracted POA without touching anyone's work: unseen rows are
    added; rows that vanished from the POA are removed only if nobody ever edited them."""
    existing = {
        a.poa_key: a
        for a in (
            await session.scalars(
                select(ProgramActivity).where(
                    ProgramActivity.ticket_id == ticket_id, ProgramActivity.source == ActivitySource.POA
                )
            )
        ).all()
        if a.poa_key
    }
    taken = await _codes(session, ticket_id)

    seen: Counter[str] = Counter()
    wanted: dict[str, dict[str, Any]] = {}
    for row in (details or {}).get("activities") or []:
        week = _week_number(row.get("week", ""))
        key = _poa_key(week, row["channel"], row["activity"], seen)
        wanted[key] = {
            "week": week,
            "channel": row["channel"],
            "title": row["activity"],
            "action": row.get("description") or None,
            "outcome": row.get("objective") or None,
            "planned_date": date.fromisoformat(row["date"]) if row.get("date") else None,
        }

    added = removed = updated = flagged = 0
    for key, fields in wanted.items():
        row = existing.get(key)
        if row is None:
            session.add(
                ProgramActivity(
                    ticket_id=ticket_id,
                    code=_next_code(f"W{fields['week'] or 0}-ACT", taken),
                    poa_key=key,
                    source=ActivitySource.POA,
                    **fields,
                )
            )
            added += 1
            continue
        row.not_in_poa = False  # listed again
        if row.updated_by is None:  # untouched by anyone: follow the POA
            changed = {f: v for f, v in fields.items() if f in _POA_FOLLOWED and getattr(row, f) != v}
            for f, v in changed.items():
                setattr(row, f, v)
            if changed:
                row.updated_at = _now()  # so a concurrent editor's If-Match sees the change
                updated += 1
    for key, activity in existing.items():
        if key in wanted:
            continue
        if activity.updated_by is None:
            await session.delete(activity)
            removed += 1
        elif not activity.not_in_poa:
            activity.not_in_poa = True
            flagged += 1

    if added or removed or updated or flagged:
        audit.record(
            session, None, entity="plan", entity_id=ticket_id, ticket_id=ticket_id,
            action="plan_seeded", new={"added": added, "removed": removed, "updated": updated, "flagged": flagged},
        )
    return SeedResult(
        added=added, removed=removed, updated=updated, flagged=flagged,
        edits_kept=sum(a.updated_by is not None for a in existing.values()),
    )


MAX_LEAD_DAYS = 60  # a go-live date may be at most ~2 months out


def check_go_live_date(day: date | None) -> None:
    """A newly entered go-live date must be today or later, and no more than two months away."""
    if day is None:
        return
    today = _now().date()
    if day < today:
        raise DomainError("go_live_date_in_past", "The go-live date can't be in the past.", 422)
    if day > today + timedelta(days=MAX_LEAD_DAYS):
        raise DomainError("go_live_date_too_far", "The go-live date can't be more than 2 months from today.", 422)


async def add_channel(
    session: AsyncSession, actor: User, ticket_id: str, *, channel: str, title: str, fields: Mapping[str, Any]
) -> ProgramActivity:
    check_go_live_date(fields.get("planned_date"))
    activity = ProgramActivity(
        ticket_id=ticket_id,
        code=_next_code("ADD", await _codes(session, ticket_id)),
        source=ActivitySource.MANUAL,
        channel=channel.strip(),
        title=title.strip(),
        updated_by=actor.id,
        **fields,
    )
    session.add(activity)
    await session.flush()
    audit.record(
        session, actor, entity="activity", entity_id=str(activity.id), ticket_id=ticket_id,
        action="channel_added", new={"code": activity.code, "channel": activity.channel, "title": activity.title},
    )
    return activity


async def update(
    session: AsyncSession,
    actor: User,
    activity: ProgramActivity,
    changes: dict[str, Any],
    *,
    expected_updated_at: datetime | None = None,
) -> ProgramActivity:
    """Apply a partial edit. One audit event per changed field."""
    if expected_updated_at is not None and expected_updated_at != activity.updated_at:
        raise DomainError("stale_write", "Someone else changed this activity. Reload and try again.", 409)
    unknown = set(changes) - EDITABLE_FIELDS
    if unknown:
        raise DomainError("field_not_editable", f"Not editable here: {', '.join(sorted(unknown))}", 422)

    changes = {k: ((v.strip() or None) if isinstance(v, str) else v) for k, v in changes.items()}
    proof = changes.get("creative_proof_url")
    if proof is not None and urlparse(proof).scheme not in ("http", "https"):
        # The UI renders this as a link, so anything but http(s) (e.g. javascript:) is refused here.
        raise DomainError("invalid_proof_url", "The creative proof must be an http(s) link.", 422)
    if changes.get("planned_date") != activity.planned_date:  # unchanged dates (e.g. from the POA) are left alone
        check_go_live_date(changes.get("planned_date"))
    status = ActivityStatus(changes.get("status", activity.status))
    utm = changes["utm"] if "utm" in changes else activity.utm

    if status == ActivityStatus.LIVE and activity.status != ActivityStatus.LIVE:
        if activity.approved_at is None:
            raise DomainError("activity_live_requires_approval", "A CSM must approve this activity before it goes live.")
        if not utm:
            raise DomainError("activity_requires_utm", "Add the UTM before this activity goes live.")
        if changes.get("go_live_at") is None:
            changes["go_live_at"] = _now()
        if activity.planned_date is None and changes.get("planned_date") is None:
            changes["planned_date"] = _now().date()  # went live without a planned date: record the actual day
    if activity.status == ActivityStatus.LIVE and "utm" in changes and not changes["utm"]:
        raise DomainError("activity_requires_utm", "A live activity must keep its UTM.")

    changed = False
    changed_fields: set[str] = set()
    for field, value in changes.items():
        old = getattr(activity, field)
        if _jsonable(old) == _jsonable(value):
            continue
        audit.record(
            session, actor, entity="activity", entity_id=str(activity.id), ticket_id=activity.ticket_id,
            action="activity_updated", field=field, old=_jsonable(old), new=_jsonable(value),
        )
        setattr(activity, field, _jsonable(value) if field == "status" else value)
        changed = True
        changed_fields.add(field)
    if activity.approved_at is not None and activity.status != ActivityStatus.LIVE and changed_fields & APPROVED_CONTENT:
        # The CSM signed off on this content: change it and the sign-off no longer applies (UTM, dates and status are
        # operational and may change after approval).
        audit.record(
            session, actor, entity="activity", entity_id=str(activity.id), ticket_id=activity.ticket_id,
            action="approval_reset", old={"by": activity.approved_by_name, "at": _jsonable(activity.approved_at)},
            new={"because": sorted(changed_fields & APPROVED_CONTENT)},
        )
        activity.approved_by = activity.approved_by_name = activity.approved_at = None
    if changed:
        activity.updated_by, activity.updated_at = actor.id, _now()
    return activity


async def approve(session: AsyncSession, actor: User, activity: ProgramActivity) -> ProgramActivity:
    if activity.approved_at is not None:
        return activity  # idempotent: the first approval stands, with its approver and time
    activity.approved_by, activity.approved_by_name = actor.id, actor.name or actor.email
    activity.approved_at = activity.updated_at = _now()
    activity.updated_by = actor.id
    audit.record(
        session, actor, entity="activity", entity_id=str(activity.id), ticket_id=activity.ticket_id,
        action="approved",
    )
    return activity


async def withdraw(session: AsyncSession, actor: User, activity: ProgramActivity) -> ProgramActivity:
    """Take the approval back. On a Live activity this creates a control breach (it is not refused)."""
    if activity.approved_at is None:
        return activity
    breach = activity.status == ActivityStatus.LIVE
    audit.record(
        session, actor, entity="activity", entity_id=str(activity.id), ticket_id=activity.ticket_id,
        action="approval_withdrawn", old={"by": activity.approved_by_name, "at": _jsonable(activity.approved_at)},
        new={"breach": breach},
    )
    activity.approved_by = activity.approved_by_name = activity.approved_at = None
    activity.updated_by, activity.updated_at = actor.id, _now()
    if breach:  # tell the program's channel straight away, outside working hours too
        await slack_outbox.enqueue(
            session, ticket_id=activity.ticket_id, kind="breach",
            body=f":rotating_light: *Control breach* · {activity.code} {activity.title} is live and {actor.name or actor.email} withdrew its approval",
            dedupe_key=f"breach:{activity.id}:{activity.updated_at.isoformat()}",
        )
    return activity
