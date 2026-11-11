"""Who registered: years of experience and city split, plus how many meet the CSM's requirement, from Redash
query 6182 (a tested v2 of 6181; spec in docs/REDASH_6181_SPEC.md).

One run per program returns everything: the YOE bands, the cities, the registrations per day and the two relevant
figures. "Relevant" = known YOE and city both meet the requirement; "possibly" = city matches but YOE is not on the
profile. The run is stored as one JSON snapshot on the program's registration settings (latest good one only; a failed
refresh keeps it and records why), and the per-day relevant counts are written into the daily registrations table,
so the existing chart shows them. A result is stored only if it reconciles (every section sums to the total).

The query pastes its three parameters into Python source, so every value is validated here before it is sent.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

import structlog
from pydantic import BaseModel
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession

from core import redash, redash_sync
from core.config import settings
from core.database import db_manager
from core.orm import ProgramRegistration, ProgramRegistrationSettings

logger = structlog.get_logger(__name__)

STALE_AFTER = timedelta(hours=36)
FRESH_FOR = timedelta(minutes=5)  # a snapshot for the current requirement this young is not fetched again
MAX_SNAPSHOT_BYTES = 256_000
MAX_RERUNS = 3  # the requirement changing while a run is in flight triggers another run, at most this many in a row
MAX_CITIES = 10
_OVERALL = "Overall Registration Metrics"
_ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
_BANDS = [(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 10), (11, None)]


class InvalidRequirement(ValueError):
    pass


class RequirementIn(BaseModel):
    """Who counts as relevant: "2+" (at least 2 years), "0-2" (0 to 2), "0-0" (freshers); empty = no requirement."""

    yoe: str | None = None
    cities: list[str] = []


# ---- the requirement (validated: it ends up inside Python source on the Redash worker) -----------------------------


def check_yoe(raw: str | None) -> str | None:
    """'2+' (at least 2), '0-2' (0 to 2, inclusive) -> canonical form. Empty or '0+' = no requirement (None)."""
    s = (raw or "").strip()
    if not s:
        return None
    if m := re.fullmatch(r"(\d{1,2})\+", s):
        return None if int(m[1]) == 0 else f"{int(m[1])}+"
    if m := re.fullmatch(r"(\d{1,2})\s*-\s*(\d{1,2})", s):
        lo, hi = sorted((int(m[1]), int(m[2])))
        return f"{lo}-{hi}"
    raise InvalidRequirement("Experience must look like 2+ or 0-2.")


def check_cities(raw: list[str] | None) -> list[str]:
    seen: dict[str, str] = {}
    for c in raw or []:
        c = re.sub(r"\s+", " ", (c or "").strip())
        if not c or c.lower() in ("all", "any", "all cities"):  # "no city filter" is an empty list, not a city called All
            continue
        if not re.fullmatch(r"[A-Za-z][A-Za-z .-]{1,49}", c):
            raise InvalidRequirement(f"'{c[:30]}' isn't a city name (letters, spaces, hyphens and dots only).")
        seen.setdefault(c.lower(), c)
    if len(seen) > MAX_CITIES:
        raise InvalidRequirement(f"At most {MAX_CITIES} cities.")
    return list(seen.values())


def has_requirement(cfg: ProgramRegistrationSettings | None) -> bool:
    return bool(cfg and (cfg.required_yoe or cfg.required_cities))


def _requirement(cfg: ProgramRegistrationSettings) -> dict[str, Any]:
    return {"yoe": cfg.required_yoe, "cities": list(cfg.required_cities or [])}


def describe(req: dict[str, Any]) -> str:
    """'2+ yrs · Bengaluru, Hyderabad' for messages; '' when there is no requirement."""
    parts = []
    if y := req.get("yoe"):
        if y.endswith("+"):
            parts.append(f"{y} yrs")
        else:
            lo, hi = y.split("-")
            parts.append(("0 yrs (freshers)" if lo == "0" else f"{lo} yrs") if lo == hi else f"{lo} to {hi} yrs")
    if req.get("cities"):
        parts.append(", ".join(req["cities"]))
    return " · ".join(parts)


# ---- reading the query output --------------------------------------------------------------------------------------


def _bad(why: str) -> redash.RedashError:
    return redash.RedashError(f"The candidates data didn't add up ({why}); keeping the last good snapshot.")


def parse(rows: list[dict[str, Any]], yoe: str | None, cities: list[str], now: datetime | None = None) -> dict[str, Any]:
    """Query rows -> snapshot. Raises RedashError on an Error row, a changed shape, or numbers that don't reconcile."""
    errors = [r for r in rows if r.get("Section") == "Error"]
    if errors:
        raise redash.RedashError(f"Redash: {str(errors[0].get('Dimension'))[:200]}")
    sections: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        sections.setdefault(r.get("Section"), []).append(r)
    T, M, P = "Total Registrations", "Matching Required Count", "Possibly Relevant Count"
    try:
        overall = {r["Dimension"]: r for r in sections[_OVERALL]}
        total = int(overall["Total registrations"][T])
        relevant = int(overall["Relevant registrations (known YOE AND location)"][M])
        possibly = int(overall["Possibly relevant (YOE unknown AND location)"][P])
        yoe_rows = [(r["Dimension"], int(r[T]), int(r[M])) for r in sections.get("YOE Breakdown", [])]
        city_rows = [(r["Dimension"], int(r[T]), int(r[M]), int(r[P])) for r in sections.get("Location Breakdown", [])]
        day_rows = [(r["Dimension"], int(r[T]), int(r[M]), int(r[P])) for r in sections.get("Daily Registrations", [])]
    except (KeyError, TypeError, ValueError) as e:
        raise redash.RedashError(f"Unexpected candidates query output ({e.__class__.__name__}).") from e

    if relevant + possibly > total:
        raise _bad("relevant exceeds total")
    if not (sum(r[1] for r in yoe_rows) == sum(r[1] for r in city_rows) == sum(r[1] for r in day_rows) == total):
        raise _bad("sections differ from the total")
    if (sum(r[2] for r in city_rows), sum(r[3] for r in city_rows)) != (relevant, possibly):
        raise _bad("cities differ from the relevant counts")
    if (sum(r[2] for r in day_rows), sum(r[3] for r in day_rows)) != (relevant, possibly):
        raise _bad("days differ from the relevant counts")

    # YOE: single years 0-5, then 6-10 and 11+; matching = how many of the band meet the requirement
    by_year = {int(m[0]): (n, mt) for d, n, mt in yoe_rows if (m := re.match(r"\d+", d))}
    unknown = sum(n for d, n, _ in yoe_rows if not re.match(r"\d+", d))
    bands = []
    for lo, hi in _BANDS:
        members = [v for y, v in by_year.items() if y >= lo and (hi is None or y <= hi)]
        bands.append({
            "label": str(lo) if lo == hi else (f"{lo}–{hi}" if hi is not None else f"{lo}+"),
            "count": sum(n for n, _ in members), "matching": sum(mt for _, mt in members),
        })

    wanted = {c.lower() for c in cities}
    named = [r for r in city_rows if r[0] not in ("Other cities", "Unparsed", "Unknown")]
    items = [
        {"name": n, "count": c, "relevant": rel, "possibly": pos,
         "selected": bool(cities) and (rel + pos > 0 or n.lower() in wanted)}
        for n, c, rel, pos in named
    ]
    return {
        "fetched_at": (now or datetime.now(timezone.utc)).isoformat(),
        "requirement": {"yoe": yoe, "cities": cities},
        "total": total, "relevant": relevant, "possibly": possibly,
        "yoe": {"unknown": unknown, "bands": bands},
        "cities": {
            "unknown": sum(r[1] for r in city_rows if r[0] == "Unknown"),
            "other": sum(r[1] for r in city_rows if r[0] in ("Other cities", "Unparsed")),
            "items": items,
        },
        "undated": {  # registrants with no registration date: in the totals above, in no day below
            "total": sum(r[1] for r in day_rows if not _ISO_DAY.fullmatch(r[0])),
            "relevant": sum(r[2] for r in day_rows if not _ISO_DAY.fullmatch(r[0])),
            "possibly": sum(r[3] for r in day_rows if not _ISO_DAY.fullmatch(r[0])),
        },
        "daily": [
            {"date": d, "total": n, "relevant": rel, "possibly": pos}
            for d, n, rel, pos in day_rows if _ISO_DAY.fullmatch(d)
        ],
    }


