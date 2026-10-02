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


def test_a_route_has_its_parameters_by_where_they_go_and_a_query_with_a_default_is_optional():
    category = {"type": "integer", "default": 1}
    day = {"$ref": "#/components/schemas/Day"}
    operation = {
        "parameters": [
            {"name": "buoy_id", "in": "path", "required": True, "schema": {"type": "string"}},
            {"name": "start", "in": "query", "schema": {"anyOf": [{"type": "string"}, {"type": "null"}]}},
            {"name": "min_category", "in": "query", "required": False, "schema": category},
        ],
        "responses": {"200": {"content": {"application/json": {"schema": day}}}},
    }

    assert api_types.route("/api/days/{buoy_id}", operation).splitlines() == [
        '  "/api/days/{buoy_id}": {',
        "    parameters: {",
        "      path: {",
        "        buoy_id: string;",
        "      };",
        "      query?: {",
        "        start?: string | null;",
        "        min_category?: number;",
        "      };",
        "    };",
        "    response: Day;",
        "  };",
    ]


def test_paths_has_the_routes_that_send_json_but_not_the_downloads():
    routes = api_types.routes()

    assert "/api/annual" in routes
    assert "/api/events/{buoy_id}/{depth}/{start}" in routes
    assert not any(path.startswith("/api/data/") for path in routes)


def test_a_parameter_neither_in_the_path_nor_the_query_is_an_error():
    operation = {"parameters": [{"name": "key", "in": "header", "required": True, "schema": {}}]}

    with pytest.raises(ValueError, match=r"No TypeScript for parameters in \['header'\]"):
        api_types.route("/api/buoys", operation)
