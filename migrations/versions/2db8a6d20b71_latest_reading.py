"""latest reading

Each series keeps its newest reading that passed quality control (a
buoy's raw reading, not an hourly mean), so the live feed and the API can
show more than the daily mean.

Revision ID: 2db8a6d20b71
Revises: b0447420d174
Create Date: 2026-09-28 21:55:22.675414

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2db8a6d20b71"
down_revision: str | Sequence[str] | None = "b0447420d174"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("series") as batch_op:
        batch_op.add_column(sa.Column("latest_reading_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("latest_reading", sa.Double(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("series") as batch_op:
        batch_op.drop_column("latest_reading")
        batch_op.drop_column("latest_reading_at")
