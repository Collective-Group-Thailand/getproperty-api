#!/bin/sh
# Chooses the process of this container (master plan §2): PROCESS=main | worker | ingest.
set -eu
case "${PROCESS:-main}" in
  main)   exec node dist/src/main.js ;;
  worker) exec node dist/src/worker.js ;;
  ingest) exec node dist/src/ingest.js ;;
  *) echo "PROCESS must be main, worker or ingest (got '${PROCESS}')" >&2; exit 64 ;;
esac
