"""Rounds of any shape, their counts, the funnel, and rounds suggested from the SOW."""

from __future__ import annotations

from datetime import date

from sqlalchemy import func, select

from core.orm import Checklist, ProgramDocument, ProgramEvent, ProgramRegistration, RoundCount
from core.permissions import Role


async def csm_client(client_for, make_user):
    return await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))


async def add_round(client, name="Round 1", **extra):
    response = await client.post("/programs/t1/rounds", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def add_counts(client, round_id: int, **fields):
    return await client.post(f"/programs/t1/rounds/{round_id}/counts", json={"as_of": "2026-10-18", **fields})


# ---- rounds ---------------------------------------------------------------------


async def test_rounds_are_numbered_in_the_order_they_are_added(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    first = await add_round(client, "Assessment", kind="assessment", cutoff_rule="Score at least 60%", cutoff_value=60)
    second = await add_round(client, "Project", kind="project")
    finale = await add_round(client, "Finale", kind="onsite")
    assert [r["seq"] for r in (first, second, finale)] == [1, 2, 3]
    assert first["cutoff_rule"] == "Score at least 60%" and first["cutoff_value"] == 60
    assert [r["name"] for r in (await client.get("/programs/t1/rounds")).json()] == ["Assessment", "Project", "Finale"]


async def test_a_round_cannot_end_before_it_starts(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    response = await client.post("/programs/t1/rounds", json={"name": "R", "starts_on": "2026-10-10", "ends_on": "2026-10-01"})
    assert (response.status_code, response.json()["code"]) == (422, "round_dates_invalid")
    made = await add_round(client, "R", starts_on="2026-10-10", ends_on="2026-10-12")
    bad = await client.patch(f"/programs/t1/rounds/{made['id']}", json={"ends_on": "2026-10-01"})
    assert (bad.status_code, bad.json()["code"]) == (422, "round_dates_invalid")


async def test_only_a_csm_edits_rounds_but_everyone_can_read_them(client_for, make_user, make_program):
    await make_program("t1")
    made = await add_round(await csm_client(client_for, make_user))
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await marketing.post("/programs/t1/rounds", json={"name": "X"})).status_code == 403
    assert (await marketing.patch(f"/programs/t1/rounds/{made['id']}", json={"name": "X"})).status_code == 403
    assert (await marketing.delete(f"/programs/t1/rounds/{made['id']}")).status_code == 403
    assert len((await marketing.get("/programs/t1/rounds")).json()) == 1


async def test_editing_a_round_is_audited_per_field(client_for, make_user, make_program, db):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    made = await add_round(client, "Old name")
    response = await client.patch(f"/programs/t1/rounds/{made['id']}", json={"name": "New name", "status": "live"})
    assert response.status_code == 200 and response.json()["status"] == "live"
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).where(ProgramEvent.action == "round_updated"))).all()
    assert sorted(e.field for e in events) == ["name", "status"]


