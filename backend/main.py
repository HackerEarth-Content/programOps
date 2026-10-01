"""FastAPI entry point for the Program Ops API."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.config import settings
from core.database import db_manager
from core.scheduler import start_scheduler
from core.users import fastapi_users

from api.auth_routes import router as auth_router
from api.program_routes import router as program_router
from api.registration_routes import router as registration_router
from models.users import UserRead, UserUpdate


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db_manager.initialize()
    scheduler = start_scheduler()
    yield
    scheduler.shutdown(wait=False)
    await db_manager.close()


app = FastAPI(title="Program Ops API", lifespan=lifespan)

# Cookie auth needs credentialed CORS, which browsers only allow with an
# explicit origin -- "*" is rejected once allow_credentials=True.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api")
app.include_router(
    fastapi_users.get_users_router(UserRead, UserUpdate),
    prefix="/users",
    tags=["users"],
)
app.include_router(program_router)
app.include_router(registration_router)
