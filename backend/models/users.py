from datetime import datetime
from typing import Literal, Optional

from fastapi_users import schemas

# Captured once at first login (see api/auth_routes.py's /users/me/role) --
# Google OAuth carries no notion of role, so the frontend prompts for one
# before showing the rest of the app.
UserRole = Literal["account_manager", "csm", "manager", "other"]


class UserRead(schemas.BaseUser[str]):
    name: Optional[str] = None
    role: Optional[UserRole] = None
    created_at: datetime
    updated_at: datetime


class UserUpdate(schemas.BaseUserUpdate):
    name: Optional[str] = None
    role: Optional[UserRole] = None
