FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci
COPY server ./server
COPY client ./client
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production CLIENT_DIST=/app/client/dist SCHEMA_FILE=/app/contracts/schema.sql
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev --workspace=server --include-workspace-root && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
COPY contracts/schema.sql ./contracts/schema.sql
USER node
EXPOSE 4000
CMD ["node", "server/dist/src/index.js"]
