#!/bin/sh
# Start as root ONLY to make the data location writable by the unprivileged `node` user, then drop
# privileges and exec the hub as `node`. This is required because a named volume only inherits the
# image dir's ownership when it is FRESH — a pre-existing root-owned hub_data volume from an older
# (root-running) deploy would otherwise be unwritable after the switch to a non-root user, the
# boot-time writability probe would exit(1), and the hub would never become healthy. (review finding #4)
set -e

if [ "$(id -u)" = "0" ]; then
  STATE_DIR="$(dirname "${STATE_FILE:-/data/state.json}")"
  UP_DIR="${UPLOADS_DIR:-/data/uploads}"
  mkdir -p /data "$STATE_DIR" "$UP_DIR"
  # Best-effort: on a read-only bind mount chown fails; the writability probe then reports it clearly.
  chown -R node:node /data "$STATE_DIR" "$UP_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi

# Already unprivileged (e.g. an orchestrator set the user) — just run.
exec "$@"
