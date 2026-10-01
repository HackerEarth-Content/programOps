"""Generates an executive weekly summary of program activity using OpenAI.

Reads only from our own DB (program_stage_history + program_notes joined to
programs) -- no HubSpot calls here. Generated on demand, not cached; see the
module docstring note in api/program_routes.py's weekly_brief route for the
caching tradeoff this leaves open.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.orm import Program, ProgramNote, ProgramStageHistory
from hubspot_client.stage_checklist import PROPERTY_LABELS, resolve_history_value

_SYSTEM_PROMPT = (
    "You are an operations analyst writing a concise weekly executive brief "
    "for a team running hackathons and hiring challenges through a sales "
    "pipeline. You are given, per program, the stage/checklist changes and "
    "internal notes logged this week. Be factual and specific -- reference "
    "program names, stage moves, and blockers. Do not invent information not "
    "present in the data.\n\n"
    "Return:\n"
    "- headline: a punchy 6-10 word title for the week.\n"
    "- summary: 2-4 sentences on what happened across the portfolio.\n"
    "- highlights: short bullet strings for genuinely positive movement "
    "(stage advances, deals progressing, wins). Empty list if none.\n"
    "- needs_attention: short bullet strings for programs that stalled, are "
    "waiting on someone, or need a decision. Empty list if none.\n"
    "- risks: short bullet strings for real blockers or things that could "
    "slip. Empty list if none.\n"
    "- next_week: short bullet strings on what should happen next, grounded "
    "in the data (not generic advice). Empty list if none.\n"
    "Each bullet should name the specific program it refers to. Keep bullets "
    "to one line each."
)

_BRIEF_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "summary": {"type": "string"},
        "highlights": {"type": "array", "items": {"type": "string"}},
        "needs_attention": {"type": "array", "items": {"type": "string"}},
        "risks": {"type": "array", "items": {"type": "string"}},
        "next_week": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "headline",
        "summary",
        "highlights",
        "needs_attention",
        "risks",
        "next_week",
    ],
    "additionalProperties": False,
}


async def _collect_weekly_activity(session: AsyncSession, since: datetime) -> list[dict]:
    """One entry per program that had any stage/checklist change or note
    since `since`, with its changes and notes attached."""
    history_rows = await session.execute(
        select(ProgramStageHistory, Program.subject, Program.event_name, Program.other_event_name)
        .join(Program, Program.ticket_id == ProgramStageHistory.ticket_id)
        .where(ProgramStageHistory.changed_at >= since)
        .order_by(ProgramStageHistory.ticket_id, ProgramStageHistory.changed_at)
    )
    notes_rows = await session.execute(
        select(ProgramNote, Program.subject, Program.event_name, Program.other_event_name)
        .join(Program, Program.ticket_id == ProgramNote.ticket_id)
        .where(ProgramNote.created_at >= since)
        .order_by(ProgramNote.ticket_id, ProgramNote.created_at)
    )

    by_ticket: dict[str, dict] = {}

    for history, subject, event_name, other_event_name in history_rows.all():
        entry = by_ticket.setdefault(
            history.ticket_id,
            {
                "ticket_id": history.ticket_id,
                "subject": subject,
                "event_name": event_name or other_event_name,
                "changes": [],
                "notes": [],
            },
        )
        entry["changes"].append(
            {
                "property": PROPERTY_LABELS.get(history.property_name, history.property_name),
                "from": resolve_history_value(history.property_name, history.old_value),
                "to": resolve_history_value(history.property_name, history.new_value),
                "at": history.changed_at.isoformat(),
                "source": history.source_type,
            }
        )

    for note, subject, event_name, other_event_name in notes_rows.all():
        entry = by_ticket.setdefault(
            note.ticket_id,
            {
                "ticket_id": note.ticket_id,
                "subject": subject,
                "event_name": event_name or other_event_name,
                "changes": [],
                "notes": [],
            },
        )
        entry["notes"].append({"body": note.body, "at": note.created_at.isoformat()})

    return list(by_ticket.values())


def _format_activity_for_prompt(activity: list[dict]) -> str:
    if not activity:
        return "No stage changes or notes were logged this week."

    lines = []
    for entry in activity:
        label = entry["event_name"] or entry["subject"]
        lines.append(f"### {label} ({entry['ticket_id']})")
        for change in entry["changes"]:
            lines.append(
                f"- {change['property']} changed from "
                f"{change['from'] or 'unset'} to {change['to']} "
                f"via {change['source']} at {change['at']}"
            )
        for note in entry["notes"]:
            lines.append(f"- Note ({note['at']}): {note['body']}")
    return "\n".join(lines)


async def generate_weekly_brief(session: AsyncSession, days: int = 7) -> dict:
    """Executive summary of program activity over the last `days` days."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    activity = await _collect_weekly_activity(session, since)

    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    response = await client.responses.create(
        model=settings.OPENAI_MODEL,
        instructions=_SYSTEM_PROMPT,
        input=_format_activity_for_prompt(activity),
        text={
            "format": {
                "type": "json_schema",
                "name": "weekly_brief",
                "schema": _BRIEF_JSON_SCHEMA,
                "strict": True,
            }
        },
    )
    brief = json.loads(response.output_text)

    # Computed directly from the DB rather than asked of the model, so these
    # counts can't be hallucinated.
    stage_moves = sum(len(entry["changes"]) for entry in activity)
    notes_logged = sum(len(entry["notes"]) for entry in activity)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "period_start": since.isoformat(),
        "period_end": datetime.now(timezone.utc).isoformat(),
        "programs_covered": len(activity),
        "stage_moves": stage_moves,
        "notes_logged": notes_logged,
        **brief,
    }
