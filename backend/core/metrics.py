"""Views, clicks and sends per marketing activity per day, and the rates derived from them.

Entered by the marketing team and only for activities that have gone live (and not before the day they went live,
nor in the future). CTR is clicks over what was shown: views when there are any, otherwise what was sent.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit
from core.errors import DomainError
from core.orm import ActivityMetric, ProgramActivity, User


def _pct(part: int | None, whole: int | None) -> float | None:
    return round(100 * part / whole, 1) if part is not None and whole else None


def ctr(views: int | None, sent: int | None, clicks: int | None) -> float | None:
    return _pct(clicks, views or sent)


def open_rate(sent: int | None, opens: int | None) -> float | None:
    return _pct(opens, sent)


@dataclass(frozen=True)
class Totals:
    views: int
    clicks: int
    sent: int
    opens: int
    ctr: float | None
    open_rate: float | None


def totals(rows: Sequence[ActivityMetric]) -> Totals:
    views, clicks = sum(r.views or 0 for r in rows), sum(r.clicks or 0 for r in rows)
    sent, opens = sum(r.sent or 0 for r in rows), sum(r.opens or 0 for r in rows)
    return Totals(views, clicks, sent, opens, ctr(views, sent, clicks), open_rate(sent, opens))


async def put_day(
    session: AsyncSession,
    actor: User,
    activity: ProgramActivity,
    *,
    day: date,
    views: int | None,
    clicks: int | None,
    sent: int | None,
    opens: int | None,
) -> ActivityMetric:
    """Record (or replace) one day's numbers for an activity."""
    if activity.go_live_at is None:
        raise DomainError("activity_not_live_yet", "Results can only be recorded once the activity has gone live.")
    if day < activity.go_live_at.date():
        raise DomainError("metrics_before_go_live", "That day is before the activity went live.", 422)
    if day > datetime.now(timezone.utc).date():
        raise DomainError("metrics_in_future", "Results can't be recorded for a future day.", 422)
    if clicks is not None and views is not None and clicks > views:
        raise DomainError("metrics_inconsistent", f"Clicks ({clicks}) can't exceed views ({views}).", 422)
    if opens is not None and sent is not None and opens > sent:
        raise DomainError("metrics_inconsistent", f"Opens ({opens}) can't exceed sent ({sent}).", 422)

    row = await session.get(ActivityMetric, (activity.id, day))
    old = None
    if row is None:
        row = ActivityMetric(activity_id=activity.id, date=day, entered_by_name="")
        session.add(row)
    else:
        old = {"views": row.views, "clicks": row.clicks, "sent": row.sent, "opens": row.opens}
    row.views, row.clicks, row.sent, row.opens = views, clicks, sent, opens
    row.entered_by, row.entered_by_name, row.entered_at = actor.id, actor.name or actor.email, datetime.now(timezone.utc)
    audit.record(
        session, actor, entity="activity_metrics", entity_id=str(activity.id), ticket_id=activity.ticket_id,
        action="metrics_recorded", field=day.isoformat(), old=old,
        new={"views": views, "clicks": clicks, "sent": sent, "opens": opens},
    )
    return row


async def list_for(session: AsyncSession, activity_id: int) -> list[ActivityMetric]:
    rows = await session.scalars(select(ActivityMetric).where(ActivityMetric.activity_id == activity_id).order_by(ActivityMetric.date))
    return list(rows.all())


async def by_channel(session: AsyncSession, ticket_id: str) -> dict[str, tuple[int, list[ActivityMetric]]]:
    """channel -> (number of activities, every metric row of that channel's activities)."""
    out: dict[str, tuple[int, list[ActivityMetric]]] = {}
    grouped: dict[str, list[ProgramActivity]] = defaultdict(list)
    for activity in (await session.scalars(select(ProgramActivity).where(ProgramActivity.ticket_id == ticket_id))).all():
        grouped[activity.channel].append(activity)
    for channel, members in sorted(grouped.items()):
        rows = (
            await session.scalars(select(ActivityMetric).where(ActivityMetric.activity_id.in_([a.id for a in members])).order_by(ActivityMetric.date))
        ).all()
        out[channel] = (len(members), list(rows))
    return out
