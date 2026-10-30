"""The Slack client: the bot joins a public channel itself on its first post, and says clearly when it can't."""

from __future__ import annotations

from core import slack
from core.orm import ProgramRegistrationSettings
from core.permissions import Role


def stub_call(monkeypatch, responses: dict[str, list]):
    """Each Slack method answers from its list in turn; the calls made are recorded."""
    calls: list[str] = []

    async def call(method: str, payload: dict):
        calls.append(method)
        return responses[method].pop(0)

    monkeypatch.setattr(slack, "_call", call)
    return calls


async def test_the_bot_joins_a_public_channel_on_its_first_post_and_then_posts(monkeypatch):
    calls = stub_call(monkeypatch, {
        "chat.postMessage": [(False, slack._friendly("not_in_channel")), (True, {"ok": True})],
        "conversations.join": [(True, {"ok": True})],
    })
    assert await slack.post_message("C0123456789", "hello") == (True, "")
    assert calls == ["chat.postMessage", "conversations.join", "chat.postMessage"]


async def test_a_private_channel_is_explained_not_retried(monkeypatch):
    calls = stub_call(monkeypatch, {
        "chat.postMessage": [(False, slack._friendly("not_in_channel"))],
        "conversations.join": [(False, slack._friendly("method_not_supported_for_channel_type"))],
    })
    ok, message = await slack.post_message("G0123456789", "hello")
    assert not ok and "/invite" in message and "private channel" in message
    assert calls == ["chat.postMessage", "conversations.join"]


async def test_other_slack_errors_do_not_try_to_join(monkeypatch):
    calls = stub_call(monkeypatch, {"chat.postMessage": [(False, slack._friendly("is_archived"))]})
    assert await slack.post_message("C0123456789", "hello") == (False, "That channel is archived.")
    assert calls == ["chat.postMessage"]


async def test_the_channel_status_says_whether_the_bot_is_in_it(monkeypatch):
    stub_call(monkeypatch, {"conversations.info": [
        (True, {"channel": {"name": "hack-updates", "is_member": True, "is_private": False}}),
        (True, {"channel": {"name": "secret", "is_member": False, "is_private": True}}),
        (False, slack._friendly("channel_not_found")),
    ]})
    assert await slack.channel_status("C0123456789") == (True, {"name": "hack-updates", "is_member": True, "is_private": False})
    assert await slack.channel_status("G0123456789") == (True, {"name": "secret", "is_member": False, "is_private": True})
    ok, message = await slack.channel_status("C0999999999")
    assert not ok and "not found" in message
    assert (await slack.channel_status("general"))[0] is False  # not a channel id: no call made


async def test_adding_the_bot_to_the_programs_channel_needs_integrations_and_a_channel(client_for, make_user, make_program, db, monkeypatch):
    await make_program("t1")
    csm = await client_for(await make_user("csm@example.com", [Role.CSM]))
    am = await client_for(await make_user("am@example.com", [Role.ACCOUNT_MANAGER]))
    joined: list[str] = []

    async def join(channel_id: str):
        joined.append(channel_id)
        return True, ""

    monkeypatch.setattr(slack, "join_channel", join)
    assert (await csm.post("/programs/t1/slack/join")).status_code == 400  # no channel linked yet
    async with db() as session:
        session.add(ProgramRegistrationSettings(ticket_id="t1", roles=[], fields=[], slack_channel_id="C0123456789"))
        await session.commit()
    assert (await am.post("/programs/t1/slack/join")).status_code == 403
    assert (await csm.post("/programs/t1/slack/join")).json() == {"joined": True}
    assert joined == ["C0123456789"]
