"""Rounds of selection and their counts. Any program shape: the CSM adds, renames, reorders and removes rounds.

Counts are append-only (a correction supersedes the old row) and the latest standing row per round is "current".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit
from core.errors import DomainError
from core.orm import ProgramDocument, ProgramRegistration, ProgramRound, RoundCount, User


class RoundKind(StrEnum):
    ASSESSMENT = "assessment"
    PROJECT = "project"
    INTERVIEW = "interview"
    ONSITE = "onsite"
    CUSTOM = "custom"


class RoundStatus(StrEnum):
    PLANNED = "planned"
    LIVE = "live"
    EVALUATING = "evaluating"
    DONE = "done"


class RoundSource(StrEnum):
    SOW = "sow"
    MANUAL = "manual"


ROUND_EDITABLE = frozenset({"name", "kind", "starts_on", "ends_on", "cutoff_rule", "cutoff_value", "status"})


def _check_dates(starts_on: date | None, ends_on: date | None) -> None:
    if starts_on and ends_on and ends_on < starts_on:
        raise DomainError("round_dates_invalid", "A round can't end before it starts.", 422)


def _jsonable(value: Any) -> Any:
    return value.isoformat() if isinstance(value, date) else getattr(value, "value", value)


async def list_rounds(session: AsyncSession, ticket_id: str) -> list[ProgramRound]:
    rows = await session.scalars(select(ProgramRound).where(ProgramRound.ticket_id == ticket_id).order_by(ProgramRound.seq))
    return list(rows.all())


async def get(session: AsyncSession, ticket_id: str, round_id: int) -> ProgramRound:
    row = await session.get(ProgramRound, round_id)
    if row is None or row.ticket_id != ticket_id:
        raise DomainError("round_not_found", "Round not found.", 404)
    return row


async def create_round(
    session: AsyncSession,
    actor: User,
    ticket_id: str,
    *,
    name: str,
    kind: RoundKind,
    starts_on: date | None,
    ends_on: date | None,
    cutoff_rule: str | None,
    cutoff_value: float | None,
    source: RoundSource = RoundSource.MANUAL,
) -> ProgramRound:
    _check_dates(starts_on, ends_on)
    seq = (await session.scalar(select(func.max(ProgramRound.seq)).where(ProgramRound.ticket_id == ticket_id)) or 0) + 1
    row = ProgramRound(
        ticket_id=ticket_id, seq=seq, name=name.strip(), kind=kind.value, starts_on=starts_on, ends_on=ends_on,
        cutoff_rule=cutoff_rule, cutoff_value=cutoff_value, source=source.value,
    )
    session.add(row)
    await session.flush()
    audit.record(session, actor, entity="round", entity_id=str(row.id), ticket_id=ticket_id,
                 action="round_added", new={"name": row.name, "kind": row.kind, "seq": seq})
    return row


async def update_round(session: AsyncSession, actor: User, row: ProgramRound, changes: Mapping[str, Any]) -> ProgramRound:
    unknown = set(changes) - ROUND_EDITABLE
    if unknown:
        raise DomainError("field_not_editable", f"Not editable here: {', '.join(sorted(unknown))}", 422)
    _check_dates(changes.get("starts_on", row.starts_on), changes.get("ends_on", row.ends_on))
    for field, value in changes.items():
        value = value.value if isinstance(value, StrEnum) else value
        if isinstance(value, str):
            value = value.strip() or None
        if field == "name" and value is None:
            raise DomainError("round_name_required", "A round needs a name.", 422)
        old = getattr(row, field)
        if old != value:
            audit.record(session, actor, entity="round", entity_id=str(row.id), ticket_id=row.ticket_id,
                         action="round_updated", field=field, old=_jsonable(old), new=_jsonable(value))
            setattr(row, field, value)
    return row


async def delete_round(session: AsyncSession, actor: User, row: ProgramRound) -> None:
    audit.record(session, actor, entity="round", entity_id=str(row.id), ticket_id=row.ticket_id,
                 action="round_deleted", old={"name": row.name, "seq": row.seq})
    ticket_id = row.ticket_id
    await session.execute(delete(ProgramRound).where(ProgramRound.id == row.id))
    await session.flush()
    for seq, remaining in enumerate(await list_rounds(session, ticket_id), start=1):
        remaining.seq = seq  # keep the order contiguous


async def reorder(session: AsyncSession, actor: User, ticket_id: str, ordered_ids: Sequence[int]) -> list[ProgramRound]:
    rounds = await list_rounds(session, ticket_id)
    if sorted(ordered_ids) != sorted(r.id for r in rounds):
        raise DomainError("reorder_mismatch", "Send every round of this program exactly once.", 422)
    by_id = {r.id: r for r in rounds}
    old = [r.id for r in rounds]
    for seq, round_id in enumerate(ordered_ids, start=1):
        by_id[round_id].seq = seq
    if list(ordered_ids) != old:
        audit.record(session, actor, entity="rounds", entity_id=ticket_id, ticket_id=ticket_id,
                     action="rounds_reordered", old=old, new=list(ordered_ids))
    return sorted(rounds, key=lambda r: r.seq)


# ---- counts --------------------------------------------------------------------


def validate_counts(invited: int | None, attempted: int | None, cleared: int | None, shortlisted: int | None) -> None:
    """Each step can't exceed the one before it: attempted <= invited, cleared <= attempted, and shortlisted <= cleared
    (or <= attempted / invited when the earlier steps weren't entered)."""
    shortlist_cap, cap_label = next(
        ((v, label) for v, label in ((cleared, "cleared"), (attempted, "attempted"), (invited, "invited")) if v is not None),
        (None, ""),
    )
    for label, part, whole, whole_label in (
        ("attempted", attempted, invited, "invited"),
        ("cleared", cleared, attempted, "attempted"),
        ("shortlisted", shortlisted, shortlist_cap, cap_label),
    ):
        if part is not None and whole is not None and part > whole:
            raise DomainError("counts_inconsistent", f"{label.capitalize()} ({part}) can't exceed {whole_label} ({whole}).", 422)


async def _check_across_rounds(
    session: AsyncSession, row: ProgramRound, invited: int | None, shortlisted: int | None
) -> None:
    """Rounds feed each other: a round can only invite people the round before shortlisted (the first round only
    people who registered), and a shortlist can't drop below what the next round already invited."""
    ordered = await list_rounds(session, row.ticket_id)
    at = next((i for i, r in enumerate(ordered) if r.id == row.id), None)
    if at is None:
        return
    before = ordered[at - 1] if at > 0 else None
    after = ordered[at + 1] if at + 1 < len(ordered) else None
    latest = await latest_counts(session, [r.id for r in (before, after) if r])
    previous = latest.get(before.id) if before else None
    following = latest.get(after.id) if after else None
    if invited is not None:
        if previous is not None and previous.shortlisted is not None and invited > previous.shortlisted:
            raise DomainError(
                "invited_exceeds_previous_shortlist",
                f"Invited ({invited}) can't exceed the {previous.shortlisted} shortlisted in {before.name}.", 422,
            )
        if before is None:
            registered = await session.scalar(
                select(func.coalesce(func.sum(ProgramRegistration.registrations), 0)).where(ProgramRegistration.ticket_id == row.ticket_id)
            )
            if registered and invited > registered:
                raise DomainError(
                    "invited_exceeds_registrations",
                    f"Invited ({invited}) can't exceed the {registered} registrations recorded for this program.", 422,
                )
    if shortlisted is not None and following is not None and following.invited is not None and shortlisted < following.invited:
        raise DomainError(
            "shortlist_below_next_invited",
            f"{after.name} already invited {following.invited}, so shortlisted can't be {shortlisted}. "
            f"Correct {after.name} first.", 422,
        )


async def add_counts(
    session: AsyncSession,
    actor: User,
    row: ProgramRound,
    *,
    as_of: date,
    invited: int | None,
    attempted: int | None,
    cleared: int | None,
    shortlisted: int | None,
    note: str | None,
    supersedes_id: int | None = None,
) -> RoundCount:
    validate_counts(invited, attempted, cleared, shortlisted)
    await _check_across_rounds(session, row, invited, shortlisted)
    entry = RoundCount(
        round_id=row.id, as_of=as_of, invited=invited, attempted=attempted, cleared=cleared,
        shortlisted=shortlisted, note=note, entered_by=actor.id, entered_by_name=actor.name or actor.email,
        supersedes_id=supersedes_id,
    )
    session.add(entry)
    await session.flush()
    audit.record(
        session, actor, entity="round_counts", entity_id=str(entry.id), ticket_id=row.ticket_id,
        action="counts_corrected" if supersedes_id else "counts_added",
        new={"round": row.name, "as_of": as_of.isoformat(), "invited": invited, "attempted": attempted,
             "cleared": cleared, "shortlisted": shortlisted},
    )
    return entry


async def supersede_counts(
    session: AsyncSession, actor: User, row: ProgramRound, count_id: int, **fields: Any
) -> RoundCount:
    old = await session.get(RoundCount, count_id)
    if old is None or old.round_id != row.id:
        raise DomainError("counts_not_found", "Counts entry not found.", 404)
    if await session.scalar(select(RoundCount.id).where(RoundCount.supersedes_id == old.id)):
        raise DomainError("counts_superseded", "That entry was already corrected. Correct the newer one.")
    return await add_counts(session, actor, row, as_of=old.as_of, supersedes_id=old.id, **fields)


async def standing_counts(session: AsyncSession, round_id: int) -> list[RoundCount]:
    """Every entry that hasn't been superseded, newest as-of date first."""
    superseded = select(RoundCount.supersedes_id).where(RoundCount.round_id == round_id, RoundCount.supersedes_id.is_not(None))
    rows = await session.scalars(
        select(RoundCount).where(RoundCount.round_id == round_id, RoundCount.id.not_in(superseded))
        .order_by(RoundCount.as_of.desc(), RoundCount.id.desc())
    )
    return list(rows.all())


async def latest_counts(session: AsyncSession, round_ids: Sequence[int]) -> dict[int, RoundCount]:
    """The current counts per round: the standing entry with the latest as-of date."""
    out: dict[int, RoundCount] = {}
    for round_id in round_ids:
        standing = await standing_counts(session, round_id)
        if standing:
            out[round_id] = standing[0]
    return out


# ---- the funnel ------------------------------------------------------------------


def _pct(part: int | None, whole: int | None) -> float | None:
    return round(100 * part / whole, 1) if part is not None and whole else None


@dataclass(frozen=True)
class FunnelStep:
    round_id: int
    name: str
    seq: int
    status: str
    as_of: date | None
    invited: int | None
    attempted: int | None
    cleared: int | None
    shortlisted: int | None
    participation_pct: float | None  # attempted / invited
    clearance_pct: float | None  # cleared / attempted
    shortlist_pct: float | None  # shortlisted / attempted
    drop_off: int | None  # invited but didn't attempt


def funnel(rounds: Sequence[ProgramRound], counts: Mapping[int, RoundCount]) -> list[FunnelStep]:
    steps: list[FunnelStep] = []
    for r in sorted(rounds, key=lambda r: r.seq):
        c = counts.get(r.id)
        steps.append(
            FunnelStep(
                round_id=r.id, name=r.name, seq=r.seq, status=r.status, as_of=c.as_of if c else None,
                invited=c.invited if c else None, attempted=c.attempted if c else None,
                cleared=c.cleared if c else None,
                shortlisted=c.shortlisted if c else None,
                participation_pct=_pct(c.attempted, c.invited) if c else None,
                clearance_pct=_pct(c.cleared, c.attempted) if c else None,
                shortlist_pct=_pct(c.shortlisted, c.attempted) if c else None,
                drop_off=(c.invited - c.attempted) if c and c.invited is not None and c.attempted is not None else None,
            )
        )
    return steps


# ---- suggestions from the SOW ------------------------------------------------------


@dataclass(frozen=True)
class SuggestedRound:
    name: str
    notes: str


async def suggested_from_sow(session: AsyncSession, ticket_id: str) -> list[SuggestedRound]:
    """The rounds the SOW describes that this program doesn't have yet, for the CSM to accept or ignore."""
    details = await session.scalar(
        select(ProgramDocument.details).where(
            ProgramDocument.ticket_id == ticket_id, ProgramDocument.kind == "sow", ProgramDocument.status == "ok"
        )
    )
    have = {r.name.strip().lower() for r in await list_rounds(session, ticket_id)}
    return [
        SuggestedRound(name=r["name"], notes="; ".join(r.get("details") or []))
        for r in (details or {}).get("rounds") or []
        if r.get("name") and r["name"].strip().lower() not in have
    ]