async def test_a_round_can_be_renamed_but_not_to_a_blank_name(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    made = await add_round(client, "Round 1")
    renamed = await client.patch(f"/programs/t1/rounds/{made['id']}", json={"name": "  Coding assessment  ", "kind": "assessment"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Coding assessment"
    blank = await client.patch(f"/programs/t1/rounds/{made['id']}", json={"name": "   "})
    assert (blank.status_code, blank.json()["code"]) == (422, "round_name_required")
    assert (await client.get("/programs/t1/rounds")).json()[0]["name"] == "Coding assessment"


async def test_deleting_a_round_closes_the_gap_in_the_numbering(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    first, second, third = [await add_round(client, n) for n in ("A", "B", "C")]
    assert (await client.delete(f"/programs/t1/rounds/{second['id']}")).status_code == 204
    assert [(r["name"], r["seq"]) for r in (await client.get("/programs/t1/rounds")).json()] == [("A", 1), ("C", 2)]


async def test_rounds_can_be_reordered_but_only_with_every_round(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    a, b, c = [await add_round(client, n) for n in ("A", "B", "C")]
    moved = await client.post("/programs/t1/rounds/reorder", json={"order": [c["id"], a["id"], b["id"]]})
    assert [r["name"] for r in moved.json()] == ["C", "A", "B"] and [r["seq"] for r in moved.json()] == [1, 2, 3]
    partial = await client.post("/programs/t1/rounds/reorder", json={"order": [a["id"]]})
    assert (partial.status_code, partial.json()["code"]) == (422, "reorder_mismatch")


async def test_a_round_from_another_program_is_not_reachable(client_for, make_user, make_program):
    await make_program("t1")
    await make_program("t2")
    client = await csm_client(client_for, make_user)
    made = await add_round(client)
    other = await client.patch(f"/programs/t2/rounds/{made['id']}", json={"name": "X"})
    assert (other.status_code, other.json()["code"]) == (404, "round_not_found")


# ---- counts ---------------------------------------------------------------------


async def test_counts_are_recorded_with_who_entered_them(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    made = await add_round(client)
    response = await add_counts(client, made["id"], invited=9800, attempted=7100, cleared=1350, shortlisted=400, note="Batch 4")
    body = response.json()
    assert response.status_code == 201
    assert (body["attempted"], body["entered_by_name"], body["note"]) == (7100, "Priya S.", "Batch 4")
    assert (await client.get("/programs/t1/rounds")).json()[0]["latest_counts"]["cleared"] == 1350


async def test_each_step_cannot_exceed_the_one_before(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    made = await add_round(client)
    for fields in (
        {"invited": 10, "attempted": 11}, {"attempted": 10, "cleared": 11}, {"attempted": 10, "shortlisted": 11},
        {"attempted": 10, "cleared": 5, "shortlisted": 6}, {"invited": 10, "shortlisted": 11},
    ):
        response = await add_counts(client, made["id"], **fields)
        assert (response.status_code, response.json()["code"]) == (422, "counts_inconsistent"), fields
    assert (await add_counts(client, made["id"], invited=-1)).status_code == 422
    assert (await add_counts(client, made["id"], invited=10, attempted=9, cleared=5, shortlisted=5)).status_code == 201


async def test_a_round_can_only_invite_who_the_previous_round_shortlisted(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    first, second = await add_round(client, "Assessment"), await add_round(client, "Project")
    await add_counts(client, first["id"], invited=1000, attempted=800, cleared=200, shortlisted=100)
    too_many = await add_counts(client, second["id"], invited=101)
    assert (too_many.status_code, too_many.json()["code"]) == (422, "invited_exceeds_previous_shortlist")
    assert (await add_counts(client, second["id"], invited=100)).status_code == 201


async def test_a_shortlist_cannot_drop_below_what_the_next_round_invited(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    first, second = await add_round(client, "Assessment"), await add_round(client, "Project")
    entry = (await add_counts(client, first["id"], invited=1000, attempted=800, cleared=200, shortlisted=100)).json()
    await add_counts(client, second["id"], invited=100)
    bad = await client.post(f"/programs/t1/rounds/{first['id']}/counts/{entry['id']}/supersede", json={"invited": 1000, "attempted": 800, "cleared": 200, "shortlisted": 90})
    assert (bad.status_code, bad.json()["code"]) == (422, "shortlist_below_next_invited")


async def test_the_first_round_cannot_invite_more_than_registered(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        session.add(ProgramRegistration(ticket_id="t1", date=date(2026, 10, 18), role="", registrations=500))
        await session.commit()
    client = await csm_client(client_for, make_user)
    made = await add_round(client)
    too_many = await add_counts(client, made["id"], invited=501)
    assert (too_many.status_code, too_many.json()["code"]) == (422, "invited_exceeds_registrations")
    assert (await add_counts(client, made["id"], invited=500)).status_code == 201


async def test_only_a_csm_enters_counts(client_for, make_user, make_program):
    await make_program("t1")
    made = await add_round(await csm_client(client_for, make_user))
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await add_counts(marketing, made["id"], invited=1)).status_code == 403


async def test_the_latest_as_of_date_is_the_current_count(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    made = await add_round(client)
    await client.post(f"/programs/t1/rounds/{made['id']}/counts", json={"as_of": "2026-10-20", "invited": 200})
    await client.post(f"/programs/t1/rounds/{made['id']}/counts", json={"as_of": "2026-10-18", "invited": 100})
    assert (await client.get("/programs/t1/rounds")).json()[0]["latest_counts"]["invited"] == 200


async def test_a_correction_supersedes_the_old_entry_and_keeps_history(client_for, make_user, make_program, db):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    made = await add_round(client)
    first = (await add_counts(client, made["id"], invited=100, attempted=90)).json()
    fixed = await client.post(f"/programs/t1/rounds/{made['id']}/counts/{first['id']}/supersede", json={"invited": 120, "attempted": 90})
    assert fixed.status_code == 201 and fixed.json()["supersedes_id"] == first["id"] and fixed.json()["as_of"] == first["as_of"]
    standing = (await client.get(f"/programs/t1/rounds/{made['id']}/counts")).json()
    assert [e["invited"] for e in standing] == [120]
    async with db() as session:
        assert await session.scalar(select(func.count()).select_from(RoundCount)) == 2
    again = await client.post(f"/programs/t1/rounds/{made['id']}/counts/{first['id']}/supersede", json={"invited": 1})
    assert (again.status_code, again.json()["code"]) == (409, "counts_superseded")


async def test_a_correction_is_checked_like_a_new_entry(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    made = await add_round(client)
    first = (await add_counts(client, made["id"], invited=100)).json()
    bad = await client.post(f"/programs/t1/rounds/{made['id']}/counts/{first['id']}/supersede", json={"invited": 5, "attempted": 9})
    assert (bad.status_code, bad.json()["code"]) == (422, "counts_inconsistent")


# ---- funnel and suggestions -------------------------------------------------------


async def test_the_funnel_shows_participation_clearance_and_drop_off(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    first = await add_round(client, "Assessment")
    await add_round(client, "Project")
    await add_counts(client, first["id"], invited=1000, attempted=800, cleared=200, shortlisted=100)
    steps = (await client.get("/programs/t1/rounds/funnel")).json()
    assert steps[0]["participation_pct"] == 80.0 and steps[0]["clearance_pct"] == 25.0
    assert steps[0]["shortlist_pct"] == 12.5 and steps[0]["drop_off"] == 200
    assert steps[1]["invited"] is None and steps[1]["participation_pct"] is None  # no counts yet: unknown, not zero


async def test_rounds_in_the_sow_are_suggested_until_they_exist(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        session.add(ProgramDocument(
            ticket_id="t1", kind="sow", hubspot_property="sow_upload", hubspot_file_id="1", file_name="s.pdf",
            mime_type="application/pdf", size_bytes=1, content=b"x", status="ok",
            details={"rounds": [{"name": "MCQ Screening", "details": ["60 minutes", "Proctored"]}, {"name": "Grand Finale", "details": []}]},
        ))
        await session.commit()
    client = await csm_client(client_for, make_user)
    suggested = (await client.get("/programs/t1/rounds/suggested")).json()
    assert suggested == [{"name": "MCQ Screening", "notes": "60 minutes; Proctored"}, {"name": "Grand Finale", "notes": ""}]
    accepted = await add_round(client, "mcq screening", source="sow")
    assert accepted["source"] == "sow"
    assert [s["name"] for s in (await client.get("/programs/t1/rounds/suggested")).json()] == ["Grand Finale"]