async def fetch(
    slug: str, yoe: str | None, cities: list[str], on_status: Callable[[str], None] | None = None
) -> dict[str, Any]:
    redash_sync.check_slug(slug)
    yoe, cities = check_yoe(yoe), check_cities(cities)
    if not settings.REDASH_CANDIDATES_QUERY_ID:
        raise redash.RedashError("Redash candidates query isn't configured (REDASH_CANDIDATES_QUERY_ID).")
    result = await redash.run_query(
        settings.REDASH_CANDIDATES_QUERY_ID,
        {"Event - Title or Slug": slug, "Required YOE": yoe or "any", "Required location": ", ".join(cities) or "All"},
        max_age=0,  # always fresh: the whole point is today's numbers
        on_status=on_status,
    )
    snap = parse(result["rows"], yoe, cities)
    snap["slug"] = slug  # a snapshot is only ever shown for the event it was fetched for
    if len(json.dumps(snap)) > MAX_SNAPSHOT_BYTES:  # bounded by design (50 cities, ~60 days); a surprise must not bloat the row
        raise redash.RedashError("The candidates data was unexpectedly large; keeping the last good snapshot.")
    return snap


# ---- stored snapshot -----------------------------------------------------------------------------------------------


def _matches(snap: dict[str, Any] | None, cfg: ProgramRegistrationSettings) -> bool:
    """The snapshot is for this program's current event AND requirement (either changing makes it someone else's data)."""
    return bool(
        snap and snap.get("slug") == cfg.redash_event_slug and snap.get("requirement") == _requirement(cfg)
    )


