"""SOW / marketing-POA documents: download from the HubSpot ticket's file
properties, extract their contents with a schema-validated LLM call, persist.

The PDF itself is sent to the model (not pypdf text) because the POA is a
wide table whose *column* says which channel an activity belongs to -- plain
text extraction loses that.
"""

from __future__ import annotations

import asyncio
import base64
from datetime import date, datetime, timedelta, timezone
from typing import Literal

import structlog
from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from core.config import settings
from core.database import db_manager
from core.orm import Program, ProgramDocument
from hubspot_client.client import HubSpotClient

logger = structlog.get_logger(__name__)

# kind -> HubSpot ticket file property
DOCUMENT_PROPERTIES = {"sow": "sow_upload", "poa": "marketing_poa_upload"}


# ---- Extraction schemas ----------------------------------------------------
# Mirror the frontend's SowDetails / PoaDetails (lib/program-documents.ts).
# No defaults on purpose: OpenAI strict structured output requires every field
# to be present, with `| None` for the optional ones.


class Commitment(BaseModel):
    label: str
    value: str


class Round(BaseModel):
    name: str
    details: list[str]


class ClientRequirement(BaseModel):
    item: str
    details: str


class Report(BaseModel):
    type: str
    frequency: str


class Milestone(BaseModel):
    task: str
    owner: str
    start: date | None  # None when the document gives this milestone no date -- never guessed
    end: date | None
    open_ended: bool


class Contact(BaseModel):
    name: str
    role: str
    contact: str
    side: str


class Sla(BaseModel):
    audience: str
    hours: str
    response: str


class SowDetails(BaseModel):
    title: str
    customer: str
    order_date: date
    validity: str
    fee: str
    fee_amount_inr: float | None
    payment_terms: str
    exclusions: str
    objective: str
    services: list[str]
    commitments: list[Commitment]
    rounds: list[Round]
    content: list[str]
    client_requirements: list[ClientRequirement]
    reports: list[Report]
    timeline: list[Milestone]
    # The planned registration window, as stated (e.g. "2/3-week" -> 2 and 3) and the
    # registration/participant target (e.g. "10,000+" -> 10000). None when not stated.
    registration_window_weeks_min: int | None
    registration_window_weeks_max: int | None
    registration_target: int | None
    contacts: list[Contact]
    sla: list[Sla]


class PoaActivity(BaseModel):
    date: date | None  # None when the document gives this row no date -- never guessed
    week: str
    channel: Literal["Email", "Social", "Community", "Newsletter", "Partner"]
    activity: str
    objective: str
    description: str


class PoaDetails(BaseModel):
    title: str
    window_start: date | None
    window_end: date | None
    activities: list[PoaActivity]


_SCHEMAS: dict[str, type[BaseModel]] = {"sow": SowDetails, "poa": PoaDetails}

_PROMPTS = {
    "sow": (
        "Extract the details of this Order Form / Statement of Work. Rules: "
        "use only what the document states, never invent; dates as ISO YYYY-MM-DD, "
        "and when a date has no year (e.g. '15th March') use the year of the order date; "
        "fee_amount_inr is the total fee as a plain number in INR without taxes "
        "(null if not stated in INR); `fee` is the fee as written; `timeline` is the "
        "dated milestone table (owner = responsible party, end only for ranges, "
        "open_ended true for 'onwards' items). Milestone dates: use ONLY a date the "
        "document states for that milestone -- never the order date or any other date "
        "as a stand-in; when a stage has no date, set start to null and open_ended false. "
        "registration_window_weeks_min/max: the registration window length in weeks as "
        "stated ('2/3-week' -> 2 and 3, '3-week' -> 3 and 3), null if not stated; "
        "registration_target: the targeted number of registrations/participants as a plain "
        "integer ('10,000+' -> 10000), null if not stated; `commitments` are 3-4 SHORT headline "
        "figures for summary cards (value at most ~12 characters, like '4,000+', '2', "
        "'1 / week', '4 months'; label 1-3 words like 'Registrations', 'Rounds', 'Term') "
        "-- never sentences or paragraphs; `side` in contacts is the company "
        "(HackerEarth or the customer's name); use empty lists / empty strings "
        "for sections the document does not contain."
    ),
    "poa": (
        "Extract this marketing plan-of-action schedule. Rules: use only what the "
        "document states; dates as ISO YYYY-MM-DD; one activity per dated row; "
        "channel is decided by which column holds the activity name (Email activity -> "
        "Email, Social media -> Social, Partner network -> Partner; use Community / "
        "Newsletter when the activity is a community promotion / newsletter feature); "
        "week is the row's week label (e.g. 'Week 1', empty string if none); "
        "window_start/window_end come from the campaign window. NEVER guess or infer a "
        "date: if a row has no date in the document, set its date to null; if the "
        "document gives no complete day-month-year (or an unambiguous year) for a row, "
        "use null rather than assuming a year or a default such as 1 January; if the "
        "campaign window is not stated, set window_start/window_end to null."
    ),
}


