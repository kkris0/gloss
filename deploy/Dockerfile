# Gloss, one always-on machine: Next.js on a Unix socket, Tailscale Serve in front, SQLite on /data.
# Build from the repo root:  docker build -f deploy/Dockerfile -t gloss .
# Not built or run in CI yet: see docs/SELF_HOST.md for what is and is not verified.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
# tailscaled and tailscale, copied from the official image (pin a version tag before a real deploy).
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscale
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iptables && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 GLOSS_DB_PATH=/data/gloss.sqlite
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY deploy/entrypoint.sh /entrypoint.sh
COPY deploy/*.mjs /app/deploy/
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
