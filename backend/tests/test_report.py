"""Program health (pure rules) and the one-view report."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from core import activities
from core.health import Health, HealthFacts, evaluate
from core.orm import ChannelSnapshot, ProgramRegistration
from core.permissions import Role

NOW = datetime.now(timezone.utc)
TODAY = NOW.date()


def days(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


# ---- health rules ----------------------------------------------------------------


def test_nothing_wrong_is_good():
    result = evaluate(HealthFacts())
    assert (result.health, result.reasons) == (Health.GOOD, ())


@pytest.mark.parametrize(
    "facts, code",
    [
        (HealthFacts(breaches=1), "control_breach"),
        (HealthFacts(latest_update_health="critical"), "update_critical"),
        (HealthFacts(overdue_dependencies=1, max_dependency_delay_days=4), "dependency_badly_overdue"),
    ],
)
def test_these_make_a_program_critical(facts, code):
    result = evaluate(facts)
    assert result.health == Health.CRITICAL and code in result.reasons


@pytest.mark.parametrize(
    "facts, code",
    [
        (HealthFacts(update_age_days=3), "update_stale"),
        (HealthFacts(latest_update_health="warning"), "update_warning"),
        (HealthFacts(overdue_requests=1), "request_overdue"),
        (HealthFacts(rounds_missing_counts=1), "round_counts_missing"),
        (HealthFacts(overdue_dependencies=1, max_dependency_delay_days=2), "dependency_overdue"),
        (HealthFacts(overdue_communications=1), "communication_overdue"),
        (HealthFacts(changes_awaiting=1), "change_awaiting_approval"),
    ],
)
def test_these_make_a_program_a_warning(facts, code):
    result = evaluate(facts)
    assert result.health == Health.WARNING and result.reasons == (code,)


def test_the_update_age_boundaries():
    assert evaluate(HealthFacts(update_age_days=2)).health == Health.GOOD  # two days is still fine
    assert evaluate(HealthFacts(update_age_days=None)).health == Health.GOOD  # never posted: not held against it


def test_a_badly_overdue_dependency_is_critical_not_also_a_warning():
    assert evaluate(HealthFacts(overdue_dependencies=1, max_dependency_delay_days=4)).reasons == ("dependency_badly_overdue",)


def test_critical_reasons_come_before_warnings():
    result = evaluate(HealthFacts(breaches=2, overdue_requests=1, changes_awaiting=1))
    assert result.health == Health.CRITICAL and result.reasons == ("control_breach", "request_overdue", "change_awaiting_approval")


# ---- the report ----------------------------------------------------------------------


async def csm_client(client_for, make_user):
    return await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))


async def test_an_empty_program_reports_zeros_and_unknowns(client_for, make_user, make_program):
    await make_program("t1")
    body = (await (await csm_client(client_for, make_user)).get("/programs/t1/report")).json()
    assert body["registrations"] == {"raw_total": 0, "relevant_total": 0, "relevant_pct": None, "target": None, "pct_of_target": None}
    assert body["funnel"] == [] and body["funnel_summary"] == {"participants": None, "final_shortlisted": None, "registered_to_shortlist_pct": None}
    assert body["sources"] == {"fetched_at": None, "organic_pct": None, "matched_users": None, "unmatched_users": None}
    assert body["marketing"]["total"] == 0 and body["operations"]["health"] == "good"


async def test_the_report_joins_registration_participation_marketing_and_operations(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    async with db() as session:
        session.add_all([
            ProgramRegistration(ticket_id="t1", date=TODAY - timedelta(days=2), role="", registrations=1000),
            ProgramRegistration(ticket_id="t1", date=TODAY - timedelta(days=1), role="", registrations=500),
        ])
        session.add(ChannelSnapshot(
            ticket_id="t1", status="ok", total=100,
            rows=[
                {"Source/Medium": "", "Campaign": "Organic", "NumUsers_with_source_as_Latest_visit_before_registration": 60},
                {"Source/Medium": "sp/", "Campaign": "", "NumUsers_with_source_as_Latest_visit_before_registration": 40},
                {"Source/Medium": "Total", "Campaign": "", "NumUsers_with_source_as_Latest_visit_before_registration": 100},
            ],
        ))
        await activities.seed_from_poa(session, "t1", {"activities": [
            {"week": "Week 1", "channel": "Email", "activity": a, "date": None, "objective": "", "description": ""} for a in ("A", "B", "C")
        ]})
        await session.commit()
    client = await csm_client(client_for, make_user)

    await client.put("/programs/t1/registrations/targets", json={"target": 3000})
    await client.post("/programs/t1/relevant-registrations", json={"date": days(-1), "count": 300})
    first = (await client.post("/programs/t1/rounds", json={"name": "Assessment"})).json()
    second = (await client.post("/programs/t1/rounds", json={"name": "Project"})).json()
    await client.post(f"/programs/t1/rounds/{first['id']}/counts", json={"as_of": days(0), "invited": 1000, "attempted": 800, "cleared": 200, "shortlisted": 100})
    await client.post(f"/programs/t1/rounds/{second['id']}/counts", json={"as_of": days(0), "invited": 100, "attempted": 90, "shortlisted": 20})
    plan = (await client.get("/programs/t1/activities")).json()
    await client.patch(f"/programs/t1/activities/{plan[0]['id']}", json={"utm": "he_mark/x"})
    await client.post(f"/programs/t1/activities/{plan[0]['id']}/approve")
    await client.post(f"/programs/t1/activities/{plan[0]['id']}/go-live", json={})
    template = next(t for t in (await client.get("/checklist-templates", params={"kind": "request"})).json())
    await client.post("/programs/t1/requests", json={"template_id": template["id"]})
    await client.post("/programs/t1/dependencies", json={"title": "Asset", "due_on": days(-5)})
    await client.post("/programs/t1/communications", json={"kind": "reminder", "audience": "A", "planned_for": (NOW - timedelta(hours=2)).isoformat()})
    await client.post("/programs/t1/timeline-changes", json={"subject_type": "round", "subject_id": str(first["id"]), "field": "starts_on", "revised": days(3), "reason": "Client delay"})

    body = (await client.get("/programs/t1/report")).json()
    assert body["registrations"] == {"raw_total": 1500, "relevant_total": 300, "relevant_pct": 20.0, "target": 3000, "pct_of_target": 50.0}
    assert [(s["name"], s["participation_pct"]) for s in body["funnel"]] == [("Assessment", 80.0), ("Project", 90.0)]
    assert body["funnel_summary"] == {"participants": 800, "final_shortlisted": 20, "registered_to_shortlist_pct": 1.3}
    assert body["sources"]["organic_pct"] == 60.0 and body["sources"]["unmatched_users"] == 40
    assert body["marketing"] == {"total": 3, "live": 1, "approved": 1, "awaiting_approval": 2, "breaches": 0}
    ops = body["operations"]
    assert (ops["open_requests"], ops["dependencies_open"], ops["dependencies_overdue"], ops["projected_slip_days"]) == (1, 1, 1, 5)
    assert (ops["communications_planned"], ops["communications_overdue"], ops["changes_proposed"]) == (1, 1, 1)
    assert ops["health"] == "critical" and "dependency_badly_overdue" in ops["reasons"]


async def test_the_health_endpoint_explains_itself(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    await client.post("/programs/t1/dependencies", json={"title": "Asset", "due_on": days(-2)})
    body = (await client.get("/programs/t1/health")).json()
    assert body["health"] == "warning" and body["reasons"] == ["dependency_overdue"]
    assert body["facts"]["overdue_dependencies"] == 1 and body["facts"]["max_dependency_delay_days"] == 2


async def test_everyone_internal_can_read_the_report(client_for, make_user, make_program):
    await make_program("t1")
    for role in (Role.MARKETING, Role.ACCOUNT_MANAGER):
        client = await client_for(await make_user(f"{role.value}@example.com", [role]))
        assert (await client.get("/programs/t1/report")).status_code == 200


# ---- portfolio and search ---------------------------------------------------------------


async def test_an_empty_portfolio_has_nothing_to_report(client_for, make_user):
    body = (await (await csm_client(client_for, make_user)).get("/portfolio")).json()
    assert body["active_programs"] == 0 and body["programs"] == [] and body["target_total"] is None
    assert body["health"] == {"good": 0, "warning": 0, "critical": 0}


async def test_the_portfolio_summarises_active_programs_and_skips_closed_ones(client_for, make_user, make_program, db):
    from sqlalchemy import text

    for ticket in ("t1", "t2", "t3"):
        await make_program(ticket)
    async with db() as session:
        await session.execute(text("UPDATE programs SET stage_label = 'Closed' WHERE ticket_id = 't2'"))
        session.add_all([
            ProgramRegistration(ticket_id="t1", date=TODAY, role="", registrations=500),
            ProgramRegistration(ticket_id="t2", date=TODAY, role="", registrations=9999),
            ProgramRegistration(ticket_id="t3", date=TODAY, role="", registrations=200),
        ])
        await activities.seed_from_poa(session, "t1", {"activities": [
            {"week": "Week 1", "channel": "Email", "activity": "Waiting", "date": None, "objective": "", "description": ""}
        ]})
        await session.commit()
    client = await csm_client(client_for, make_user)
    await client.put("/programs/t1/registrations/targets", json={"target": 1000})
    waiting = (await client.get("/programs/t1/activities")).json()[0]
    await client.patch(f"/programs/t1/activities/{waiting['id']}", json={"status": "wip"})
    await client.post("/programs/t3/dependencies", json={"title": "Asset", "due_on": days(-5)})

    body = (await client.get("/portfolio")).json()
    assert body["active_programs"] == 2 and body["registrations_total"] == 700 and body["target_total"] == 1000
    assert body["health"] == {"good": 1, "warning": 0, "critical": 1} and body["stage_distribution"] == {"Onboarding": 2}
    assert body["action_items"] == {"control_breaches": 0, "pending_approvals": 1, "missing_utm": 1}
    cards = {c["ticket_id"]: c for c in body["programs"]}
    assert set(cards) == {"t1", "t3"} and cards["t3"]["health"] == "critical" and cards["t1"]["target"] == 1000
    assert (cards["t1"]["marketing_total"], cards["t1"]["awaiting_approval"], cards["t1"]["registrations"]) == (1, 1, 500)


async def test_search_finds_programs_by_name_client_csm_or_ticket_id(client_for, make_user, db):
    from core.orm import Program

    async with db() as session:
        session.add_all([
            Program(ticket_id="1001", subject="x", event_name="HackCellence: The Embark Edition", company_name="Embark Technology", csm_name="Priya S.",
                    pipeline_id="p", pipeline_label="P", stage_id="s", stage_label="Ongoing"),
            Program(ticket_id="1002", subject="TalentHack", event_name=None, company_name="Booking Holdings", csm_name="Arjun M.",
                    pipeline_id="p", pipeline_label="P", stage_id="s", stage_label="Onboarding"),
        ])
        await session.commit()
    client = await csm_client(client_for, make_user)
    for query, expected in (("embark", ["HackCellence: The Embark Edition"]), ("booking", ["TalentHack"]),
                            ("arjun", ["TalentHack"]), ("1001", ["HackCellence: The Embark Edition"]), ("talent", ["TalentHack"])):
        hits = (await client.get("/search", params={"q": query})).json()
        assert [h["name"] for h in hits] == expected, query
    assert (await client.get("/search", params={"q": "zzzz"})).json() == []
    assert (await client.get("/search", params={"q": "a"})).status_code == 422  # too short to be useful
    hit = (await client.get("/search", params={"q": "embark"})).json()[0]
    assert hit == {"ticket_id": "1001", "name": "HackCellence: The Embark Edition", "client": "Embark Technology", "stage": "Ongoing", "csm": "Priya S."}
