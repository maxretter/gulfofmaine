"""/docs: Swagger UI at one version, checked by its hashes, under a content security policy that allows
it and nothing else."""

import base64
import hashlib
import re

from heatwaves.main import SWAGGER_UI, SWAGGER_UI_INTEGRITY


def test_the_docs_load_one_version_of_swagger_ui_and_nothing_else_from_elsewhere(client):
    page = client.get("/docs").text

    assert re.fullmatch(r"https://cdn\.jsdelivr\.net/npm/swagger-ui-dist@\d+\.\d+\.\d+/", SWAGGER_UI)
    external = re.findall(r'(?:src|href)="(https?://[^"]+)"', page)
    assert sorted(external) == [f"{SWAGGER_UI}swagger-ui-bundle.js", f"{SWAGGER_UI}swagger-ui.css"]
    assert 'href="/favicon.svg"' in page


def test_the_browser_uses_each_file_only_if_it_has_its_pinned_hash(client):
    page = client.get("/docs").text

    tags = re.findall(r'<(?:script|link)\b[^>]*"https?://[^>]*>', page)
    assert len(tags) == len(SWAGGER_UI_INTEGRITY) == 2
    for tag in tags:
        [url] = re.findall(r'(?:src|href)="(https?://[^"]+)"', tag)
        integrity = SWAGGER_UI_INTEGRITY[url.removeprefix(SWAGGER_UI)]
        assert f'integrity="{integrity}"' in tag
        assert 'crossorigin="anonymous"' in tag  # or a cross-origin file can't be checked
        assert len(base64.b64decode(integrity.removeprefix("sha384-"), validate=True)) == 48


def test_the_docs_policy_allows_their_files_and_inline_script_alone(client):
    response = client.get("/docs")
    policy = dict(
        part.strip().split(" ", 1) for part in response.headers["content-security-policy"].split(";")
    )

    [inline] = re.findall(r"<script>(.*?)</script>", response.text, re.DOTALL)
    digest = base64.b64encode(hashlib.sha256(inline.encode()).digest()).decode()
    assert policy == {
        "default-src": "'self'",
        "script-src": f"{SWAGGER_UI} 'sha256-{digest}'",
        "style-src": SWAGGER_UI,
        "img-src": "'self' data:",
        "frame-ancestors": "'none'",
    }


def test_only_the_docs_set_their_own_policy(client):
    # Caddy gives the rest the app's.
    assert "content-security-policy" not in client.get("/openapi.json").headers
    assert "/docs" not in client.get("/openapi.json").json()["paths"]