def is_current(cfg: ProgramRegistrationSettings | None) -> bool:
    """The stored snapshot was computed for the event and requirement the program has now."""
    return bool(cfg and _matches(cfg.candidates, cfg))


def usable_daily(cfg: ProgramRegistrationSettings | None) -> dict[date, int] | None:
    """{date: relevant} from the stored snapshot, or None when there is none or it is for another requirement."""
    if not is_current(cfg):
        return None
    return {date.fromisoformat(d["date"]): int(d["relevant"]) for d in cfg.candidates["daily"]}


def view(cfg: ProgramRegistrationSettings | None, ticket_id: str) -> dict[str, Any]:
    """The API shape: no per-day list (the daily chart reads those from the registrations)."""
    snap = cfg.candidates if cfg else None
    running = is_running(ticket_id)
    out: dict[str, Any] = {
        "requirement": _requirement(cfg) if cfg else {"yoe": None, "cities": []},
        "snapshot": {k: v for k, v in snap.items() if k != "daily"} if snap else None,
        "outdated": bool(snap) and not is_current(cfg),  # the requirement changed after this snapshot
        "stale": False,
        "error": cfg.candidates_error if cfg else None,
        "running": running,
        # while running: "starting", "queued" (waiting for a Redash worker) or "running", and the seconds so far
        "progress": _progress_of(ticket_id) if running else None,
    }
    if snap:
        out["stale"] = _age(cfg) > STALE_AFTER
    return out


def _age(cfg: ProgramRegistrationSettings) -> timedelta:
    return datetime.now(timezone.utc) - datetime.fromisoformat(cfg.candidates["fetched_at"])


def is_fresh(cfg: ProgramRegistrationSettings | None) -> bool:
    """A snapshot for the current requirement, fetched a moment ago: running the query again would change nothing."""
    return is_current(cfg) and _age(cfg) < FRESH_FOR


