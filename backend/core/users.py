from typing import Any

from fastapi import Depends, Request
from fastapi_users import BaseUserManager, FastAPIUsers
from fastapi.responses import RedirectResponse
from fastapi_users.authentication import (
    AuthenticationBackend,
    CookieTransport,
    JWTStrategy,
)
from fastapi_users.db import SQLAlchemyUserDatabase
from httpx_oauth.clients.google import GoogleOAuth2
from sqlalchemy import func, select

from core import invites
from core.config import settings
from core.database import get_session
from core.errors import DomainError
from core.orm import User, OAuthAccount
from core.permissions import Role

SECRET = settings.USER_SECRET


USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo"


class CustomGoogleOAuth2(GoogleOAuth2):
    async def userinfo(self, token: str) -> dict[str, Any]:
        """Google's verified view of the signed-in account: `email`, `email_verified`, and `hd` (the Workspace
        domain, present only for accounts managed by one)."""
        async with self.get_httpx_client() as client:
            response = await client.get(USERINFO_ENDPOINT, headers={"Authorization": f"Bearer {token}"})
            response.raise_for_status()
            return response.json()

    async def get_id_email(self, token: str):
        try:
            return await super().get_id_email(token)
        except Exception as e:
            if hasattr(e, "response"):
                print(f"Google API Error Response: {e.response.text}")
            raise e


google_oauth_client = CustomGoogleOAuth2(
    settings.GOOGLE_CLIENT_ID,
    settings.GOOGLE_CLIENT_SECRET,
)


async def _require_company_account(access_token: str, email: str) -> None:
    """Refuse a first-time sign-in unless Google says the email is verified and belongs to the company domain."""
    refusal = DomainError(
        "outside_domain", f"Sign in with your @{settings.ALLOWED_EMAIL_DOMAIN} Google account.", 403
    )
    if not invites.in_allowed_domain(email):
        raise refusal
    try:
        info = await google_oauth_client.userinfo(access_token)
    except Exception as error:  # a failed check must not let anyone in
        raise refusal from error
    domain = settings.ALLOWED_EMAIL_DOMAIN.strip().lower()
    if (
        info.get("email_verified") is not True
        or str(info.get("email", "")).strip().lower() != email
        or str(info.get("hd", "")).strip().lower() != domain
    ):
        raise refusal


class UserManager(BaseUserManager[User, str]):
    reset_password_token_secret = SECRET
    verification_token_secret = SECRET

    def parse_id(self, value: Any) -> str:
        return str(value)

    async def oauth_callback(
        self,
        oauth_name: str,
        access_token: str,
        account_id: str,
        account_email: str,
        expires_at: int | None = None,
        refresh_token: str | None = None,
        request: Request | None = None,
        *,
        associate_by_email: bool = False,
        is_verified_by_default: bool = False,
    ):
        # Company accounts only. People who already have an account (matched by email, or by this Google
        # account, so a changed Google email doesn't make them "new") just sign in, e.g. the bootstrapped
        # super admin. A first-time sign-in must be a verified account managed by the company's Google
        # Workspace domain, and starts as a Viewer unless a super admin pre-granted roles for that email.
        session = self.user_db.session
        email = account_email.strip().lower()
        known = await session.scalar(select(User.id).where(func.lower(User.email) == email))
        known = known or await session.scalar(
            select(OAuthAccount.user_id).where(
                OAuthAccount.oauth_name == oauth_name, OAuthAccount.account_id == account_id
            )
        )
        is_new = known is None
        if is_new:
            await _require_company_account(access_token, email)

        result = await super().oauth_callback(
            oauth_name,
            access_token,
            account_id,
            account_email,
            expires_at,
            refresh_token,
            request,
            associate_by_email=associate_by_email,
            is_verified_by_default=is_verified_by_default,
        )

        # If the user doesn't have a name, extract it from the email.
        if not result.name and result.email:
            result = await self.user_db.update(result, {"name": result.email.split("@")[0]})

        if is_new:
            pre_granted = await invites.pending_for(session, email)
            if pre_granted is not None:
                await invites.accept(session, pre_granted, result)
            else:
                await invites.grant(session, [Role.VIEWER.value], result)
            await session.commit()
        return result


async def get_user_db(session=Depends(get_session)):
    yield SQLAlchemyUserDatabase(session, User, OAuthAccount)


async def get_user_manager(user_db: SQLAlchemyUserDatabase = Depends(get_user_db)):
    yield UserManager(user_db)


cookie_transport = CookieTransport(
    cookie_max_age=3600,
    cookie_name="programops_auth",
    cookie_secure=settings.ENVIRONMENT == "production",
    cookie_samesite="none" if settings.ENVIRONMENT == "production" else "lax",
)


class RedirectCookieTransport(CookieTransport):
    """CookieTransport that redirects to a URL after login (for OAuth flows)."""

    def __init__(self, redirect_url: str, **kwargs):
        super().__init__(**kwargs)
        self.redirect_url = redirect_url

    async def get_login_response(self, token: str) -> RedirectResponse:
        response = RedirectResponse(self.redirect_url, status_code=302)
        return self._set_login_cookie(response, token)


oauth_cookie_transport = RedirectCookieTransport(
    redirect_url=settings.FRONTEND_URL,
    cookie_max_age=3600,
    cookie_name="programops_auth",
    cookie_secure=settings.ENVIRONMENT == "production",
    cookie_samesite="none" if settings.ENVIRONMENT == "production" else "lax",
)


def get_jwt_strategy() -> JWTStrategy:
    return JWTStrategy(secret=SECRET, lifetime_seconds=3600)


auth_backend = AuthenticationBackend(
    name="cookie",
    transport=cookie_transport,
    get_strategy=get_jwt_strategy,
)

oauth_auth_backend = AuthenticationBackend(
    name="oauth-cookie",
    transport=oauth_cookie_transport,
    get_strategy=get_jwt_strategy,
)

fastapi_users = FastAPIUsers[User, str](get_user_manager, [auth_backend])

current_active_user = fastapi_users.current_user(active=True)
current_active_user_optional = fastapi_users.current_user(optional=True, active=True)
