"""The merged "needs you today" list: grouped, deduplicated by what an item is about, ordered by urgency, and
showing contradictions in the data. The directory's escalation count is the sum of these lists."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from core import activities
from core.orm import Program
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


async def test_plan_rows_waiting_for_approval_collapse_into_one_item(client_for, make_user, make_program, db):
    await make_program("t1")
    await plan(db, [("A", None), ("B", None), ("C", None)])
    found = await needs(await csm(client_for, make_user))
    item = found["approvals:activities"]
    assert item["title"] == "3 marketing activities waiting for approval"
    assert item["tab"] == "marketing" and item["severity"] == "warn"


async def test_two_rounds_with_the_same_name_are_two_items_keyed_by_round_id(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm(client_for, make_user)
    for _ in range(2):
        await client.post("/programs/t1/rounds", json={"name": "Screening", "starts_on": days(1), "ends_on": days(3)})
    found = await needs(client)
    readiness = [i for i in found if i.startswith("readiness:round:")]
    assert len(readiness) == 2 and len(set(readiness)) == 2  # not merged by name, not duplicated either
    assert all(found[i]["severity"] == "danger" for i in readiness)  # starts tomorrow


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


async def test_items_are_ordered_danger_then_warn_then_neutral(client_for, make_user, make_program, db, templates):
    await make_program("t1")
    client = await csm(client_for, make_user)
    await plan(db, [("A", None)])
    await client.post("/programs/t1/rounds", json={"name": "Soon", "starts_on": days(1)})
    order = [n["severity"] for n in (await client.get("/programs/t1/needs")).json()]
    assert order == sorted(order, key=["danger", "warn", "neutral"].index) and order[0] == "danger"


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


async def test_the_directory_escalation_count_is_the_sum_of_every_programs_needs(client_for, make_user, make_program, db):
    for tid in ("t1", "t2"):
        await make_program(tid)
    await plan(db, [("A", None)])
    client = await csm(client_for, make_user)
    portfolio = (await client.get("/portfolio")).json()
    per_program = {p["ticket_id"]: p["needs"] for p in portfolio["programs"]}
    assert portfolio["escalations"] == sum(per_program.values())
    assert per_program["t1"] == len((await client.get("/programs/t1/needs")).json())
    assert portfolio["programs_with_target"] == 0 and portfolio["programs_on_target"] == 0