async def _write_relevant(session: AsyncSession, ticket_id: str, daily: dict[date, int]) -> None:
    """Relevant per day for an auto program: the snapshot's value (never more than that day's registrations) where it
    differs from what is stored, NULL (unknown) for days the snapshot doesn't list, the same rule `apply_days` uses."""
    days = ProgramRegistration.ticket_id == ticket_id, ProgramRegistration.role == ""
    for d, rel in daily.items():
        new = func.least(rel, ProgramRegistration.registrations)
        await session.execute(
            update(ProgramRegistration)
            .where(*days, ProgramRegistration.date == d, ProgramRegistration.relevant.is_distinct_from(new))
            .values(relevant=new)
        )
    await session.execute(
        update(ProgramRegistration)
        .where(*days, ProgramRegistration.date.not_in(list(daily)), ProgramRegistration.relevant.is_not(None))
        .values(relevant=None)
    )


async def reset_relevant(session: AsyncSession, cfg: ProgramRegistrationSettings) -> None:
    """The requirement or event just changed: what each day's `relevant` meant no longer holds. From the snapshot if it
    happens to fit, else unknown (NULL) until the refresh lands, or equal to the day's registrations when there is no
    requirement. Only for auto programs: a manual program's relevant counts are the CSM's own entries."""
    if not cfg.redash_auto:
        return
    if (daily := usable_daily(cfg)) is not None:
        await _write_relevant(session, cfg.ticket_id, daily)
    else:
        await session.execute(
            update(ProgramRegistration)
            .where(ProgramRegistration.ticket_id == cfg.ticket_id, ProgramRegistration.role == "")
            .values(relevant=None if has_requirement(cfg) else ProgramRegistration.registrations)
        )


# ticket -> {"phase", "since"} while its query is in flight. In process memory: one API process (a restart forgets
# a run, the next request simply starts another).
_running: dict[str, dict[str, Any]] = {}
_waiters: dict[str, list[Callable[[], Awaitable[None]]]] = {}  # run once the refresh is over, whatever its outcome


_dirty: set[str] = set()  # a request arrived while a run was in flight: look at the settings again when it ends


def is_running(ticket_id: str) -> bool:
    return ticket_id in _running


async def wait_idle(ticket_id: str, timeout: float = 300) -> None:
    """Let a run already in flight finish (the daily sync wants its numbers rather than going ahead without them)."""
    waited = 0.0
    while is_running(ticket_id) and waited < timeout:
        await asyncio.sleep(2)
        waited += 2


def _progress_of(ticket_id: str) -> dict[str, Any] | None:
    p = _running.get(ticket_id)
    return {"phase": p["phase"], "elapsed": int(time.monotonic() - p["since"])} if p else None


