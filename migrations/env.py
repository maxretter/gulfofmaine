import logging
from logging.config import fileConfig

from alembic import context

from heatwaves.db import engine
from heatwaves.models import Base

if context.config.config_file_name is not None:
    fileConfig(context.config.config_file_name)

log = logging.getLogger("alembic.env")

# Compose's migrate step runs alembic -x newer-database=leave upgrade head. On a database that newer
# code has migrated, at a revision none of these migrations is, alembic would stop with "Can't locate
# revision", and after a rollback the API and the sync job, which wait for migrate to succeed, would
# never start. With newer-database=leave, that is logged instead, and the database left as it is.
#
# That rests on older code running on a newer schema, which holds as long as each migration only adds
# what older code can ignore: tables, indexes, and columns that are nullable or have a default. One
# that removes or renames anything older code uses, or tightens a constraint so that its writes fail,
# ends that: rolling back past it needs the database restored too, and this would let the older code
# start on a schema it can't use. Not every migration before this check kept to it (0c0a55f91898
# renamed columns, 4e6154f85ae0 added a unique constraint), but code from before it has no such
# check, and stops at migrate.
leave_newer = context.get_x_argument(as_dictionary=True).get("newer-database") == "leave"


def newer_revisions() -> list[str]:
    """The revisions the database is at that none of these migrations is: newer code's."""
    known = {script.revision for script in context.script.walk_revisions()}
    return sorted(set(context.get_context().get_current_heads()) - known)


with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=True)
    if leave_newer and (newer := newer_revisions()):
        log.warning(
            "The database is at revision %s, which none of these migrations is: newer code migrated it. "
            "Leaving it as it is (newer-database=leave).",
            ", ".join(newer),
        )
    else:
        with context.begin_transaction():
            context.run_migrations()
