"""Add the bot to a private channel. A bot can't join one itself, so the signed-in CSM approves once in Slack
and the bot is invited as them. Their token is used for that one call and never stored."""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from fastapi.responses import RedirectResponse
from fastapi_users.jwt import decode_jwt, generate_jwt

from core import audit, slack
from core.access import Access, require_permission
from core.config import settings
from core.database import get_session
from core.permissions import Permission
from core.users import SECRET
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/slack", tags=["slack"])
_AUDIENCE = "programops:slack-invite"
_LINK = Depends(require_permission(Permission.INTEGRATIONS_LINK))


def _callback_url() -> str:
    return f"{settings.API_BASE_URL}/api/slack/oauth/callback"


def _back(ticket_id: str, **params: str) -> RedirectResponse:
    query = "&".join(f"{k}={quote(v)}" for k, v in params.items())
    return RedirectResponse(f"{settings.FRONTEND_URL}/programs/{quote(ticket_id)}?tab=registrations&{query}", status_code=302)


@router.get("/invite/start")
async def start(ticket_id: str, channel_id: str = Query(pattern=slack.CHANNEL_ID.pattern), access: Access = _LINK):
    """The browser navigates here (not fetch) so the session cookie rides along, then on to Slack's consent page."""
    if not slack.oauth_configured():
        return _back(ticket_id, slack_error="Slack sign-in isn't set up yet. Ask an admin to add the Slack client id and secret.")
    state = generate_jwt(
        {"sub": str(access.user.id), "ticket_id": ticket_id, "channel_id": channel_id, "aud": _AUDIENCE}, SECRET, lifetime_seconds=600
    )
    return RedirectResponse(slack.authorize_url(_callback_url(), state), status_code=302)


@router.get("/oauth/callback")
async def callback(
    state: str, code: str | None = None, error: str | None = None,
    access: Access = _LINK, session: AsyncSession = Depends(get_session),
):
    try:
        claims = decode_jwt(state, SECRET, [_AUDIENCE])
    except Exception:  # expired or tampered
        return RedirectResponse(f"{settings.FRONTEND_URL}/?slack_error={quote('That Slack link expired. Start again.')}", status_code=302)
    ticket_id, channel_id = claims["ticket_id"], claims["channel_id"]
    if claims["sub"] != str(access.user.id):  # the link was started by someone else
        return _back(ticket_id, slack_error="That Slack link was started by a different person.")
    if error or not code:
        return _back(ticket_id, slack_error="Slack access wasn't approved, so the bot wasn't added.")
    ok, message = await slack.invite_bot_with_code(code, _callback_url(), channel_id)
    if not ok:
        return _back(ticket_id, slack_error=message)
    audit.record(
        session, access.user, entity="slack_channel", entity_id=channel_id, ticket_id=ticket_id,
        action="bot_invited", new={"channel_id": channel_id},
    )
    await session.commit()
    return _back(ticket_id, slack="invited")
