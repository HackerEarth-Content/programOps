"""The Slack text for special requests. Pure: no database, no Slack. Plain text with *bold* and emoji only (the poster
escapes & < >, so no quotes or <url|text> links)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Route:
    label: str
    team: str  # "marketing" or "content": drives the chip colour


ROUTES: dict[str, Route] = {
    "csm_to_marketing": Route(label="CSM → Marketing", team="marketing"),
    "csm_to_content": Route(label="CSM → Content", team="content"),
}

_STATUS_EMOJI = {
    "done": ":white_check_mark:", "in_progress": ":arrows_counterclockwise:", "ready": ":arrows_counterclockwise:",
    "declined": ":no_entry_sign:", "open": ":inbox_tray:",
}


def route_for(template_key: str) -> Route | None:
    return ROUTES.get(template_key)


def _lines(*lines: str | None) -> str:
    return "\n".join(line for line in lines if line)


def _fact(label: str, value: str | None) -> str | None:
    return f"*{label}:* {value.strip()}" if value and value.strip() else None


def created_text(
    route_label: str | None, program_name: str, title: str, due: datetime | None, raised_by: str | None,
    detail: str | None, items_count: int, url: str,
) -> str:
    """`route_label` is the route's label, or the request type's name when it has no route."""
    return _lines(
        f":inbox_tray: *New request: {route_label or 'Special request'}*",
        _fact("Program", program_name), _fact("Request", title),
        _fact("Due", f"{due:%a}, {due.day} {due:%b %Y}" if due else None),
        _fact("Raised by", raised_by), _fact("Detail", detail),
        f"*Checklist:* {items_count} item{'' if items_count == 1 else 's'} to confirm" if items_count else None,
        f"Open in ProgramOps: {url}",
    )


def status_text(route_label: str | None, program_name: str, title: str, status: str, resolution: str | None) -> str:
    emoji = _STATUS_EMOJI.get(status, ":information_source:")
    return _lines(
        f"{emoji} *{route_label or 'Special'} request is now {status.replace('_', ' ')}*",
        _fact("Request", title), _fact("Program", program_name), _fact("Resolution", resolution),
    )