async def extract_details(kind: str, pdf: bytes) -> BaseModel:
    """Run the schema-validated extraction. One retry on a schema-invalid
    response; raises if it still doesn't validate."""
    schema = _SCHEMAS[kind]
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    file_part = {
        "type": "file",
        "file": {
            "filename": f"{kind}.pdf",
            "file_data": "data:application/pdf;base64," + base64.b64encode(pdf).decode(),
        },
    }
    last_error: Exception | None = None
    for _ in range(2):
        try:
            completion = await client.chat.completions.parse(
                model=settings.OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": _PROMPTS[kind]},
                    {"role": "user", "content": [file_part]},
                ],
                response_format=schema,
                temperature=0,
            )
            message = completion.choices[0].message
            if message.parsed is None:
                raise ValueError(message.refusal or "model returned no parsed output")
            return message.parsed
        except (ValidationError, ValueError) as e:
            last_error = e
    raise ValueError(f"extraction failed schema validation: {last_error}")


def sanitize_sow(sow: SowDetails) -> SowDetails:
    """Keep the registration window/target only when they're plausible."""
    lo, hi = sow.registration_window_weeks_min, sow.registration_window_weeks_max
    if lo is None or hi is None or not 1 <= lo <= hi <= 12:
        sow.registration_window_weeks_min = sow.registration_window_weeks_max = None
    if sow.registration_target is not None and sow.registration_target <= 0:
        sow.registration_target = None
    return sow


