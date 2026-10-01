"""The frontend's copy of the API's types (scripts/api_types.py), which its type check holds types.ts to."""

import pytest

from scripts import api_types


def test_the_frontend_has_the_api_types_as_they_are():
    assert api_types.OUT.read_text() == api_types.source(), (
        "frontend/src/api/schema.ts is out of date: run `uv run python -m scripts.api_types`, "
        "then fix frontend/src/api/types.ts until `npx tsc -b` passes"
    )


@pytest.mark.parametrize(
    "schema",
    [
        {"oneOf": [{"type": "integer"}, {"type": "string"}]},
        {"type": "object", "properties": {"a": {"type": "integer"}}},  # only named, at the top
        {"$ref": "#/$defs/Day"},
        {"type": ["string", "null"]},
    ],
)
def test_a_schema_it_cant_translate_is_an_error_not_a_loose_type(schema):
    with pytest.raises(ValueError, match="No TypeScript"):
        api_types.typescript(schema)


def test_a_field_with_a_default_is_required_since_it_is_always_sent():
    schema = {
        "type": "object",
        "properties": {"type": {"const": "ping", "default": "ping"}, "note": {"type": "string"}},
        "required": [],
    }

    assert api_types.declaration("Ping", schema).splitlines() == [
        "export interface Ping {",
        '  type: "ping";',
        "  note?: string;",
        "}",
    ]
