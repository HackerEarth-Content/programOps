from core.config import settings
from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse
from core.users import (
    fastapi_users,
    auth_backend,
    oauth_auth_backend,
    google_oauth_client,
    SECRET,
)
from fastapi_users.router.oauth import (
    generate_state_token,
    generate_csrf_token,
    CSRF_TOKEN_KEY,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/logout", name="auth:logout")
async def logout(
    user_token=Depends(fastapi_users.authenticator.current_user_token(active=True)),
    strategy=Depends(auth_backend.get_strategy),
):
    user, token = user_token
    return await auth_backend.logout(strategy, user, token)


# Custom Google login endpoint -- frontend navigates here directly (not
# fetch) so the CSRF cookie is set as a first-party cookie.
@router.get("/google/login")
async def google_login():
    csrf_token = generate_csrf_token()
    state_data = {CSRF_TOKEN_KEY: csrf_token}
    state = generate_state_token(state_data, SECRET)

    callback_url = f"{settings.API_BASE_URL}/api/auth/google/callback"
    authorization_url = await google_oauth_client.get_authorization_url(callback_url, state)

    response = RedirectResponse(authorization_url)
    response.set_cookie(
        "fastapiusersoauthcsrf",
        csrf_token,
        max_age=3600,
        path="/",
        secure=settings.ENVIRONMENT == "production",
        httponly=True,
        samesite="lax",
    )
    return response


# Google OAuth router (callback handled by fastapi-users)
router.include_router(
    fastapi_users.get_oauth_router(
        google_oauth_client,
        oauth_auth_backend,
        SECRET,
        associate_by_email=True,
        is_verified_by_default=True,
        csrf_token_cookie_secure=settings.ENVIRONMENT == "production",
        csrf_token_cookie_samesite="lax",
        redirect_url=f"{settings.API_BASE_URL}/api/auth/google/callback",
    ),
    prefix="/google",
)
