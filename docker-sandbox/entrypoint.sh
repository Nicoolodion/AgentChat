#!/bin/bash
set -euo pipefail

# Chatinterface Agent Sandbox Entrypoint
# Starts as root to fix bind-mount permissions, then drops to sandbox user

SANDBOX_PORT="${SANDBOX_PORT:-8080}"
SANDBOX_HOST="${SANDBOX_HOST:-0.0.0.0}"
SANDBOX_LOG_LEVEL="${SANDBOX_LOG_LEVEL:-info}"
SANDBOX_WORKERS="${SANDBOX_WORKERS:-2}"

echo "=========================================="
echo "Chatinterface Agent Sandbox"
echo "=========================================="
echo ""

# ── Filesystem hardening ────────────────────────────────────────────────────
# /workspace holds every session directory on a shared bind mount. Root owns
# the volume root (mode 0750) — session subdirectories are created by the API
# server with a restrictive umask so a session cannot list/clobber siblings
# through write-permission overlap. /app is root-owned & read-only by design
# (see Dockerfile) and must NOT be chowned to the runtime user here.
umask 077
mkdir -p /workspace
chown sandbox:sandbox /workspace
chmod 0750 /workspace
chown -R sandbox:sandbox /workspace/* 2>/dev/null || true
find /workspace -maxdepth 1 -type d ! -path /workspace -exec chmod 0750 {} + 2>/dev/null || true

# Verify the application image was not accidentally made writable by the runtime
# user (defense-in-depth: abort early rather than run a possibly-backdoored app).
if [ -w /app/lib ] 2>/dev/null; then
  echo "ERROR: /app/lib is writable by the runtime user — refusing to start (security)."
  exit 1
fi

# Verify dependencies
echo "Checking dependencies..."

# Python
python --version || { echo "ERROR: Python not found"; exit 1; }

# Node.js
node --version || { echo "ERROR: Node.js not found"; exit 1; }

# Playwright
python -c "import playwright; print(f'Playwright: OK')" || { echo "WARNING: Playwright not available"; }

# LibreOffice
libreoffice --version || { echo "WARNING: LibreOffice not available"; }

# .NET
dotnet --version || { echo "WARNING: .NET not available"; }

echo ""
echo "Starting sandbox API server..."
echo "  Host: $SANDBOX_HOST"
echo "  Port: $SANDBOX_PORT"
echo "  Workers: $SANDBOX_WORKERS"
echo "  Log Level: $SANDBOX_LOG_LEVEL"
echo ""

# ── Per-session UID isolation jail ──────────────────────────────────────────
# A small root process maps each session to a dedicated uid and runs that
# session's code under it, so one session cannot read/write another's files
# (audit 2.1/2.3). The API server itself stays non-root. Fail closed: if the
# jail cannot start (e.g. the host lacks ACL support), refuse to boot rather
# than run unprotected.
SANDBOX_JAIL_SOCKET="${SANDBOX_JAIL_SOCKET:-/run/session-jail.sock}"
mkdir -p "$(dirname "$SANDBOX_JAIL_SOCKET")"
python /app/lib/session_jail.py &
JAIL_PID=$!
for _ in $(seq 1 30); do
  [ -S "$SANDBOX_JAIL_SOCKET" ] && break
  if ! kill -0 "$JAIL_PID" 2>/dev/null; then
    echo "ERROR: session isolation jail failed to start — refusing to boot unprotected."
    exit 1
  fi
  sleep 0.5
done
if [ ! -S "$SANDBOX_JAIL_SOCKET" ]; then
  echo "ERROR: session isolation jail did not become ready in time — refusing to boot."
  exit 1
fi
echo "Session isolation jail ready (pid $JAIL_PID, socket $SANDBOX_JAIL_SOCKET)."

cd /app/lib

if [ "$SANDBOX_WORKERS" -gt 1 ]; then
    exec gosu sandbox gunicorn \
        -w "$SANDBOX_WORKERS" \
        -b "$SANDBOX_HOST:$SANDBOX_PORT" \
        --timeout 300 \
        --keep-alive 30 \
        --worker-class sync \
        --access-logfile - \
        --error-logfile - \
        --log-level "$SANDBOX_LOG_LEVEL" \
        "sandbox_server:app"
else
    exec gosu sandbox python sandbox_server.py \
        --port "$SANDBOX_PORT" \
        --host "$SANDBOX_HOST"
fi
