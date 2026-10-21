"""System status, a program's Slack outbox, and the super admin's settings."""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import redash_sync, settings_store, slack_outbox
from core.access import Access, require_permission
from core.config import settings
from core.database import get_session
from core.deps import program_or_404
from core.orm import ChannelSnapshot, Program, SlackOutbox, SyncCursor
from core.permissions import Permission
from core.report import PortfolioOut, build_portfolio
from core.settings_store import PortalSettings
from core.slack_outbox import OutboxStatus

router = APIRouter(tags=["system"], dependencies=[Depends(require_permission(Permission.PROGRAM_VIEW))])


class SystemStatus(BaseModel):
    hubspot_synced_at: dt.datetime | None
    redash_registrations_synced_at: dt.datetime | None
    sources_fetched_at: dt.datetime | None
    outbox_queued: int
    outbox_failed: int
    hubspot_writeback_enabled: bool  # false: hide the controls that change HubSpot


@router.get("/system/status", response_model=SystemStatus)
async def system_status(session: AsyncSession = Depends(get_session)) -> SystemStatus:
    """How fresh each source is, for the "synced 4 min ago" strip, and whether Slack messages are stuck."""
    cursor = await session.get(SyncCursor, "hubspot_programs")
    counts = dict(
        (await session.execute(select(SlackOutbox.status, func.count()).group_by(SlackOutbox.status))).all()
    )
    return SystemStatus(
        hubspot_synced_at=cursor.last_synced_at if cursor else None,
        redash_registrations_synced_at=redash_sync.state.get("finished_at"),
        sources_fetched_at=await session.scalar(select(func.max(ChannelSnapshot.fetched_at)).where(ChannelSnapshot.status == "ok")),
        outbox_queued=counts.get(OutboxStatus.QUEUED.value, 0),
        outbox_failed=counts.get(OutboxStatus.FAILED.value, 0),
        hubspot_writeback_enabled=settings.HUBSPOT_WRITEBACK_ENABLED,
    )


class OutboxOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    body: str
    status: OutboxStatus
    attempts: int
    error: str | None
    created_at: dt.datetime
    sent_at: dt.datetime | None


@router.get("/programs/{ticket_id}/outbox", response_model=list[OutboxOut], dependencies=[Depends(program_or_404)])
async def program_outbox(ticket_id: str, session: AsyncSession = Depends(get_session)) -> list[SlackOutbox]:
    """What the portal has sent (or tried to send) to this program's Slack channel."""
    return await slack_outbox.recent(session, ticket_id)


@router.get(
    "/admin/settings", response_model=PortalSettings, dependencies=[Depends(require_permission(Permission.SETTINGS_EDIT))]
)
async def get_settings(session: AsyncSession = Depends(get_session)) -> PortalSettings:
    return await settings_store.load(session)


@router.put("/admin/settings", response_model=PortalSettings)
async def put_settings(
    body: PortalSettings,
    session: AsyncSession = Depends(get_session),
    access: Access = Depends(require_permission(Permission.SETTINGS_EDIT)),
) -> PortalSettings:
    """Reminder time, working hours, time zone and retention. Reminders stay off until a reminder time is set."""
    saved = await settings_store.save(session, access.user, body)
    await session.commit()
    return saved


# ---- portfolio and search (the programs directory) ------------------------------------


@router.get("/portfolio", response_model=PortfolioOut)
async def get_portfolio(session: AsyncSession = Depends(get_session)) -> PortfolioOut:
    """The directory header and cards: health, registrations against target, stages, and the open action items."""
    return await build_portfolio(session)


class SearchHit(BaseModel):
    ticket_id: str
    name: str
    client: str | None
    stage: str
    csm: str | None


@router.get("/search", response_model=list[SearchHit])
async def search_programs(q: str = Query(min_length=2, max_length=100), session: AsyncSession = Depends(get_session)) -> list[SearchHit]:
    """Programs by name, ticket id, client or CSM. At most 20, newest first."""
    pattern = f"%{q.strip()}%"
    rows = await session.scalars(
        select(Program)
        .where(or_(
            Program.event_name.ilike(pattern), Program.subject.ilike(pattern), Program.ticket_id.ilike(pattern),
            Program.company_name.ilike(pattern), Program.csm_name.ilike(pattern),
        ))
        .order_by(Program.created_at.desc()).limit(20)
    )
    return [
        SearchHit(ticket_id=p.ticket_id, name=p.display_name, client=p.company_name, stage=p.stage_label, csm=p.csm_name)
        for p in rows.all()
    ]
