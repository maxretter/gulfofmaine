"""preliminary from

Each satellite series keeps the first day it stored from the preliminary
product, so later syncs read again from there until the final product
replaces it, however far behind the final product falls.

Revision ID: 4126eff7d52e
Revises: 4e6154f85ae0
Create Date: 2026-09-30 22:24:03.051758

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4126eff7d52e"
down_revision: str | Sequence[str] | None = "4e6154f85ae0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("series") as batch_op:
        batch_op.add_column(sa.Column("preliminary_from", sa.Date(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("series") as batch_op:
        batch_op.drop_column("preliminary_from")
