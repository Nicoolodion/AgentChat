#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  chown -R chatapp:chatapp /app/data 2>/dev/null || true
  exec gosu chatapp "$@"
fi

exec "$@"
