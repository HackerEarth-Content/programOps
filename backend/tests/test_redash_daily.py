"""The scheduled Redash fetch: once a day at the super admin's time, only programs in their registration period (and a
few days after it, while the last counts settle), today's count only, one Slack message per program per day."""

from __future__ import annotations

from datetime import date, datetime, time, timezone

from sqlalchemy import select

from core import redash_sync, settings_store
from core.orm import Program, ProgramRegistration, ProgramRegistrationSettings, SlackOutbox
from core.permissions import Role
from core.settings_store import PortalSettings

# Monday 11:00 in Kolkata (05:30 UTC)
NOW = datetime(2026, 10, 19, 5, 30, tzinfo=timezone.utc)
TODAY, YESTERDAY = date(2026, 10, 19), date(2026, 10, 18)


async def link(db, start=date(2026, 10, 1), end=date(2026, 10, 30), notify=True):
    async with db() as session:
        session.add(ProgramRegistrationSettings(
            ticket_id="t1", roles=[], fields=[], slack_channel_id="C0123456789", notify_slack=notify,
            redash_auto=True, redash_event_slug="ev", redash_event_start=start, redash_event_end=end,
        ))
        await session.commit()


def fake_fetch(monkeypatch, days):
    async def fetch(slug):
        return {"name": "Ev", "start": None, "end": None}, days
    monkeypatch.setattr(redash_sync, "fetch_event", fetch)
    monkeypatch.setattr(redash_sync, "event_dates", lambda info: (date(2026, 10, 1), date(2026, 10, 30)))


async def outbox(db):
    async with db() as session:
        return list((await session.scalars(select(SlackOutbox))).all())


async def test_posts_today_only_once_a_day(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db)
    fake_fetch(monkeypatch, {YESTERDAY: 10, TODAY: 25})
    await redash_sync.run_all(NOW)
    [message] = await outbox(db)
    assert "19 Oct 2026" in message.body and "18 Oct" not in message.body and "25 registrations" in message.body
    assert "Auto-fetched" in message.body
    async with db() as session:  # yesterday is saved, just not announced
        assert (await session.scalar(select(ProgramRegistration.registrations).where(ProgramRegistration.date == YESTERDAY))) == 10
    fake_fetch(monkeypatch, {YESTERDAY: 10, TODAY: 30})
    await redash_sync.run_all(NOW)
    assert len(await outbox(db)) == 1  # same day: not posted again


async def test_skips_programs_outside_the_registration_period_or_without_dates(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, start=date(2026, 9, 1), end=date(2026, 9, 30))
    fake_fetch(monkeypatch, {TODAY: 25})
    await redash_sync.run_all(NOW)
    assert await outbox(db) == [] and redash_sync.state["skipped"] == 1
    assert not redash_sync.in_registration_period({"start": None, "end": None}, TODAY)


async def test_an_event_that_just_ended_is_still_refreshed_so_its_last_days_settle(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, start=date(2026, 10, 1), end=date(2026, 10, 17))  # ended two days ago
    fake_fetch(monkeypatch, {date(2026, 10, 16): 844 + 1348, date(2026, 10, 17): 1009})
    await redash_sync.run_all(NOW)
    assert redash_sync.state["programs"] == 1 and redash_sync.state["skipped"] == 0
    async with db() as session:
        stored = {r.date: r.registrations for r in (await session.scalars(select(ProgramRegistration))).all()}
    assert stored == {date(2026, 10, 16): 2192, date(2026, 10, 17): 1009}  # the late numbers arrive
    assert await outbox(db) == []  # nothing is announced for a day that isn't today


async def test_the_refresh_stops_after_the_grace_days(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, start=date(2026, 10, 1), end=date(2026, 10, 15))  # grace ran to 18 Oct; today is 19 Oct
    fake_fetch(monkeypatch, {date(2026, 10, 15): 5})
    await redash_sync.run_all(NOW)
    assert redash_sync.state["programs"] == 0 and redash_sync.state["skipped"] == 1


def test_the_period_runs_from_the_start_to_a_few_days_after_the_end():
    window = {"start": date(2026, 10, 1), "end": date(2026, 10, 10)}
    in_period = redash_sync.in_registration_period
    assert not in_period(window, date(2026, 9, 30))
    assert in_period(window, date(2026, 10, 1)) and in_period(window, date(2026, 10, 10))
    assert in_period(window, date(2026, 10, 13))  # the last grace day
    assert not in_period(window, date(2026, 10, 14))


async def test_no_post_when_notify_is_off_or_today_is_unchanged(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, notify=False)
    fake_fetch(monkeypatch, {TODAY: 25})
    await redash_sync.run_all(NOW)
    assert await outbox(db) == []


async def test_the_daily_tick_waits_for_the_set_time_and_runs_once(db, make_user, make_program, monkeypatch):
    await make_program("t1")
    await link(db)
    fake_fetch(monkeypatch, {TODAY: 25})
    monkeypatch.setattr(redash_sync, "_last_scheduled", None)
    assert await redash_sync.run_daily(NOW) is False  # no time set: off
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    async with db() as session:
        await settings_store.save(session, admin, PortalSettings(redash_sync_time=time(12, 0)))
        await session.commit()
    assert await redash_sync.run_daily(NOW) is False  # 11:00 Kolkata, before 12:00
    later = datetime(2026, 10, 19, 6, 31, tzinfo=timezone.utc)  # 12:01 Kolkata
    assert await redash_sync.run_daily(later) is True
    assert await redash_sync.run_daily(later) is False  # once a day
    assert len(await outbox(db)) == 1
