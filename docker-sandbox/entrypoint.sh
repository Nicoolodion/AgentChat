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

# Fix ownership of bind-mounted /workspace (created by Docker as root:root)
mkdir -p /workspace
chown -R sandbox:sandbox /workspace

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
