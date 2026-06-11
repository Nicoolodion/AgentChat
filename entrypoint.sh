#!/bin/sh
set -e

# Fix ownership of the data directory so the chatapp user can write to it.
# Bind-mounted host directories may have different ownership.
chown -R chatapp:chatapp /app/data 2>/dev/null || true

# Drop to chatapp user and run the CMD
exec gosu chatapp "$@"
