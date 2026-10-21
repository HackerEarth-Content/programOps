"""Write-back of stage and checklist changes to HubSpot: behind a flag, HubSpot wins on a conflict."""

from __future__ import annotations

import aiohttp
import pytest
from sqlalchemy import select

from core.config import settings
from core.orm import Program, ProgramEvent
from core.permissions import Role
from hubspot_client import writer
from hubspot_client.stage_checklist import PROGRAM_STAGES

ONBOARDING_STAGE = PROGRAM_STAGES["onboarding"]["stage_id"]


class FakeHubSpot:
    """Stands in for the HubSpot client: holds one ticket's properties and records what was written."""

    def __init__(self, props: dict[str, str | None]) -> None:
        self.props = dict(props)
        self.writes: list[dict[str, str]] = []
        self.read_error: Exception | None = None
        self.write_error: Exception | None = None

    async def read_ticket_properties(self, ticket_id: str, names: list[str]) -> dict[str, str | None]:
        if self.read_error:
            raise self.read_error
        return {n: self.props.get(n) for n in names}

    async def update_ticket_properties(self, ticket_id: str, properties: dict[str, str]) -> None:
        if self.write_error:
            raise self.write_error
        self.writes.append(properties)
        self.props.update(properties)


@pytest.fixture
def hubspot(monkeypatch) -> FakeHubSpot:
    fake = FakeHubSpot({"onboarding_status": "Kickoff Done;Page Build", "hs_pipeline_stage": ONBOARDING_STAGE})
    monkeypatch.setattr(settings, "HUBSPOT_WRITEBACK_ENABLED", True)
    monkeypatch.setattr(writer, "HubSpotClient", lambda: fake)
    return fake


async def csm_client(client_for, make_user):
    return await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))


def tick(item="Pre-requisites Received", done=True, expected=("Kickoff Done", "Page Build"), stage="onboarding"):
    return {"stage_key": stage, "item": item, "done": done, "expected": list(expected)}


# ---- the flag and permissions ------------------------------------------------------


