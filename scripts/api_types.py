"""The API's JSON as TypeScript, for the frontend's type check: frontend/src/api/schema.ts.

    uv run python -m scripts.api_types

Writes a type for every schema in the app's OpenAPI document, and for each
of the live feed's messages (heatwaves.live), which OpenAPI doesn't cover,
then Paths: each GET path that answers with JSON, the parameters its route
takes, in the path and the query, and the type of what it sends with a 200.
frontend/src/api/types.ts keeps the names and comments the app uses, and
frontend/src/api/contract.ts fails the type check unless they match these.
frontend/src/api/queries.ts fetches by Paths' keys, so the type check also
fails for a path, a parameter or a response the API renamed or dropped.
tests/test_api_types.py fails unless schema.ts is up to date, so after
changing a route or a response model, run this, then fix types.ts and
queries.ts until tsc passes.
"""

import json
from pathlib import Path
from typing import Any, get_args

from pydantic.json_schema import models_json_schema

from heatwaves import live
from heatwaves.main import app

OUT = Path(__file__).resolve().parent.parent / "frontend" / "src" / "api" / "schema.ts"
REF = "#/components/schemas/"

HEADER = """\
// The API's JSON and routes, generated from its OpenAPI schema and the live feed's messages by
// scripts/api_types.py: don't edit it, but run `uv run python -m scripts.api_types` after changing a route
// or a response model. The app uses the names in types.ts, which contract.ts checks against these, and
// fetches by Paths, in queries.ts.
"""

# Keywords that say nothing about a value's TypeScript type. Any other the
# translation doesn't handle is an error, rather than a type that's too loose.
IGNORED = {
    "title",
    "description",
    "default",
    "examples",
    "format",  # dates and times are strings
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
}
# The keywords the translation handles, outside an object's properties.
TRANSLATED = {"$ref", "anyOf", "const", "enum", "type", "items", "additionalProperties"}
# Where a GET's parameters go, as Paths keys them. Any other, a header or a cookie, is an error.
LOCATIONS = ("path", "query")

type Schema = dict[str, Any]


def schemas() -> dict[str, Schema]:
    """Every named schema of the API's responses and the live feed's messages, as sent."""
    found = dict(app.openapi()["components"]["schemas"])
    _, messages = models_json_schema(
        [(model, "serialization") for model in get_args(live.Message)], ref_template=REF + "{model}"
    )
    for name, schema in messages["$defs"].items():
        if found.setdefault(name, schema) != schema:
            raise ValueError(f"Two schemas named {name}")
    return dict(sorted(found.items()))


def typescript(schema: Schema) -> str:
    """The TypeScript type for a JSON schema of the kinds pydantic writes."""
    unknown = schema.keys() - IGNORED - TRANSLATED
    if unknown:
        raise ValueError(f"No TypeScript for {sorted(unknown)} in {schema}")
    if "$ref" in schema:
        name = schema["$ref"].removeprefix(REF)
        if name == schema["$ref"]:
            raise ValueError(f"No TypeScript for a reference outside the schemas: {schema}")
        return name
    if "anyOf" in schema:
        return " | ".join(typescript(each) for each in schema["anyOf"])
    if "const" in schema:
        return json.dumps(schema["const"])
    if "enum" in schema:
        return " | ".join(json.dumps(each) for each in schema["enum"])
    match schema.get("type"):
        case None:
            return "unknown"
        case "string":
            return "string"
        case "integer" | "number":
            return "number"
        case "boolean":
            return "boolean"
        case "null":
            return "null"
        case "array":
            item = typescript(schema["items"])
            return f"({item})[]" if " | " in item else f"{item}[]"
        case "object":
            return f"Record<string, {typescript(schema.get('additionalProperties', {}))}>"
    raise ValueError(f"No TypeScript for {schema}")


def declaration(name: str, schema: Schema) -> str:
    if "properties" not in schema:
        return f"export type {name} = {typescript(schema)};\n"
    unknown = schema.keys() - IGNORED - {"type", "properties", "required"}
    if unknown:
        raise ValueError(f"No TypeScript for {sorted(unknown)} in {name}")
    required = set(schema.get("required", ()))
    lines = [f"export interface {name} {{"]
    for field, each in schema["properties"].items():
        # A field with a default is always sent, though its schema doesn't list it as required.
        optional = "" if field in required or "default" in each else "?"
        key = field if field.isidentifier() else json.dumps(field)
        lines.append(f"  {key}{optional}: {typescript(each)};")
    return "\n".join([*lines, "}\n"])


def routes() -> dict[str, Schema]:
    """The OpenAPI operation of each GET path that answers with JSON, by path: not the file downloads."""
    found = {}
    for path, operations in app.openapi()["paths"].items():
        get = operations.get("get")
        if get and "application/json" in get["responses"]["200"].get("content", {}):
            found[path] = get
    return dict(sorted(found.items()))


def route(path: str, operation: Schema) -> str:
    """A GET path's entry in Paths: its parameters, by where they go, and what it sends with a 200."""
    parameters = operation.get("parameters", [])
    elsewhere = sorted({each["in"] for each in parameters} - set(LOCATIONS))
    if elsewhere:
        raise ValueError(f"No TypeScript for parameters in {elsewhere} of {path}")
    lines = [f"  {json.dumps(path)}: {{", "    parameters: {"]
    for location in LOCATIONS:
        here = [each for each in parameters if each["in"] == location]
        if not here:
            # Takes none: anything given there fails the type check.
            lines.append(f"      {location}?: never;")
            continue
        optional = "" if any(each.get("required") for each in here) else "?"
        lines.append(f"      {location}{optional}: {{")
        for each in here:
            key = each["name"] if each["name"].isidentifier() else json.dumps(each["name"])
            lines.append(f"        {key}{'' if each.get('required') else '?'}: {typescript(each['schema'])};")
        lines.append("      };")
    response = operation["responses"]["200"]["content"]["application/json"]["schema"]
    return "\n".join([*lines, "    };", f"    response: {typescript(response)};", "  };"])


def paths() -> str:
    lines = [
        "/** Each GET path that answers with JSON: its route's parameters, and what it sends with a 200. */",
        "export interface Paths {",
        *(route(path, operation) for path, operation in routes().items()),
    ]
    return "\n".join([*lines, "}\n"])


def source() -> str:
    return "\n".join([HEADER, *(declaration(name, schema) for name, schema in schemas().items()), paths()])


if __name__ == "__main__":
    OUT.write_text(source())
