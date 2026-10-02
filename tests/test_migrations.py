"""Compose's migrate step: alembic upgrade head, except that with newer-database=leave a database newer
code migrated is left as it is (migrations/env.py)."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

ROOT = Path(__file__).resolve().parent.parent
MIGRATE = ["alembic", "-x", "newer-database=leave", "upgrade", "head"]  # compose.yaml's migrate command
NEWER = "fedcba987654"  # a revision none of the migrations is, as newer code's would be


@pytest.fixture
def engine(tmp_path):
    """An empty SQLite file."""
    engine = create_engine(f"sqlite:///{tmp_path / 'heatwaves.db'}")
    yield engine
    engine.dispose()


def alembic(engine, *args: str) -> subprocess.CompletedProcess[str]:
    """alembic run on `engine`'s database, as Compose runs it: a process of its own, from the repo's root."""
    return subprocess.run(
        [sys.executable, "-m", *args],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": engine.url.render_as_string()},
        capture_output=True,
        text=True,
        timeout=60,
    )


def revision(engine) -> str:
    with engine.connect() as connection:
        return connection.scalar(text("SELECT version_num FROM alembic_version"))


def stamp_newer(engine) -> None:
    """Mark the database as migrated by newer code, as alembic_version would be after its migrations."""
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)"))
        connection.execute(text("INSERT INTO alembic_version VALUES (:newer)"), {"newer": NEWER})


def test_compose_runs_the_migrate_step_tested_here():
    compose = yaml.safe_load((ROOT / "compose.yaml").read_text())

    assert compose["services"]["migrate"]["command"] == MIGRATE


def test_an_empty_database_is_migrated_to_the_newest_revision(engine):
    migrated = alembic(engine, *MIGRATE)

    assert migrated.returncode == 0, migrated.stderr
    assert revision(engine) == ScriptDirectory.from_config(Config(ROOT / "alembic.ini")).get_current_head()
    assert {"buoy", "series", "daily_mean", "event"} <= set(inspect(engine).get_table_names())


def test_a_database_newer_code_migrated_is_left_as_it_is(engine):
    stamp_newer(engine)

    migrated = alembic(engine, *MIGRATE)

    assert migrated.returncode == 0, migrated.stderr
    assert f"The database is at revision {NEWER}" in migrated.stderr
    assert "newer code migrated it" in migrated.stderr
    assert revision(engine) == NEWER
    assert inspect(engine).get_table_names() == ["alembic_version"]  # no migration ran


@pytest.mark.parametrize(
    "command",
    [["alembic", "upgrade", "head"], ["alembic", "check"]],
    ids=["upgrade without the option", "check"],
)
def test_without_the_option_alembic_still_stops_at_a_revision_it_doesnt_know(engine, command):
    stamp_newer(engine)

    refused = alembic(engine, *command)

    assert refused.returncode != 0
    assert f"Can't locate revision identified by '{NEWER}'" in refused.stderr


def test_any_other_failure_still_fails_the_step(engine):
    # No revision yet, but a table the first migration creates is already there.
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE buoy (id VARCHAR(8) PRIMARY KEY)"))

    broken = alembic(engine, *MIGRATE)

    assert broken.returncode != 0
    assert "table buoy already exists" in broken.stderr
