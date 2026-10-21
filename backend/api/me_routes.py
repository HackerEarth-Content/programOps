from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.access import Access, current_access
from core.permissions import Permission, Role

router = APIRouter(tags=["me"])


class MeOut(BaseModel):
    id: str
    email: str
    name: str | None
    roles: list[Role]
    permissions: list[Permission]
    pending: bool  # signed in but no role yet: show "waiting for access"


@router.get("/me", response_model=MeOut)
async def me(access: Access = Depends(current_access)) -> MeOut:
    user = access.user
    return MeOut(
        id=user.id,
        email=user.email,
        name=user.name,
        roles=sorted(access.roles),
        permissions=sorted(access.permissions),
        pending=access.pending,
    )
