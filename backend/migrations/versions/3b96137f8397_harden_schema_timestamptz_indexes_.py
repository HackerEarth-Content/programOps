"""harden schema: timestamptz, indexes, documents in db

Revision ID: 3b96137f8397
Revises: c898e9307afe
Create Date: 2026-09-30 11:37:13.213828

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3b96137f8397'
down_revision: Union[str, Sequence[str], None] = 'c898e9307afe'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NAIVE_TS = """
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = {type!r}
"""


def _convert_timestamps(from_type: str, to_type: str, zone_clause: str) -> None:
    """Existing values were written as UTC, so reinterpret them as UTC."""
    bind = op.get_bind()
    rows = bind.execute(sa.text(_NAIVE_TS.format(type=from_type))).fetchall()
    for table, column in rows:
        op.execute(
            f'ALTER TABLE "{table}" ALTER COLUMN "{column}" TYPE {to_type} '
            f'USING "{column}" {zone_clause}'
        )


def upgrade() -> None:
    _convert_timestamps("timestamp without time zone", "timestamptz", "AT TIME ZONE 'UTC'")

    op.create_index("ix_programs_stage_label", "programs", ["stage_label"])
    op.create_index("ix_programs_campaign_type", "programs", ["campaign_type"])
    op.create_index(
        "ix_program_stage_history_ticket_changed", "program_stage_history", ["ticket_id", "changed_at"]
    )
    op.create_index("ix_program_notes_ticket_created", "program_notes", ["ticket_id", "created_at"])

    # Documents move from local disk into the database.
    op.add_column("program_documents", sa.Column("content", sa.LargeBinary(), nullable=True))
    op.add_column(
        "program_documents",
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    bind = op.get_bind()
    for ticket_id, kind, path in bind.execute(
        sa.text("SELECT ticket_id, kind, storage_path FROM program_documents")
    ).fetchall():
        try:
            data = open(path, "rb").read()
        except OSError:
            continue  # file gone: the row is dropped below and re-fetched by the next sync
        bind.execute(
            sa.text("UPDATE program_documents SET content = :c WHERE ticket_id = :t AND kind = :k"),
            {"c": data, "t": ticket_id, "k": kind},
        )
    op.execute("DELETE FROM program_documents WHERE content IS NULL")
    op.alter_column("program_documents", "content", nullable=False)
    op.drop_column("program_documents", "storage_path")


def downgrade() -> None:
    op.add_column("program_documents", sa.Column("storage_path", sa.String(), nullable=True))
    op.execute("UPDATE program_documents SET storage_path = ''")  # files are not restored to disk
    op.alter_column("program_documents", "storage_path", nullable=False)
    op.drop_column("program_documents", "attempts")
    op.drop_column("program_documents", "content")

    op.drop_index("ix_program_notes_ticket_created", table_name="program_notes")
    op.drop_index("ix_program_stage_history_ticket_changed", table_name="program_stage_history")
    op.drop_index("ix_programs_campaign_type", table_name="programs")
    op.drop_index("ix_programs_stage_label", table_name="programs")

    _convert_timestamps("timestamp with time zone", "timestamp", "AT TIME ZONE 'UTC'")
