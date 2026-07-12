# Production Dockerfile for the Chatinterface Next.js app.
#
# Build:    docker build -t chatinterface-app .
# Run:      docker run -p 3000:3000 --env-file .env -v $PWD/data:/app/data chatinterface-app
#
# The sandbox container is a separate image; see docker-sandbox/Dockerfile.

# ── Dependencies (cached layer) ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* bun.lock* ./
RUN if [ -f bun.lock ]; then \
      npm install -g bun && bun install --frozen-lockfile && \
      bun add --dev lightningcss-linux-x64-gnu@1.32.0 @tailwindcss/oxide-linux-x64-gnu@4.2.4 @node-rs/argon2-linux-x64-gnu@2.0.2 @napi-rs/canvas-linux-x64-gnu@0.1.82; \
    elif [ -f package-lock.json ]; then \
      npm ci && \
      npm install --no-save lightningcss-linux-x64-gnu@1.32.0 @tailwindcss/oxide-linux-x64-gnu@4.2.4 @node-rs/argon2-linux-x64-gnu@2.0.2 @napi-rs/canvas-linux-x64-gnu@0.1.82; \
    else \
      npm install && \
      npm install --no-save lightningcss-linux-x64-gnu@1.32.0 @tailwindcss/oxide-linux-x64-gnu@4.2.4 @node-rs/argon2-linux-x64-gnu@2.0.2 @napi-rs/canvas-linux-x64-gnu@0.1.82; \
    fi

# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:./data/chatinterface.db \
    APP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    SESSION_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    NANOGPT_API_KEY=build-placeholder \
    NANOGPT_BASE_URL=https://nano-gpt.com/api/v1
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ── Production runtime ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# OS deps for Prisma better-sqlite3 native binding + sharp canvas + gosu
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl python3 gosu \
    && rm -rf /var/lib/apt/lists/*

# Provide safe defaults so `prisma migrate deploy` can read DATABASE_URL at
# startup when no .env has been baked into the image. Real values come from
# docker-compose env_file at runtime and override these.
ENV DATABASE_URL=file:./data/chatinterface.db

# Non-root user
RUN groupadd -r chatapp -g 1001 \
 && useradd -r -g chatapp -u 1001 -m chatapp

# Copy only what we need to run. Next.js standalone (output: "standalone" in
# next.config.ts) bundles a minimal, traced node_modules + server.js, so the
# full dev node_modules is no longer shipped. Static assets + public are served
# by the standalone server when placed at ./.next/static and ./public.
COPY --from=builder --chown=chatapp:chatapp /app/.next/standalone ./
COPY --from=builder --chown=chatapp:chatapp /app/.next/static ./.next/static
COPY --from=builder --chown=chatapp:chatapp /app/public ./public

# Prisma schema + migrations, used by `prisma migrate deploy` at startup
# (replaces the data-loss-prone `prisma db push`).
COPY --from=builder --chown=chatapp:chatapp /app/prisma ./prisma
COPY --from=builder --chown=chatapp:chatapp /app/prisma.config.ts ./prisma.config.ts

# The `prisma` CLI + its engine/internals packages are NOT traced by Next.js
# (app code only imports @prisma/client, never the CLI). Install prisma + its
# transitive deps into a dedicated location so migrations can run at startup.
# This is a thin layer (~50 MB) separate from the standalone server bundle.
RUN npm install -g prisma@7.8.0 --omit=dev

# Persistent data (DB, encrypted user uploads, agent workspaces)
RUN mkdir -p /app/data && chown -R chatapp:chatapp /app/data
VOLUME ["/app/data"]

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 3000

# NOTE: a dedicated GET /api/health route returning 200 unauthenticated is the
# recommended probe. It does not exist yet, so any HTTP response < 500
# (including the 401 from /api/auth/me) is treated as healthy: it proves the
# Next.js server is up and routing requests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth/me').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" || exit 1

CMD ["sh", "-c", "prisma migrate deploy && node server.js"]
