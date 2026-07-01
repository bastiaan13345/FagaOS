# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for the FagaOS control-plane server.
# Builds all workspaces, installs only production dependencies in the
# final image, and runs the service as a non-root user.

FROM node:20-alpine AS builder
WORKDIR /app

# Install build tooling for any native modules.
RUN apk add --no-cache python3 make g++

# Copy the full source tree, then install and build.
COPY . .
RUN npm install
RUN npm run build

# Drop dev dependencies so the final image only ships production packages.
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Use the built-in non-root `node` user that already exists in the image.
# Copy the built tree (node_modules now contains only production deps).
COPY --from=builder /app /app

# Ensure the data volume directory is writable by the runtime user.
RUN mkdir -p /app/data && chown -R node:node /app/data /app/node_modules
VOLUME /app/data

USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "apps/control-plane-server/dist/main.js"]
