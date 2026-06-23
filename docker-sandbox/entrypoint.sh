#!/bin/bash
set -euo pipefail

# Chatinterface Agent Sandbox Entrypoint
# Runs as root: the server performs per-session seteuid isolation. The
# application image is read-only (read_only rootfs) so even root cannot patch it.

SANDBOX_PORT="${SANDBOX_PORT:-8080}"
SANDBOX_HOST="${SANDBOX_HOST:-0.0.0.0}"
SANDBOX_LOG_LEVEL="${SANDBOX_LOG_LEVEL:-info}"
SANDBOX_WORKERS="${SANDBOX_WORKERS:-2}"

export HOME=/tmp
export DOTNET_CLI_HOME=/tmp
export NUGET_PACKAGES=/tmp/nuget
export NUGET_HTTP_CACHE_PATH=/tmp/nuget-http-cache
export NUGET_SCRATCH=/tmp/nuget-scratch
export TMPDIR=/tmp

echo "=========================================="
echo "Chatinterface Agent Sandbox"
echo "=========================================="
echo ""

# ── Filesystem hardening ────────────────────────────────────────────────────
# /workspace is shared by every session. Root owns it (0711): sessions' alloc
# uids can traverse to their own /workspace/<sid> (other gets --x) but cannot
# list or create sibling entries. Each <sid> is created/owned by the server
# (isolation.prepare_session) under a dedicated uid with mode 0700.
umask 077
mkdir -p /workspace
chown root:root /workspace
chmod 0711 /workspace

# The application code must be read-only even to root: the read-only rootfs is
# the real guard. Abort if it happens to be writable (e.g. forgot read_only).
if touch /app/lib/..__w_test__ 2>/dev/null; then
  rm -f /app/lib/..__w_test__
  echo "ERROR: /app/lib is writable — refusing to start (security). Enable read_only rootfs."
  exit 1
fi

# Verify dependencies
echo "Checking dependencies..."

python --version || { echo "ERROR: Python not found"; exit 1; }
node --version || { echo "ERROR: Node.js not found"; exit 1; }
python -c "import playwright; print(f'Playwright: OK')" || { echo "WARNING: Playwright not available"; }
libreoffice --version || { echo "WARNING: LibreOffice not available"; }
dotnet --version || { echo "WARNING: .NET not available"; }

echo ""
echo "Starting sandbox API server..."
echo "  Host: $SANDBOX_HOST"
echo "  Port: $SANDBOX_PORT"
echo "  Workers: $SANDBOX_WORKERS"
echo "  Log Level: $SANDBOX_LOG_LEVEL"
echo ""

cd /app/lib

if [ "$SANDBOX_WORKERS" -gt 1 ]; then
    # sync worker class: one request per worker at a time, which is required
    # for safe per-session seteuid bracketing (no concurrent uid switches in a
    # single process).
    exec gunicorn \
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
    exec python sandbox_server.py \
        --port "$SANDBOX_PORT" \
        --host "$SANDBOX_HOST"
fi
