"""Daily registration counts per program + the Slack channel they're announced to."""

from __future__ import annotations

from collections import defaultdict
from datetime import date

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from core import redash, slack
from core.config import settings
from core.database import get_session
from core.orm import Program, ProgramDocument, ProgramRegistration, ProgramRegistrationSettings
from core.users import current_active_user

logger = structlog.get_logger(__name__)

router = APIRouter(
    prefix="/programs/{ticket_id}",
    tags=["registrations"],
    dependencies=[Depends(current_active_user)],
)


class EntryIn(BaseModel):
    date: date
    role: str = ""
    registrations: int = Field(ge=0)
    relevant: int = Field(ge=0)  # required, also for hackathons
    extra: dict[str, str] = {}

    @model_validator(mode="after")
    def _relevant_within_total(self):
        if self.relevant > self.registrations:
            raise ValueError("relevant registrations can't exceed total registrations")
        return self


class EntriesIn(BaseModel):
    entries: list[EntryIn] = Field(min_length=1, max_length=2000)


class ConfigIn(BaseModel):
    roles: list[str]
    fields: list[str]


class SlackIn(BaseModel):
    channel_id: str | None = None  # None/"" clears the channel
    notify: bool | None = None


class RedashIn(BaseModel):
    auto: bool | None = None
    event_slug: str | None = None


async def _program(session: AsyncSession, ticket_id: str) -> Program:
    program = await session.get(Program, ticket_id)
    if program is None:
        raise HTTPException(404, "Program not found")
    return program


async def _settings(session: AsyncSession, ticket_id: str) -> ProgramRegistrationSettings:
    row = await session.get(ProgramRegistrationSettings, ticket_id)
    if row is None:
        row = ProgramRegistrationSettings(ticket_id=ticket_id, roles=[], fields=[], notify_slack=True)
        session.add(row)
    return row


def _slack_view(s: ProgramRegistrationSettings | None) -> dict:
    return {
        "channel_id": s.slack_channel_id if s else None,
        "channel_name": s.slack_channel_name if s else None,
        "notify": s.notify_slack if s else True,  # default on
    }


def _redash_view(s: ProgramRegistrationSettings | None) -> dict:
    return {
        "auto": bool(s and s.redash_auto),
        "event_slug": s.redash_event_slug if s else None,
        "configured": bool(settings.REDASH_API_KEY and settings.REDASH_REGISTRATIONS_QUERY_ID),
    }


@router.get("/registrations")
async def get_registrations(ticket_id: str, session: AsyncSession = Depends(get_session)):
    await _program(session, ticket_id)
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    rows = (
        await session.execute(
            select(ProgramRegistration)
            .where(ProgramRegistration.ticket_id == ticket_id)
            .order_by(ProgramRegistration.date.desc(), ProgramRegistration.role)
        )
    ).scalars().all()
    return {
        "roles": cfg.roles if cfg else [],
        "fields": cfg.fields if cfg else [],
        "entries": [
            {"id": r.id, "date": r.date, "role": r.role, "registrations": r.registrations,
             "relevant": r.relevant, "extra": r.extra}
            for r in rows
        ],
        "slack": _slack_view(cfg),
        "slack_configured": bool(settings.SLACK_BOT_TOKEN),
        "redash": _redash_view(cfg),
    }


@router.put("/registrations/config")
async def put_config(ticket_id: str, payload: ConfigIn, session: AsyncSession = Depends(get_session)):
    await _program(session, ticket_id)
    cfg = await _settings(session, ticket_id)
    cfg.roles = list(dict.fromkeys(r.strip() for r in payload.roles if r.strip()))
    cfg.fields = list(dict.fromkeys(f.strip() for f in payload.fields if f.strip()))
    await session.commit()
    return {"roles": cfg.roles, "fields": cfg.fields}


