#!/bin/sh
set -eu
case "${1:-app}" in
  app)
    python manage.py startup --timeout "${SPECMATE_STARTUP_TIMEOUT:-120}"
    exec uvicorn specmate.asgi:application --host 0.0.0.0 --port 8000 --no-server-header
    ;;
  jobs)
    exec python -m specmate.jobs.worker
    ;;
  *) exec "$@" ;;
esac
