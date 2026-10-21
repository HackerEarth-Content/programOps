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


class PortalSettings(BaseModel):
    reminders: ReminderSettings = ReminderSettings()
    # How long history is kept. None means forever. Nothing is ever deleted automatically in release 1:
    # this only records the choice, so a period can be picked later without rebuilding anything.
    retention_days: int | None = Field(default=None, ge=1)


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