@router.post("/registrations")
async def add_entries(ticket_id: str, payload: EntriesIn, session: AsyncSession = Depends(get_session)):
    """Upsert day counts (same date+role replaces). One Slack summary per call,
    so a CSV import is a single message. Slack trouble never fails the save."""
    program = await _program(session, ticket_id)
    cfg = await _settings(session, ticket_id)

    rows = {(e.date, e.role.strip()): e for e in payload.entries}  # last wins within a batch
    cfg.roles = list(dict.fromkeys([*cfg.roles, *(r for _, r in rows if r)]))
    cfg.fields = list(dict.fromkeys([*cfg.fields, *(k for e in rows.values() for k in e.extra)]))
    stmt = insert(ProgramRegistration).values(
        [
            {"ticket_id": ticket_id, "date": d, "role": r, "registrations": e.registrations,
             "relevant": e.relevant, "extra": e.extra}
            for (d, r), e in rows.items()
        ]
    )
    await session.execute(
        stmt.on_conflict_do_update(
            constraint="uq_program_registrations",
            set_={c: getattr(stmt.excluded, c) for c in ("registrations", "relevant", "extra")},
        )
    )
    await session.commit()

    result = {"saved": len(rows), "slack": {"sent": False, "error": None}}
    if cfg.notify_slack and cfg.slack_channel_id:
        text = await _summary(session, program, list(rows.values()))
        ok, err = await slack.post_message(cfg.slack_channel_id, text)
        result["slack"] = {"sent": ok, "error": None if ok else err}
        if not ok:
            logger.warning("slack_notify_failed", ticket_id=ticket_id, error=err)
    return result


async def _fetch_entries(slug: str) -> list[EntryIn]:
    if not settings.REDASH_REGISTRATIONS_QUERY_ID:
        raise HTTPException(503, "Redash registrations query isn't configured (REDASH_REGISTRATIONS_QUERY_ID).")
    try:
        result = await redash.run_query(settings.REDASH_REGISTRATIONS_QUERY_ID, {"Event Slug": slug})
    except redash.RedashError as e:
        raise HTTPException(502, str(e)) from e
    return rows_to_entries(result["rows"])


@router.post("/registrations/redash/check")
async def check_redash(ticket_id: str, payload: RedashIn, session: AsyncSession = Depends(get_session)):
    """Confirm a slug: what the query returns for it, without saving anything."""
    await _program(session, ticket_id)
    slug = (payload.event_slug or "").strip()
    if not slug:
        raise HTTPException(422, "Enter the event slug.")
    entries = await _fetch_entries(slug)
    days = sorted(e.date for e in entries)
    return {"rows": len(entries), "registrations": sum(e.registrations for e in entries),
            "from": days[0], "to": days[-1]}


@router.put("/registrations/redash")
async def put_redash(ticket_id: str, payload: RedashIn, session: AsyncSession = Depends(get_session)):
    """Set the slug and/or switch mode. Switching to auto re-checks the slug against Redash."""
    await _program(session, ticket_id)
    cfg = await _settings(session, ticket_id)
    if payload.event_slug is not None:
        cfg.redash_event_slug = payload.event_slug.strip() or None
    if payload.auto:
        if not cfg.redash_event_slug:
            raise HTTPException(422, "Enter the event slug before switching to auto.")
        await _fetch_entries(cfg.redash_event_slug)  # raises if Redash is down or returns nothing usable
    if payload.auto is not None:
        cfg.redash_auto = payload.auto
    await session.commit()
    return _redash_view(cfg)


def rows_to_entries(rows: list[dict]) -> list[EntryIn]:
    """Redash rows -> entries. Columns (case-insensitive): date, registrations, relevant, role (optional)."""
    out = []
    for i, raw in enumerate(rows, 1):
        r = {k.strip().lower(): v for k, v in raw.items()}
        missing = [k for k in ("date", "registrations", "relevant") if r.get(k) in (None, "")]
        if missing:
            raise HTTPException(422, f"Query row {i} is missing column(s): {', '.join(missing)}. "
                                     "The query must return date, registrations, relevant (and optionally role).")
        try:
            out.append(EntryIn(date=str(r["date"])[:10], role=str(r.get("role") or ""),
                               registrations=int(r["registrations"]), relevant=int(r["relevant"])))
        except ValueError as e:
            raise HTTPException(422, f"Query row {i}: {e}") from e
    if not out:
        raise HTTPException(422, "The query returned no rows.")
    return out


@router.post("/registrations/redash/run")
async def run_redash(ticket_id: str, session: AsyncSession = Depends(get_session)):
    """Fetch the event's rows and save them exactly like a manual add (incl. the Slack summary)."""
    await _program(session, ticket_id)
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    if not cfg or not cfg.redash_event_slug:
        raise HTTPException(400, "No event slug set for this program.")
    entries = await _fetch_entries(cfg.redash_event_slug)
    return await add_entries(ticket_id, EntriesIn(entries=entries[:2000]), session)


