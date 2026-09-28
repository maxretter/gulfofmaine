"""series by variable and source

A series becomes one variable at one depth on one buoy, from one source, so
several series can share a dataset. The temperature columns become values.

Revision ID: 0c0a55f91898
Revises: f3b4661263f3
Create Date: 2026-09-28 19:36:05.693154

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0c0a55f91898"
down_revision: str | Sequence[str] | None = "f3b4661263f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The initial schema left its unique constraints unnamed. Postgres named them
# <table>_<columns>_key; this gives SQLite's the same names, so batch mode can
# drop them on either database.
NAMING = {"uq": "%(table_name)s_%(column_0_N_name)s_key"}


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("daily_mean") as batch_op:
        batch_op.alter_column("temperature", new_column_name="value")

    with op.batch_alter_table("series", naming_convention=NAMING) as batch_op:
        # Every existing series is buoy temperature.
        batch_op.add_column(sa.Column("variable", sa.String(), nullable=False, server_default="temperature"))
        batch_op.add_column(sa.Column("source", sa.String(), nullable=False, server_default="buoy"))
        batch_op.alter_column("latest_temperature", new_column_name="latest_value")
        batch_op.drop_constraint("series_buoy_id_depth_key", type_="unique")
        batch_op.drop_constraint("series_dataset_id_key", type_="unique")
        batch_op.create_unique_constraint(
            "series_buoy_id_depth_variable_source_key", ["buoy_id", "depth", "variable", "source"]
        )

    with op.batch_alter_table("series") as batch_op:
        batch_op.alter_column("variable", server_default=None)
        batch_op.alter_column("source", server_default=None)


def downgrade() -> None:
    """Downgrade schema. Fails once a buoy and depth have more than one series."""
    with op.batch_alter_table("series", naming_convention=NAMING) as batch_op:
        batch_op.drop_constraint("series_buoy_id_depth_variable_source_key", type_="unique")
        batch_op.drop_column("source")
        batch_op.drop_column("variable")
        batch_op.alter_column("latest_value", new_column_name="latest_temperature")
        batch_op.create_unique_constraint("series_dataset_id_key", ["dataset_id"])
        batch_op.create_unique_constraint("series_buoy_id_depth_key", ["buoy_id", "depth"])

    with op.batch_alter_table("daily_mean") as batch_op:
        batch_op.alter_column("value", new_column_name="temperature")
