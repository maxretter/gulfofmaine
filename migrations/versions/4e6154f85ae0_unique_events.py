"""unique events

A heatwave is addressed by its series and first day, so no two events in a
series may start on the same day. Two syncs storing at once could have
stored the same events twice; events are recomputed by every sync, so the
duplicates are dropped rather than failing the upgrade.

Revision ID: 4e6154f85ae0
Revises: 2db8a6d20b71
Create Date: 2026-09-30 16:36:20.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4e6154f85ae0"
down_revision: str | Sequence[str] | None = "2db8a6d20b71"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema, keeping the last stored of any events with the same series and first day."""
    op.execute("DELETE FROM event WHERE id NOT IN (SELECT max(id) FROM event GROUP BY series_id, start_date)")

    # Named as Postgres names an unnamed one, as models.Event's is when the tables are created from it.
    with op.batch_alter_table("event") as batch_op:
        batch_op.create_unique_constraint("event_series_id_start_date_key", ["series_id", "start_date"])


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("event") as batch_op:
        batch_op.drop_constraint("event_series_id_start_date_key", type_="unique")
