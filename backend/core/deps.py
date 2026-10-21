"""Small request dependencies shared by the route modules."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_session
from core.errors import DomainError
from core.orm import Program


async def program_or_404(ticket_id: str, session: AsyncSession = Depends(get_session)) -> Program:
    program = await session.get(Program, ticket_id)
    if program is None:
        raise DomainError("program_not_found", "Program not found.", 404)
    return program
