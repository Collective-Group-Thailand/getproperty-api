#!/bin/sh
# Container entry point (tini runs it). A command given by the orchestrator wins (the Collective platform compose
# file sets `command: ["node", "dist/src/worker.js"]` etc.); without one, PROCESS picks the process
# (master plan §2): main | worker | ingest | migrate.
set -eu
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
case "${PROCESS:-main}" in
  main)    exec node dist/src/main.js ;;
  worker)  exec node dist/src/worker.js ;;
  ingest)  exec node dist/src/ingest.js ;;
  migrate) exec node dist/src/migrate.js ;;
  *) echo "PROCESS must be main, worker, ingest or migrate (got '${PROCESS}')" >&2; exit 64 ;;
esac
