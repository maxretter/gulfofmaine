# One image runs the web app, the sync job and migrations; Compose picks the command.
FROM python:3.14-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project

FROM python:3.14-slim
RUN useradd --system --uid 10001 --no-create-home app \
 && mkdir -p /data/products && chown app /data/products
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY alembic.ini ./
COPY migrations ./migrations
COPY heatwaves ./heatwaves
# Compose mounts the products volume here; an empty volume takes this directory's owner.
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PRODUCTS_DIR=/data/products
USER app
EXPOSE 8000
# The live feed reads nothing from browsers, so a message from one may be 1 KiB, not uvicorn's 16 MiB.
CMD ["uvicorn", "heatwaves.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws-max-size", "1024", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
