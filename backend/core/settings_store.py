"""Portal-wide settings, edited by the super admin: when reminders go out, working hours, the time zone, and the
history retention period. Reminders stay off until a reminder time is set."""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit
from core.orm import AppSetting, User

_KEY = "portal"


class ReminderSettings(BaseModel):
    reminder_time: dt.time | None = None  # daily time for the "no update yet" nudge; None keeps all reminders off
    work_start: dt.time = dt.time(9, 0)
    work_end: dt.time = dt.time(18, 0)
    work_days: list[int] = [0, 1, 2, 3, 4]  # Monday is 0
    timezone: str = "Asia/Kolkata"

    @field_validator("timezone")
    @classmethod
    def _known_zone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError(f"Unknown time zone: {value}") from error
        return value

    @field_validator("work_days")
    @classmethod
    def _days(cls, value: list[int]) -> list[int]:
        days = sorted(set(value))
        if not days or any(d not in range(7) for d in days):
            raise ValueError("Working days are 0 (Monday) to 6 (Sunday), at least one.")
        return days

    @model_validator(mode="after")
    def _hours(self) -> ReminderSettings:
        if self.work_end <= self.work_start:
            raise ValueError("Working hours must end after they start.")
        return self


class SlackSettings(BaseModel):
    """What ProgramOps may send to Slack. The master switch pauses everything (data keeps syncing); the type
    switches pause one kind. Reminders: only the informative ones are ever sent (go-live due, approvals waiting, ...)."""

    enabled: bool = True
    registration_counts: bool = True  # scheduled count posts and the manual "Fetch from Redash" post
    csm_updates: bool = True  # daily updates and counts a CSM posts
    nudges_requests: bool = True  # marketing nudges, special requests, "approval withdrawn from a live activity"
    reminders: bool = True  # go-live due, approval waiting, overdue requests and dependencies, changes awaiting approval


# Outbox message kind -> the switch that governs it. A kind not listed here is a reminder.
SLACK_CATEGORY = {
    "registrations": "registration_counts",
    "daily_update": "csm_updates",
    "nudge": "nudges_requests",
    "request": "nudges_requests",
    "breach": "nudges_requests",
}
MAX_SYNC_TIMES = 6


class PortalSettings(BaseModel):
    reminders: ReminderSettings = ReminderSettings()
    slack: SlackSettings = SlackSettings()
    # Times of day (in the reminders time zone) the registration counts are fetched from Redash and posted to
    # Slack. Empty keeps the scheduled fetch off; the "Fetch from Redash" button still works.
    redash_sync_times: list[dt.time] = []
    # How long history is kept. None means forever. Nothing is ever deleted automatically in release 1:
    # this only records the choice, so a period can be picked later without rebuilding anything.
    retention_days: int | None = Field(default=None, ge=1)

    @model_validator(mode="before")
    @classmethod
    def _legacy_single_time(cls, data):
        """Settings saved before there could be several times hold one `redash_sync_time`."""
        if isinstance(data, dict) and "redash_sync_time" in data:
            data = dict(data)
            single = data.pop("redash_sync_time")
            if single is not None and not data.get("redash_sync_times"):
                data["redash_sync_times"] = [single]
        return data

    @field_validator("redash_sync_times")
    @classmethod
    def _times(cls, value: list[dt.time]) -> list[dt.time]:
        times = sorted(set(t.replace(second=0, microsecond=0) for t in value))
        if len(times) > MAX_SYNC_TIMES:
            raise ValueError(f"At most {MAX_SYNC_TIMES} posting times.")
        return times


def slack_allows(settings: PortalSettings, category: str) -> bool:
    return settings.slack.enabled and getattr(settings.slack, category)


async def slack_allowed(session: AsyncSession, category: str) -> bool:
    """Whether the admin settings let this kind of message out right now."""
    return slack_allows(await load(session), category)


async def load(session: AsyncSession) -> PortalSettings:
    row = await session.get(AppSetting, _KEY)
    return PortalSettings.model_validate(row.value) if row else PortalSettings()


async def save(session: AsyncSession, actor: User, new: PortalSettings) -> PortalSettings:
    row = await session.get(AppSetting, _KEY)
    old = row.value if row else None
    value = new.model_dump(mode="json")
    if row is None:
        session.add(AppSetting(key=_KEY, value=value, updated_by=actor.id))
    else:
        row.value, row.updated_by, row.updated_at = value, actor.id, dt.datetime.now(dt.timezone.utc)
    audit.record(session, actor, entity="settings", entity_id=_KEY, action="settings_changed", old=old, new=value)
    return new