def sanitize_poa(poa: PoaDetails) -> PoaDetails:
    """Belt and braces against the model inventing dates. A date the document states is
    kept as-is; one more than 30 days outside the stated campaign window is treated as
    invented (e.g. a default 1 Jan) and nulled. With no window, the yardstick is 120 days
    around the median of the document's own dates."""
    dated = sorted(a.date for a in poa.activities if a.date)
    if poa.window_start and poa.window_end:
        lo, hi = poa.window_start - timedelta(days=30), poa.window_end + timedelta(days=30)
    elif dated:
        median = dated[len(dated) // 2]
        lo, hi = median - timedelta(days=120), median + timedelta(days=120)
    else:
        return poa
    dropped = 0
    for a in poa.activities:
        if a.date and not lo <= a.date <= hi:
            a.date, dropped = None, dropped + 1
    if dropped:
        logger.warning("poa_dates_dropped", count=dropped, window=(str(lo), str(hi)))
    return poa


# ---- Sync ------------------------------------------------------------------

# Failed extractions are retried on later syncs, but not forever (each retry
# is a paid LLM call).
MAX_ATTEMPTS = 5
_CONCURRENCY = 4


def _first_file_id(raw: str | None) -> str | None:
    ids = [p.strip() for p in (raw or "").split(";") if p.strip()]
    return ids[0] if ids else None


def needs_processing(file_id: str, current: tuple | None) -> bool:
    """current = (stored hubspot_file_id, status, attempts[, schema_ok]) or None if no row.
    Process when there's no row, the file was replaced, or the last extraction
    failed and retries remain."""
    if current is None:
        return True
    stored_file_id, status, attempts, *rest = current
    if stored_file_id != file_id or (rest and not rest[0]):  # file replaced, or extracted by an older schema
        return True
    return status != "ok" and attempts < MAX_ATTEMPTS


async def sync_documents() -> int:
    """Bring every program's stored SOW/POA in line with its HubSpot file
    properties. Scans all programs (cheap) rather than only the tickets that
    changed this run, so a document that failed earlier is retried even when
    its ticket hasn't been edited since. Returns how many were processed."""
    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        programs = (
            await session.execute(select(Program.ticket_id, Program.raw_properties))
        ).all()
        existing = {
            # schema_ok False = an "ok" SOW extracted before registration_target existed: redo once.
            (t, k): (fid, status, attempts, status != "ok" or k != "sow" or "registration_target" in (details or {}))
            for t, k, fid, status, attempts, details in (
                await session.execute(
                    select(
                        ProgramDocument.ticket_id,
                        ProgramDocument.kind,
                        ProgramDocument.hubspot_file_id,
                        ProgramDocument.status,
                        ProgramDocument.attempts,
                        ProgramDocument.details,
                    )
                )
            ).all()
        }

    work: list[tuple[str, str, str, str, int]] = []
    for ticket_id, raw in programs:
        for kind, prop in DOCUMENT_PROPERTIES.items():
            file_id = _first_file_id((raw or {}).get(prop))
            current = existing.get((ticket_id, kind))
            if file_id is None:
                if current is not None:
                    await _delete_document(ticket_id, kind)
            elif needs_processing(file_id, current):
                same_file = current is not None and current[0] == file_id
                work.append((ticket_id, kind, prop, file_id, current[2] if same_file else 0))

    client = HubSpotClient()
    gate = asyncio.Semaphore(_CONCURRENCY)

    async def run(ticket_id: str, kind: str, prop: str, file_id: str, attempts: int) -> bool:
        async with gate:
            try:
                await _process(client, ticket_id, kind, prop, file_id, attempts)
                return True
            except Exception:
                logger.exception("document_sync_failed", ticket_id=ticket_id, kind=kind)
                return False

    return sum(await asyncio.gather(*(run(*w) for w in work)))


async def _process(
    client: HubSpotClient, ticket_id: str, kind: str, prop: str, file_id: str, attempts: int
) -> None:
    meta, content = await client.fetch_file(file_id)
    extension = (meta.get("extension") or "pdf").lower()

    details: dict | None = None
    error: str | None = None
    if extension == "pdf":
        try:
            extracted = await extract_details(kind, content)
            if kind == "poa":
                extracted = sanitize_poa(extracted)
            else:
                extracted = sanitize_sow(extracted)
            details = extracted.model_dump(mode="json")
            attempts = 0
        except Exception as e:
            attempts += 1
            error = str(e)[:500]
            logger.warning("document_extraction_failed", ticket_id=ticket_id, kind=kind, error=error)
    else:
        attempts = MAX_ATTEMPTS  # nothing to retry: viewable/downloadable only
        error = f"unsupported file type '{extension}' -- download only"

    row = {
        "ticket_id": ticket_id,
        "kind": kind,
        "hubspot_property": prop,
        "hubspot_file_id": file_id,
        "file_name": f"{meta.get('name', kind)}.{extension}",
        "mime_type": "application/pdf" if extension == "pdf" else "application/octet-stream",
        "size_bytes": len(content),
        "content": content,
        "uploaded_at": _parse_ts(meta.get("createdAt")),
        "status": "ok" if details is not None else "failed",
        "error": error,
        "attempts": attempts,
        "details": details,
        "extracted_at": datetime.now(timezone.utc),
    }
    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        stmt = insert(ProgramDocument).values(row)
        stmt = stmt.on_conflict_do_update(
            index_elements=["ticket_id", "kind"],
            set_={c: getattr(stmt.excluded, c) for c in row if c not in ("ticket_id", "kind")},
        )
        await session.execute(stmt)
        await session.commit()


async def _delete_document(ticket_id: str, kind: str) -> None:
    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        doc = await session.get(ProgramDocument, (ticket_id, kind))
        if doc is not None:
            await session.delete(doc)
            await session.commit()


def _parse_ts(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


# ---- Deal value ------------------------------------------------------------


def sow_matches_program(details: dict, company: str | None) -> bool:
    """The SOW only counts if it's about this ticket's client. With no known
    company there's nothing to contradict it, so it's accepted."""
    if not company:
        return True
    haystack = f"{details.get('customer', '')} {details.get('title', '')}".lower()
    return company.strip().lower().split()[0] in haystack


async def apply_sow_deal_value() -> None:
    """Expected deal value priority: SOW fee > ticket description > HubSpot
    field. The latter two are decided at sync time (models.ProgramTicket);
    this overrides with the SOW fee wherever an extracted SOW matches the
    client. Runs over all programs, so a document processed on a retry (for a
    ticket not re-synced this run) is applied too."""
    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        docs = (
            await session.execute(
                select(ProgramDocument.ticket_id, ProgramDocument.details).where(
                    ProgramDocument.kind == "sow", ProgramDocument.status == "ok"
                )
            )
        ).all()
        for ticket_id, details in docs:
            amount = (details or {}).get("fee_amount_inr")
            program = await session.get(Program, ticket_id)
            if amount and program and sow_matches_program(details, program.company_name):
                if program.expected_deal_size != amount or program.deal_size_source != "sow":
                    program.expected_deal_size = amount
                    program.deal_size_source = "sow"
        await session.commit()


if __name__ == "__main__":
    # Self-check of the pure logic (no network/DB).
    assert sow_matches_program({"customer": "Barclays Global Service Centre", "title": ""}, "Barclays")
    assert not sow_matches_program({"customer": "Deutsche Telekom", "title": "Talent Hack"}, "Barclays")
    assert sow_matches_program({"customer": "x"}, None)
    assert _first_file_id("12;34") == "12" and _first_file_id(None) is None
    assert needs_processing("1", None)  # no row yet
    assert needs_processing("2", ("1", "ok", 0))  # file replaced
    assert not needs_processing("1", ("1", "ok", 0))  # up to date
    assert needs_processing("1", ("1", "failed", MAX_ATTEMPTS - 1))  # retries left
    assert not needs_processing("1", ("1", "failed", MAX_ATTEMPTS))  # gave up
    assert needs_processing("1", ("1", "ok", 0, False))  # extracted by an older schema
    assert not needs_processing("1", ("1", "ok", 0, True))
    _sow = SowDetails.model_construct(registration_window_weeks_min=3, registration_window_weeks_max=2, registration_target=-5)
    _sow = sanitize_sow(_sow)
    assert _sow.registration_window_weeks_min is None and _sow.registration_target is None
    _act = lambda d: PoaActivity(date=d, week="", channel="Email", activity="a", objective="", description="")
    poa = PoaDetails(title="x", window_start=None, window_end=None,
                     activities=[_act(date(2026, m, d)) for m, d in [(1, 1), (6, 28), (7, 1), (7, 5)]] + [_act(None)])
    assert [a.date for a in sanitize_poa(poa).activities] == [None, date(2026, 6, 28), date(2026, 7, 1), date(2026, 7, 5), None]  # lone Jan 1 dropped
    poa = PoaDetails(title="x", window_start=date(2026, 6, 27), window_end=date(2026, 7, 15), activities=[_act(date(2026, 1, 1))])
    assert sanitize_poa(poa).activities[0].date is None  # months outside the stated window
    poa = PoaDetails(title="x", window_start=date(2026, 6, 27), window_end=date(2026, 7, 15), activities=[_act(date(2026, 7, 20)), _act(date(2026, 6, 20))])
    assert [a.date for a in sanitize_poa(poa).activities] == [date(2026, 7, 20), date(2026, 6, 20)]  # stated dates just outside the window are kept
    print("ok")
