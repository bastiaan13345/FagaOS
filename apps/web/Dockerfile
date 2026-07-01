# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for the FagaOS web app.
# Builds the Next.js standalone output against the local workspace
# packages and serves it with `next start` on port 3000.

FROM node:20-alpine AS builder
WORKDIR /app

# Install build tooling for any native modules.
RUN apk add --no-cache python3 make g++

# Copy the full source tree, then install and build every workspace.
# `npm run build` runs `tsc -b` and the web app's own `next build`,
# so all workspace packages must build before the web app.
COPY . .
RUN npm install
RUN npm run build

# Drop dev dependencies so the final image only ships production packages.
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Use the built-in non-root `node` user that already exists in the image.
COPY --from=builder /app /app

USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV FAGAOS_CONTROL_PLANE_URL=http://fagaos-control-plane:8080

EXPOSE 3000

# Next.js standalone output is in apps/web/.next/standalone. We start the
# server with `next start` which honours HOST / PORT above.
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web"]
