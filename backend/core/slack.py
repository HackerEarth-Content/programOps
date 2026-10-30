"""Minimal Slack Web API client: resolve a channel id to its name, join a public channel, post a message.
Never raises to callers -- returns (ok, value_or_error) so a Slack problem can't
break saving data."""

from __future__ import annotations

import asyncio
import re

import httpx

from core.config import settings

CHANNEL_ID = re.compile(r"^[CG][A-Z0-9]{8,}$")  # public (C) / private (G) channels
_ERRORS = {
    "channel_not_found": "Channel not found (or it's private and the bot isn't in it).",
    "not_in_channel": "The bot isn't in that channel -- invite it with /invite.",
    "invalid_auth": "Slack token is invalid.",
    "token_revoked": "Slack token was revoked.",
    "missing_scope": "Slack token is missing a required scope (channels:read / groups:read / chat:write / channels:join).",
    "is_archived": "That channel is archived.",
    "method_not_supported_for_channel_type": "That is a private channel: Slack doesn't let a bot join one. In the channel, type /invite and pick the bot.",
}


class _SlackError(str):
    """The friendly message, remembering Slack's own error code so callers can act on it."""

    code: str = ""


def _friendly(error: str) -> _SlackError:
    message = _SlackError(_ERRORS.get(error, f"Slack error: {error}"))
    message.code = error
    return message


async def _call(method: str, payload: dict, token: str | None = None) -> tuple[bool, dict | str]:
    """`token` defaults to the bot token; the invite flow passes the signed-in person's one-off user token."""
    token = token or settings.SLACK_BOT_TOKEN
    if not token:
        return False, "Slack isn't connected yet. Ask an admin to connect it."
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            for _ in range(2):  # one retry on rate limit
                r = await client.post(
                    f"https://slack.com/api/{method}",
                    data=payload,  # form-encoded: conversations.info doesn't accept JSON
                    headers={"Authorization": f"Bearer {token}"},
                )
                if r.status_code == 429:
                    await asyncio.sleep(min(int(r.headers.get("Retry-After", 1)), 5))
                    continue
                data = r.json()
                return (True, data) if data.get("ok") else (False, _friendly(data.get("error", "unknown")))
            return False, "Slack is rate-limiting requests; try again shortly."
    except (httpx.HTTPError, ValueError) as e:
        return False, f"Couldn't reach Slack: {e.__class__.__name__}"


async def channel_name(channel_id: str) -> tuple[bool, str]:
    if not CHANNEL_ID.match(channel_id):
        return False, "That doesn't look like a Slack channel ID (e.g. C0123456789)."
    ok, data = await _call("conversations.info", {"channel": channel_id})
    return (True, data["channel"]["name"]) if ok else (False, str(data))


async def channel_status(channel_id: str) -> tuple[bool, dict | str]:
    """The channel's name and whether the bot is already in it: {"name", "is_member", "is_private"}."""
    if not CHANNEL_ID.match(channel_id):
        return False, "That doesn't look like a Slack channel ID (e.g. C0123456789)."
    ok, data = await _call("conversations.info", {"channel": channel_id})
    if not ok:
        return False, str(data)
    channel = data["channel"]
    return True, {
        "name": channel["name"], "is_member": bool(channel.get("is_member")),
        "is_private": bool(channel.get("is_private")) or channel_id.startswith("G"),
    }


async def join_channel(channel_id: str) -> tuple[bool, str]:
    """Add the bot to a public channel (needs the channels:join scope). A private channel needs /invite instead."""
    if not CHANNEL_ID.match(channel_id):
        return False, "That doesn't look like a Slack channel ID (e.g. C0123456789)."
    ok, data = await _call("conversations.join", {"channel": channel_id})
    return (True, "") if ok else (False, str(data))


def oauth_configured() -> bool:
    return bool(settings.SLACK_CLIENT_ID and settings.SLACK_CLIENT_SECRET)


def authorize_url(redirect_uri: str, state: str) -> str:
    """Slack's consent page asking the person for the one permission that lets them add apps to a private channel."""
    from urllib.parse import urlencode

    query = urlencode({"client_id": settings.SLACK_CLIENT_ID, "user_scope": "groups:write", "redirect_uri": redirect_uri, "state": state})
    return f"https://slack.com/oauth/v2/authorize?{query}"


async def _user_token(code: str, redirect_uri: str) -> tuple[bool, str]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                "https://slack.com/api/oauth.v2.access",
                data={"client_id": settings.SLACK_CLIENT_ID, "client_secret": settings.SLACK_CLIENT_SECRET, "code": code, "redirect_uri": redirect_uri},
            )
        data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        return False, f"Couldn't reach Slack: {e.__class__.__name__}"
    token = (data.get("authed_user") or {}).get("access_token")
    if not data.get("ok") or not token:
        return False, f"Slack didn't approve the request: {data.get('error', 'no user token returned')}"
    return True, token


async def invite_bot_with_code(code: str, redirect_uri: str, channel_id: str) -> tuple[bool, str]:
    """Trade the one-time code for the person's token, invite the bot with it, and drop the token. Nothing is stored."""
    ok, token = await _user_token(code, redirect_uri)
    if not ok:
        return False, token
    ok, me = await _call("auth.test", {})  # the bot's own user id
    if not ok:
        return False, str(me)
    ok, value = await _call("conversations.invite", {"channel": channel_id, "users": me["user_id"]}, token=token)
    if ok or getattr(value, "code", "") == "already_in_channel":
        return True, "The bot is in the channel."
    if getattr(value, "code", "") in ("channel_not_found", "not_in_channel"):
        return False, "You aren't a member of that channel, so you can't add the bot. Join it in Slack first, then try again."
    return False, str(value)


def escape(text: str) -> str:
    """Slack's required escaping, so a program name, note or title can't ping @channel or build a link."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def post_message(channel_id: str, text: str) -> tuple[bool, str]:
    # Every message we write uses only *bold*, :emoji: and plain text, so escaping the whole body is safe and covers
    # every caller (outbox, summaries, tests) at the one place messages leave.
    payload = {"channel": channel_id, "text": escape(text)}
    ok, data = await _call("chat.postMessage", payload)
    if not ok and getattr(data, "code", "") == "not_in_channel":
        # The bot was never added: join it ourselves (public channels) and post again, instead of failing the message.
        joined, why = await join_channel(channel_id)
        if not joined:
            return False, why
        ok, data = await _call("chat.postMessage", payload)
    return (True, "") if ok else (False, str(data))


if __name__ == "__main__":
    assert CHANNEL_ID.match("C0123456789") and CHANNEL_ID.match("G0123456789")
    assert not CHANNEL_ID.match("general") and not CHANNEL_ID.match("c0123456789")
    assert escape("<!channel> a&b <https://x|y>") == "&lt;!channel&gt; a&amp;b &lt;https://x|y&gt;"
    print("ok")
