"""event origin

Heatwaves at 20 and 50 m get a label for where their heat likely came from,
and the evidence behind it. Both are recomputed with the events.

Revision ID: b0447420d174
Revises: 55b1d1ed7a69
Create Date: 2026-09-28 20:43:23.054335

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b0447420d174"
down_revision: str | Sequence[str] | None = "55b1d1ed7a69"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("event") as batch_op:
        batch_op.add_column(sa.Column("origin", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("evidence", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("event") as batch_op:
        batch_op.drop_column("evidence")
        batch_op.drop_column("origin")
