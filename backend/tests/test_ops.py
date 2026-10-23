"""Operations: client dependencies, participant communications, timeline changes, closure, assignments."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

from core import activities, dependencies
from core.dependencies import DependencyStatus
from core.orm import ClientDependency, Program, ProgramActivity, ProgramEvent
from core.permissions import Role

NOW = datetime.now(timezone.utc)
TODAY = NOW.date()


def days(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


def when(hours: int) -> str:
    return (NOW + timedelta(hours=hours)).isoformat()


async def csm_client(client_for, make_user, email="csm@example.com", name="Priya S."):
    user = await make_user(email, [Role.CSM], name=name)
    return await client_for(user), user


# ---- dependencies ----------------------------------------------------------------


def dep(status="open", due=None) -> ClientDependency:
    return ClientDependency(title="x", status=status, due_on=due)


def test_delay_counts_days_past_the_due_date_only_while_open():
    assert dependencies.delay_days(dep(due=TODAY - timedelta(days=5)), TODAY) == 5
    assert dependencies.delay_days(dep(due=TODAY), TODAY) == 0  # due today is not late yet
    assert dependencies.delay_days(dep(due=None), TODAY) == 0
    assert dependencies.delay_days(dep(status="received", due=TODAY - timedelta(days=5)), TODAY) == 0
    assert dependencies.delay_days(dep(status="waived", due=TODAY - timedelta(days=5)), TODAY) == 0


def test_the_projected_slip_is_the_worst_open_delay():
    deps = [dep(due=TODAY - timedelta(days=2)), dep(due=TODAY - timedelta(days=7)), dep(due=TODAY + timedelta(days=3)), dep("received", TODAY - timedelta(days=30))]
    result = dependencies.impact(deps, TODAY)
    assert (result.open, result.overdue, result.max_delay_days, result.projected_slip_days) == (3, 2, 7, 7)


async def test_a_dependency_records_who_owes_it_who_follows_up_and_what_it_blocks(client_for, make_user, make_program):
    await make_program("t1")
    client, user = await csm_client(client_for, make_user)
    response = await client.post("/programs/t1/dependencies", json={
        "title": "Brand guidelines", "kind": "asset", "client_owner": "Meera J. (client AM)", "owner_id": user.id,
        "due_on": days(-5), "blocks_round_id": None, "notes": "Needed for the email template",
    })
    body = response.json()
    assert response.status_code == 201
    assert (body["owner_name"], body["client_owner"]) == ("Priya S.", "Meera J. (client AM)")
    assert (body["overdue"], body["delay_days"], body["status"]) == (True, 5, "open")


async def test_the_dependency_list_shows_the_impact_on_the_timeline(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    await client.post("/programs/t1/dependencies", json={"title": "Late asset", "due_on": days(-5)})
    await client.post("/programs/t1/dependencies", json={"title": "Later decision", "due_on": days(4)})
    body = (await client.get("/programs/t1/dependencies")).json()
    assert [i["title"] for i in body["items"]] == ["Late asset", "Later decision"]  # open, soonest due first
    assert body["impact"] == {
        "open": 2, "overdue": 1, "max_delay_days": 5, "projected_slip_days": 5,
        "blocked_round_ids": [],
    }


async def test_receiving_a_dependency_clears_its_delay_and_stamps_the_time(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = (await client.post("/programs/t1/dependencies", json={"title": "Asset", "due_on": days(-3)})).json()
    received = (await client.patch(f"/programs/t1/dependencies/{made['id']}", json={"status": "received"})).json()
    assert (received["status"], received["overdue"], received["delay_days"]) == ("received", False, 0) and received["received_at"]
    reopened = (await client.patch(f"/programs/t1/dependencies/{made['id']}", json={"status": "open"})).json()
    assert reopened["received_at"] is None and reopened["delay_days"] == 3
    waived = (await client.patch(f"/programs/t1/dependencies/{made['id']}", json={"status": "waived"})).json()
    assert waived["overdue"] is False
    assert (await client.get("/programs/t1/dependencies")).json()["impact"]["open"] == 0


async def test_a_dependency_cannot_block_a_round_from_another_program(client_for, make_user, make_program):
    await make_program("t1")
    await make_program("t2")
    client, _ = await csm_client(client_for, make_user)
    other = (await client.post("/programs/t2/rounds", json={"name": "Elsewhere"})).json()
    response = await client.post("/programs/t1/dependencies", json={"title": "x", "blocks_round_id": other["id"]})
    assert (response.status_code, response.json()["code"]) == (422, "round_not_found")


async def test_marketing_can_read_dependencies_but_not_change_them(client_for, make_user, make_program):
    await make_program("t1")
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await marketing.get("/programs/t1/dependencies")).status_code == 200
    assert (await marketing.post("/programs/t1/dependencies", json={"title": "x"})).status_code == 403


async def test_dependency_changes_are_audited(client_for, make_user, make_program, db):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = (await client.post("/programs/t1/dependencies", json={"title": "Asset", "due_on": days(2)})).json()
    await client.patch(f"/programs/t1/dependencies/{made['id']}", json={"due_on": days(9)})
    async with db() as session:
        actions = [e.action for e in (await session.scalars(select(ProgramEvent).order_by(ProgramEvent.id))).all()]
    assert actions == ["dependency_added", "dependency_updated"]


# ---- participant communications -----------------------------------------------------


async def test_a_communication_is_planned_and_flagged_overdue_when_its_time_passes_unsent(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    future = (await client.post("/programs/t1/communications", json={"kind": "invitation", "audience": "Round 1 candidates", "planned_for": when(48), "recipients": 9800})).json()
    past = (await client.post("/programs/t1/communications", json={"kind": "reminder", "audience": "Not yet attempted", "planned_for": when(-3)})).json()
    assert (future["overdue"], future["status"], future["recipients"]) == (False, "planned", 9800)
    assert (past["overdue"], past["kind"]) == (True, "reminder")


async def test_marking_a_communication_sent_stamps_when_and_clears_the_flag(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = (await client.post("/programs/t1/communications", json={"kind": "shortlist", "audience": "Shortlisted", "planned_for": when(-3)})).json()
    sent = (await client.patch(f"/programs/t1/communications/{made['id']}", json={"status": "sent", "recipients": 400})).json()
    assert (sent["status"], sent["overdue"], sent["recipients"]) == ("sent", False, 400) and sent["sent_at"]


async def test_a_communication_planned_with_a_naive_datetime_is_read_as_utc(client_for, make_user, make_program):
    client, _ = await csm_client(client_for, make_user)
    await make_program("t1")
    naive = (NOW + timedelta(days=2)).replace(tzinfo=None).isoformat()  # what a datetime-local input sends
    made = await client.post("/programs/t1/communications", json={"kind": "reminder", "audience": "A", "planned_for": naive})
    assert made.status_code == 201 and made.json()["overdue"] is False


async def test_communications_can_be_filtered_by_round_and_status(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    round_one = (await client.post("/programs/t1/rounds", json={"name": "R1"})).json()
    await client.post("/programs/t1/communications", json={"kind": "invitation", "audience": "A", "planned_for": when(5), "round_id": round_one["id"]})
    other = (await client.post("/programs/t1/communications", json={"kind": "rsvp", "audience": "B", "planned_for": when(6)})).json()
    await client.patch(f"/programs/t1/communications/{other['id']}", json={"status": "skipped"})
    by_round = (await client.get("/programs/t1/communications", params={"round_id": round_one["id"]})).json()
    assert [c["audience"] for c in by_round] == ["A"]
    assert [c["audience"] for c in (await client.get("/programs/t1/communications", params={"status": "skipped"})).json()] == ["B"]


async def test_a_communication_cannot_target_a_round_from_another_program(client_for, make_user, make_program):
    await make_program("t1")
    await make_program("t2")
    client, _ = await csm_client(client_for, make_user)
    other = (await client.post("/programs/t2/rounds", json={"name": "Elsewhere"})).json()
    response = await client.post("/programs/t1/communications", json={"kind": "invitation", "audience": "A", "planned_for": when(5), "round_id": other["id"]})
    assert (response.status_code, response.json()["code"]) == (422, "round_not_found")


async def test_marketing_cannot_plan_communications(client_for, make_user, make_program):
    await make_program("t1")
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await marketing.post("/programs/t1/communications", json={"kind": "invitation", "audience": "A", "planned_for": when(5)})).status_code == 403


# ---- timeline changes ---------------------------------------------------------------


async def round_with_comms(client, templates_loaded=True):
    made = (await client.post("/programs/t1/rounds", json={"name": "Assessment", "starts_on": days(10), "ends_on": days(12)})).json()
    await client.post("/programs/t1/communications", json={"kind": "invitation", "audience": "All registrants", "planned_for": when(24 * 8), "round_id": made["id"]})
    return made


def propose_body(round_id, **extra):
    return {"subject_type": "round", "subject_id": str(round_id), "field": "starts_on", "revised": days(11),
            "reason": "Client content approval is late", **extra}


async def test_anyone_internal_proposes_a_change_and_it_records_the_original(client_for, make_user, make_program, templates):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = await round_with_comms(client)
    am = await client_for(await make_user("am@example.com", [Role.ACCOUNT_MANAGER], name="Meera J."))
    response = await am.post("/programs/t1/timeline-changes", json=propose_body(made["id"], tasks=["Update the landing page date"]))
    body = response.json()
    assert response.status_code == 201
    assert (body["status"], body["original"], body["revised"], body["label"], body["proposed_by_name"]) == (
        "proposed", days(10), days(11), "Assessment", "Meera J.",
    )
    assert [t["label"] for t in body["tasks"]] == ["Update the landing page date"]


async def test_only_a_csm_approves_and_approving_applies_the_date_and_opens_downstream_tasks(client_for, make_user, make_program, templates):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = await round_with_comms(client)
    am = await client_for(await make_user("am@example.com", [Role.ACCOUNT_MANAGER]))
    change = (await am.post("/programs/t1/timeline-changes", json=propose_body(made["id"], tasks=["Update the landing page date"]))).json()
    assert (await am.post(f"/programs/t1/timeline-changes/{change['id']}/approve")).status_code == 403
    approved = (await client.post(f"/programs/t1/timeline-changes/{change['id']}/approve")).json()
    assert (approved["status"], approved["decided_by_name"], approved["original"]) == ("approved", "Priya S.", days(10))  # the original stays
    assert sorted(t["label"] for t in approved["tasks"]) == [
        "Re-time the invitation for All registrants", "Update the landing page date",
    ]
    assert (await client.get("/programs/t1/rounds")).json()[0]["starts_on"] == days(11)


async def test_a_rejected_change_leaves_the_date_alone(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = await round_with_comms(client)
    change = (await client.post("/programs/t1/timeline-changes", json=propose_body(made["id"]))).json()
    rejected = (await client.post(f"/programs/t1/timeline-changes/{change['id']}/reject")).json()
    assert rejected["status"] == "rejected" and rejected["decided_by_name"] == "Priya S."
    assert (await client.get("/programs/t1/rounds")).json()[0]["starts_on"] == days(10)


async def test_a_change_can_only_be_decided_once(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = await round_with_comms(client)
    change = (await client.post("/programs/t1/timeline-changes", json=propose_body(made["id"]))).json()
    await client.post(f"/programs/t1/timeline-changes/{change['id']}/approve")
    for action in ("approve", "reject"):
        again = await client.post(f"/programs/t1/timeline-changes/{change['id']}/{action}")
        assert (again.status_code, again.json()["code"]) == (409, "change_decided")


async def test_bad_proposals_are_refused(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = await round_with_comms(client)
    same = await client.post("/programs/t1/timeline-changes", json=propose_body(made["id"], revised=days(10)))
    assert (same.status_code, same.json()["code"]) == (422, "change_is_noop")
    wrong_field = await client.post("/programs/t1/timeline-changes", json=propose_body(made["id"], field="due_on"))
    assert (wrong_field.status_code, wrong_field.json()["code"]) == (422, "field_not_changeable")
    missing = await client.post("/programs/t1/timeline-changes", json=propose_body(99999))
    assert (missing.status_code, missing.json()["code"]) == (404, "subject_not_found")
    no_reason = await client.post("/programs/t1/timeline-changes", json=propose_body(made["id"], reason=""))
    assert no_reason.status_code == 422


async def test_approving_a_change_that_would_end_a_round_before_it_starts_is_refused(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = await round_with_comms(client)
    change = (await client.post("/programs/t1/timeline-changes", json=propose_body(made["id"], field="ends_on", revised=days(2)))).json()
    response = await client.post(f"/programs/t1/timeline-changes/{change['id']}/approve")
    assert (response.status_code, response.json()["code"]) == (422, "round_dates_invalid")
    assert (await client.get(f"/programs/t1/timeline-changes")).json()[0]["status"] == "proposed"


async def test_an_activity_date_change_protects_the_row_from_a_poa_reread(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        await activities.seed_from_poa(session, "t1", {"activities": [{"week": "Week 1", "channel": "Email", "activity": "Launch", "date": days(3), "objective": "", "description": ""}]})
        await session.commit()
        activity = (await activities.list_for(session, "t1"))[0]
    client, _ = await csm_client(client_for, make_user)
    change = (await client.post("/programs/t1/timeline-changes", json={
        "subject_type": "activity", "subject_id": str(activity.id), "field": "planned_date", "revised": days(8), "reason": "Client delay",
    })).json()
    await client.post(f"/programs/t1/timeline-changes/{change['id']}/approve")
    async with db() as session:
        row = await session.get(ProgramActivity, activity.id)
        assert row.planned_date == date.fromisoformat(days(8)) and row.updated_by is not None
        result = await activities.seed_from_poa(session, "t1", {"activities": []})
        assert result.removed == 0  # edited rows survive a POA that no longer lists them


async def test_downstream_tasks_can_be_ticked_off_and_reopened(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = await round_with_comms(client)
    change = (await client.post("/programs/t1/timeline-changes", json=propose_body(made["id"], tasks=["Tell the client"]))).json()
    task = change["tasks"][0]
    done = (await client.patch(f"/programs/t1/timeline-changes/{change['id']}/tasks/{task['id']}", json={"done": True})).json()
    assert done["tasks"][0]["done"] is True and done["tasks"][0]["done_by_name"] == "Priya S."
    reopened = (await client.patch(f"/programs/t1/timeline-changes/{change['id']}/tasks/{task['id']}", json={"done": False})).json()
    assert reopened["tasks"][0]["done"] is False and reopened["tasks"][0]["done_by_name"] is None


async def test_the_change_history_is_audited(client_for, make_user, make_program, db):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    made = await round_with_comms(client)
    change = (await client.post("/programs/t1/timeline-changes", json=propose_body(made["id"]))).json()
    await client.post(f"/programs/t1/timeline-changes/{change['id']}/approve")
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).where(ProgramEvent.entity == "timeline_change").order_by(ProgramEvent.id))).all()
    assert [e.action for e in events] == ["change_proposed", "change_approved"]
    assert events[0].old == days(10) and events[0].new == days(11)


# ---- closure ------------------------------------------------------------------------


POST_CAMPAIGN = ["Winners Announced", "Rewards Distribution", "Report Shared", "Feedback & Retro"]


async def tick_post_campaign(db, items):
    async with db() as session:
        (await session.get(Program, "t1")).post_campaign_status = items
        await session.commit()


async def test_a_new_program_is_not_ready_to_close_and_lists_what_hubspot_still_needs(client_for, make_user, make_program):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    body = (await client.get("/programs/t1/closure")).json()
    assert body["ready_to_close"] is False and body["gate_ready"] is False
    assert [o["title"] for o in body["outstanding"]] == POST_CAMPAIGN


async def test_ticking_the_post_campaign_checklist_in_hubspot_makes_closure_ready(client_for, make_user, make_program, db):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    await tick_post_campaign(db, POST_CAMPAIGN[:3])
    assert [o["title"] for o in (await client.get("/programs/t1/closure")).json()["outstanding"]] == ["Feedback & Retro"]
    await tick_post_campaign(db, POST_CAMPAIGN)
    assert (await client.get("/programs/t1/closure")).json() == {"ready_to_close": True, "gate_ready": True, "outstanding": []}


async def test_an_open_request_or_client_dependency_blocks_closure(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    client, _ = await csm_client(client_for, make_user)
    await tick_post_campaign(db, POST_CAMPAIGN)
    template = next(t for t in (await client.get("/checklist-templates")).json() if t["key"] == "content_to_marketing")
    request = (await client.post("/programs/t1/requests", json={"template_id": template["id"], "title": "Prize banner"})).json()
    blocker = (await client.post("/programs/t1/dependencies", json={"title": "Winner list sign-off", "client_owner": "Meera"})).json()
    body = (await client.get("/programs/t1/closure")).json()
    assert body["ready_to_close"] is False and body["gate_ready"] is True
    assert {(o["kind"], o["title"]) for o in body["outstanding"]} == {("request", "Prize banner"), ("dependency", "Winner list sign-off")}
    await client.patch(f"/programs/t1/requests/{request['id']}", json={"status": "declined"})
    await client.patch(f"/programs/t1/dependencies/{blocker['id']}", json={"status": "received"})
    assert (await client.get("/programs/t1/closure")).json()["ready_to_close"] is True


# ---- assignments ---------------------------------------------------------------------


async def test_a_super_admin_assigns_people_and_the_list_replaces_the_old_one(client_for, make_user, make_program):
    await make_program("t1")
    _, csm = await csm_client(client_for, make_user)
    client = await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN]))
    marketer = await make_user("m@example.com", [Role.MARKETING], name="Neha K.")
    put = await client.put("/programs/t1/assignments", json=[{"user_id": csm.id, "role": "csm"}, {"user_id": marketer.id, "role": "marketing"}])
    assert [(a["name"], a["role"]) for a in put.json()] == [("Priya S.", "csm"), ("Neha K.", "marketing")]
    replaced = await client.put("/programs/t1/assignments", json=[{"user_id": csm.id, "role": "csm"}])
    assert [a["name"] for a in replaced.json()] == ["Priya S."]


async def test_assigning_an_unknown_user_is_refused_and_only_a_super_admin_can_assign(client_for, make_user, make_program):
    await make_program("t1")
    csm, _ = await csm_client(client_for, make_user)
    client = await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN]))
    unknown = await client.put("/programs/t1/assignments", json=[{"user_id": "nobody", "role": "csm"}])
    assert (unknown.status_code, unknown.json()["code"]) == (422, "user_not_found")
    assert (await csm.put("/programs/t1/assignments", json=[])).status_code == 403
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await marketing.put("/programs/t1/assignments", json=[])).status_code == 403
    assert (await marketing.get("/programs/t1/assignments")).status_code == 200
