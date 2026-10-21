"""The Slack message for registration counts, shared by the manual routes and the scheduled Redash run."""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.orm import Program, ProgramDocument, ProgramRegistration


def label(p: Program) -> str:
    return p.event_name or p.other_event_name or p.subject or p.ticket_id


def format_summary(label: str, rows: list[dict], total: int, activities: dict[date, list[str]]) -> str:
    """rows: [{date, role, registrations, relevant, extra}]. Date(s) lead the message,
    then the counts (role, registrations, relevant), then that day's marketing activities and the running total."""
    by_day: dict[date, list[dict]] = defaultdict(list)
    for r in rows:
        by_day[r["date"]].append(r)
    days = sorted(by_day)
    span = f"{days[0]:%d %b %Y}" + (f" - {days[-1]:%d %b %Y}" if len(days) > 1 else "")
    lines = [f":calendar: *{span}* | {label}", "Registrations update"]
    for d in days:
        day = by_day[d]
        if len(days) > 1:
            lines += ["", f"*{d:%a, %d %b %Y}*"]
        for r in day:
            parts = [f"{r['registrations']:,} registrations"]
            if r["relevant"] is not None:  # unknown for Redash-sourced days
                parts.append(f"{r['relevant']:,} relevant")
            lines.append(f"- {r['role'] + ': ' if r['role'] else ''}" + " | ".join(parts))
        if len(day) > 1:
            lines.append(f"Day total: *{sum(r['registrations'] for r in day):,}*")
        if activities.get(d):
            lines.append(":mega: *Marketing activity:* " + "; ".join(activities[d]))
    lines += ["", f"Total so far: *{total:,}*"]
    return "\n".join(lines)


async def summary(session: AsyncSession, program: Program, rows: list[dict]) -> str:
    """Message for `saved`, whether or not it's persisted yet: the total is the
    stored rows not being replaced plus the saved ones."""
    keys = {(r["date"], r["role"]) for r in rows}
    stored = (
        await session.execute(
            select(ProgramRegistration.date, ProgramRegistration.role, ProgramRegistration.registrations)
            .where(ProgramRegistration.ticket_id == program.ticket_id)
        )
    ).all()
    total = sum(n for d, r, n in stored if (d, r) not in keys) + sum(r["registrations"] for r in rows)
    poa = (
        await session.execute(
            select(ProgramDocument.details).where(
                ProgramDocument.ticket_id == program.ticket_id,
                ProgramDocument.kind == "poa",
                ProgramDocument.status == "ok",
            )
        )
    ).scalar()
    activities: dict[date, list[str]] = defaultdict(list)
    for a in (poa or {}).get("activities", []):
        if a.get("date"):  # undated rows can't be tied to a day
            activities[date.fromisoformat(a["date"])].append(f"{a['activity']} ({a['channel']})")
    return format_summary(label(program), rows, total, activities)
