"""What the API does with what a client sends that a proxy passes on: the Host header."""

import pytest


@pytest.mark.parametrize("path", ["/api/buoys/", "/api/origin/rules/", "/healthz/"])
def test_a_trailing_slash_is_a_404_not_a_redirect_to_the_host_sent(client, path):
    response = client.get(path, headers={"Host": "evil.example"}, follow_redirects=False)

    assert response.status_code == 404
    assert "location" not in response.headers
