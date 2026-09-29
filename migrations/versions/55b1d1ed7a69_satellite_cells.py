"""satellite cells

Satellite series record the grid cell they're read from and its distance
from the buoy; their days are a daily analysis, so they have no hour count.

Revision ID: 55b1d1ed7a69
Revises: 0c0a55f91898
Create Date: 2026-09-28 20:03:51.753765

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "55b1d1ed7a69"
down_revision: str | Sequence[str] | None = "0c0a55f91898"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("daily_mean") as batch_op:
        batch_op.alter_column("hours", existing_type=sa.Integer(), nullable=True)

    with op.batch_alter_table("series") as batch_op:
        batch_op.add_column(sa.Column("latitude", sa.Double(), nullable=True))
        batch_op.add_column(sa.Column("longitude", sa.Double(), nullable=True))
        batch_op.add_column(sa.Column("distance_km", sa.Double(), nullable=True))


def downgrade() -> None:
    """Downgrade schema, removing the satellite series: their days have no hour count."""
    satellite = "SELECT id FROM series WHERE source = 'satellite'"
    for table in ("daily_mean", "climatology_day", "event"):
        op.execute(f"DELETE FROM {table} WHERE series_id IN ({satellite})")
    op.execute("DELETE FROM series WHERE source = 'satellite'")

    with op.batch_alter_table("series") as batch_op:
        batch_op.drop_column("distance_km")
        batch_op.drop_column("longitude")
        batch_op.drop_column("latitude")

    with op.batch_alter_table("daily_mean") as batch_op:
        batch_op.alter_column("hours", existing_type=sa.Integer(), nullable=False)
