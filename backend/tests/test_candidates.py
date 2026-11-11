"""The candidates split (Redash 6182): reconciliation of what comes back, relevant per day in the daily counts, and a
failed refresh keeping the last good snapshot. Validation of what is sent is the self-check in core/candidates.py.
No real Redash: rows are synthetic."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from core import candidates, redash, redash_sync, registration_message
from core.orm import ProgramRegistration, ProgramRegistrationSettings

D1, D2 = date(2026, 10, 1), date(2026, 10, 2)


def row(section, dim, total=0, matching=0, possibly=0):
    return {"Section": section, "Dimension": dim, "Total Registrations": total,
            "Matching Required Count": matching, "Possibly Relevant Count": possibly}


def rows():
    """100 registrations; YOE: 0y 40, 3y 20 (meet 2+), unknown 40; cities Pune 60 / Other 10 / Unknown 30."""
    return [
        row("Overall Registration Metrics", "Total registrations", 100),
        row("Overall Registration Metrics", "Relevant registrations (known YOE AND location)", 0, 10),
        row("Overall Registration Metrics", "Possibly relevant (YOE unknown AND location)", 0, 0, 30),
        row("YOE Breakdown", "0 years", 40, 0), row("YOE Breakdown", "3 years", 20, 20), row("YOE Breakdown", "Unknown", 40, 0),
        row("Location Breakdown", "Pune", 60, 10, 30),
        row("Location Breakdown", "Other cities", 10), row("Location Breakdown", "Unknown", 30),
        row("Daily Registrations", "2026-10-01", 70, 6, 20), row("Daily Registrations", "2026-10-02", 25, 4, 10),
        row("Daily Registrations", "Undated", 5),
    ]


def test_parse_builds_the_snapshot():
    snap = candidates.parse(rows(), "2+", ["Pune"])
    assert (snap["total"], snap["relevant"], snap["possibly"]) == (100, 10, 30)
    assert snap["yoe"]["unknown"] == 40
    by = {b["label"]: b for b in snap["yoe"]["bands"]}
    assert by["0"]["count"] == 40 and by["3"] == {"label": "3", "count": 20, "matching": 20} and by["11+"]["count"] == 0
    assert snap["cities"] == {"unknown": 30, "other": 10, "items": [
        {"name": "Pune", "count": 60, "relevant": 10, "possibly": 30, "selected": True}]}
    assert [d["date"] for d in snap["daily"]] == ["2026-10-01", "2026-10-02"]  # the undated 5 only count in the total


@pytest.mark.parametrize("mutate", [
    lambda r: r[0].update({"Total Registrations": 101}),  # sections no longer sum to the total
    lambda r: r[1].update({"Matching Required Count": 11}),  # cities and days differ from relevant
    lambda r: r[2].update({"Possibly Relevant Count": 31}),
])
def test_parse_rejects_numbers_that_dont_add_up(mutate):
    r = rows()
    mutate(r)
    with pytest.raises(redash.RedashError):
        candidates.parse(r, "2+", ["Pune"])


def test_parse_surfaces_a_query_error_row():
    with pytest.raises(redash.RedashError, match="Event not found"):
        candidates.parse([row("Error", "Event not found (check slug/title)")], None, [])


async def link(db, **kw):
    async with db() as session:
        session.add(ProgramRegistrationSettings(
            ticket_id="t1", roles=[], fields=[], redash_auto=True, redash_event_slug="ev", **kw))
        await session.commit()


async def stored(db):
    async with db() as session:
        return {r.date: (r.registrations, r.relevant) for r in
                (await session.scalars(select(ProgramRegistration).where(ProgramRegistration.role == ""))).all()}


async def age_snapshot(db, minutes=10):
    """Make the stored snapshot older than the freshness window, so the next refresh really runs."""
    from datetime import datetime, timedelta, timezone
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, "t1")
        cfg.candidates = {**cfg.candidates, "fetched_at": (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()}
        await session.commit()


async def ok_fetch(slug, yoe, cities, on_status=None):
    snap = candidates.parse(rows(), yoe, cities)
    snap["slug"] = slug  # what candidates.fetch does
    return snap


async def test_refresh_writes_relevant_per_day_and_keeps_the_last_good_snapshot_on_failure(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, required_yoe="2+", required_cities=["Pune"])
    async with db() as session:
        await redash_sync.apply_days(session, "t1", {D1: 70, D2: 25})  # requirement but no snapshot yet: relevant unknown
    assert await stored(db) == {D1: (70, None), D2: (25, None)}

    monkeypatch.setattr(candidates, "fetch", ok_fetch)
    assert await candidates.refresh("t1") is True
    assert await stored(db) == {D1: (70, 6), D2: (25, 4)}

    async def down(slug, yoe, cities, on_status=None):
        raise redash.RedashError("Couldn't reach Redash (VPN?): ConnectError")
    monkeypatch.setattr(candidates, "fetch", down)
    assert await candidates.refresh("t1") is False and (await stored(db)) == {D1: (70, 6), D2: (25, 4)}  # fresh: not even tried
    await age_snapshot(db)
    assert await candidates.refresh("t1") is False
    async with db() as session:
        v = candidates.view(await session.get(ProgramRegistrationSettings, "t1"), "t1")
    assert v["snapshot"]["relevant"] == 10 and "VPN" in v["error"] and v["outdated"] is False and not v["running"]

    async with db() as session:  # a later sync changes a count: relevant comes from the snapshot, it is not lost
        await redash_sync.apply_days(session, "t1", {D1: 72, D2: 25})
    assert await stored(db) == {D1: (72, 6), D2: (25, 4)}


async def test_changing_the_requirement_makes_the_snapshot_outdated_and_leaves_relevant_alone(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, required_yoe="2+", required_cities=["Pune"])
    monkeypatch.setattr(candidates, "fetch", ok_fetch)
    async with db() as session:
        await redash_sync.apply_days(session, "t1", {D1: 70})
    await candidates.refresh("t1")
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, "t1")
        cfg.required_yoe = "0-2"
        await session.commit()
        assert candidates.view(cfg, "t1")["outdated"] is True and candidates.usable_daily(cfg) is None
        changed = await redash_sync.apply_days(session, "t1", {D1: 70})  # same count: nothing to write
    assert changed == [] and await stored(db) == {D1: (70, 6)}


async def test_no_requirement_keeps_relevant_equal_to_registrations(db, make_program):
    await make_program("t1")
    await link(db)
    async with db() as session:
        await redash_sync.apply_days(session, "t1", {D1: 70})
    assert await stored(db) == {D1: (70, 70)}


def test_slack_message_ends_with_the_total_and_the_relevant_count():
    split = {"requirement": "2+ yrs · Pune", "relevant": 75}
    text = registration_message.format_summary(
        "Ev", [{"date": D1, "role": "", "registrations": 70, "relevant": 6, "extra": {}}], 1500, {}, split)
    assert text.endswith("Total registrations: *1,500*\nRelevant registrations (2+ yrs · Pune): *75*") and "6 relevant" in text
    assert "possibly" not in text and "Top cities" not in text
    no_req = registration_message.format_summary(
        "Ev", [{"date": D1, "role": "", "registrations": 70, "relevant": 70, "extra": {}}], 1500, {}, None)  # no requirement: the unchanged message
    assert no_req.endswith("Total so far: *1,500*")


# ---- reruns, races and idempotency: the feature must not overstore, double-announce or show the wrong event ----------


async def count_rows(db):
    async with db() as session:
        return len((await session.scalars(select(ProgramRegistration))).all())


async def test_refresh_is_a_noop_while_the_snapshot_is_fresh_and_never_adds_rows(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, required_yoe="2+", required_cities=["Pune"])
    calls = []

    async def counting(slug, yoe, cities, on_status=None):
        calls.append(yoe)
        return await ok_fetch(slug, yoe, cities)
    monkeypatch.setattr(candidates, "fetch", counting)
    async with db() as session:
        assert len(await redash_sync.apply_days(session, "t1", {D1: 70, D2: 25})) == 2
    assert await candidates.refresh("t1") is True
    before = await stored(db)
    assert await candidates.refresh("t1") is False and len(calls) == 1  # fresh: the query isn't run again
    async with db() as session:
        assert await redash_sync.apply_days(session, "t1", {D1: 70, D2: 25}) == []  # same counts: nothing to announce
    assert await stored(db) == before and await count_rows(db) == 2
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, "t1")
        assert candidates.view(cfg, "t1")["running"] is False and "daily" not in candidates.view(cfg, "t1")["snapshot"]


async def test_a_requirement_changed_while_the_query_runs_is_run_again_not_lost(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, required_yoe="2+")
    seen = []

    async def fetch(slug, yoe, cities, on_status=None):
        seen.append(yoe)
        if len(seen) == 1:  # the CSM edits the requirement while the first query is in flight
            async with db() as session:
                cfg = await session.get(ProgramRegistrationSettings, "t1")
                cfg.required_yoe = "0-0"
                await session.commit()
        return await ok_fetch(slug, yoe, cities)
    monkeypatch.setattr(candidates, "fetch", fetch)
    assert await candidates.refresh("t1") is True
    assert seen == ["2+", "0-0"]
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, "t1")
        assert cfg.candidates["requirement"]["yoe"] == "0-0" and candidates.is_current(cfg)  # only the matching one is kept


async def test_a_snapshot_is_only_ever_shown_for_the_event_it_was_fetched_for(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db)
    monkeypatch.setattr(candidates, "fetch", ok_fetch)
    await candidates.refresh("t1")
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, "t1")
        assert candidates.is_fresh(cfg)
        cfg.redash_event_slug = "another-event"
        await session.commit()
        v = candidates.view(cfg, "t1")
        assert v["outdated"] is True and candidates.usable_daily(cfg) is None and not candidates.is_fresh(cfg)


async def test_a_relevant_only_change_is_written_but_not_announced(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, required_yoe="2+")
    monkeypatch.setattr(candidates, "fetch", ok_fetch)
    async with db() as session:
        await redash_sync.apply_days(session, "t1", {D1: 70})
    await candidates.refresh("t1")
    assert await stored(db) == {D1: (70, 6)}
    async with db() as session:  # people edited their profiles: the next snapshot says 9 instead of 6 for that day
        cfg = await session.get(ProgramRegistrationSettings, "t1")
        snap = dict(cfg.candidates)
        snap["daily"] = [{**d, "relevant": 9} if d["date"] == "2026-10-01" else d for d in snap["daily"]]
        cfg.candidates = snap
        await session.commit()
        assert await redash_sync.apply_days(session, "t1", {D1: 70}) == []  # nothing for Slack
    assert await stored(db) == {D1: (70, 9)}  # but the number is kept right


async def test_start_refresh_runs_the_follow_up_after_the_refresh_even_when_nothing_was_fetched(db, make_program, monkeypatch):
    import asyncio
    await make_program("t1")
    await link(db, required_yoe="2+")
    monkeypatch.setattr(candidates, "fetch", ok_fetch)
    ran = []

    async def after():
        ran.append("announced")
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, "t1")
    assert candidates.start_refresh("t1", cfg, after=after) == "started"
    await asyncio.gather(*candidates._tasks)
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, "t1")
    assert candidates.start_refresh("t1", cfg, after=after) == "fresh"  # the snapshot is fresh now: no query, still announces
    await asyncio.gather(*candidates._tasks)
    assert ran == ["announced", "announced"] and not candidates._waiters


def test_progress_is_reported_while_a_run_is_in_flight():
    import time
    candidates._running["t9"] = {"phase": "queued", "since": time.monotonic() - 5}
    try:
        assert candidates.view(None, "t9")["progress"] == {"phase": "queued", "elapsed": 5}
    finally:
        candidates._running.pop("t9")
    assert candidates.view(None, "t9")["progress"] is None


def test_all_is_not_a_city():
    assert candidates.check_cities(["All", "pune", "ANY", "all cities"]) == ["pune"]


async def test_manual_fetch_queues_one_slack_message_after_the_relevant_count_is_in(client_for, make_user, make_program, db, monkeypatch):
    import asyncio
    from core.orm import SlackOutbox
    from core.permissions import Role

    await make_program("t1")
    await link(db, required_yoe="2+", required_cities=["Pune"], slack_channel_id="C0123456789", notify_slack=True)

    async def fetch_event(slug):
        return {"name": "Ev", "start": None, "end": None}, {D1: 70, D2: 25}
    monkeypatch.setattr(redash_sync, "fetch_event", fetch_event)
    monkeypatch.setattr(redash_sync, "event_dates", lambda info: (D1, D2))
    monkeypatch.setattr(candidates, "fetch", ok_fetch)

    async def outbox():
        async with db() as session:
            return list((await session.scalars(select(SlackOutbox))).all())

    client = await client_for(await make_user("csm@example.com", [Role.CSM]))
    body = (await client.post("/programs/t1/registrations/redash/run")).json()
    assert body["saved"] == 2 and body["slack"]["queued"] is True and await outbox() == []  # waits for the relevant count
    await asyncio.gather(*candidates._tasks)
    [message] = await outbox()  # through the outbox: kept across a Slack outage, deduped
    assert "Total registrations: *95*" in message.body and "Relevant registrations (2+ yrs · Pune): *10*" in message.body
    assert "6 relevant" in message.body and "4 relevant" in message.body  # each day carries its own relevant count

    again = (await client.post("/programs/t1/registrations/redash/run")).json()  # nothing changed: nothing announced
    await asyncio.gather(*candidates._tasks)
    assert again["saved"] == 0 and again["slack"]["queued"] is False and len(await outbox()) == 1
    assert await count_rows(db) == 2


# ---- findings from the independent review ---------------------------------------------------------------------------


async def test_a_refresh_never_overwrites_a_manual_programs_own_relevant_counts(db, make_program, monkeypatch):
    await make_program("t1")
    async with db() as session:  # manual mode: the CSM typed 40 relevant out of 100 for that day
        session.add(ProgramRegistrationSettings(ticket_id="t1", roles=[], fields=[], redash_event_slug="ev", required_yoe="2+"))
        session.add(ProgramRegistration(ticket_id="t1", date=D1, role="", registrations=100, relevant=40, extra={}))
        await session.commit()
    monkeypatch.setattr(candidates, "fetch", ok_fetch)
    assert await candidates.refresh("t1") is True  # the split is stored...
    assert await stored(db) == {D1: (100, 40)}  # ...the CSM's number is not touched


async def test_a_request_that_arrives_during_a_run_makes_it_look_again_even_after_an_error(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, required_yoe="2+")
    seen = []

    async def fetch(slug, yoe, cities, on_status=None):
        seen.append(yoe)
        if len(seen) == 1:  # the CSM changes the requirement (PUT starts a refresh: "already running") and the run then fails
            async with db() as session:
                cfg = await session.get(ProgramRegistrationSettings, "t1")
                cfg.required_yoe = "0-0"
                await session.commit()
            assert candidates.start_refresh("t1") == "already_running"
            raise redash.RedashError("Redash rejected the query (500)")
        return await ok_fetch(slug, yoe, cities)
    monkeypatch.setattr(candidates, "fetch", fetch)
    assert await candidates.refresh("t1") is True
    assert seen == ["2+", "0-0"] and not candidates._dirty
    async with db() as session:
        cfg = await session.get(ProgramRegistrationSettings, "t1")
        assert candidates.is_current(cfg) and cfg.candidates_error is None


async def test_a_plain_request_during_a_run_does_not_trigger_another_query(db, make_program, monkeypatch):
    await make_program("t1")
    await link(db, required_yoe="2+")
    calls = []

    async def fetch(slug, yoe, cities, on_status=None):
        calls.append(yoe)
        assert candidates.start_refresh("t1") == "already_running"  # e.g. someone clicks Refresh meanwhile
        return await ok_fetch(slug, yoe, cities)
    monkeypatch.setattr(candidates, "fetch", fetch)
    await candidates.refresh("t1")
    assert calls == ["2+"] and not candidates._dirty  # the second look finds a fresh snapshot and stops


async def test_a_failed_refresh_removes_the_relevant_line_from_the_slack_message(db, make_program, monkeypatch):
    from core.orm import Program
    await make_program("t1")
    await link(db, required_yoe="2+")
    monkeypatch.setattr(candidates, "fetch", ok_fetch)
    await candidates.refresh("t1")
    rows_ = [{"date": D1, "role": "", "registrations": 70, "relevant": 6, "extra": {}}]
    async with db() as session:
        program = await session.get(Program, "t1")
        assert "Relevant registrations (2+ yrs)" in await registration_message.summary(session, program, rows_)
        cfg = await session.get(ProgramRegistrationSettings, "t1")
        cfg.candidates_error = "Couldn't reach Redash (VPN?)"  # the newest refresh failed: the old figure would be frozen
        await session.commit()
        text = await registration_message.summary(session, program, rows_)
    assert "Relevant registrations" not in text and "Total so far" in text


async def test_changing_the_requirement_resets_each_days_relevant_until_the_new_numbers_land(client_for, make_user, make_program, db):
    import asyncio
    from core.permissions import Role
    await make_program("t1")
    await link(db)
    async with db() as session:
        await redash_sync.apply_days(session, "t1", {D1: 70})
    assert await stored(db) == {D1: (70, 70)}  # no requirement: relevant = registrations
    client = await client_for(await make_user("csm@example.com", [Role.CSM]))
    assert (await client.put("/programs/t1/candidates/requirement", json={"yoe": "2+", "cities": []})).status_code == 200
    await asyncio.gather(*candidates._tasks)  # the background refresh fails here (Redash is off in tests): nothing stored
    assert await stored(db) == {D1: (70, None)}  # unknown, not the old "everyone is relevant"
    await client.put("/programs/t1/candidates/requirement", json={"yoe": None, "cities": []})
    await asyncio.gather(*candidates._tasks)
    assert await stored(db) == {D1: (70, 70)}


def test_an_event_with_no_registrants_parses_and_the_undated_bucket_is_kept():
    empty = [row("Overall Registration Metrics", "Total registrations", 0),
             row("Overall Registration Metrics", "Relevant registrations (known YOE AND location)"),
             row("Overall Registration Metrics", "Possibly relevant (YOE unknown AND location)")]
    snap = candidates.parse(empty, None, [])  # the query emits no rows for the other sections
    assert snap["total"] == 0 and snap["daily"] == [] and snap["cities"]["items"] == [] and snap["yoe"]["unknown"] == 0
    assert candidates.parse(rows(), "2+", ["Pune"])["undated"] == {"total": 5, "relevant": 0, "possibly": 0}


async def test_manual_count_posts_respect_the_admin_slack_switch_and_the_page_is_told(client_for, make_user, make_program, db, monkeypatch):
    from api import registration_routes
    from core import settings_store
    from core.permissions import Role
    from core.settings_store import PortalSettings, SlackSettings

    await make_program("t1")
    async with db() as session:
        session.add(ProgramRegistrationSettings(ticket_id="t1", roles=[], fields=[], slack_channel_id="C0123456789", notify_slack=True))
        await session.commit()
    posted = []

    async def post(channel, body):
        posted.append(body)
        return True, None
    monkeypatch.setattr(registration_routes.slack, "post_message", post)
    csm = await client_for(await make_user("csm@example.com", [Role.CSM]))
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])

    first = (await csm.post("/programs/t1/registrations", json={"entries": [{"date": "2026-10-01", "registrations": 10, "relevant": 4}]})).json()
    assert first["slack"]["sent"] is True and len(posted) == 1
    assert (await csm.get("/programs/t1/registrations")).json()["slack_paused"] is False
    async with db() as session:
        await settings_store.save(session, admin, PortalSettings(slack=SlackSettings(enabled=False)))
        await session.commit()
    second = (await csm.post("/programs/t1/registrations", json={"entries": [{"date": "2026-10-02", "registrations": 12, "relevant": 5}]})).json()
    assert second["saved"] == 1 and second["slack"]["sent"] is False and len(posted) == 1  # saved, not announced
    assert (await csm.get("/programs/t1/registrations")).json()["slack_paused"] is True


async def test_linking_an_event_cannot_set_the_requirement_without_the_registrations_permission(client_for, make_user, make_program, db, monkeypatch):
    from core.orm import UserPermissionOverride
    from core.permissions import Permission, Role

    await make_program("t1")
    user = await make_user("link-only@example.com", [Role.CSM])  # a CSM whose registrations.manage was revoked
    async with db() as session:
        session.add(UserPermissionOverride(user_id=user.id, permission=Permission.REGISTRATIONS_MANAGE.value, granted=False))
        await session.commit()

    async def fetch_event(slug):
        return {"name": "Ev", "start": None, "end": None}, {}
    monkeypatch.setattr(redash_sync, "fetch_event", fetch_event)
    monkeypatch.setattr(redash_sync, "event_dates", lambda info: (D1, D2))
    client = await client_for(user)
    body = {"event_slug": "ev", "auto": True, "requirement": {"yoe": "2+", "cities": []}}
    assert (await client.put("/programs/t1/registrations/redash", json=body)).status_code == 403  # the same gate as the dedicated route
    assert (await client.put("/programs/t1/candidates/requirement", json={"yoe": "2+", "cities": []})).status_code == 403
    async with db() as session:
        assert (await session.get(ProgramRegistrationSettings, "t1")) is None  # nothing was saved by the refused call
    assert (await client.put("/programs/t1/registrations/redash", json={"event_slug": "ev", "auto": True})).status_code == 200  # linking alone is fine
