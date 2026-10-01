# Multi-stage build producing a single image that serves the API + the built SPA.
# Build from the REPO ROOT so both web/ and server/ are in context:
#   docker build -f server/Dockerfile -t finance-tracker .
# syntax=docker/dockerfile:1

# 1) Build the web SPA -> /web/dist
FROM node:20-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# vite.config.ts reads ../CHANGELOG.md for the What's New page.
COPY CHANGELOG.md /CHANGELOG.md
RUN npm run build

# 2) Compile the server (TypeScript -> dist, incl. migrate.js / bootstrap.js)
FROM node:20-slim AS server-build
WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# 3) Lean runtime image
FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
WORKDIR /app/server
# Production deps only.
COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Compiled server + migrations, and the built SPA as a sibling (server serves ../../web/dist).
COPY --from=server-build /server/dist ./dist
COPY server/migrations ./migrations
COPY --from=web /web/dist /app/web/dist
EXPOSE 4000
# Migrations are NOT run on boot — run them as a one-off task (see DEPLOY.md):
#   node dist/migrate.js
CMD ["node", "dist/index.js"]
