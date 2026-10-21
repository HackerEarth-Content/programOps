"""Views, clicks and sends per activity, CTR, channel trends, and the results-to-record queue."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from core import metrics
from core.orm import ActivityMetric, ProgramActivity, ProgramEvent
from core.permissions import Role

NOW = datetime.now(timezone.utc)
TODAY = NOW.date()


def day(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


async def live(db, code="W1-ACT-01", channel="Social", went_live_days_ago=5, ticket="t1") -> int:
    async with db() as session:
        activity = ProgramActivity(
            ticket_id=ticket, code=code, source="poa", channel=channel, title=f"Activity {code}", status="live", utm="he_mark/x",
            approved_at=NOW - timedelta(days=went_live_days_ago + 1), approved_by_name="Priya S.",
            go_live_at=NOW - timedelta(days=went_live_days_ago),
        )
        session.add(activity)
        await session.commit()
        return activity.id


async def marketer(client_for, make_user):
    return await client_for(await make_user("m@example.com", [Role.MARKETING], name="Neha K."))


async def put(client, aid, when, **fields):
    return await client.put(f"/programs/t1/activities/{aid}/metrics", json={"date": when, **fields})


# ---- the calculations ----------------------------------------------------------


def test_ctr_is_clicks_over_views_or_over_sends_when_there_are_no_views():
    assert metrics.ctr(42100, None, 5200) == 12.4
    assert metrics.ctr(None, 180000, 16000) == 8.9
    assert metrics.ctr(1000, 5000, 100) == 10.0  # views win when both exist
    assert metrics.ctr(None, None, 5) is None and metrics.ctr(0, None, 5) is None and metrics.ctr(100, None, None) is None


def test_open_rate_is_opens_over_sent():
    assert metrics.open_rate(180000, 43560) == 24.2
    assert metrics.open_rate(None, 5) is None and metrics.open_rate(0, 5) is None


# ---- recording -----------------------------------------------------------------


async def test_the_marketing_team_records_a_days_results(client_for, make_user, make_program, db):
    await make_program("t1")
    aid = await live(db)
    client = await marketer(client_for, make_user)
    body = (await put(client, aid, day(-1), views=42100, clicks=5200)).json()
    assert body["days"][0]["ctr"] == 12.4 and body["days"][0]["entered_by_name"] == "Neha K."
    assert body["totals"] == {"views": 42100, "clicks": 5200, "sent": 0, "opens": 0, "ctr": 12.4, "open_rate": None}


async def test_recording_the_same_day_again_replaces_it_and_the_old_numbers_stay_in_the_audit_trail(client_for, make_user, make_program, db):
    await make_program("t1")
    aid = await live(db)
    client = await marketer(client_for, make_user)
    await put(client, aid, day(-1), views=1000, clicks=100)
    body = (await put(client, aid, day(-1), views=1200, clicks=150)).json()
    assert len(body["days"]) == 1 and body["days"][0]["views"] == 1200
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).where(ProgramEvent.action == "metrics_recorded").order_by(ProgramEvent.id))).all()
    assert events[0].old is None and events[1].old == {"views": 1000, "clicks": 100, "sent": None, "opens": None}


async def test_totals_add_up_across_days_and_days_are_listed_oldest_first(client_for, make_user, make_program, db):
    await make_program("t1")
    aid = await live(db)
    client = await marketer(client_for, make_user)
    await put(client, aid, day(-1), sent=100000, clicks=8000, opens=24000)
    await put(client, aid, day(-2), sent=80000, clicks=8000, opens=19560)
    body = (await client.get(f"/programs/t1/activities/{aid}/metrics")).json()
    assert [d["date"] for d in body["days"]] == [day(-2), day(-1)]
    assert body["totals"] == {"views": 0, "clicks": 16000, "sent": 180000, "opens": 43560, "ctr": 8.9, "open_rate": 24.2}


async def test_results_can_only_be_recorded_for_an_activity_that_has_gone_live(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        session.add(ProgramActivity(ticket_id="t1", code="W1-ACT-09", source="poa", channel="Email", title="Not yet"))
        await session.commit()
        aid = (await session.scalar(select(ProgramActivity.id)))
    response = await put(await marketer(client_for, make_user), aid, day(-1), views=10)
    assert (response.status_code, response.json()["code"]) == (409, "activity_not_live_yet")


async def test_a_day_before_go_live_or_in_the_future_is_refused(client_for, make_user, make_program, db):
    await make_program("t1")
    aid = await live(db, went_live_days_ago=3)
    client = await marketer(client_for, make_user)
    early = await put(client, aid, day(-5), views=10)
    assert (early.status_code, early.json()["code"]) == (422, "metrics_before_go_live")
    future = await put(client, aid, day(1), views=10)
    assert (future.status_code, future.json()["code"]) == (422, "metrics_in_future")
    assert (await put(client, aid, day(-3), views=10)).status_code == 200  # the go-live day itself counts


async def test_impossible_numbers_are_refused(client_for, make_user, make_program, db):
    await make_program("t1")
    aid = await live(db)
    client = await marketer(client_for, make_user)
    for fields in ({"views": 10, "clicks": 11}, {"sent": 10, "opens": 11}):
        response = await put(client, aid, day(-1), **fields)
        assert (response.status_code, response.json()["code"]) == (422, "metrics_inconsistent")
    assert (await put(client, aid, day(-1), views=-1)).status_code == 422


async def test_csm_and_marketing_can_record_but_an_account_manager_cannot(client_for, make_user, make_program, db):
    await make_program("t1")
    aid = await live(db)
    csm = await client_for(await make_user("csm@example.com", [Role.CSM]))
    assert (await put(csm, aid, day(-1), views=10)).status_code == 200
    am = await client_for(await make_user("am@example.com", [Role.ACCOUNT_MANAGER]))
    assert (await put(am, aid, day(-1), views=10)).status_code == 403
    assert (await am.get(f"/programs/t1/activities/{aid}/metrics")).status_code == 200  # but anyone can read


async def test_another_programs_activity_is_not_reachable(client_for, make_user, make_program, db):
    await make_program("t1")
    await make_program("t2")
    aid = await live(db, ticket="t2")
    response = await put(await marketer(client_for, make_user), aid, day(-1), views=10)
    assert (response.status_code, response.json()["code"]) == (404, "activity_not_found")


# ---- trends per channel --------------------------------------------------------------


async def test_the_channel_trends_group_activities_and_sum_each_day(client_for, make_user, make_program, db):
    await make_program("t1")
    a = await live(db, "W1-ACT-01", "Social")
    b = await live(db, "W1-ACT-02", "Social")
    c = await live(db, "W1-ACT-03", "Email")
    client = await marketer(client_for, make_user)
    await put(client, a, day(-1), views=1000, clicks=100)
    await put(client, b, day(-1), views=3000, clicks=100)
    await put(client, a, day(-2), views=500, clicks=50)
    await put(client, c, day(-1), sent=2000, clicks=100, opens=800)
    body = {ch["channel"]: ch for ch in (await client.get("/programs/t1/metrics/channels")).json()}
    social = body["Social"]
    assert social["activities"] == 2 and social["totals"]["views"] == 4500 and social["totals"]["clicks"] == 250
    assert [(p["date"], p["views"], p["ctr"]) for p in social["series"]] == [(day(-2), 500, 10.0), (day(-1), 4000, 5.0)]
    assert body["Email"]["totals"]["open_rate"] == 40.0 and body["Email"]["totals"]["ctr"] == 5.0


async def test_a_channel_with_no_results_yet_shows_empty_totals(client_for, make_user, make_program, db):
    await make_program("t1")
    await live(db, channel="Community")
    body = (await (await marketer(client_for, make_user)).get("/programs/t1/metrics/channels")).json()
    assert body == [{"channel": "Community", "activities": 1, "totals": {"views": 0, "clicks": 0, "sent": 0, "opens": 0, "ctr": None, "open_rate": None}, "series": []}]


# ---- the results-to-record queue ----------------------------------------------------


async def test_a_live_activity_with_no_results_for_yesterday_is_queued_until_they_are_logged(client_for, make_user, make_program, db):
    await make_program("t1")
    aid = await live(db)
    client = await marketer(client_for, make_user)
    queue = (await client.get("/queues/marketing")).json()
    assert queue["counts"]["results_to_record"] == 1
    item = next(i for i in queue["items"] if i["kind"] == "results_to_record")
    assert item["activity_id"] == aid and "Log views and clicks" in item["detail"]
    await put(client, aid, day(-1), views=10, clicks=1)
    assert (await client.get("/queues/marketing")).json()["counts"]["results_to_record"] == 0


async def test_an_activity_that_went_live_today_is_not_asked_for_yesterdays_results(client_for, make_user, make_program, db):
    await make_program("t1")
    await live(db, went_live_days_ago=0)
    assert (await (await marketer(client_for, make_user)).get("/queues/marketing")).json()["counts"]["results_to_record"] == 0


async def test_deleting_an_activity_removes_its_results(db, make_program):
    await make_program("t1")
    aid = await live(db)
    async with db() as session:
        session.add(ActivityMetric(activity_id=aid, date=TODAY - timedelta(days=1), views=5, entered_by_name="x"))
        await session.commit()
        await session.delete(await session.get(ProgramActivity, aid))
        await session.commit()
        assert (await session.scalars(select(ActivityMetric))).all() == []
