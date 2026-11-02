"""Routed special requests (CSM to Marketing / Content) posted to the program's Slack channel, with a previewable message."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select

from core import request_messages as rm
from core.checklists import DEFAULT_TEMPLATES
from core.config import settings
from core.orm import Checklist, ProgramRegistrationSettings, SlackOutbox
from core.permissions import Role
from tests.test_checklists import new_request, template_id

MKT, CONTENT = "C0000000001", "C0000000002"
DUE = datetime(2026, 11, 4, 9, 0, tzinfo=timezone.utc)


async def setup(client_for, make_user, make_program, db, channel=None):
    await make_program("t1")
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN], name="Sai")
    if channel:
        async with db() as session:
            session.add(ProgramRegistrationSettings(ticket_id="t1", slack_channel_id=channel, slack_channel_name="hack-t1"))
            await session.commit()
    return await client_for(admin)


async def outbox(db) -> list[SlackOutbox]:
    async with db() as session:
        return list((await session.scalars(select(SlackOutbox).order_by(SlackOutbox.id))).all())


def test_defaults_and_routes():
    by_key = {t.key: t for t in DEFAULT_TEMPLATES}
    assert by_key["csm_to_marketing"].name == "CSM to Marketing" and len(by_key["csm_to_marketing"].items) == 5
    assert by_key["csm_to_content"].name == "CSM to Content" and len(by_key["csm_to_content"].items) == 5
    assert rm.route_for("csm_to_marketing") == rm.Route("CSM → Marketing", "marketing")
    assert rm.route_for("csm_to_content").team == "content"
    assert rm.route_for("content_to_marketing") is None


def test_message_text():
    text = rm.created_text("CSM → Marketing", "HackCellence", "Email Batch 2", DUE, "Sai", "Needs a reminder", 5, "http://x/p")
    assert text == (
        ":inbox_tray: *New request: CSM → Marketing*\n*Program:* HackCellence\n*Request:* Email Batch 2\n"
        "*Due:* Wed, 4 Nov 2026\n*Raised by:* Sai\n*Detail:* Needs a reminder\n*Checklist:* 5 items to confirm\n"
        "Open in ProgramOps: http://x/p"
    )
    assert rm.created_text(None, "P", "T", None, "S", "", 0, "u") == (
        ":inbox_tray: *New request: Special request*\n*Program:* P\n*Request:* T\n*Raised by:* S\nOpen in ProgramOps: u"
    )
    assert rm.status_text("CSM → Marketing", "P", "T", "done", "Shipped") == (
        ":white_check_mark: *CSM → Marketing request is now done*\n*Request:* T\n*Program:* P\n*Resolution:* Shipped"
    )
    assert rm.status_text(None, "P", "T", "declined", None).startswith(":no_entry_sign: *Special request is now declined*")


async def test_the_programs_channel_gets_one_message_with_the_exact_text(client_for, make_user, make_program, db, templates):
    client = await setup(client_for, make_user, make_program, db, channel=MKT)
    out = await new_request(client, "csm_to_marketing", title="Email Batch 2", detail="Reminder variant", due_at=DUE.isoformat())
    assert out["route"] == "CSM → Marketing" and out["team"] == "marketing"
    (msg,) = await outbox(db)
    assert msg.channel_id == MKT
    assert msg.body == rm.created_text(
        "CSM → Marketing", "t1", "Email Batch 2", DUE, "Sai", "Reminder variant", 5, f"{settings.FRONTEND_URL}/programs/t1?tab=requests"
    )


async def test_a_program_with_no_channel_is_skipped_visibly(client_for, make_user, make_program, db, templates):
    client = await setup(client_for, make_user, make_program, db)
    await new_request(client, "csm_to_marketing")
    (msg,) = await outbox(db)
    assert msg.status == "skipped" and msg.channel_id is None
    body = {"template_id": await template_id(client, "csm_to_marketing"), "title": "Hi"}
    preview = (await client.post("/programs/t1/requests/preview", json=body)).json()
    assert preview["channel_id"] is None and preview["route"] == "CSM → Marketing"


async def test_preview_has_no_side_effects(client_for, make_user, make_program, db, templates):
    client = await setup(client_for, make_user, make_program, db, channel=MKT)
    body = {"template_id": await template_id(client, "csm_to_marketing"), "title": "Email Batch 2"}
    preview = (await client.post("/programs/t1/requests/preview", json=body)).json()
    assert (preview["channel_id"], preview["channel_name"]) == (MKT, "hack-t1")
    assert preview["text"].startswith(":inbox_tray: *New request: CSM → Marketing*")
    async with db() as session:
        assert await session.scalar(select(func.count()).select_from(Checklist)) == 0
    assert await outbox(db) == []
    await new_request(client, "csm_to_marketing", title="Email Batch 2")
    assert (await outbox(db))[0].body == preview["text"]


async def test_status_change_posts_the_status_text_to_the_programs_channel(client_for, make_user, make_program, db, templates):
    client = await setup(client_for, make_user, make_program, db, channel=CONTENT)
    out = await new_request(client, "csm_to_content", title="Blog post")
    r = await client.patch(f"/programs/t1/requests/{out['id']}", json={"status": "declined", "resolution": "Out of scope"})
    assert r.status_code == 200, r.text
    created, status = await outbox(db)
    assert status.channel_id == CONTENT
    assert status.body == rm.status_text("CSM → Content", "t1", "Blog post", "declined", "Out of scope")
