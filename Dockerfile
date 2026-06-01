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
RUN if [ -f package-lock.json ]; then npm ci; \
    elif [ -f bun.lock ]; then npm install -g bun && bun install --frozen-lockfile; \
    else npm install; fi \
    && npm install \
        lightningcss-linux-x64-gnu@1.32.0 \
        @tailwindcss/oxide-linux-x64-gnu \
        @node-rs/argon2-linux-x64-gnu \
        @napi-rs/canvas-linux-x64-gnu \
        --no-save

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

# OS deps for Prisma better-sqlite3 native binding + sharp canvas
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl python3 \
    && rm -rf /var/lib/apt/lists/*

# Provide safe defaults so `prisma db push` can read DATABASE_URL at startup
# when no .env has been baked into the image. Real values come from
# docker-compose env_file at runtime and override these.
ENV DATABASE_URL=file:./data/chatinterface.db

# Non-root user
RUN groupadd -r chatapp -g 1001 \
 && useradd -r -g chatapp -u 1001 -m chatapp

# Copy only what we need to run
COPY --from=builder --chown=chatapp:chatapp /app/public ./public
COPY --from=builder --chown=chatapp:chatapp /app/.next ./.next
COPY --from=builder --chown=chatapp:chatapp /app/node_modules ./node_modules
COPY --from=builder --chown=chatapp:chatapp /app/package.json ./package.json
COPY --from=builder --chown=chatapp:chatapp /app/prisma ./prisma
COPY --from=builder --chown=chatapp:chatapp /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=chatapp:chatapp /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=chatapp:chatapp /app/.env.example ./.env.example

# Persistent data (DB, encrypted user uploads, agent workspaces)
RUN mkdir -p /app/data && chown -R chatapp:chatapp /app/data
VOLUME ["/app/data"]

USER chatapp
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

CMD ["sh", "-c", "set -a && . /app/.env 2>/dev/null; . /app/.env.local 2>/dev/null; set +a; export DATABASE_URL="${DATABASE_URL:-file:/app/data/chatinterface.db}"; npx prisma db push && node node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT}"]
