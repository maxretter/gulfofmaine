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
# uvicorn takes forwarded headers only from FORWARDED_ALLOW_IPS: the private ranges Docker's networks
# use, since Caddy's address on Compose's network is whatever Docker gives it, and the client is the
# last address in X-Forwarded-For outside them, not the first, which a client can write itself. Only
# the stack's own containers reach the API, and Caddy replaces the headers of anyone it doesn't
# trust (TRUSTED_PROXIES in frontend/Caddyfile). Set it to change who uvicorn trusts.
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PRODUCTS_DIR=/data/products \
    FORWARDED_ALLOW_IPS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
USER app
EXPOSE 8000
# The live feed reads nothing from browsers, so a message from one may be 1 KiB, not uvicorn's 16 MiB.
CMD ["uvicorn", "heatwaves.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws-max-size", "1024", \
     "--proxy-headers"]
