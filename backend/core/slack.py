"""Minimal Slack Web API client: resolve a channel id to its name, post a message.
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
    "missing_scope": "Slack token is missing a required scope (channels:read / groups:read / chat:write).",
    "is_archived": "That channel is archived.",
}


def _friendly(error: str) -> str:
    return _ERRORS.get(error, f"Slack error: {error}")


async def _call(method: str, payload: dict) -> tuple[bool, dict | str]:
    if not settings.SLACK_BOT_TOKEN:
        return False, "Slack isn't connected yet. Ask an admin to connect it."
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            for _ in range(2):  # one retry on rate limit
                r = await client.post(
                    f"https://slack.com/api/{method}",
                    data=payload,  # form-encoded: conversations.info doesn't accept JSON
                    headers={"Authorization": f"Bearer {settings.SLACK_BOT_TOKEN}"},
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


def escape(text: str) -> str:
    """Slack's required escaping, so a program name, note or title can't ping @channel or build a link."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def post_message(channel_id: str, text: str) -> tuple[bool, str]:
    # Every message we write uses only *bold*, :emoji: and plain text, so escaping the whole body is safe and covers
    # every caller (outbox, summaries, tests) at the one place messages leave.
    ok, data = await _call("chat.postMessage", {"channel": channel_id, "text": escape(text)})
    return (True, "") if ok else (False, str(data))


if __name__ == "__main__":
    assert CHANNEL_ID.match("C0123456789") and CHANNEL_ID.match("G0123456789")
    assert not CHANNEL_ID.match("general") and not CHANNEL_ID.match("c0123456789")
    assert escape("<!channel> a&b <https://x|y>") == "&lt;!channel&gt; a&amp;b &lt;https://x|y&gt;"
    print("ok")
