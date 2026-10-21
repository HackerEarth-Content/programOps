"""The Slack outbox, reminders, nudges and the alerts that go through the outbox."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select, text

from core import reminders, settings_store, slack_outbox
from core.orm import ProgramActivity, ProgramRegistrationSettings, SlackOutbox
from core.permissions import Role
from core.settings_store import PortalSettings, ReminderSettings

# A Monday, 11:00 in Kolkata (05:30 UTC): inside the default working hours.
MONDAY = datetime(2026, 10, 19, 5, 30, tzinfo=timezone.utc)


def days(n: int, base: datetime = MONDAY) -> str:
    return (base.date() + timedelta(days=n)).isoformat()


async def link_slack(db, ticket_id="t1"):
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, ticket_id)
        if cfg is None:
            session.add(ProgramRegistrationSettings(ticket_id=ticket_id, roles=[], fields=[], slack_channel_id="C0123456789"))
        else:
            cfg.slack_channel_id = "C0123456789"
        await session.commit()


async def set_reminders(db, make_user, **kwargs):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    async with db() as session:
        await settings_store.save(session, admin, PortalSettings(reminders=ReminderSettings(**kwargs)))
        await session.commit()


async def outbox(db) -> list[SlackOutbox]:
    async with db() as session:
        return list((await session.scalars(select(SlackOutbox).order_by(SlackOutbox.id))).all())


# ---- the outbox ------------------------------------------------------------------


async def test_a_message_for_a_linked_channel_is_queued(db, make_program):
    await make_program("t1")
    await link_slack(db)
    async with db() as session:
        message = await slack_outbox.enqueue(session, ticket_id="t1", kind="nudge", body="hello")
        await session.commit()
    assert (message.status, message.channel_id, message.error) == ("queued", "C0123456789", None)


async def test_a_program_without_a_channel_gets_a_visible_skipped_row(db, make_program):
    await make_program("t1")
    async with db() as session:
        message = await slack_outbox.enqueue(session, ticket_id="t1", kind="nudge", body="hello")
        await session.commit()
    assert message.status == "skipped" and "No Slack channel" in message.error


async def test_a_repeated_dedupe_key_adds_nothing(db, make_program):
    await make_program("t1")
    async with db() as session:
        first = await slack_outbox.enqueue(session, ticket_id="t1", kind="r", body="a", dedupe_key="k:1")
        second = await slack_outbox.enqueue(session, ticket_id="t1", kind="r", body="b", dedupe_key="k:1")
        await session.commit()
    assert first is not None and second is None and len(await outbox(db)) == 1


async def test_sending_marks_messages_sent_oldest_first(db, make_program):
    await make_program("t1")
    await link_slack(db)
    async with db() as session:
        for body in ("one", "two"):
            await slack_outbox.enqueue(session, ticket_id="t1", kind="x", body=body)
        await session.commit()
    posted: list[tuple[str, str]] = []

    async def post(channel: str, body: str):
        posted.append((channel, body))
        return True, ""

    assert await slack_outbox.send_pending(db, post) == 2
    assert posted == [("C0123456789", "one"), ("C0123456789", "two")]
    rows = await outbox(db)
    assert [r.status for r in rows] == ["sent", "sent"] and all(r.sent_at and r.attempts == 1 for r in rows)
    assert await slack_outbox.send_pending(db, post) == 0  # nothing is sent twice


async def test_a_failing_send_is_retried_then_marked_failed_and_never_retried_again(db, make_program):
    await make_program("t1")
    await link_slack(db)
    async with db() as session:
        await slack_outbox.enqueue(session, ticket_id="t1", kind="x", body="hello")
        await session.commit()

    async def down(channel: str, body: str):
        return False, "Couldn't reach Slack: ConnectError"

    for expected in ("queued", "queued", "failed"):
        await slack_outbox.send_pending(db, down)
        assert (await outbox(db))[0].status == expected
    row = (await outbox(db))[0]
    assert row.attempts == 3 and "ConnectError" in row.error
    await slack_outbox.send_pending(db, down)
    assert (await outbox(db))[0].attempts == 3


async def test_a_message_that_finally_goes_through_clears_its_error(db, make_program):
    await make_program("t1")
    await link_slack(db)
    async with db() as session:
        await slack_outbox.enqueue(session, ticket_id="t1", kind="x", body="hello")
        await session.commit()

    async def down(channel: str, body: str):
        return False, "boom"

    async def up(channel: str, body: str):
        return True, ""

    await slack_outbox.send_pending(db, down)
    await slack_outbox.send_pending(db, up)
    row = (await outbox(db))[0]
    assert (row.status, row.error, row.attempts) == ("sent", None, 2)


# ---- working hours -----------------------------------------------------------------


def test_working_time_follows_the_configured_zone_hours_and_days():
    settings = ReminderSettings()  # 09:00-18:00 Monday to Friday, Asia/Kolkata
    assert reminders.is_working_time(settings, MONDAY)  # 11:00 IST
    assert not reminders.is_working_time(settings, datetime(2026, 10, 19, 13, 0, tzinfo=timezone.utc))  # 18:30 IST
    assert not reminders.is_working_time(settings, datetime(2026, 10, 19, 3, 0, tzinfo=timezone.utc))  # 08:30 IST
    assert not reminders.is_working_time(settings, datetime(2026, 10, 18, 5, 30, tzinfo=timezone.utc))  # Sunday
    utc = ReminderSettings(timezone="UTC")
    assert not reminders.is_working_time(utc, MONDAY)  # 05:30 UTC is before 09:00


def test_the_local_date_can_differ_from_the_utc_date():
    late = datetime(2026, 10, 19, 20, 0, tzinfo=timezone.utc)  # already Tuesday morning in Kolkata
    assert reminders.local_date(ReminderSettings(), late) == date(2026, 10, 20)


# ---- reminders -----------------------------------------------------------------------


async def overdue_dependency(db, ticket="t1", due=-5):
    async with db() as session:
        await session.execute(
            text("INSERT INTO client_dependencies (ticket_id, title, kind, status, due_on, created_at, updated_at) "
                 "VALUES (:t, 'Brand guidelines', 'asset', 'open', :due, now(), now())"),
            {"t": ticket, "due": MONDAY.date() + timedelta(days=due)},
        )
        await session.commit()


async def test_reminders_are_off_until_a_reminder_time_is_set(db, make_program):
    await make_program("t1")
    await link_slack(db)
    await overdue_dependency(db)
    assert await reminders.run(db, MONDAY) == 0 and await outbox(db) == []


async def test_nothing_is_sent_outside_working_hours(db, make_program, make_user):
    await make_program("t1")
    await link_slack(db)
    await overdue_dependency(db)
    await set_reminders(db, make_user, reminder_time=time(9, 30))
    assert await reminders.run(db, datetime(2026, 10, 19, 13, 0, tzinfo=timezone.utc)) == 0


async def test_an_overdue_item_is_reminded_once_a_day(db, make_program, make_user):
    await make_program("t1")
    await link_slack(db)
    await overdue_dependency(db)
    await set_reminders(db, make_user, reminder_time=time(9, 30))
    first = await reminders.run(db, MONDAY)
    assert first >= 1
    sent = [r for r in await outbox(db) if r.kind == "dependency_overdue"]
    assert len(sent) == 1 and ":rotating_light:" in sent[0].body and "Brand guidelines" in sent[0].body and sent[0].status == "queued"
    assert await reminders.run(db, MONDAY + timedelta(minutes=5)) == 0  # same day: nothing new
    tuesday = MONDAY + timedelta(days=1)
    assert await reminders.run(db, tuesday) >= 1
    assert len([r for r in await outbox(db) if r.kind == "dependency_overdue"]) == 2


async def test_a_fresh_approval_request_is_not_chased_but_an_old_one_is(db, make_program, make_user):
    await make_program("t1")
    await link_slack(db)
    await set_reminders(db, make_user, reminder_time=time(9, 30))
    async with db() as session:
        session.add(ProgramActivity(ticket_id="t1", code="W1-ACT-01", source="poa", channel="Email", title="Waiting", status="wip", updated_at=MONDAY - timedelta(hours=1)))
        await session.commit()
    await reminders.run(db, MONDAY)
    assert [r for r in await outbox(db) if r.kind == "approval_waiting"] == []
    async with db() as session:
        await session.execute(text("UPDATE program_activities SET updated_at = :t"), {"t": MONDAY - timedelta(hours=6)})
        await session.commit()
    await reminders.run(db, MONDAY + timedelta(minutes=5))
    assert len([r for r in await outbox(db) if r.kind == "approval_waiting"]) == 1


async def test_the_update_reminder_waits_for_the_reminder_time(db, make_program, make_user):
    await make_program("t1")
    await link_slack(db)
    await set_reminders(db, make_user, reminder_time=time(11, 30))  # 11:30 IST
    await reminders.run(db, MONDAY)  # 11:00 IST: too early
    assert [r for r in await outbox(db) if r.kind == "update_due"] == []
    await reminders.run(db, MONDAY + timedelta(hours=1))  # 12:00 IST
    assert len([r for r in await outbox(db) if r.kind == "update_due"]) == 1


async def test_a_missing_slack_channel_is_not_something_to_remind_about(db, make_program, make_user):
    await make_program("t1")
    await set_reminders(db, make_user, reminder_time=time(9, 30))
    await reminders.run(db, MONDAY)
    assert "slack_unlinked" not in {r.kind for r in await outbox(db)}


async def test_without_a_channel_the_reminders_are_recorded_as_skipped(db, make_program, make_user):
    await make_program("t1")
    await overdue_dependency(db)
    await set_reminders(db, make_user, reminder_time=time(9, 30))
    await reminders.run(db, MONDAY)
    rows = [r for r in await outbox(db) if r.kind == "dependency_overdue"]
    assert len(rows) == 1 and rows[0].status == "skipped"


async def test_an_approved_activity_planned_for_today_is_a_go_live_reminder(db, make_program, make_user):
    await make_program("t1")
    await link_slack(db)
    await set_reminders(db, make_user, reminder_time=time(9, 30))
    async with db() as session:
        session.add(ProgramActivity(
            ticket_id="t1", code="W1-ACT-01", source="poa", channel="Email", title="Launch email", status="wip",
            approved_at=MONDAY, approved_by_name="Priya S.", planned_date=MONDAY.date(), updated_at=MONDAY,
        ))
        await session.commit()
    await reminders.run(db, MONDAY)
    go_live = [r for r in await outbox(db) if r.kind == "go_live_due"]
    assert len(go_live) == 1 and ":rocket:" in go_live[0].body and "Launch email" in go_live[0].body


async def test_a_closed_program_gets_no_reminders(db, make_program, make_user):
    await make_program("t1")
    await link_slack(db)
    await overdue_dependency(db)
    await set_reminders(db, make_user, reminder_time=time(9, 30))
    async with db() as session:
        await session.execute(text("UPDATE programs SET stage_label = 'Closed'"))
        await session.commit()
    assert await reminders.run(db, MONDAY) == 0


# ---- nudge, breach alert and daily update through the outbox -------------------------------


async def live_activity(client, db):
    async with db() as session:
        session.add(ProgramActivity(ticket_id="t1", code="W1-ACT-01", source="poa", channel="Email", title="Launch email", status="wip"))
        await session.commit()
    return (await client.get("/programs/t1/activities")).json()[0]


async def test_marketing_can_nudge_the_csm_once_an_hour(client_for, make_user, make_program, db):
    await make_program("t1")
    await link_slack(db)
    csm = await make_user("csm@example.com", [Role.CSM], name="Priya S.")
    csm_client = await client_for(csm)
    await csm_client.put("/programs/t1/assignments", json=[{"user_id": csm.id, "role": "csm"}])
    activity = await live_activity(csm_client, db)
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING], name="Neha K."))
    first = await marketing.post(f"/programs/t1/activities/{activity['id']}/nudge")
    assert (first.status_code, first.json()) == (202, {"queued": True, "recipients": ["Priya S."]})
    body = next(r for r in await outbox(db) if r.kind == "nudge").body
    assert "Priya S." in body and "Launch email" in body and "nudged by Neha K." in body
    again = await marketing.post(f"/programs/t1/activities/{activity['id']}/nudge")
    assert (again.status_code, again.json()["code"]) == (429, "nudge_too_soon")


async def test_one_nudge_covers_everything_waiting_instead_of_one_message_per_activity(client_for, make_user, make_program, db):
    await make_program("t1")
    await link_slack(db)
    csm = await make_user("csm@example.com", [Role.CSM], name="Priya S.")
    csm_client = await client_for(csm)
    await csm_client.put("/programs/t1/assignments", json=[{"user_id": csm.id, "role": "csm"}])
    async with db() as session:
        session.add_all(
            ProgramActivity(ticket_id="t1", code=f"W1-ACT-0{i}", source="poa", channel="Email", title=f"Mail {i}", status="not_started")
            for i in range(3)
        )
        await session.commit()
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING], name="Neha K."))
    first = await marketing.post("/programs/t1/activities/nudge-approvals")
    assert (first.status_code, first.json()) == (202, {"queued": True, "recipients": ["Priya S."]})
    nudges = [r for r in await outbox(db) if r.kind == "nudge"]
    assert len(nudges) == 1 and "3 marketing activities are waiting for your approval" in nudges[0].body
    again = await marketing.post("/programs/t1/activities/nudge-approvals")
    assert (again.status_code, again.json()["code"]) == (429, "nudge_too_soon")


async def test_an_approved_activity_cannot_be_nudged_and_an_account_manager_cannot_nudge(client_for, make_user, make_program, db):
    await make_program("t1")
    csm_client = await client_for(await make_user("csm@example.com", [Role.CSM]))
    activity = await live_activity(csm_client, db)
    await csm_client.post(f"/programs/t1/activities/{activity['id']}/approve")
    done = await csm_client.post(f"/programs/t1/activities/{activity['id']}/nudge")
    assert (done.status_code, done.json()["code"]) == (409, "nothing_to_nudge")
    am = await client_for(await make_user("am@example.com", [Role.ACCOUNT_MANAGER]))
    assert (await am.post(f"/programs/t1/activities/{activity['id']}/nudge")).status_code == 403


async def test_withdrawing_approval_on_a_live_activity_alerts_the_channel_straight_away(client_for, make_user, make_program, db):
    await make_program("t1")
    await link_slack(db)
    client = await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))
    activity = await live_activity(client, db)
    await client.patch(f"/programs/t1/activities/{activity['id']}", json={"utm": "he_mark/x"})
    await client.post(f"/programs/t1/activities/{activity['id']}/approve")
    await client.post(f"/programs/t1/activities/{activity['id']}/go-live", json={})
    assert [r for r in await outbox(db) if r.kind == "breach"] == []
    await client.delete(f"/programs/t1/activities/{activity['id']}/approve")
    breach = [r for r in await outbox(db) if r.kind == "breach"]
    assert len(breach) == 1 and breach[0].status == "queued" and "Control breach" in breach[0].body and "Priya S." in breach[0].body


async def test_withdrawing_approval_before_go_live_sends_no_alert(client_for, make_user, make_program, db):
    await make_program("t1")
    await link_slack(db)
    client = await client_for(await make_user("csm@example.com", [Role.CSM]))
    activity = await live_activity(client, db)
    await client.post(f"/programs/t1/activities/{activity['id']}/approve")
    await client.delete(f"/programs/t1/activities/{activity['id']}/approve")
    assert [r for r in await outbox(db) if r.kind == "breach"] == []


async def test_a_daily_update_is_also_posted_to_the_programs_channel(client_for, make_user, make_program, db):
    await make_program("t1")
    await link_slack(db)
    client = await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))
    await client.post("/programs/t1/updates", json={"health": "warning", "summary": "Counts pending", "blockers": "Waiting on client"})
    comment = await client.post("/programs/t1/comments", json={"body": "just a comment"})
    assert comment.status_code == 201
    rows = await outbox(db)
    assert [r.kind for r in rows] == ["daily_update"]  # comments are not broadcast
    assert "Priya S." in rows[0].body and "[warning]" in rows[0].body and "Counts pending" in rows[0].body and "Waiting on client" in rows[0].body


async def test_the_program_outbox_lists_what_was_sent_newest_first(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        await slack_outbox.enqueue(session, ticket_id="t1", kind="a", body="first")
        await slack_outbox.enqueue(session, ticket_id="t1", kind="b", body="second")
        await session.commit()
    client = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    body = (await client.get("/programs/t1/outbox")).json()
    assert [m["body"] for m in body] == ["second", "first"] and body[0]["status"] == "skipped"


async def test_text_from_people_cannot_ping_a_channel_or_build_a_link_in_slack(monkeypatch):
    from core import slack

    sent: dict = {}

    async def fake_call(method, payload):
        sent.update(payload)
        return True, {}

    monkeypatch.setattr(slack, "_call", fake_call)
    await slack.post_message("C0123456789", ":memo: *Launch <!channel> & <https://evil.example|click>*")
    assert sent["text"] == ":memo: *Launch &lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;*"
