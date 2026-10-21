"""The CSM queue: every kind of work that needs a CSM, ordered by urgency, scoped to my programs or all."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from core import activities
from core.csm_queue import CsmKind
from core.permissions import Role

NOW = datetime.now(timezone.utc)
TODAY = NOW.date()


def days(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


async def csm(client_for, make_user):
    user = await make_user("csm@example.com", [Role.CSM], name="Priya S.")
    return await client_for(user), user


async def busy_program(client, db) -> None:
    """One program with something wrong in every way the queue knows about."""
    async with db() as session:
        await activities.seed_from_poa(session, "t1", {"activities": [
            {"week": "Week 1", "channel": "Email", "activity": a, "date": None, "objective": "", "description": ""} for a in ("Live one", "Waiting one")
        ]})
        await session.commit()
    live, waiting = (await client.get("/programs/t1/activities")).json()
    await client.patch(f"/programs/t1/activities/{live['id']}", json={"utm": "he_mark/x"})
    await client.post(f"/programs/t1/activities/{live['id']}/approve")
    await client.post(f"/programs/t1/activities/{live['id']}/go-live", json={})
    await client.delete(f"/programs/t1/activities/{live['id']}/approve")  # now a control breach
    await client.patch(f"/programs/t1/activities/{waiting['id']}", json={"status": "wip"})  # marketing is waiting for approval

    template = next(t for t in (await client.get("/checklist-templates", params={"kind": "request"})).json())
    await client.post("/programs/t1/requests", json={"template_id": template["id"], "title": "Overdue banner", "due_at": (NOW - timedelta(hours=1)).isoformat()})
    await client.post("/programs/t1/rounds", json={"name": "Ended round", "starts_on": days(-5), "ends_on": days(-1)})
    await client.post("/programs/t1/rounds", json={"name": "Starting round", "starts_on": days(1), "ends_on": days(3)})
    await client.post("/programs/t1/dependencies", json={"title": "Badly late", "due_on": days(-5), "client_owner": "Meera"})
    await client.post("/programs/t1/dependencies", json={"title": "A bit late", "due_on": days(-2)})
    await client.post("/programs/t1/communications", json={"kind": "reminder", "audience": "Candidates", "planned_for": (NOW - timedelta(hours=3)).isoformat()})
    rounds = (await client.get("/programs/t1/rounds")).json()
    await client.post("/programs/t1/timeline-changes", json={"subject_type": "round", "subject_id": str(rounds[1]["id"]), "field": "starts_on", "revised": days(2), "reason": "Client delay"})


async def test_the_queue_collects_every_kind_of_work_and_orders_it_by_urgency(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    client, _ = await csm(client_for, make_user)
    await busy_program(client, db)
    body = (await client.get("/queues/csm", params={"scope": "all"})).json()
    assert {i["kind"] for i in body["items"]} == {k.value for k in CsmKind}
    assert body["counts"]["dependency_overdue"] == 2 and body["counts"]["control_breach"] == 1
    severities = [i["severity"] for i in body["items"]]
    assert severities == sorted(severities, key={"critical": 0, "amber": 1, "info": 2}.get)
    critical = {i["kind"] for i in body["items"] if i["severity"] == "critical"}
    assert critical == {"control_breach", "request_due", "dependency_overdue"}


async def test_dependency_severity_depends_on_how_late_it_is(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    client, _ = await csm(client_for, make_user)
    await busy_program(client, db)
    items = (await client.get("/queues/csm", params={"scope": "all", "kind": "dependency_overdue"})).json()["items"]
    assert {i["title"]: i["severity"] for i in items} == {"Badly late": "critical", "A bit late": "amber"}
    assert "owed by Meera" in next(i for i in items if i["title"] == "Badly late")["detail"]


async def test_an_item_names_its_program_and_what_to_open(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    client, _ = await csm(client_for, make_user)
    await busy_program(client, db)
    breach = next(i for i in (await client.get("/queues/csm", params={"scope": "all"})).json()["items"] if i["kind"] == "control_breach")
    assert breach["ticket_id"] == "t1" and breach["ref_type"] == "activity" and breach["ref_id"] and "Live one" in breach["title"]


async def test_mine_shows_only_programs_assigned_to_me_as_csm(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    await make_program("t2")
    client, user = await csm(client_for, make_user)
    await busy_program(client, db)
    assert (await client.get("/queues/csm")).json()["items"] == []  # default scope is mine, and nothing is assigned
    await client.put("/programs/t1/assignments", json=[{"user_id": user.id, "role": "csm"}])
    mine = (await client.get("/queues/csm")).json()["items"]
    assert mine and {i["ticket_id"] for i in mine} == {"t1"}
    as_marketing = await client.put("/programs/t2/assignments", json=[{"user_id": user.id, "role": "marketing"}])
    assert as_marketing.status_code == 200
    assert {i["ticket_id"] for i in (await client.get("/queues/csm")).json()["items"]} == {"t1"}  # only CSM assignments count


async def test_a_closed_program_is_not_in_the_queue(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    client, _ = await csm(client_for, make_user)
    await busy_program(client, db)
    async with db() as session:
        await session.execute(text("UPDATE programs SET stage_label = 'Closed' WHERE ticket_id = 't1'"))
        await session.commit()
    assert (await client.get("/queues/csm", params={"scope": "all"})).json()["items"] == []


async def test_a_posted_update_clears_update_due_and_a_linked_channel_clears_slack_unlinked(client_for, make_user, make_program, db):
    await make_program("t1")
    client, _ = await csm(client_for, make_user)
    before = {i["kind"] for i in (await client.get("/queues/csm", params={"scope": "all"})).json()["items"]}
    assert before == {"update_due", "slack_unlinked"}  # an active program with no update and no channel
    await client.post("/programs/t1/updates", json={"health": "good", "summary": "All well"})
    async with db() as session:
        await session.execute(text("INSERT INTO program_registration_settings (ticket_id, roles, fields, notify_slack, redash_auto, slack_channel_id) VALUES ('t1', '{}', '{}', true, false, 'C123')"))
        await session.commit()
    assert (await client.get("/queues/csm", params={"scope": "all"})).json()["items"] == []


async def test_an_inactive_stage_is_not_nagged_for_updates(client_for, make_user, make_program, db):
    await make_program("t1")
    client, _ = await csm(client_for, make_user)
    async with db() as session:
        await session.execute(text("UPDATE programs SET stage_label = 'Pre Sales' WHERE ticket_id = 't1'"))
        await session.commit()
    assert (await client.get("/queues/csm", params={"scope": "all"})).json()["items"] == []


async def test_a_counts_entry_clears_counts_missing(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    client, _ = await csm(client_for, make_user)
    made = (await client.post("/programs/t1/rounds", json={"name": "R", "starts_on": days(-5), "ends_on": days(-1)})).json()
    body = (await client.get("/queues/csm", params={"scope": "all", "kind": "counts_missing"})).json()
    assert body["counts"]["counts_missing"] == 1
    await client.post(f"/programs/t1/rounds/{made['id']}/counts", json={"as_of": days(-1), "invited": 10})
    assert (await client.get("/queues/csm", params={"scope": "all", "kind": "counts_missing"})).json()["items"] == []


async def test_marketing_and_account_managers_can_open_the_queue_too(client_for, make_user, make_program):
    await make_program("t1")
    for role in (Role.MARKETING, Role.ACCOUNT_MANAGER):
        client = await client_for(await make_user(f"{role.value}@example.com", [role]))
        assert (await client.get("/queues/csm", params={"scope": "all"})).status_code == 200


async def test_an_untouched_plan_row_is_not_flagged_for_a_missing_utm(client_for, make_user, make_program, db):
    from core import activities

    await make_program("t1")
    async with db() as session:
        await activities.seed_from_poa(session, "t1", {"activities": [
            {"week": "Week 1", "channel": "Email", "activity": "Untouched", "date": None, "objective": "", "description": ""}
        ]})
        await session.commit()
    client = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await client.get("/queues/marketing")).json()["items"] == []
    aid = (await client.get("/programs/t1/activities")).json()[0]["id"]
    await client.patch(f"/programs/t1/activities/{aid}", json={"status": "wip"})
    kinds = {i["kind"] for i in (await client.get("/queues/marketing")).json()["items"]}
    assert "missing_utm_or_proof" in kinds


async def test_my_queue_follows_the_csm_named_on_the_hubspot_ticket_by_email(client_for, make_user, make_program, db):
    """A CSM who has just signed in sees their programs without anyone assigning them first."""
    await make_program("mine")
    await make_program("theirs")
    async with db() as session:
        await session.execute(text("UPDATE programs SET csm_email = 'Priya@Example.com', stage_label = 'Ongoing' WHERE ticket_id = 'mine'"))
        await session.execute(text("UPDATE programs SET csm_email = 'someone.else@example.com', stage_label = 'Ongoing' WHERE ticket_id = 'theirs'"))
        await session.commit()
    me = await client_for(await make_user("priya@example.com", [Role.CSM], name="Priya S."))
    mine = (await me.get("/queues/csm", params={"scope": "mine"})).json()["items"]
    everyone = (await me.get("/queues/csm", params={"scope": "all"})).json()["items"]
    assert {i["ticket_id"] for i in mine} == {"mine"}
    assert {i["ticket_id"] for i in everyone} == {"mine", "theirs"}
