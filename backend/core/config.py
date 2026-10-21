"""Settings for the Program Ops HubSpot extraction pipeline."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # HubSpot private-app token
    HUBSPOT_SERVICE_KEY: str

    DATABASE_URL: str

    PROGRAM_PIPELINE_ID: str

    OPENAI_API_KEY: str
    OPENAI_MODEL : str

    # Slack bot token (scopes: channels:read, groups:read, chat:write). Empty = Slack off.
    SLACK_BOT_TOKEN: str = ""

    # Redash (VPN-only). Empty key = auto registrations unavailable (manual still works).
    REDASH_API_KEY: str = ""
    REDASH_BASE_URL: str = "https://he-metrics.hackerearth.com"
    # Saved queries: per-event details incl. the daily registration split, and the active-events list.
    REDASH_REGISTRATIONS_QUERY_ID: str = "6123"  # per-event details + daily registrations (param `event_slug`)
    REDASH_EVENTS_QUERY_ID: str = "6142"  # active events, for the slug picker
    # Registrations by source / medium / campaign (param `Event - Title or Slug`; slow, so snapshotted).
    REDASH_CHANNELS_QUERY_ID: str = "6170"

    # Off until the HubSpot token has the ticket-update scope: lets CSMs change stage and checklists from the portal.
    HUBSPOT_WRITEBACK_ENABLED: bool = False

    # HubSpot search API allows up to 200 results per page
    PROGRAM_PAGE_SIZE: int = 200

    FRONTEND_URL: str
    API_BASE_URL: str
    ENVIRONMENT: str

    # Auth (Google OAuth). Sign-in is invite-only (core/invites.py); these emails are created as
    # super admins on start so the very first login works without an invite. Comma-separated.
    SUPER_ADMIN_EMAILS: str = ""
    USER_SECRET: str
    GOOGLE_CLIENT_ID: str
    GOOGLE_CLIENT_SECRET: str

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="allow"
    )


settings = Settings()
