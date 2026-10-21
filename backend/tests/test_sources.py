"""Registrations by source: attribution of Redash query 6170 rows, lift, and the snapshot endpoints."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from core import channel_sync, redash
from core.channel_sync import ActivityRef, SourceBucket, classify, lift
from core.orm import ChannelSnapshot, ProgramActivity, ProgramRegistration, ProgramRegistrationSettings
from core.permissions import Role

USERS = "NumUsers_with_source_as_Latest_visit_before_registration"


def row(source: str, campaign: str, users: int) -> dict:
    return {"Source/Medium": source, "Campaign": campaign, USERS: users}


# The real rows Redash returned for hackcellence-the-embark-edition on 2026-10-19.
HACKCELLENCE = [
    row("", "Referrer-Challenges", 397), row("", "Referrer-Jobs", 0), row("", "Referrer-Practice", 0),
    row("", "Referrer-Leaderboard", 0), row("", "Organic_But_RegisteredBefore", 24617), row("", "Organic", 16655),
    row("sp_auto_dm/", "", 1944), row("chatgpt.com/", "", 514), row("he_mark/", "", 11), row("/channel7", "", 3),
    row("/email", "HackCellence: The Embark Edition", 2), row("he_mark/channel3", "hackcellence", 1),
    row("he_mark/channel3", "hackcellence-", 1), row("he_mark/channel7", "hackcellence-bookingholdings", 1),
    row("perplexity/", "", 1), row("registration/email", "hackathons", 1), row("Total", "", 44148),
]


# ---- classify -----------------------------------------------------------------


def test_the_hackcellence_rows_reconcile_and_show_the_organic_dominance():
    report = classify(HACKCELLENCE, [ActivityRef(1, "W1-ACT-01", "he_mark/channel3")])
    assert report.total == 44148 and report.reconciles
    assert report.organic_pct == 93.5  # the same figure the Stitch registrations screen shows
    assert report.matched_users == 2  # both he_mark/channel3 rows
    assert report.unmatched_users == 1944 + 514 + 11 + 3 + 2 + 1 + 1 + 1  # shown, never dropped


def test_each_line_lands_in_one_bucket():
    report = classify(HACKCELLENCE, [ActivityRef(1, "W1-ACT-01", "he_mark/channel3")])
    bucket = {(l.source_medium, l.campaign): l.bucket for l in report.lines}
    assert bucket[("", "Organic")] == SourceBucket.ORGANIC
    assert bucket[("", "Organic_But_RegisteredBefore")] == SourceBucket.ORGANIC_EARLIER
    assert bucket[("", "Referrer-Challenges")] == SourceBucket.REFERRAL
    assert bucket[("he_mark/channel3", "hackcellence")] == SourceBucket.ACTIVITY
    assert bucket[("sp_auto_dm/", "")] == SourceBucket.UNMATCHED
    assert all(l.activity_code in (None, "W1-ACT-01") for l in report.lines)


def test_lines_are_ordered_by_users_and_shares_use_the_total():
    report = classify(HACKCELLENCE, [])
    assert [l.users for l in report.lines] == sorted((l.users for l in report.lines), reverse=True)
    assert report.lines[0].share_pct == 55.8 and report.lines[0].campaign == "Organic_But_RegisteredBefore"


def test_the_longest_matching_utm_wins():
    activities = [ActivityRef(1, "A", "he_mark/channel"), ActivityRef(2, "B", "he_mark/channel3")]
    line = classify([row("he_mark/channel3", "x", 5), row("Total", "", 5)], activities).lines[0]
    assert line.activity_code == "B"


def test_an_activity_without_a_utm_matches_nothing():
    line = classify([row("he_mark/channel3", "", 5), row("Total", "", 5)], [ActivityRef(1, "A", None)]).lines[0]
    assert line.bucket == SourceBucket.UNMATCHED


def test_rows_that_do_not_add_up_to_the_total_are_flagged():
    assert not classify([row("a/", "", 5), row("Total", "", 9)], []).reconciles


def test_without_a_total_row_the_lines_define_it():
    report = classify([row("a/", "", 5), row("b/", "", 5)], [])
    assert report.total == 10 and report.reconciles


# ---- lift ---------------------------------------------------------------------


def test_lift_compares_the_days_before_with_the_go_live_day_and_after():
    daily = {date(2026, 10, 3): 100, date(2026, 10, 4): 100, date(2026, 10, 5): 100,
             date(2026, 10, 6): 300, date(2026, 10, 7): 300, date(2026, 10, 8): 300}
    result = lift(daily, date(2026, 10, 6))
    assert (result.before_avg, result.after_avg, result.lift_pct) == (100.0, 300.0, 200.0)


def test_lift_uses_only_the_days_that_have_data():
    result = lift({date(2026, 10, 5): 50, date(2026, 10, 6): 100}, date(2026, 10, 6))
    assert (result.before_avg, result.after_avg, result.lift_pct) == (50.0, 100.0, 100.0)


def test_lift_is_none_without_data_on_both_sides():
    assert lift({date(2026, 10, 6): 100}, date(2026, 10, 6)) is None
    assert lift({date(2026, 10, 5): 100}, date(2026, 10, 6)) is None


def test_lift_has_no_percentage_when_nothing_came_in_before():
    result = lift({date(2026, 10, 5): 0, date(2026, 10, 6): 40}, date(2026, 10, 6))
    assert result.lift_pct is None and result.after_avg == 40.0


# ---- the snapshot ----------------------------------------------------------------


async def link(db, ticket="t1", slug="hackcellence-the-embark-edition"):
    async with db() as session:
        session.add(ProgramRegistrationSettings(ticket_id=ticket, roles=[], fields=[], redash_event_slug=slug))
        await session.commit()


async def csm_client(client_for, make_user):
    return await client_for(await make_user("csm@example.com", [Role.CSM]))


async def test_before_any_refresh_the_sources_are_empty(client_for, make_user, make_program):
    await make_program("t1")
    body = (await (await csm_client(client_for, make_user)).get("/programs/t1/sources")).json()
    assert body == {"fetched_at": None, "stale": False, "running": False, "error": None, "report": None}


async def test_a_refresh_stores_a_snapshot_the_page_then_reads(client_for, make_user, make_program, db, monkeypatch):
    await make_program("t1")
    await link(db)
    seen = []

    async def fake(slug):
        seen.append(slug)
        return HACKCELLENCE

    monkeypatch.setattr(channel_sync, "fetch_rows", fake)
    snapshot = await channel_sync.refresh(db, "t1")
    assert snapshot.status == "ok" and snapshot.total == 44148 and seen == ["hackcellence-the-embark-edition"]
    body = (await (await csm_client(client_for, make_user)).get("/programs/t1/sources")).json()
    assert body["report"]["total"] == 44148 and body["report"]["reconciles"] is True and body["stale"] is False


async def test_the_page_matches_lines_to_the_programs_activities(client_for, make_user, make_program, db, monkeypatch):
    await make_program("t1")
    await link(db)
    async with db() as session:
        session.add(ProgramActivity(ticket_id="t1", code="W1-ACT-01", source="poa", channel="Social", title="Spotlight", utm="he_mark/channel3"))
        await session.commit()

    async def fake(slug):
        return HACKCELLENCE

    monkeypatch.setattr(channel_sync, "fetch_rows", fake)
    await channel_sync.refresh(db, "t1")
    lines = (await (await csm_client(client_for, make_user)).get("/programs/t1/sources")).json()["report"]["lines"]
    assert {l["activity_code"] for l in lines if l["bucket"] == "activity"} == {"W1-ACT-01"}


async def test_a_failed_refresh_keeps_the_last_good_snapshot_and_reports_why(client_for, make_user, make_program, db, monkeypatch):
    await make_program("t1")
    await link(db)

    async def good(slug):
        return HACKCELLENCE

    async def bad(slug):
        raise redash.RedashError("Couldn't reach Redash (VPN?)")

    monkeypatch.setattr(channel_sync, "fetch_rows", good)
    await channel_sync.refresh(db, "t1")
    monkeypatch.setattr(channel_sync, "fetch_rows", bad)
    failed = await channel_sync.refresh(db, "t1")
    assert failed.status == "failed"
    body = (await (await csm_client(client_for, make_user)).get("/programs/t1/sources")).json()
    assert body["report"]["total"] == 44148 and "VPN" in body["error"]


async def test_a_snapshot_older_than_a_day_and_a_half_is_stale(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        session.add(ChannelSnapshot(
            ticket_id="t1", status="ok", rows=[row("Total", "", 0)], total=0,
            fetched_at=datetime.now(timezone.utc) - timedelta(hours=40),
        ))
        await session.commit()
    assert (await (await csm_client(client_for, make_user)).get("/programs/t1/sources")).json()["stale"] is True


async def test_refresh_needs_a_linked_event_and_integration_rights(client_for, make_user, make_program, db):
    await make_program("t1")
    csm = await csm_client(client_for, make_user)
    unlinked = await csm.post("/programs/t1/sources/refresh")
    assert (unlinked.status_code, unlinked.json()["code"]) == (409, "no_event_linked")
    await link(db)
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await marketing.post("/programs/t1/sources/refresh")).status_code == 403


async def test_the_refresh_endpoint_runs_in_the_background(client_for, make_user, make_program, db, monkeypatch):
    await make_program("t1")
    await link(db)

    async def fake(slug):
        await asyncio.sleep(0.05)
        return HACKCELLENCE

    monkeypatch.setattr(channel_sync, "fetch_rows", fake)
    csm = await csm_client(client_for, make_user)
    started = await csm.post("/programs/t1/sources/refresh")
    assert (started.status_code, started.json()) == (202, {"status": "started"})
    assert (await csm.post("/programs/t1/sources/refresh")).json() == {"status": "already_running"}
    for _ in range(100):
        body = (await csm.get("/programs/t1/sources")).json()
        if body["report"] and not body["running"]:
            break
        await asyncio.sleep(0.05)
    assert body["report"]["total"] == 44148 and body["running"] is False


async def test_an_unsafe_slug_never_reaches_redash(monkeypatch):
    called = []

    async def spy(*args, **kwargs):
        called.append(args)
        return {"rows": []}

    monkeypatch.setattr(redash, "run_query", spy)
    # The slug below is an injection payload that must be refused. It is only ever passed to the validator and never executed.
    with pytest.raises(redash.RedashError):
        await channel_sync.fetch_rows('x"; import os; os.system("id") #')
    assert called == []


# ---- lift endpoint ----------------------------------------------------------------


async def test_the_lift_endpoint_reports_before_and_after_for_each_live_activity(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        for day, n in ((3, 100), (4, 100), (5, 100), (6, 300), (7, 300), (8, 300)):
            session.add(ProgramRegistration(ticket_id="t1", date=date(2026, 10, day), role="", registrations=n))
        session.add(ProgramActivity(
            ticket_id="t1", code="W1-ACT-01", source="poa", channel="Email", title="Launch", status="live",
            approved_at=datetime.now(timezone.utc), go_live_at=datetime(2026, 10, 6, 9, tzinfo=timezone.utc),
        ))
        session.add(ProgramActivity(ticket_id="t1", code="W1-ACT-02", source="poa", channel="Email", title="Not live yet"))
        await session.commit()
    body = (await (await csm_client(client_for, make_user)).get("/programs/t1/lift")).json()
    assert body == [{
        "kind": "lift", "activity_id": body[0]["activity_id"], "code": "W1-ACT-01", "title": "Launch",
        "go_live_on": "2026-10-06", "before_avg": 100.0, "after_avg": 300.0, "lift_pct": 200.0,
    }]


async def test_stored_snapshots_are_not_deleted_by_a_new_one(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db)

    async def fake(slug):
        return HACKCELLENCE

    monkeypatch.setattr(channel_sync, "fetch_rows", fake)
    await channel_sync.refresh(db, "t1")
    await channel_sync.refresh(db, "t1")
    async with db() as session:
        assert len((await session.scalars(select(ChannelSnapshot))).all()) == 2