async def refresh(ticket_id: str) -> bool:
    """Run the query for this program and store the result. Never raises: a failure is recorded on the settings row
    and the last good snapshot stays. Single-flight per program, and a no-op while the stored snapshot is fresh for
    the current requirement, so reruns never pile up or rewrite the same data. If the requirement or event changes
    while the query runs (or a request arrives meanwhile), the result is not stored unless it still fits, and it runs
    again for the new settings (up to MAX_RERUNS). Per-day relevant counts are written for auto programs only: a
    manual program's are the CSM's own entries. Returns whether a new snapshot was stored."""
    if ticket_id in _running:
        return False
    factory = db_manager.session_factory()
    stored = False
    try:
        for _ in range(MAX_RERUNS):
            _running[ticket_id] = {"phase": "starting", "since": time.monotonic()}
            _dirty.discard(ticket_id)
            async with factory() as s:
                cfg = await s.get(ProgramRegistrationSettings, ticket_id)
                if not cfg or not cfg.redash_event_slug or is_fresh(cfg):
                    return stored
                slug, req = cfg.redash_event_slug, _requirement(cfg)

            def on_status(phase: str) -> None:
                if (p := _running.get(ticket_id)) is not None:
                    p["phase"] = phase

            try:
                snap = await fetch(slug, req["yoe"], req["cities"], on_status)
                error = None
            except (redash.RedashError, InvalidRequirement) as e:
                snap, error = None, str(e)[:300]
            except Exception:  # noqa: BLE001 -- record it; one program must not stop the daily run
                logger.exception("candidates_refresh_failed", ticket_id=ticket_id)
                snap, error = None, "Couldn't refresh the candidates split."
            async with factory() as s:
                cfg = await s.get(ProgramRegistrationSettings, ticket_id)
                if cfg is None:
                    return stored
                matches = _matches(snap, cfg)
                if matches or error:  # a run whose result was dropped says nothing about the last one's outcome
                    cfg.candidates_error = error
                if matches:
                    cfg.candidates = snap  # the single latest snapshot: replaced, never appended
                    if cfg.redash_auto:
                        await _write_relevant(s, ticket_id, {date.fromisoformat(d["date"]): d["relevant"] for d in snap["daily"]})
                    stored = True
                await s.commit()
            if error:
                logger.warning("candidates_refresh_error", ticket_id=ticket_id, error=error)
            if ticket_id in _dirty or (snap is not None and not matches):
                logger.info("candidates_settings_changed_mid_run", ticket_id=ticket_id)  # go round again for the new ones
                continue
            return stored
        return stored
    except Exception:  # noqa: BLE001 -- a database hiccup must not become an unretrieved task exception
        logger.exception("candidates_refresh_crashed", ticket_id=ticket_id)
        return stored
    finally:
        _running.pop(ticket_id, None)
        for after in _waiters.pop(ticket_id, []):
            try:
                await after()
            except Exception:  # noqa: BLE001 -- a failed follow-up (a Slack post) must not look like a failed refresh
                logger.exception("candidates_after_failed", ticket_id=ticket_id)


_tasks: set[asyncio.Task] = set()


def start_refresh(
    ticket_id: str, cfg: ProgramRegistrationSettings | None = None, after: Callable[[], Awaitable[None]] | None = None
) -> str:
    """Background refresh for the request path (the query takes about a minute). 'started', 'already_running', or
    'fresh' (the stored snapshot is already for the current requirement and a few minutes old: nothing to fetch).
    `after` runs once the refresh is over in every case (the Slack update waits on it)."""
    if after:
        _waiters.setdefault(ticket_id, []).append(after)
    if is_running(ticket_id):
        _dirty.add(ticket_id)  # the run in flight drains `after` and looks at the settings again before it ends
        return "already_running"
    task = asyncio.create_task(refresh(ticket_id))
    _tasks.add(task)  # keep a reference so it isn't garbage collected
    task.add_done_callback(_tasks.discard)
    return "fresh" if is_fresh(cfg) else "started"


if __name__ == "__main__":
    assert check_yoe("2+") == "2+" and check_yoe(" 0 - 2 ") == "0-2" and check_yoe("2-0") == "0-2"
    assert check_yoe("") is None and check_yoe("0+") is None
    assert check_yoe("0-0") == "0-0" and check_yoe("3 - 3") == "3-3"  # exactly 0 = freshers is a real requirement
    assert describe({"yoe": "0-0", "cities": []}) == "0 yrs (freshers)"
    assert describe({"yoe": "3-3", "cities": ["Pune"]}) == "3 yrs · Pune"
    assert describe({"yoe": "0-2", "cities": []}) == "0 to 2 yrs" and describe({"yoe": "2+", "cities": []}) == "2+ yrs"
    for bad in ("2", "abc", '2+"; x', "-1", "100+", "2+3"):
        try:
            check_yoe(bad)
            raise SystemExit(f"accepted {bad!r}")
        except InvalidRequirement:
            pass
    assert check_cities([" Bengaluru ", "bengaluru", "New  Delhi"]) == ["Bengaluru", "New Delhi"]
    for bad in ('x"; import os #', "a{{b}}", "1", "a" * 51, 'Pu"ne', "Pu\\ne", "Pune;"):
        try:
            check_cities([bad])
            raise SystemExit(f"accepted {bad!r}")
        except InvalidRequirement:
            pass
    print("ok")
