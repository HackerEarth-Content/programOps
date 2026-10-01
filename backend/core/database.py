"""Database manager"""

from typing import AsyncIterator

import structlog
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from core.config import settings

logger = structlog.get_logger(__name__)


class DatabaseManager:
    """Manages database connections"""

    def __init__(self) -> None:
        self.engine: AsyncEngine | None = None
        self._database_url = settings.DATABASE_URL.replace(
            "postgresql://", "postgresql+psycopg://"
        )

    async def initialize(self) -> None:
        """Initialize database connection"""
        self.engine = create_async_engine(
            self._database_url,
            connect_args={"prepare_threshold": None},
            pool_pre_ping=True,
            pool_size=20,
            max_overflow=20,
        )

        logger.info("Database initialized")

    async def close(self) -> None:
        """Close database connection"""
        if self.engine:
            await self.engine.dispose()

        logger.info("Database connection closed")

    def get_engine(self) -> AsyncEngine:
        """Get the SQLAlchemy engine"""
        if not self.engine:
            raise RuntimeError("Database not initialized")
        return self.engine

    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        return async_sessionmaker(self.get_engine(), expire_on_commit=False)


# Global database manager instance
db_manager = DatabaseManager()


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: yields a request-scoped AsyncSession."""
    async with db_manager.session_factory()() as session:
        yield session
