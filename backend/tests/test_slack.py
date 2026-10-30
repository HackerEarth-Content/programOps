"""The Slack client: the bot joins a public channel itself on its first post, and says clearly when it can't."""

from __future__ import annotations

from core import slack
from core.orm import ProgramRegistrationSettings
from core.permissions import Role


def stub_call(monkeypatch, responses: dict[str, list]):
    """Each Slack method answers from its list in turn; the calls made are recorded."""
    calls: list[str] = []

    async def call(method: str, payload: dict, token: str | None = None):
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


# --- inviting the bot to a private channel as the signed-in person ---------------------------------------------

async def _invite(monkeypatch, invite_result):
    async def token(code, redirect_uri):
        return True, "xoxp-one-off"

    monkeypatch.setattr(slack, "_user_token", token)
    calls = stub_call(monkeypatch, {"auth.test": [(True, {"user_id": "UBOT"})], "conversations.invite": [invite_result]})
    return calls, await slack.invite_bot_with_code("code", "https://api/cb", "G0123456789")


async def test_the_bot_is_invited_as_the_person(monkeypatch):
    calls, result = await _invite(monkeypatch, (True, {"ok": True}))
    assert result[0] and calls == ["auth.test", "conversations.invite"]


async def test_a_bot_already_in_the_channel_counts_as_added(monkeypatch):
    assert (await _invite(monkeypatch, (False, slack._friendly("already_in_channel"))))[1][0]


async def test_someone_outside_the_channel_is_told_to_join_first(monkeypatch):
    ok, message = (await _invite(monkeypatch, (False, slack._friendly("channel_not_found"))))[1]
    assert not ok and "aren't a member" in message


async def test_the_invite_link_needs_the_integrations_permission_and_the_slack_app_settings(client_for, make_user, monkeypatch):
    from core.config import settings

    url = "/api/slack/invite/start?ticket_id=t1&channel_id=G0123456789"
    am = await client_for(await make_user("am@example.com", [Role.ACCOUNT_MANAGER]))
    assert (await am.get(url, follow_redirects=False)).status_code == 403

    csm = await client_for(await make_user("csm@example.com", [Role.CSM]))
    monkeypatch.setattr(settings, "SLACK_CLIENT_ID", "")
    r = await csm.get(url, follow_redirects=False)
    assert "slack_error" in r.headers["location"] and "/programs/t1" in r.headers["location"]

    monkeypatch.setattr(settings, "SLACK_CLIENT_ID", "123.456")
    monkeypatch.setattr(settings, "SLACK_CLIENT_SECRET", "secret")
    r = await csm.get(url, follow_redirects=False)
    assert r.headers["location"].startswith("https://slack.com/oauth/v2/authorize?") and "user_scope=groups%3Awrite" in r.headers["location"]


async def test_the_callback_adds_the_bot_once_for_the_same_person_and_records_it(client_for, make_user, make_program, db, monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from sqlalchemy import select

    from core.config import settings
    from core.orm import ProgramEvent

    monkeypatch.setattr(settings, "SLACK_CLIENT_ID", "123.456")
    monkeypatch.setattr(settings, "SLACK_CLIENT_SECRET", "secret")
    await make_program("t1")
    seen = []

    async def invite(code, redirect_uri, channel_id):
        seen.append(channel_id)
        return True, "ok"

    monkeypatch.setattr(slack, "invite_bot_with_code", invite)
    csm = await client_for(await make_user("csm@example.com", [Role.CSM]))
    other = await client_for(await make_user("other@example.com", [Role.CSM]))
    start = await csm.get("/api/slack/invite/start?ticket_id=t1&channel_id=G0123456789", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    stolen = await other.get(f"/api/slack/oauth/callback?code=c&state={state}", follow_redirects=False)
    assert "different%20person" in stolen.headers["location"] and seen == []

    done = await csm.get(f"/api/slack/oauth/callback?code=c&state={state}", follow_redirects=False)
    assert "slack=invited" in done.headers["location"] and seen == ["G0123456789"]
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).where(ProgramEvent.action == "bot_invited"))).all()
    assert len(events) == 1 and events[0].ticket_id == "t1"

    refused = await csm.get(f"/api/slack/oauth/callback?error=access_denied&state={state}", follow_redirects=False)
    assert "slack_error" in refused.headers["location"]
