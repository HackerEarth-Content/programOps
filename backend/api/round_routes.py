"""Rounds, their counts, the funnel, and rounds suggested from the SOW."""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from core import rounds
from core.access import Access, require_permission
from core.database import get_session
from core.deps import program_or_404
from core.orm import ProgramRound, RoundCount
from core.permissions import Permission
from core.report import FunnelStepOut
from core.rounds import RoundKind, RoundSource, RoundStatus

router = APIRouter(
    prefix="/programs/{ticket_id}/rounds",
    tags=["rounds"],
    dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW)), Depends(program_or_404)],
)


class CountsFields(BaseModel):
    invited: int | None = Field(default=None, ge=0)
    attempted: int | None = Field(default=None, ge=0)  # participation
    cleared: int | None = Field(default=None, ge=0)  # cleared the cutoff
    shortlisted: int | None = Field(default=None, ge=0)
    note: str | None = None


class CountsIn(CountsFields):
    as_of: dt.date


class CountsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    round_id: int
    as_of: dt.date
    invited: int | None
    attempted: int | None
    cleared: int | None
    shortlisted: int | None
    note: str | None
    entered_by_name: str
    entered_at: dt.datetime
    supersedes_id: int | None


class RoundOut(BaseModel):
    id: int
    seq: int
    name: str
    kind: RoundKind
    starts_on: dt.date | None
    ends_on: dt.date | None
    cutoff_rule: str | None
    cutoff_value: float | None
    status: RoundStatus
    source: RoundSource
    latest_counts: CountsOut | None


class RoundIn(BaseModel):
    name: str = Field(min_length=1)
    kind: RoundKind = RoundKind.ASSESSMENT
    starts_on: dt.date | None = None
    ends_on: dt.date | None = None
    cutoff_rule: str | None = None
    cutoff_value: float | None = None
    source: RoundSource = RoundSource.MANUAL  # "sow" when accepted from a suggestion


class RoundPatch(BaseModel):
    """Only the fields present in the request are changed."""

    name: str | None = Field(default=None, min_length=1)
    kind: RoundKind | None = None
    starts_on: dt.date | None = None
    ends_on: dt.date | None = None
    cutoff_rule: str | None = None
    cutoff_value: float | None = None
    status: RoundStatus | None = None


class ReorderIn(BaseModel):
    order: list[int]


class SuggestedOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    notes: str


async def _round_outs(session: AsyncSession, ticket_id: str, rows: list[ProgramRound]) -> list[RoundOut]:
    counts = await rounds.latest_counts(session, [r.id for r in rows])
    out: list[RoundOut] = []
    for r in rows:
        out.append(
            RoundOut(
                id=r.id, seq=r.seq, name=r.name, kind=RoundKind(r.kind), starts_on=r.starts_on, ends_on=r.ends_on,
                cutoff_rule=r.cutoff_rule, cutoff_value=r.cutoff_value, status=RoundStatus(r.status),
                source=RoundSource(r.source),
                latest_counts=CountsOut.model_validate(counts[r.id]) if r.id in counts else None,
            )
        )
    return out


@router.get("", response_model=list[RoundOut])
async def list_rounds(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[RoundOut]:
    return await _round_outs(session, ticket_id, await rounds.list_rounds(session, ticket_id))


@router.get("/funnel", response_model=list[FunnelStepOut])
async def get_funnel(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[FunnelStepOut]:
    program_rounds = await rounds.list_rounds(session, ticket_id)
    steps = rounds.funnel(program_rounds, await rounds.latest_counts(session, [r.id for r in program_rounds]))
    return [FunnelStepOut.model_validate(s) for s in steps]


@router.get("/suggested", response_model=list[SuggestedOut])
async def suggested_rounds(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[SuggestedOut]:
    """Rounds the SOW describes that the program doesn't have yet. Accept one by creating it with source "sow"."""
    return [SuggestedOut.model_validate(s) for s in await rounds.suggested_from_sow(session, ticket_id)]


@router.post("", status_code=201, response_model=RoundOut)
async def add_round(
    ticket_id: str,
    body: RoundIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ROUNDS_EDIT)),
) -> RoundOut:
    row = await rounds.create_round(
        session, access.user, ticket_id, name=body.name, kind=body.kind, starts_on=body.starts_on,
        ends_on=body.ends_on, cutoff_rule=body.cutoff_rule, cutoff_value=body.cutoff_value, source=body.source,
    )
    await session.commit()
    return (await _round_outs(session, ticket_id, [row]))[0]


@router.post("/reorder", response_model=list[RoundOut])
async def reorder_rounds(
    ticket_id: str,
    body: ReorderIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ROUNDS_EDIT)),
) -> list[RoundOut]:
    ordered = await rounds.reorder(session, access.user, ticket_id, body.order)
    await session.commit()
    return await _round_outs(session, ticket_id, ordered)


@router.patch("/{round_id}", response_model=RoundOut)
async def patch_round(
    ticket_id: str,
    round_id: int,
    body: RoundPatch,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ROUNDS_EDIT)),
) -> RoundOut:
    row = await rounds.get(session, ticket_id, round_id)
    await rounds.update_round(session, access.user, row, body.model_dump(exclude_unset=True))
    await session.commit()
    return (await _round_outs(session, ticket_id, [row]))[0]


@router.delete("/{round_id}", status_code=204)
async def delete_round(
    ticket_id: str,
    round_id: int,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.ROUNDS_EDIT)),
) -> Response:
    await rounds.delete_round(session, access.user, await rounds.get(session, ticket_id, round_id))
    await session.commit()
    return Response(status_code=204)


@router.get("/{round_id}/counts", response_model=list[CountsOut])
async def list_counts(ticket_id: str, round_id: int, session: AsyncSession = Depends(get_session)) -> list[RoundCount]:
    await rounds.get(session, ticket_id, round_id)
    return await rounds.standing_counts(session, round_id)


@router.post("/{round_id}/counts", status_code=201, response_model=CountsOut)
async def add_counts(
    ticket_id: str,
    round_id: int,
    body: CountsIn,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.COUNTS_ENTER)),
) -> RoundCount:
    row = await rounds.get(session, ticket_id, round_id)
    entry = await rounds.add_counts(session, access.user, row, **body.model_dump())
    await session.commit()
    return entry


@router.post("/{round_id}/counts/{count_id}/supersede", status_code=201, response_model=CountsOut)
async def correct_counts(
    ticket_id: str,
    round_id: int,
    count_id: int,
    body: CountsFields,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.COUNTS_ENTER)),
) -> RoundCount:
    row = await rounds.get(session, ticket_id, round_id)
    entry = await rounds.supersede_counts(session, access.user, row, count_id, **body.model_dump())
    await session.commit()
    return entry
