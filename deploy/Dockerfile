# Tiny deploy-webhook receiver.
# Built and pushed to ghcr.io/nicoolodion/agentchat-webhook by GitHub Actions.
#
# Why docker:cli as the base: it bundles `docker` + the `docker compose` v2
# plugin, so the hook can talk to the host docker daemon over the mounted
# /var/run/docker.sock. Alpine-based; apk adds python3 + git.

FROM docker:24-cli

RUN apk add --no-cache python3 git

WORKDIR /app
COPY server.py deploy.sh ./
RUN chmod +x /app/deploy.sh

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-9000}/health" || exit 1

CMD ["python3", "/app/server.py"]
