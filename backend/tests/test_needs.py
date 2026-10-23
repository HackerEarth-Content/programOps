"""The merged "needs you today" list: grouped, deduplicated by what an item is about, ordered by urgency, and
showing contradictions in the data as separate checks. The directory count is the CSM queue's count."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from core import activities
from core.orm import Program, ProgramActivity
from core.permissions import Role

TODAY = datetime.now(timezone.utc).date()


def days(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


async def csm(client_for, make_user):
    return await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))


async def plan(db, rows: list[tuple[str, str | None]]) -> None:
    async with db() as session:
        await activities.seed_from_poa(session, "t1", {"activities": [
            {"week": "Week 1", "channel": "Email", "activity": name, "date": date, "objective": "", "description": ""}
            for name, date in rows
        ]})
        await session.commit()


async def needs(client) -> dict[str, dict]:
    return {n["id"]: n for n in (await client.get("/programs/t1/needs")).json()}


async def mark_ready(db) -> None:
    """What marketing does when a plan row is ready for the CSM: set it to WIP."""
    async with db() as session:
        await session.execute(update(ProgramActivity).where(ProgramActivity.ticket_id == "t1").values(status="wip"))
        await session.commit()


async def test_plan_rows_waiting_for_approval_collapse_into_one_item(client_for, make_user, make_program, db):
    await make_program("t1")
    await plan(db, [("A", None), ("B", None), ("C", None)])
    await mark_ready(db)
    found = await needs(await csm(client_for, make_user))
    item = found["approvals:activities"]
    assert item["title"] == "3 marketing activities waiting for approval"
    assert item["tab"] == "marketing" and item["severity"] == "warn"


async def test_two_rounds_with_the_same_name_are_two_items_keyed_by_round_id(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm(client_for, make_user)
    for _ in range(2):
        await client.post("/programs/t1/rounds", json={"name": "Screening", "starts_on": days(-6), "ends_on": days(-3)})
    found = await needs(client)
    missing = [i for i in found if i.startswith("counts_missing:round:")]
    assert len(missing) == 2 and len(set(missing)) == 2  # not merged by name, not duplicated either


async def test_marketing_planned_after_registration_closes_is_called_out(client_for, make_user, make_program, db):
    await make_program("t1")
    client = await csm(client_for, make_user)
    await client.put("/programs/t1/registrations/targets", json={"campaign_start": days(-10), "campaign_end": days(-2)})
    await plan(db, [("Late push", days(5))])
    item = (await needs(client))["window:marketing_after_close"]
    assert "but marketing runs to" in item["title"] and item["action"] == "Fix dates"


async def test_a_round_marked_done_that_has_not_started_is_a_contradiction(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm(client_for, make_user)
    made = (await client.post("/programs/t1/rounds", json={"name": "Final", "starts_on": days(10)})).json()
    await client.patch(f"/programs/t1/rounds/{made['id']}", json={"status": "done"})
    item = (await needs(client))[f"round_conflict:round:{made['id']}"]
    assert "marked done but starts" in item["title"]


async def test_items_are_ordered_danger_then_warn_then_neutral(client_for, make_user, make_program, db):
    await make_program("t1")
    client = await csm(client_for, make_user)
    await plan(db, [("A", None)])
    await mark_ready(db)  # a warn: waiting for approval
    await client.post("/programs/t1/dependencies", json={"title": "Creatives", "due_on": days(-10)})  # a danger: badly overdue
    order = [n["severity"] for n in (await client.get("/programs/t1/needs")).json() if n["group"] == "action"]
    assert order == sorted(order, key=["danger", "warn", "neutral"].index)
    assert order[0] == "danger" and "warn" in order and order[-1] == "neutral"


async def test_health_that_disagrees_with_the_latest_update_is_flagged(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm(client_for, make_user)
    await client.post("/programs/t1/dependencies", json={"title": "Creatives", "due_on": days(-10)})  # critical: badly overdue
    await client.post("/programs/t1/updates", json={"health": "good", "summary": "All fine"})
    item = (await needs(client))["health:mismatch"]
    assert "latest update says Good" in item["title"]


async def test_an_untitled_program_is_named_clearly(client_for, make_user, db):
    async with db() as session:
        session.add(Program(
            ticket_id="t1", pipeline_id="p", pipeline_label="P", stage_id="s", stage_label="Onboarding",
            subject="New form submission – Acme", company_name="Acme",
        ))
        await session.commit()
    client = await csm(client_for, make_user)
    assert (await needs(client))["program:untitled"]["title"] == "This program has no name yet"
    async with db() as session:
        program = await session.get(Program, "t1")
        assert program.display_name == "Untitled program (Acme)"
        await session.execute(update(Program).where(Program.ticket_id == "t1").values(event_name="HackFest"))
        await session.commit()
        await session.refresh(program)
        assert program.display_name == "HackFest" and not program.is_untitled


async def test_activities_nobody_has_marked_ready_are_not_waiting_for_approval(client_for, make_user, make_program, db):
    await make_program("t1")
    await plan(db, [("A", None), ("B", None)])
    assert "approvals:activities" not in await needs(await csm(client_for, make_user))


async def test_data_contradictions_are_checks_listed_after_the_actions(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:  # an unnamed program is a data check, an overdue update is an action
        await session.execute(update(Program).where(Program.ticket_id == "t1").values(subject="New form submission 1"))
        await session.commit()
    items = (await (await csm(client_for, make_user)).get("/programs/t1/needs")).json()
    groups = [(i["id"], i["group"]) for i in items]
    assert ("program:untitled", "check") in groups
    assert all(g == "action" for _, g in groups[: groups.index(("program:untitled", "check"))])
    assert groups[-1][1] == "check"


async def test_the_directory_count_is_the_csm_queues_count(client_for, make_user, make_program, db):
    for tid in ("t1", "t2"):
        await make_program(tid)
    await plan(db, [("A", None)])
    await mark_ready(db)
    client = await csm(client_for, make_user)
    portfolio = (await client.get("/portfolio")).json()
    per_program = {p["ticket_id"]: p["open_items"] for p in portfolio["programs"]}
    queue = (await client.get("/queues/csm", params={"scope": "all"})).json()
    assert portfolio["open_items"] == sum(per_program.values()) == len(queue["items"])
    assert per_program["t1"] == sum(i["ticket_id"] == "t1" for i in queue["items"])
    assert portfolio["programs_with_target"] == 0 and portfolio["programs_on_target"] == 0
