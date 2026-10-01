"""/api/method: the numbers the pages state the method with, from the modules that apply them."""

import re
from pathlib import Path

from heatwaves import hobday, qc, state, stations

COLORS = Path(__file__).resolve().parent.parent / "frontend" / "src" / "lib" / "colors.ts"


def test_method_is_the_module_constants(client):
    method = client.get("/api/method").json()

    assert (method["baseline_start"], method["baseline_end"]) == stations.BASELINE
    assert method["percentile"] == hobday.PERCENTILE * 100
    assert method["window_half_width"] == hobday.WINDOW_HALF_WIDTH
    assert method["smooth_width"] == hobday.SMOOTH_WIDTH
    assert method["min_duration"] == hobday.MIN_DURATION
    assert method["max_gap"] == hobday.MAX_GAP
    assert method["max_pad"] == hobday.MAX_PAD
    assert method["categories"] == ["Moderate", "Strong", "Severe", "Extreme"]
    assert method["min_hours"] == qc.MIN_HOURS
    assert method["offline_after"] == state.OFFLINE_AFTER.days


def test_the_map_shows_the_depths_every_buoy_has(client, monkeypatch):
    assert client.get("/api/method").json()["depths"] == [1, 20, 50]  # M01's 100-250 m are its own

    monkeypatch.setattr(stations, "DEPTHS", {"A01": (1, 20, 50), "M01": (1, 50, 100)})
    assert client.get("/api/method").json()["depths"] == [1, 50]


def test_the_frontends_category_names_are_the_methods():
    # The legends name the categories from the frontend's colors (lib/colors.ts) rather than wait for the API.
    [table] = re.findall(r"export const categories\b.*?\n\};", COLORS.read_text(), re.DOTALL)

    assert dict(re.findall(r'(\d+): \{ name: "(\w+)"', table)) == {
        str(category): name for category, name in hobday.CATEGORIES.items()
    }
