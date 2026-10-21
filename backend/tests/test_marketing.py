"""The marketing tracker: POA seeding, CSM-only approval, the go-live rule (service and database), the queue."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from core import activities
from core.activities import ActivityStatus
from core.orm import ProgramActivity, ProgramDocument, ProgramEvent
from core.permissions import Role


def poa(*rows: tuple[str, str, str, str | None]) -> dict:
    """POA details as extraction stores them: (week label, channel, activity title, ISO date or None)."""
    return {
        "activities": [
            {"week": w, "channel": c, "activity": a, "date": d, "objective": "Awareness", "description": f"Run {a}"}
            for w, c, a, d in rows
        ]
    }


BASE = poa(
    ("Week 1", "Community", "Onsite Banner", "2026-10-06"),
    ("Week 1", "Email", "Email Batch 1", None),
    ("Week 2", "Social", "LinkedIn Carousels", None),
)


async def seed(db, details: dict = BASE, ticket_id: str = "t1"):
    async with db() as session:
        result = await activities.seed_from_poa(session, ticket_id, details)
        await session.commit()
    return result


async def rows(db, ticket_id: str = "t1") -> list[ProgramActivity]:
    async with db() as session:
        return await activities.list_for(session, ticket_id)


@pytest.fixture
async def plan(db, make_program) -> str:
    await make_program("t1")
    await seed(db)
    return "t1"


async def csm(make_user, email="csm@example.com", name="Priya S."):
    return await make_user(email, [Role.CSM], name=name)


async def marketer(make_user):
    return await make_user("mkt@example.com", [Role.MARKETING], name="Neha K.")


async def ready_for_live(client_csm, aid: int, ticket: str = "t1"):
    """Approved and with a UTM: everything go-live needs."""
    await client_csm.patch(f"/programs/{ticket}/activities/{aid}", json={"utm": "he_mark/channel3"})
    assert (await client_csm.post(f"/programs/{ticket}/activities/{aid}/approve")).status_code == 200


# ---- seeding from the POA ----------------------------------------------------


async def test_every_poa_row_becomes_an_unapproved_activity(db, plan):
    got = await rows(db)
    assert [(a.code, a.week, a.channel, a.title, a.source, a.status) for a in got] == [
        ("W1-ACT-01", 1, "Community", "Onsite Banner", "poa", "not_started"),
        ("W1-ACT-02", 1, "Email", "Email Batch 1", "poa", "not_started"),
        ("W2-ACT-01", 2, "Social", "LinkedIn Carousels", "poa", "not_started"),
    ]
    assert got[0].planned_date == date(2026, 10, 6) and got[1].planned_date is None
    assert all(a.approved_at is None and a.utm is None for a in got)


async def test_rereading_an_unchanged_poa_changes_nothing(db, plan):
    result = await seed(db)
    assert (result.added, result.removed, result.edits_kept) == (0, 0, 0)
    assert len(await rows(db)) == 3


async def test_a_new_poa_row_is_added_and_existing_rows_are_left_alone(db, plan):
    same = [(r["week"], r["channel"], r["activity"], r["date"]) for r in BASE["activities"]]
    result = await seed(db, poa(*same, ("Week 3", "Email", "Final Day Email", None)))
    assert (result.added, result.removed) == (1, 0)
    assert [a.title for a in await rows(db)][-1] == "Final Day Email"


async def test_a_row_that_vanished_is_removed_only_if_nobody_edited_it(db, make_user, plan):
    async with db() as session:
        edited = (await activities.list_for(session, "t1"))[0]
        await activities.update(session, await csm(make_user), edited, {"utm": "he_mark/x"})
        await session.commit()
    result = await seed(db, poa(("Week 2", "Social", "LinkedIn Carousels", None)))
    assert (result.added, result.removed, result.edits_kept) == (0, 1, 1)
    assert sorted(a.title for a in await rows(db)) == ["LinkedIn Carousels", "Onsite Banner"]  # the edited one stayed


async def test_a_repeated_poa_row_gets_its_own_key(db, make_program):
    await make_program("t2")
    await seed(db, poa(("Week 1", "Email", "Reminder", None), ("Week 1", "Email", "Reminder", None)), "t2")
    got = await rows(db, "t2")
    assert len(got) == 2 and len({a.poa_key for a in got}) == 2


async def test_reread_endpoint_reseeds_from_the_stored_poa_without_touching_edits(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        session.add(
            ProgramDocument(
                ticket_id="t1", kind="poa", hubspot_property="marketing_poa_upload", hubspot_file_id="1",
                file_name="poa.pdf", mime_type="application/pdf", size_bytes=1, content=b"x", status="ok", details=BASE,
            )
        )
        await session.commit()
    client = await client_for(await csm(make_user))
    first = (await client.post("/programs/t1/plan/reread")).json()
    again = (await client.post("/programs/t1/plan/reread")).json()
    assert first == {"added": 3, "removed": 0, "edits_kept": 0}
    assert again == {"added": 0, "removed": 0, "edits_kept": 0}


async def test_the_sync_pass_seeds_only_programs_that_have_a_poa_and_no_plan(db, make_program):
    from hubspot_client.documents import seed_missing_plans

    for ticket in ("planned", "unplanned", "no-poa"):
        await make_program(ticket)
    async with db() as session:
        for ticket in ("planned", "unplanned"):
            session.add(
                ProgramDocument(
                    ticket_id=ticket, kind="poa", hubspot_property="marketing_poa_upload", hubspot_file_id="1",
                    file_name="poa.pdf", mime_type="application/pdf", size_bytes=1, content=b"x", status="ok", details=BASE,
                )
            )
        await session.commit()
    await seed(db, poa(("Week 1", "Email", "Hand-made plan", None)), "planned")

    await seed_missing_plans()
    await seed_missing_plans()  # a second run changes nothing

    assert [a.title for a in await rows(db, "planned")] == ["Hand-made plan"]  # left alone
    assert len(await rows(db, "unplanned")) == 3
    assert await rows(db, "no-poa") == []


async def test_reread_without_a_poa_is_404_and_needs_integration_rights(client_for, make_user, make_program):
    await make_program("t1")
    missing = await (await client_for(await csm(make_user))).post("/programs/t1/plan/reread")
    assert (missing.status_code, missing.json()["code"]) == (404, "poa_missing")
    forbidden = await (await client_for(await marketer(make_user))).post("/programs/t1/plan/reread")
    assert forbidden.status_code == 403


# ---- the database enforces the go-live rule too --------------------------------


async def test_the_database_refuses_live_without_approval_even_for_raw_sql(db, plan):
    async with db() as session:
        with pytest.raises(DBAPIError, match="activity_live_requires_approval"):
            await session.execute(text("UPDATE program_activities SET status = 'live' WHERE code = 'W1-ACT-01'"))


async def test_the_database_refuses_inserting_a_live_unapproved_activity(db, plan):
    async with db() as session:
        session.add(ProgramActivity(ticket_id="t1", code="ADD-09", source="manual", channel="X", title="X", status="live"))
        with pytest.raises(DBAPIError, match="activity_live_requires_approval"):
            await session.commit()


async def test_the_database_still_lets_an_approval_be_withdrawn_on_a_live_activity(db, plan):
    async with db() as session:
        await session.execute(
            text("UPDATE program_activities SET approved_at = now(), status = 'live' WHERE code = 'W1-ACT-01'")
        )
        await session.execute(text("UPDATE program_activities SET approved_at = NULL WHERE code = 'W1-ACT-01'"))
        await session.commit()
    assert activities.is_breach((await rows(db))[0])


# ---- approval and go-live through the API ----------------------------------------


async def test_only_a_csm_can_approve(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    refused = await (await client_for(await marketer(make_user))).post(f"/programs/t1/activities/{aid}/approve")
    assert (refused.status_code, refused.json()["code"]) == (403, "permission_denied")
    ok = await (await client_for(await csm(make_user))).post(f"/programs/t1/activities/{aid}/approve")
    body = ok.json()
    assert ok.status_code == 200 and body["approved_by_name"] == "Priya S." and body["approved_at"]


async def test_the_first_approval_stands_when_a_second_csm_approves_again(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    await (await client_for(await csm(make_user))).post(f"/programs/t1/activities/{aid}/approve")
    second = await (await client_for(await csm(make_user, "other@example.com", "Arjun M."))).post(
        f"/programs/t1/activities/{aid}/approve"
    )
    assert second.json()["approved_by_name"] == "Priya S."


async def test_go_live_is_refused_without_an_approval(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    client = await client_for(await csm(make_user))
    await client.patch(f"/programs/t1/activities/{aid}", json={"utm": "he_mark/channel3"})
    response = await client.post(f"/programs/t1/activities/{aid}/go-live", json={})
    assert (response.status_code, response.json()["code"]) == (409, "activity_live_requires_approval")


async def test_patching_the_status_to_live_cannot_bypass_the_rule(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    response = await (await client_for(await marketer(make_user))).patch(f"/programs/t1/activities/{aid}", json={"status": "live"})
    assert (response.status_code, response.json()["code"]) == (409, "activity_live_requires_approval")


async def test_go_live_is_refused_without_a_utm(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    client = await client_for(await csm(make_user))
    await client.post(f"/programs/t1/activities/{aid}/approve")
    response = await client.post(f"/programs/t1/activities/{aid}/go-live", json={})
    assert (response.status_code, response.json()["code"]) == (409, "activity_requires_utm")


async def test_an_approved_activity_with_a_utm_goes_live_and_marketing_can_do_it(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    await ready_for_live(await client_for(await csm(make_user)), aid)
    live = await (await client_for(await marketer(make_user))).post(f"/programs/t1/activities/{aid}/go-live", json={})
    body = live.json()
    assert live.status_code == 200 and body["status"] == "live" and body["go_live_at"] and body["breach"] is False


async def test_a_live_activity_must_keep_its_utm(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    client = await client_for(await csm(make_user))
    await ready_for_live(client, aid)
    await client.post(f"/programs/t1/activities/{aid}/go-live", json={})
    response = await client.patch(f"/programs/t1/activities/{aid}", json={"utm": ""})
    assert (response.status_code, response.json()["code"]) == (409, "activity_requires_utm")


async def test_withdrawing_approval_on_a_live_activity_is_a_breach_not_a_refusal(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    client = await client_for(await csm(make_user))
    await ready_for_live(client, aid)
    await client.post(f"/programs/t1/activities/{aid}/go-live", json={})
    withdrawn = await client.delete(f"/programs/t1/activities/{aid}/approve")
    assert withdrawn.status_code == 200 and withdrawn.json()["breach"] is True
    summary = (await client.get("/programs/t1/activities/summary")).json()
    assert summary["breaches"] == 1 and summary["live"] == 1
    async with db() as session:
        event = await session.scalar(select(ProgramEvent).where(ProgramEvent.action == "approval_withdrawn"))
    assert event.new == {"breach": True} and event.actor_name == "Priya S."


async def test_withdrawing_approval_before_go_live_is_not_a_breach(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    client = await client_for(await csm(make_user))
    await client.post(f"/programs/t1/activities/{aid}/approve")
    assert (await client.delete(f"/programs/t1/activities/{aid}/approve")).json()["breach"] is False


async def test_the_control_strip_counts(client_for, make_user, plan, db):
    first, second = [a.id for a in (await rows(db))[:2]]
    client = await client_for(await csm(make_user))
    await ready_for_live(client, first)
    await client.post(f"/programs/t1/activities/{first}/go-live", json={})
    await client.post(f"/programs/t1/activities/{second}/approve")
    assert (await client.get("/programs/t1/activities/summary")).json() == {
        "total": 3, "live": 1, "approved": 2, "awaiting_approval": 1, "breaches": 0, "ramp_pct": 33.3,
    }


# ---- editing, adding, auditing --------------------------------------------------------


async def test_marketing_edits_and_the_change_is_audited_per_field(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    mkt = await marketer(make_user)
    client = await client_for(mkt)
    response = await client.patch(
        f"/programs/t1/activities/{aid}",
        json={"utm": "he_mark/channel3", "status": "wip", "creative_proof_url": "https://figma.com/x", "title": "Onsite Banner"},
    )
    assert response.status_code == 200 and response.json()["status"] == "wip"
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).where(ProgramEvent.action == "activity_updated"))).all()
    assert sorted(e.field for e in events) == ["creative_proof_url", "status", "utm"]  # the unchanged title wrote nothing
    assert {e.actor_id for e in events} == {mkt.id}


async def test_an_account_manager_can_read_the_plan_but_not_change_it(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    client = await client_for(await make_user("am@example.com", [Role.ACCOUNT_MANAGER]))
    assert len((await client.get("/programs/t1/activities")).json()) == 3
    assert (await client.patch(f"/programs/t1/activities/{aid}", json={"utm": "x"})).status_code == 403
    assert (await client.post("/programs/t1/activities", json={"channel": "Email", "title": "X"})).status_code == 403


async def test_adding_a_channel_is_marked_as_added_and_gets_its_own_code(client_for, make_user, plan):
    client = await client_for(await marketer(make_user))
    first = (await client.post("/programs/t1/activities", json={"channel": "Community", "title": "Discord Blitz", "week": 1})).json()
    second = (await client.post("/programs/t1/activities", json={"channel": "Email", "title": "Extra send"})).json()
    assert (first["source"], first["code"], first["status"]) == ("manual", "ADD-01", "not_started")
    assert second["code"] == "ADD-02"


async def test_a_stale_edit_is_refused_and_a_fresh_one_passes(client_for, make_user, plan, db):
    aid = (await rows(db))[0].id
    client = await client_for(await csm(make_user))
    seen = (await client.get("/programs/t1/activities")).json()[0]["updated_at"]
    assert (await client.patch(f"/programs/t1/activities/{aid}", json={"utm": "a"})).status_code == 200  # moves updated_at
    stale = await client.patch(f"/programs/t1/activities/{aid}", json={"utm": "b"}, headers={"If-Match": seen})
    assert (stale.status_code, stale.json()["code"]) == (409, "stale_write")
    fresh = (await client.get("/programs/t1/activities")).json()[0]["updated_at"]
    assert (await client.patch(f"/programs/t1/activities/{aid}", json={"utm": "b"}, headers={"If-Match": fresh})).status_code == 200


async def test_an_unknown_program_is_404(client_for, make_user):
    response = await (await client_for(await csm(make_user))).get("/programs/nope/activities")
    assert (response.status_code, response.json()["code"]) == (404, "program_not_found")


async def test_another_programs_activity_is_not_reachable(client_for, make_user, make_program, plan, db):
    await make_program("t2")
    aid = (await rows(db))[0].id
    response = await (await client_for(await csm(make_user))).post(f"/programs/t2/activities/{aid}/approve")
    assert (response.status_code, response.json()["code"]) == (404, "activity_not_found")


# ---- the marketing queue --------------------------------------------------------------


async def test_the_marketing_queue_sorts_work_into_its_kinds(client_for, make_user, plan, db):
    first, second, third = [a.id for a in await rows(db)]
    client = await client_for(await csm(make_user))
    await ready_for_live(client, first)  # approved + UTM, planned 6 Oct (past): due
    await client.patch(f"/programs/t1/activities/{second}", json={"status": "wip"})  # waiting for approval
    await client.patch(f"/programs/t1/activities/{third}", json={"status": "off"})
    queue = (await client.get("/queues/marketing")).json()
    kinds = {(i["activity_id"], i["kind"]) for i in queue["items"]}
    assert (first, "go_live_due") in kinds
    assert (second, "awaiting_approval") in kinds and (second, "missing_utm_or_proof") in kinds
    assert all(i["activity_id"] != third for i in queue["items"])  # off: not queued
    assert queue["counts"]["go_live_due"] == 1 and queue["counts"]["awaiting_approval"] == 1
    assert queue["items"][0]["severity"] == "critical"  # most urgent first


async def test_an_approved_activity_planned_later_is_ready_to_go_live(client_for, make_user, make_program, db):
    await make_program("t3")
    await seed(db, poa(("Week 1", "Email", "Later Send", (date.today() + timedelta(days=5)).isoformat())), "t3")
    aid = (await rows(db, "t3"))[0].id
    client = await client_for(await csm(make_user))
    await ready_for_live(client, aid, "t3")
    items = (await client.get("/queues/marketing", params={"program": "t3"})).json()["items"]
    # approved and tagged but no creative proof yet: ready, and still flagged for the missing proof
    assert {i["kind"] for i in items if i["activity_id"] == aid} == {"ready_to_go_live", "missing_utm_or_proof"}


async def test_a_closed_program_is_not_queued(client_for, make_user, make_program, db):
    await make_program("t4")
    await seed(db, BASE, "t4")
    async with db() as session:
        await session.execute(text("UPDATE programs SET stage_label = 'Closed' WHERE ticket_id = 't4'"))
        await session.commit()
    assert (await (await client_for(await csm(make_user))).get("/queues/marketing")).json()["items"] == []


async def test_the_status_enum_matches_the_database_check():
    assert {s.value for s in ActivityStatus} == {"not_started", "wip", "live", "off"}


async def test_a_creative_proof_must_be_an_http_link(client_for, make_user, plan):
    # The UI renders the proof as a link, so javascript: and friends are refused at the source.
    client = await client_for(await csm(make_user))
    aid = (await client.get(f"/programs/{plan}/activities")).json()[0]["id"]
    for bad in ("javascript:alert(1)", "data:text/html,x", "ftp://x/y", "not a url"):
        response = await client.patch(f"/programs/{plan}/activities/{aid}", json={"creative_proof_url": bad})
        assert response.status_code == 422 and response.json()["code"] == "invalid_proof_url", bad
    ok = await client.patch(f"/programs/{plan}/activities/{aid}", json={"creative_proof_url": "https://figma.com/file/x"})
    assert ok.status_code == 200
    cleared = await client.patch(f"/programs/{plan}/activities/{aid}", json={"creative_proof_url": ""})
    assert cleared.status_code == 200 and cleared.json()["creative_proof_url"] is None