async def test_everything_is_refused_while_the_flag_is_off(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    for path, body in (("checklist", tick()), ("stage", {"stage_key": "ongoing", "expected_stage_key": "onboarding"})):
        response = await client.post(f"/programs/t1/hubspot/{path}", json=body)
        assert (response.status_code, response.json()["code"]) == (503, "hubspot_writeback_disabled")


async def test_only_someone_with_hubspot_write_can_change_the_ticket(client_for, make_user, make_program, hubspot):
    await make_program("t1")
    for role in (Role.MARKETING, Role.ACCOUNT_MANAGER, Role.SUPER_ADMIN):
        client = await client_for(await make_user(f"{role.value}@example.com", [role]))
        assert (await client.post("/programs/t1/hubspot/checklist", json=tick())).status_code == 403
        assert (await client.post("/programs/t1/hubspot/stage", json={"stage_key": "ongoing", "expected_stage_key": "onboarding"})).status_code == 403
    assert hubspot.writes == []


# ---- checklist ----------------------------------------------------------------------


async def test_ticking_an_item_writes_the_ticket_in_canonical_order_and_updates_the_portal(client_for, make_user, make_program, hubspot, db):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    response = await client.post("/programs/t1/hubspot/checklist", json=tick())
    assert response.status_code == 200 and response.json()["selected"] == ["Kickoff Done", "Pre-requisites Received", "Page Build"]
    assert hubspot.writes == [{"onboarding_status": "Kickoff Done;Pre-requisites Received;Page Build"}]
    async with db() as session:
        assert (await session.get(Program, "t1")).onboarding_status == ["Kickoff Done", "Pre-requisites Received", "Page Build"]
        event = await session.scalar(select(ProgramEvent).where(ProgramEvent.action == "checklist_item_set"))
    assert (event.actor_name, event.field, event.old, event.new) == (
        "Priya S.", "Pre-requisites Received", ["Kickoff Done", "Page Build"], ["Kickoff Done", "Pre-requisites Received", "Page Build"],
    )


async def test_unticking_removes_the_item(client_for, make_user, make_program, hubspot):
    await make_program("t1")
    response = await (await csm_client(client_for, make_user)).post("/programs/t1/hubspot/checklist", json=tick("Page Build", done=False))
    assert response.json()["selected"] == ["Kickoff Done"] and hubspot.writes == [{"onboarding_status": "Kickoff Done"}]


async def test_an_item_already_in_the_wanted_state_writes_nothing(client_for, make_user, make_program, hubspot):
    await make_program("t1")
    response = await (await csm_client(client_for, make_user)).post("/programs/t1/hubspot/checklist", json=tick("Kickoff Done", done=True))
    assert response.status_code == 200 and hubspot.writes == []


async def test_hubspot_wins_when_the_checklist_changed_since_the_caller_looked(client_for, make_user, make_program, hubspot, db):
    await make_program("t1")
    hubspot.props["onboarding_status"] = "Kickoff Done;Page Build;Go-Live Approved "  # edited in HubSpot meanwhile
    response = await (await csm_client(client_for, make_user)).post("/programs/t1/hubspot/checklist", json=tick())
    assert response.status_code == 409
    assert response.json()["code"] == "hubspot_conflict" and response.json()["current"] == ["Kickoff Done", "Page Build", "Go-Live Approved "]
    assert hubspot.writes == []
    async with db() as session:
        assert (await session.get(Program, "t1")).onboarding_status == []  # the portal's copy wasn't touched


async def test_a_refused_change_is_kept_in_the_audit_trail(client_for, make_user, make_program, hubspot, db):
    await make_program("t1")
    hubspot.props["onboarding_status"] = "Kickoff Done;Page Build;Go-Live Approved "
    await (await csm_client(client_for, make_user)).post("/programs/t1/hubspot/checklist", json=tick())
    async with db() as session:
        event = (await session.scalars(select(ProgramEvent).where(ProgramEvent.action == "checklist_item_set_refused"))).one()
    assert event.ticket_id == "t1" and event.new["code"] == "hubspot_conflict"


async def test_a_conflict_is_judged_on_the_set_not_the_order(client_for, make_user, make_program, hubspot):
    await make_program("t1")
    response = await (await csm_client(client_for, make_user)).post("/programs/t1/hubspot/checklist", json=tick(expected=("Page Build", "Kickoff Done")))
    assert response.status_code == 200


async def test_unknown_items_and_stages_without_a_checklist_are_refused(client_for, make_user, make_program, hubspot):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    unknown = await client.post("/programs/t1/hubspot/checklist", json=tick("Not an item"))
    assert (unknown.status_code, unknown.json()["code"]) == (422, "unknown_checklist_item")
    for stage in ("new", "closed", "nope"):
        response = await client.post("/programs/t1/hubspot/checklist", json=tick(stage=stage))
        assert (response.status_code, response.json()["code"]) == (422, "stage_has_no_checklist")
    assert hubspot.writes == []


# ---- stage --------------------------------------------------------------------------


async def test_moving_the_stage_writes_the_ticket_and_updates_the_portal(client_for, make_user, make_program, hubspot, db):
    await make_program("t1")
    response = await (await csm_client(client_for, make_user)).post("/programs/t1/hubspot/stage", json={"stage_key": "ongoing", "expected_stage_key": "onboarding"})
    assert response.status_code == 200 and response.json() == {"stage_key": "ongoing", "stage_label": "Ongoing"}
    assert hubspot.writes == [{"hs_pipeline_stage": PROGRAM_STAGES["ongoing"]["stage_id"]}]
    async with db() as session:
        program = await session.get(Program, "t1")
        event = await session.scalar(select(ProgramEvent).where(ProgramEvent.action == "stage_moved"))
    assert (program.stage_label, program.stage_id) == ("Ongoing", PROGRAM_STAGES["ongoing"]["stage_id"])
    assert (event.old, event.new) == ("onboarding", "ongoing")


async def test_hubspot_wins_when_the_stage_moved_since_the_caller_looked(client_for, make_user, make_program, hubspot):
    await make_program("t1")
    hubspot.props["hs_pipeline_stage"] = PROGRAM_STAGES["post_campaign"]["stage_id"]
    response = await (await csm_client(client_for, make_user)).post("/programs/t1/hubspot/stage", json={"stage_key": "ongoing", "expected_stage_key": "onboarding"})
    assert response.status_code == 409
    assert (response.json()["code"], response.json()["current_stage"]) == ("hubspot_conflict", "post_campaign")
    assert hubspot.writes == []


async def test_moving_to_the_stage_it_is_already_in_writes_nothing_and_unknown_stages_are_refused(client_for, make_user, make_program, hubspot):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    same = await client.post("/programs/t1/hubspot/stage", json={"stage_key": "onboarding", "expected_stage_key": "onboarding"})
    assert same.status_code == 200 and hubspot.writes == []
    bad = await client.post("/programs/t1/hubspot/stage", json={"stage_key": "nope", "expected_stage_key": "onboarding"})
    assert (bad.status_code, bad.json()["code"]) == (422, "unknown_stage")


# ---- HubSpot failing ----------------------------------------------------------------------


async def test_a_token_without_the_update_scope_is_reported_clearly(client_for, make_user, make_program, hubspot, db):
    await make_program("t1")
    hubspot.write_error = aiohttp.ClientResponseError(None, (), status=403)  # type: ignore[arg-type]
    response = await (await csm_client(client_for, make_user)).post("/programs/t1/hubspot/checklist", json=tick())
    assert (response.status_code, response.json()["code"]) == (502, "hubspot_scope_missing")
    async with db() as session:
        assert (await session.get(Program, "t1")).onboarding_status == []  # nothing is shown that HubSpot didn't accept


async def test_hubspot_being_unreachable_is_a_502_not_a_crash(client_for, make_user, make_program, hubspot):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    hubspot.read_error = aiohttp.ClientConnectionError("down")
    response = await client.post("/programs/t1/hubspot/checklist", json=tick())
    assert (response.status_code, response.json()["code"]) == (502, "hubspot_unavailable")
    hubspot.read_error = None
    hubspot.write_error = aiohttp.ClientResponseError(None, (), status=500)  # type: ignore[arg-type]
    again = await client.post("/programs/t1/hubspot/checklist", json=tick())
    assert (again.status_code, again.json()["code"]) == (502, "hubspot_unavailable")
