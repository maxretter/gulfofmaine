# Build the static app, then serve it with Caddy, which also forwards API requests.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2.11-alpine
# Caddy runs as a user of its own, not root, and still listens on :80: the image gives its binary
# the capability to bind a low port, and Docker lets any user in a container do so anyway. Its
# data and config directories ($XDG_DATA_HOME and $XDG_CONFIG_HOME) are that user's.
RUN adduser -S -D -H -u 10001 -s /sbin/nologin caddy && chown -R caddy /data /config
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
USER caddy