@router.delete("/registrations/{entry_id}", status_code=204)
async def delete_entry(ticket_id: str, entry_id: int, session: AsyncSession = Depends(get_session)):
    row = await session.get(ProgramRegistration, entry_id)
    if row is None or row.ticket_id != ticket_id:
        raise HTTPException(404, "Entry not found")
    await session.delete(row)
    await session.commit()


@router.get("/slack/lookup")
async def lookup_channel(ticket_id: str, channel_id: str):
    """Preview: the channel name for an id, before saving it."""
    ok, value = await slack.channel_name(channel_id.strip())
    if not ok:
        raise HTTPException(422, value)
    return {"channel_id": channel_id.strip(), "channel_name": value}


@router.put("/slack")
async def put_slack(ticket_id: str, payload: SlackIn, session: AsyncSession = Depends(get_session)):
    await _program(session, ticket_id)
    cfg = await _settings(session, ticket_id)
    if payload.channel_id is not None:
        channel_id = payload.channel_id.strip()
        if channel_id:
            ok, value = await slack.channel_name(channel_id)
            if not ok:
                raise HTTPException(422, value)
            cfg.slack_channel_id, cfg.slack_channel_name = channel_id, value
        else:
            cfg.slack_channel_id = cfg.slack_channel_name = None
    if payload.notify is not None:
        cfg.notify_slack = payload.notify
    await session.commit()
    return _slack_view(cfg)


@router.post("/slack/test")
async def test_slack(ticket_id: str, session: AsyncSession = Depends(get_session)):
    program = await _program(session, ticket_id)
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    if not cfg or not cfg.slack_channel_id:
        raise HTTPException(400, "No Slack channel set for this program.")
    ok, err = await slack.post_message(
        cfg.slack_channel_id, f":white_check_mark: ProgramOps is connected to *{_label(program)}*."
    )
    if not ok:
        raise HTTPException(502, err)
    return {"sent": True}


# ---- Message ----------------------------------------------------------------


def _label(p: Program) -> str:
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
            parts = [f"{r['registrations']:,} registrations", f"{r['relevant']:,} relevant"]
            lines.append(f"- {r['role'] + ': ' if r['role'] else ''}" + " | ".join(parts))
        if len(day) > 1:
            lines.append(f"Day total: *{sum(r['registrations'] for r in day):,}*")
        if activities.get(d):
            lines.append(":mega: *Marketing activity:* " + "; ".join(activities[d]))
    lines += ["", f"Total so far: *{total:,}*"]
    return "\n".join(lines)


async def _summary(session: AsyncSession, program: Program, saved: list[EntryIn]) -> str:
    """Message for `saved`, whether or not it's persisted yet: the total is the
    stored rows not being replaced plus the saved ones."""
    rows = [e.model_dump() | {"role": e.role.strip()} for e in saved]
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
        activities[date.fromisoformat(a["date"])].append(f"{a['activity']} ({a['channel']})")
    return format_summary(_label(program), rows, total, activities)


@router.post("/registrations/preview")
async def preview_message(ticket_id: str, payload: EntriesIn, session: AsyncSession = Depends(get_session)):
    """The exact Slack text that saving these entries would post."""
    program = await _program(session, ticket_id)
    cfg = await session.get(ProgramRegistrationSettings, ticket_id)
    return {
        "text": await _summary(session, program, payload.entries),
        "channel_name": cfg.slack_channel_name if cfg else None,
    }


if __name__ == "__main__":
    text = format_summary(
        "TalentForge",
        [
            {"date": date(2026, 10, 1), "role": "SWE", "registrations": 30, "relevant": 12, "extra": {"Source": "LinkedIn"}},
            {"date": date(2026, 10, 1), "role": "QA", "registrations": 10, "relevant": 0, "extra": {}},
        ],
        1500,
        {date(2026, 10, 1): ["Launch mailer (Email)"]},
    )
    assert text.startswith(":calendar: *01 Oct 2026* | TalentForge")
    assert "- SWE: 30 registrations | 12 relevant\n" in text and "Source" not in text and "Day total: *40*" in text
    assert ":mega: *Marketing activity:* Launch mailer" in text and text.endswith("Total so far: *1,500*")
    print(text)
