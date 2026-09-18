FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci
COPY server ./server
COPY client ./client
RUN npm run build

FROM debian:bookworm-slim AS av-updater
RUN apt-get update && apt-get install -y --no-install-recommends clamav-freshclam ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/clamav && chown clamav:clamav /var/lib/clamav
COPY ops/av/freshclam.conf /etc/clamav/freshclam.conf
USER clamav
CMD ["/usr/bin/freshclam", "--daemon", "--foreground", "--config-file=/etc/clamav/freshclam.conf"]

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production CLIENT_DIST=/app/client/dist SCHEMA_FILE=/app/contracts/schema.sql
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends clamav ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev --workspace=server --include-workspace-root && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
COPY contracts/schema.sql ./contracts/schema.sql
COPY server/migrations ./server/migrations
COPY ops ./ops
RUN mkdir -p /var/lib/fresh/report-quarantine && chown node:node /var/lib/fresh/report-quarantine && chmod 700 /var/lib/fresh/report-quarantine
USER node
EXPOSE 4000
CMD ["node", "server/dist/src/index.js"]
