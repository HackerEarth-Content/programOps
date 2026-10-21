"""Relevant registrations (the CSM's own count) and the target and dates override."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from core.orm import ProgramRegistration, ProgramEvent, RelevantRegistration
from core.permissions import Role


async def csm(make_user, email="csm@example.com", name="Priya S."):
    return await make_user(email, [Role.CSM], name=name)


async def add(client, day="2026-10-18", count=810, **extra):
    return await client.post("/programs/t1/relevant-registrations", json={"date": day, "count": count, **extra})


async def test_a_csm_records_the_days_relevant_registrations(client_for, make_user, make_program):
    await make_program("t1")
    client = await client_for(await csm(make_user))
    response = await add(client, criteria="Tier 1/2 full-stack", note="Email batch 1 respondents")
    body = response.json()
    assert response.status_code == 201
    assert (body["count"], body["entered_by_name"], body["source"], body["criteria"]) == (810, "Priya S.", "manual", "Tier 1/2 full-stack")
    listed = (await client.get("/programs/t1/relevant-registrations")).json()
    assert listed["total"] == 810 and len(listed["entries"]) == 1


async def test_only_a_csm_can_enter_the_count_but_marketing_can_read_it(client_for, make_user, make_program):
    await make_program("t1")
    await add(await client_for(await csm(make_user)))
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await add(marketing, count=5)).status_code == 403
    assert (await marketing.get("/programs/t1/relevant-registrations")).json()["total"] == 810


async def test_the_total_sums_every_day_newest_day_first(client_for, make_user, make_program):
    await make_program("t1")
    client = await client_for(await csm(make_user))
    for day, count in (("2026-10-16", 920), ("2026-10-18", 810), ("2026-10-17", 540)):
        await add(client, day, count)
    listed = (await client.get("/programs/t1/relevant-registrations")).json()
    assert listed["total"] == 2270
    assert [e["date"] for e in listed["entries"]] == ["2026-10-18", "2026-10-17", "2026-10-16"]


async def test_a_negative_count_is_rejected(client_for, make_user, make_program):
    await make_program("t1")
    assert (await add(await client_for(await csm(make_user)), count=-1)).status_code == 422


async def test_a_correction_replaces_the_entry_and_keeps_the_history(client_for, make_user, make_program, db):
    await make_program("t1")
    client = await client_for(await csm(make_user))
    first = (await add(client)).json()
    fixed = await client.post(
        f"/programs/t1/relevant-registrations/{first['id']}/supersede", json={"count": 700}
    )
    assert fixed.status_code == 201 and fixed.json()["supersedes_id"] == first["id"]
    listed = (await client.get("/programs/t1/relevant-registrations")).json()
    assert listed["total"] == 700 and [e["id"] for e in listed["entries"]] == [fixed.json()["id"]]
    async with db() as session:
        assert len((await session.scalars(select(RelevantRegistration))).all()) == 2  # nothing was overwritten


async def test_a_correction_keeps_the_criteria_and_note_when_not_given(client_for, make_user, make_program):
    await make_program("t1")
    client = await client_for(await csm(make_user))
    first = (await add(client, criteria="Tier 1", note="batch 4")).json()
    fixed = (await client.post(f"/programs/t1/relevant-registrations/{first['id']}/supersede", json={"count": 1})).json()
    assert (fixed["criteria"], fixed["note"]) == ("Tier 1", "batch 4")


async def test_an_entry_can_only_be_corrected_once_and_only_in_its_own_program(client_for, make_user, make_program):
    await make_program("t1")
    await make_program("t2")
    client = await client_for(await csm(make_user))
    first = (await add(client)).json()
    await client.post(f"/programs/t1/relevant-registrations/{first['id']}/supersede", json={"count": 1})
    again = await client.post(f"/programs/t1/relevant-registrations/{first['id']}/supersede", json={"count": 2})
    assert (again.status_code, again.json()["code"]) == (409, "entry_superseded")
    elsewhere = await client.post(f"/programs/t2/relevant-registrations/{first['id']}/supersede", json={"count": 2})
    assert (elsewhere.status_code, elsewhere.json()["code"]) == (404, "entry_not_found")


async def test_adding_and_correcting_are_audited(client_for, make_user, make_program, db):
    await make_program("t1")
    user = await csm(make_user)
    client = await client_for(user)
    first = (await add(client)).json()
    await client.post(f"/programs/t1/relevant-registrations/{first['id']}/supersede", json={"count": 700})
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).order_by(ProgramEvent.id))).all()
    assert [e.action for e in events] == ["relevant_added", "relevant_corrected"]
    assert events[1].old == {"count": 810} and events[1].new == {"count": 700} and events[1].actor_id == user.id


async def test_relevant_registrations_are_never_added_into_the_redash_total(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        session.add(ProgramRegistration(ticket_id="t1", date=date(2026, 10, 18), role="", registrations=100, relevant=100))
        await session.commit()
    client = await client_for(await csm(make_user))
    await add(client, count=20)
    body = (await client.get("/programs/t1/registrations")).json()
    assert (body["raw_total"], body["relevant_total"]) == (100, 20)


async def test_the_csm_overrides_the_target_and_campaign_dates(client_for, make_user, make_program):
    await make_program("t1")
    client = await client_for(await csm(make_user))
    response = await client.put(
        "/programs/t1/registrations/targets",
        json={"target": 50000, "campaign_start": "2026-10-01", "campaign_end": "2026-11-15"},
    )
    assert response.status_code == 200
    estimate = (await client.get("/programs/t1/registrations")).json()["estimate"]
    assert (estimate["target"], estimate["start"], estimate["end"], estimate["start_source"]) == (
        50000, "2026-10-01", "2026-11-15", "override",
    )


async def test_marketing_cannot_change_the_target_and_the_end_cannot_precede_the_start(client_for, make_user, make_program):
    await make_program("t1")
    refused = await (await client_for(await make_user("m@example.com", [Role.MARKETING]))).put(
        "/programs/t1/registrations/targets", json={"target": 5}
    )
    assert refused.status_code == 403
    backwards = await (await client_for(await csm(make_user))).put(
        "/programs/t1/registrations/targets", json={"campaign_start": "2026-11-01", "campaign_end": "2026-10-01"}
    )
    assert backwards.status_code == 422
