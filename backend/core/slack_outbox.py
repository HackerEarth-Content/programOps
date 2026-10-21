"""The Slack outbox. Every message the portal sends goes through here: queued when something happens, sent by a
worker. A message is never lost when Slack is down, a repeated reminder is recognised by its `dedupe_key`, and the
log shows what went out (and why something didn't)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from enum import StrEnum

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core import slack
from core.orm import ProgramRegistrationSettings, SlackOutbox

MAX_ATTEMPTS = 3

Post = Callable[[str, str], Awaitable[tuple[bool, str]]]


class OutboxStatus(StrEnum):
    QUEUED = "queued"
    SENT = "sent"
    FAILED = "failed"  # tried MAX_ATTEMPTS times
    SKIPPED = "skipped"  # the program has no Slack channel linked


async def enqueue(
    session: AsyncSession, *, ticket_id: str | None, kind: str, body: str, dedupe_key: str | None = None
) -> SlackOutbox | None:
    """Queue a message for the program's linked channel. None when `dedupe_key` was already used. A program with no
    channel gets a `skipped` row, so the gap is visible instead of silent. The caller commits."""
    if dedupe_key and await session.scalar(select(SlackOutbox.id).where(SlackOutbox.dedupe_key == dedupe_key)):
        return None
    cfg = await session.get(ProgramRegistrationSettings, ticket_id) if ticket_id else None
    channel = cfg.slack_channel_id if cfg else None
    message = SlackOutbox(
        ticket_id=ticket_id, channel_id=channel, kind=kind, body=body, dedupe_key=dedupe_key,
        status=OutboxStatus.QUEUED if channel else OutboxStatus.SKIPPED,
        error=None if channel else "No Slack channel is linked to this program.",
    )
    session.add(message)
    await session.flush()
    return message


async def send_pending(
    factory: async_sessionmaker[AsyncSession], post: Post = slack.post_message, limit: int = 50
) -> int:
    """Send queued messages. A failure is recorded and retried on the next run, up to MAX_ATTEMPTS. Returns the number sent."""
    sent = 0
    async with factory() as session:
        queued = (
            await session.scalars(
                select(SlackOutbox).where(SlackOutbox.status == OutboxStatus.QUEUED.value)
                .order_by(SlackOutbox.id).limit(limit).with_for_update(skip_locked=True)
            )
        ).all()
        for message in queued:
            ok, error = await post(message.channel_id or "", message.body)
            message.attempts += 1
            if ok:
                message.status, message.sent_at, message.error = OutboxStatus.SENT.value, datetime.now(timezone.utc), None
                sent += 1
            else:
                message.error = error[:300]
                if message.attempts >= MAX_ATTEMPTS:
                    message.status = OutboxStatus.FAILED.value
        await session.commit()
    return sent


async def recent(session: AsyncSession, ticket_id: str, limit: int = 30) -> list[SlackOutbox]:
    rows = await session.scalars(
        select(SlackOutbox).where(SlackOutbox.ticket_id == ticket_id).order_by(SlackOutbox.id.desc()).limit(limit)
    )
    return list(rows.all())
