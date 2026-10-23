"""FastAPI entry point for the Program Ops API."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response

from core.access import bootstrap_super_admins
from core.checklists import ensure_default_templates
from core.config import settings
from core.database import db_manager
from core.errors import DomainError
from core.scheduler import start_scheduler

from api.activity_routes import router as activity_router
from api.admin_routes import audit_router
from api.admin_routes import router as admin_router
from api.auth_routes import router as auth_router
from api.checklist_routes import router as checklist_router
from api.checklist_routes import templates_router
from api.hubspot_write_routes import router as hubspot_write_router
from api.me_routes import router as me_router
from api.ops_routes import router as ops_router
from api.program_routes import router as program_router
from api.queue_routes import router as queue_router
from api.registration_extra_routes import router as registration_extra_router
from api.registration_routes import router as registration_router
from api.round_routes import router as round_router
from api.system_routes import router as system_router
from api.update_routes import router as update_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db_manager.initialize()
    async with db_manager.session_factory()() as session:
        await bootstrap_super_admins(session, settings.SUPER_ADMIN_EMAILS.split(","))
        await ensure_default_templates(session)  # starter checklists: the content request
        await session.commit()
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



@app.exception_handler(DomainError)
async def domain_error_handler(request: Request, exc: DomainError) -> Response:
    # A refused Google sign-in is a browser navigation: send the person back to the app with the reason.
    if request.url.path.endswith("/google/callback"):
        return RedirectResponse(f"{settings.FRONTEND_URL}/?auth_error={exc.code}", status_code=302)
    return JSONResponse({"detail": exc.detail, "code": exc.code, **exc.extra}, status_code=exc.status_code)


app.include_router(auth_router, prefix="/api")
app.include_router(me_router)
app.include_router(admin_router)
app.include_router(audit_router)
app.include_router(program_router)
app.include_router(registration_router)
app.include_router(registration_extra_router)
app.include_router(activity_router)
app.include_router(round_router)
app.include_router(templates_router)
app.include_router(checklist_router)
app.include_router(update_router)
app.include_router(ops_router)
app.include_router(queue_router)
app.include_router(system_router)
app.include_router(hubspot_write_router)
