"""The super admin's settings and the system status strip."""

from __future__ import annotations

from sqlalchemy import select

from core.orm import ProgramEvent, SlackOutbox
from core.permissions import Role


async def admin(client_for, make_user):
    return await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN], name="Sai"))


async def test_the_defaults_keep_reminders_off_until_a_time_is_set(client_for, make_user):
    body = (await (await admin(client_for, make_user)).get("/admin/settings")).json()
    assert body["reminders"] == {
        "reminder_time": None, "work_start": "09:00:00", "work_end": "18:00:00", "work_days": [0, 1, 2, 3, 4], "timezone": "Asia/Kolkata",
    }
    assert body["retention_days"] is None  # history is kept forever by default


async def test_the_super_admin_sets_the_reminder_time_hours_zone_and_retention(client_for, make_user):
    client = await admin(client_for, make_user)
    new = {"reminders": {"reminder_time": "09:30", "work_start": "10:00", "work_end": "19:00", "work_days": [0, 1, 2, 3, 4, 5], "timezone": "Asia/Kolkata"}, "retention_days": 730}
    assert (await client.put("/admin/settings", json=new)).status_code == 200
    saved = (await client.get("/admin/settings")).json()
    assert saved["reminders"]["reminder_time"] == "09:30:00" and saved["reminders"]["work_days"] == [0, 1, 2, 3, 4, 5]
    assert saved["retention_days"] == 730


async def test_bad_settings_are_refused(client_for, make_user):
    client = await admin(client_for, make_user)
    for reminders in (
        {"timezone": "Mars/Olympus"},
        {"work_start": "18:00", "work_end": "09:00"},
        {"work_days": []},
        {"work_days": [7]},
    ):
        assert (await client.put("/admin/settings", json={"reminders": reminders})).status_code == 422
    assert (await client.put("/admin/settings", json={"retention_days": 0})).status_code == 422


async def test_only_the_super_admin_can_read_or_change_settings(client_for, make_user):
    csm = await client_for(await make_user("csm@example.com", [Role.CSM]))
    assert (await csm.get("/admin/settings")).status_code == 403
    assert (await csm.put("/admin/settings", json={})).status_code == 403


async def test_changing_settings_is_audited_with_old_and_new(client_for, make_user, db):
    client = await admin(client_for, make_user)
    await client.put("/admin/settings", json={"reminders": {"reminder_time": "09:30"}})
    await client.put("/admin/settings", json={"reminders": {"reminder_time": "10:00"}})
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).where(ProgramEvent.action == "settings_changed").order_by(ProgramEvent.id))).all()
    assert events[0].old is None and events[1].old["reminders"]["reminder_time"] == "09:30:00"
    assert events[1].new["reminders"]["reminder_time"] == "10:00:00" and events[1].actor_name == "Sai"


async def test_the_status_strip_reports_freshness_and_stuck_messages(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        session.add_all([
            SlackOutbox(ticket_id="t1", kind="x", body="a", status="queued"),
            SlackOutbox(ticket_id="t1", kind="x", body="b", status="failed"),
            SlackOutbox(ticket_id="t1", kind="x", body="c", status="sent"),
        ])
        await session.commit()
    body = (await (await client_for(await make_user("m@example.com", [Role.MARKETING]))).get("/system/status")).json()
    assert (body["outbox_queued"], body["outbox_failed"]) == (1, 1)
    assert set(body) == {
        "hubspot_synced_at", "redash_registrations_synced_at", "sources_fetched_at", "outbox_queued", "outbox_failed",
        "hubspot_writeback_enabled",
    }
    assert body["hubspot_writeback_enabled"] is False  # off until the token is allowed to update tickets
