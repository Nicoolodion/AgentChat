#!/bin/sh
# sandbox-watchdog.sh — self-heal the agent sandbox's gluetun netns coupling.
#
# The agent-sandbox shares gluetun's network namespace via
# `network_mode: service:gluetun`. Whenever the gluetun CONTAINER restarts
# (manual `docker restart`, a recreate, a daemon event, a host reboot race,
# etc.) it gets a fresh network namespace, but the sandbox keeps running on the
# now-destroyed old one. The sandbox's own loopback healthcheck keeps passing
# (so Docker still reports it "healthy") yet it is unreachable from the app at
# http://gluetun:8080 -> the app reports "sandbox offline".
#
# Compose's `depends_on` only orders startup; it does NOT restart dependents on
# a later dependency restart, and Docker has no native "restart B when A
# restarts" for ad-hoc events. This lightweight probe loop is the permanent
# fix: it hits the sandbox through the SAME path the app uses and restarts the
# sandbox container (re-attaching it to gluetun's current netns) when it goes
# silent — but only while gluetun itself is healthy, so the VPN tunnel is never
# touched and it never thrashes during a genuine gluetun outage.
#
# Runs as its own `sandbox-watchdog` service (profile "full"). It only needs:
#   * app-net membership (to reach http://gluetun:8080 like the app does)
#   * read/write access to /var/run/docker.sock (to `docker restart` the sandbox)
set -u

SANDBOX="${SANDBOX_CONTAINER:-chatinterface-agent-sandbox}"
GLUETUN="${GLUETUN_CONTAINER:-chatinterface-gluetun}"
URL="${SANDBOX_HEALTH_URL:-http://gluetun:8080/health}"
INTERVAL="${WATCHDOG_INTERVAL_SECONDS:-30}"
THRESHOLD="${WATCHDOG_FAILURE_THRESHOLD:-3}"   # ~90s of silence before acting
COOLDOWN="${WATCHDOG_COOLDOWN_SECONDS:-45}"    # post-restart settle window

fails=0

log() { printf '%s %s\n' "$(date -Iseconds 2>/dev/null || date)" "$*"; }

while true; do
  sleep "$INTERVAL"

  # Don't act while gluetun is down/unhealthy: gluetun's own `restart:
  # unless-stopped` policy + its built-in healthcheck recover it. Once gluetun
  # is healthy again, the sandbox will still be orphaned (netns swapped under
  # it) and the probe below will fail -> we restart it then.
  gluetun_state="$(docker inspect -f '{{.State.Health.Status}}' "$GLUETUN" 2>/dev/null \
                   || docker inspect -f '{{.State.Status}}' "$GLUETUN" 2>/dev/null \
                   || echo unknown)"
  case "$gluetun_state" in
    healthy|running) : ;;        # gluetun is up; verify the sandbox is reachable
      *) fails=0; continue ;;    # gluetun not up yet; nothing to do here
  esac

  if wget -q -T 5 -O /dev/null "$URL" 2>/dev/null; then
    fails=0
    continue
  fi

  fails=$((fails + 1))
  log "sandbox probe failed ($fails/$THRESHOLD): $URL"

  if [ "$fails" -ge "$THRESHOLD" ]; then
    log "sandbox unreachable via $URL while gluetun='$gluetun_state'; restarting $SANDBOX"
    docker restart -t 10 "$SANDBOX" >/dev/null 2>&1 || log "WARN: docker restart $SANDBOX failed"
    fails=0
    sleep "$COOLDOWN"
  fi
done
