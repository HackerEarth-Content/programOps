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

from core.config import settings
from core.database import get_session
from core.orm import User, OAuthAccount

SECRET = settings.USER_SECRET


class CustomGoogleOAuth2(GoogleOAuth2):
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
