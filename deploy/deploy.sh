#!/bin/sh
# Deploy script run by the deploy-webhook container.
#
# It runs against the HOST's docker daemon (via the mounted docker.sock) and
# operates on the repo checked out on the host at $HOST_DEPLOY_PATH. The
# container bind-mounts that path at the SAME absolute path, so `docker compose`
# resolves relative volume binds (like ./data:/app/data) against the real host
# directory.
#
# IMPORTANT: this script updates app + agent-sandbox ONLY. It deliberately does
# NOT recreate the deploy-webhook container itself, because that would kill the
# process serving this HTTP response mid-flight. The webhook image is updated
# manually (rare: only when deploy.sh / server.py / Dockerfile change) via:
#   docker compose --profile full pull deploy-webhook
#   docker compose --profile full up -d --no-deps --force-recreate deploy-webhook
set -eu

cd "${HOST_DEPLOY_PATH:?HOST_DEPLOY_PATH is not set}"

echo "==> git: fetch + reset to origin/master"
# The compose directory is mounted read-only in production (see docker-
# compose.yml, C10), so fetch/reset may be unable to write to .git or the
# working tree. Treat that as best-effort: image pulls + container recreation
# below still apply the latest images. For docker-compose.yml / deploy file
# changes, git-pull on the host (with a temporarily writable mount) is still
# required.
if ! git fetch --all || ! git reset --hard origin/master; then
  echo "  WARN: git update failed or skipped (checkout may be read-only); continuing with current docker-compose.yml"
fi

echo "==> pulling app + agent-sandbox images"
docker compose --profile full pull app agent-sandbox

echo "==> recreating app + agent-sandbox (no deps, no self-restart)"
docker compose --profile full up -d --no-deps --force-recreate app agent-sandbox

echo "==> pruning dangling images"
docker image prune -f

echo "==> done. current state:"
docker compose --profile full ps
