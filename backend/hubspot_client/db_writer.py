"""Persists normalized programs to Postgres.

Assumes the `programs` table (core.orm.Program) already exists -- schema is
managed via Alembic migrations, this module never creates or alters tables.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import structlog

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from core.database import db_manager
from core.orm import Program, ProgramNote, ProgramStageHistory
from hubspot_client.models import ProgramNoteModel, ProgramTicket, StageHistoryEvent

logger = structlog.get_logger(__name__)


# Postgres allows 65,535 bind parameters per statement; a multi-row INSERT uses
# rows x columns of them, so big batches must be split.
_MAX_PARAMS = 60_000


def chunk_rows(rows: list[dict], columns: int | None = None) -> list[list[dict]]:
    """Split rows so each INSERT stays under the bind-parameter limit."""
    if not rows:
        return []
    per_chunk = max(1, _MAX_PARAMS // (columns or len(rows[0])))
    return [rows[i : i + per_chunk] for i in range(0, len(rows), per_chunk)]


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def parse_date(value: str | None) -> date | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).date()


def _to_row(p: ProgramTicket, synced_at: datetime) -> dict:
    row = p.model_dump()
    row["created_at"] = parse_iso(row["created_at"])
    row["closed_at"] = parse_iso(row["closed_at"])
    row["last_modified_at"] = parse_iso(row["last_modified_at"])
    row["notes_last_updated"] = parse_iso(row["notes_last_updated"])
    row["registration_start_date"] = parse_date(row["registration_start_date"])
    row["event_end_date"] = parse_date(row["event_end_date"])
    row["first_synced_at"] = synced_at
    row["last_synced_at"] = synced_at
    return row


async def upsert_programs(programs: list[ProgramTicket]) -> None:
    """Insert-or-update programs by ticket_id. first_synced_at is set once,
    on insert, and never overwritten on update -- last_synced_at always
    advances to this run's timestamp."""
    if not programs:
        return

    synced_at = datetime.now(timezone.utc)
    rows = [_to_row(p, synced_at) for p in programs]
    update_cols = {c for c in rows[0] if c not in ("ticket_id", "first_synced_at")}

    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        for chunk in chunk_rows(rows):
            stmt = insert(Program).values(chunk)
            stmt = stmt.on_conflict_do_update(
                index_elements=["ticket_id"],
                set_={c: getattr(stmt.excluded, c) for c in update_cols},
            )
            await session.execute(stmt)
        await session.commit()


async def upsert_stage_history(events: list[StageHistoryEvent]) -> None:
    """Insert stage/checklist change events. Immutable once recorded --
    ON CONFLICT DO NOTHING on the (ticket_id, property_name, changed_at)
    unique constraint, since a re-sync re-fetches the same history HubSpot
    already has."""
    if not events:
        return

    rows = []
    for e in events:
        row = e.model_dump()
        row["changed_at"] = parse_iso(row["changed_at"])
        rows.append(row)

    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        for chunk in chunk_rows(rows):
            stmt = insert(ProgramStageHistory).values(chunk)
            stmt = stmt.on_conflict_do_nothing(
                index_elements=["ticket_id", "property_name", "changed_at"]
            )
            await session.execute(stmt)
        await session.commit()


async def upsert_notes(notes: list[ProgramNoteModel]) -> None:
    """Insert-or-update notes by note_id -- a note's body can be edited in
    HubSpot after creation."""
    if not notes:
        return

    rows = []
    for n in notes:
        row = n.model_dump()
        row["created_at"] = parse_iso(row["created_at"])
        rows.append(row)
    update_cols = {c for c in rows[0] if c != "note_id"}

    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        for chunk in chunk_rows(rows):
            stmt = insert(ProgramNote).values(chunk)
            stmt = stmt.on_conflict_do_update(
                index_elements=["note_id"],
                set_={c: getattr(stmt.excluded, c) for c in update_cols},
            )
            await session.execute(stmt)
        await session.commit()


# Refuse to wipe a big share of the table in one pass: an empty or partial
# answer from HubSpot (outage, permissions) must not look like "all deleted".
_MAX_DELETE_FRACTION = 0.5
_MIN_ROWS_FOR_GUARD = 10


def deletion_is_safe(existing: int, to_delete: int) -> bool:
    return existing < _MIN_ROWS_FOR_GUARD or to_delete <= existing * _MAX_DELETE_FRACTION


async def delete_missing_programs(hubspot_ids: set[str]) -> list[str]:
    """Remove programs no longer in the HubSpot pipeline (deleted, or moved to
    another pipeline). Child rows (history, notes, documents) cascade.
    Returns the deleted ticket ids; [] if the safety guard tripped."""
    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        existing = set((await session.execute(select(Program.ticket_id))).scalars())
        gone = sorted(existing - hubspot_ids)
        if not gone:
            return []
        if not deletion_is_safe(len(existing), len(gone)):
            logger.error("reconcile_skipped_unsafe", existing=len(existing), would_delete=len(gone))
            return []
        await session.execute(delete(Program).where(Program.ticket_id.in_(gone)))
        await session.commit()
        return gone
