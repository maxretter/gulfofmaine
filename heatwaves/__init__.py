"""Marine heatwaves below the surface of the Gulf of Maine, from NERACOOS buoy data."""

# The app's version, which the API (heatwaves.main) and the sync's User-Agent (heatwaves.config) send.
# It's kept here, not read with importlib.metadata, as the project isn't installed as a package: uv.lock
# has it as virtual, and the image is built without it. pyproject.toml and frontend/package.json state
# the same, which tests/test_version.py checks.
__version__ = "0.2.0"
